/**
 * Portfolio management and transaction processing
 *
 * Orchestrates contributions, withdrawals, RMDs, rebalancing, and tax settlement
 * across all investment accounts. Implements the contribution waterfall (priority-ordered
 * rules with IRS limits) and withdrawal ordering (tax-optimized account sequencing).
 */

import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import type { GlidePathInputs } from '@/lib/schemas/inputs/glide-path-form-schema';
import type { ConversionInputs } from '@/lib/schemas/inputs/conversion-form-schema';
import type { SeppScheduleInputs } from '@/lib/schemas/inputs/sepp-form-schema';
import { addMonths, formatISODate, type ISODateString } from './clock';
import { seppAnnualAmount, seppAnnualAmountFromTables, seppMustContinueUntil } from './retirement-rules/sepp';
import { singleLifeExpectancy, type SeppRateMonth } from './retirement-rules/sepp-tables';

import {
  type Account,
  SavingsAccount,
  TaxableBrokerageAccount,
  TaxDeferredAccount,
  TaxFreeAccount,
  InvestmentAccount,
  type AccountDataWithFlows,
} from './account';
import type { SimulationState, SimulationContext } from './simulation-engine';
import {
  type AssetReturnRates,
  type AssetReturnAmounts,
  type AssetAllocation,
  type AssetValues,
  type AssetYieldRates,
  type AssetYieldAmounts,
  type AssetFlows,
  type TaxCategory,
  zeroAssetAmounts,
  addAssetAmounts,
} from './asset';
import { ContributionRules } from './contribution-rules';
import { timePointProgress } from './time-binding';
import type { IncomesData } from './incomes';
import type { ExpensesData } from './expenses';
import type { DebtsData } from './debts';
import type { PhysicalAssetsData } from './physical-assets';
import type { AccountDataWithReturns } from './returns';
import { uniformLifetimeMap } from './historical-data/rmd-table';
import { DEFAULT_WITHDRAWAL_STRATEGY, type WithdrawalOrderItem, type WithdrawalStrategy } from './withdrawal-strategies';

type FlowsData = { total: AssetFlows; byAccount: Record<string, AssetFlows> };

const DEFAULT_ASSET_ALLOCATION = { stocks: 0.6, bonds: 0.4, cash: 0 };

const zeroFlows = zeroAssetAmounts<AssetFlows>;
const addFlows = addAssetAmounts<AssetFlows>;

/** Manages monthly portfolio transactions including contributions, withdrawals, RMDs, taxes, and rebalancing */
export class PortfolioProcessor {
  private initialAssetAllocation: AssetAllocation | null;
  private extraSavingsAccount: SavingsAccount;
  private rmdSavingsAccount: SavingsAccount;
  private monthlyData: PortfolioData[] = [];
  private outstandingShortfall: number = 0;
  private currentMonthConversionsByAccount: Record<string, number> = {};
  private currentMonthConversionsTotal = 0;
  private fixedSeppPaymentByScheduleId: Map<string, number> = new Map();
  private cumulativeSeppByScheduleId: Map<string, number> = new Map();
  private seppRecaptureTriggered: Set<string> = new Set();

  /** Simulation-year index the current allowance was computed for; see `currentYearWithdrawalAllowance`. */
  private allowanceYearIndex: number | undefined;
  /** What is left of the current year's spending allowance, or `undefined` when uncapped. */
  private remainingAllowance: number | undefined;
  /** Spending withdrawals taken so far this simulation year, the history Guyton-Klinger reads. */
  private annualWithdrawnTotal = 0;
  /** Last simulation year's spending withdrawals, or `undefined` if it took none. */
  private previousAnnualWithdrawal: number | undefined;

  /**
   * @param withdrawalStrategy - Where withdrawals come from and, for the capping strategies, how
   *   much a year may take. Defaults to `ordered`: the pre-strategy sequence with no ceiling, so a
   *   processor constructed without this argument behaves exactly as it did before P1-P4.
   */
  constructor(
    private simulationState: SimulationState,
    private simulationContext: SimulationContext,
    private contributionRules: ContributionRules,
    private glidePath?: GlidePathInputs,
    private withdrawalStrategy: WithdrawalStrategy = DEFAULT_WITHDRAWAL_STRATEGY
  ) {
    this.initialAssetAllocation = this.simulationState.portfolio.getWeightedAssetAllocation();
    this.extraSavingsAccount = this.createExtraSavingsAccount();
    this.rmdSavingsAccount = this.createRmdSavingsAccount();
  }

  private createExtraSavingsAccount(): SavingsAccount {
    return new SavingsAccount({ type: 'savings' as const, id: '54593a0d-7b4f-489d-a5bd-42500afba532', name: 'Extra Savings', balance: 0 });
  }

  private createRmdSavingsAccount(): SavingsAccount {
    return new SavingsAccount({ type: 'savings' as const, id: 'd7288042-1f83-4e50-9a6a-b1ef7a6191cc', name: 'RMD Savings', balance: 0 });
  }

  /**
   * Processes monthly contributions or withdrawals based on net cash flow
   * @param incomesData - Monthly income data
   * @param expensesData - Monthly expense data
   * @param debtsData - Monthly debt payment data
   * @param physicalAssetsData - Monthly physical asset data
   * @param essentialSpending - This month's essential spending (P1-P4), already scaled and
   *   frequency-adjusted by the expenses processor. A strategy's annual cap may not cut it, so it
   *   raises the month's allowance when the cap would leave it unfunded. Zero by default, which is
   *   exactly the pre-essential behaviour.
   * @param investmentIncomeCash - Dividends and interest paid out of taxable accounts this month
   *   (v20 `distributeIncome`); already removed from the balances, so here it is household cash.
   * @returns Portfolio data and any discretionary expense from surplus
   */
  processContributionsAndWithdrawals(
    incomesData: IncomesData,
    expensesData: ExpensesData,
    debtsData: DebtsData,
    physicalAssetsData: PhysicalAssetsData,
    essentialSpending = 0,
    investmentIncomeCash = 0
  ): { portfolioData: PortfolioData; discretionaryExpense: number } {
    const debtAndLoanPayments = debtsData.totalPayment + physicalAssetsData.totalLoanPayment;

    const physicalAssetPurchaseOutlay = physicalAssetsData.totalPurchaseOutlay;
    const physicalAssetSaleProceeds = physicalAssetsData.totalSaleProceeds;

    const netCashFlow =
      incomesData.totalIncomeAfterPayrollDeductions +
      investmentIncomeCash +
      physicalAssetSaleProceeds -
      expensesData.totalExpenses -
      debtAndLoanPayments -
      physicalAssetPurchaseOutlay;

    const {
      total: contributions,
      byAccount: contributionsByAccount,
      discretionaryExpense,
      employerMatch,
      employerMatchByAccount,
      shortfallRepaid,
    } = this.processContributions(netCashFlow, incomesData);

    const {
      total: withdrawals,
      byAccount: withdrawalsByAccount,
      realizedGains: realizedGainsBeforeRebalance,
      realizedGainsByAccount: realizedGainsByAccountBeforeRebalance,
      earningsWithdrawn,
      earningsWithdrawnByAccount,
      unseasonedConversionsWithdrawn,
      unseasonedConversionsWithdrawnByAccount,
      shortfall,
    } = this.processWithdrawals(
      netCashFlow,
      this.currentYearWithdrawalAllowance(this.essentialWithdrawalFloor(netCashFlow, essentialSpending))
    );

    const { realizedGainsFromRebalance, realizedGainsByAccountFromRebalance } = this.processRebalance();

    const realizedGains = realizedGainsBeforeRebalance + realizedGainsFromRebalance;
    const realizedGainsByAccount = { ...realizedGainsByAccountBeforeRebalance };
    for (const [k, v] of Object.entries(realizedGainsByAccountFromRebalance)) {
      realizedGainsByAccount[k] = (realizedGainsByAccount[k] ?? 0) + v;
    }

    const perAccountData: Record<string, AccountDataWithFlows> = this.buildPerAccountData(
      {},
      contributionsByAccount,
      employerMatchByAccount,
      withdrawalsByAccount,
      realizedGainsByAccount,
      earningsWithdrawnByAccount,
      {},
      unseasonedConversionsWithdrawnByAccount
    );

    const portfolioData = this.buildPortfolioData(
      {
        withdrawals,
        contributions,
        employerMatch,
        realizedGains,
        earningsWithdrawn,
        rmds: 0,
        shortfall,
        shortfallRepaid,
        ...(unseasonedConversionsWithdrawn > 0 ? { unseasonedConversionsWithdrawn } : {}),
      },
      perAccountData
    );

    this.monthlyData.push(portfolioData);
    return { portfolioData, discretionaryExpense };
  }

  /**
   * Settles annual tax obligations by withdrawing (tax due) or contributing (refund)
   * @param annualPortfolioDataBeforeTaxes - Portfolio state before tax settlement
   * @param taxesData - Tax amounts due or refundable
   * @returns Updated portfolio data and any discretionary expense from refund
   */
  processTaxes(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    taxesData: { totalTaxesDue: number; totalTaxesRefund: number }
  ): { portfolioData: PortfolioData; discretionaryExpense: number } {
    const perAccountDataBeforeTaxes = annualPortfolioDataBeforeTaxes.perAccountData;

    let withdrawals = { ...annualPortfolioDataBeforeTaxes.withdrawals };
    let contributions = { ...annualPortfolioDataBeforeTaxes.contributions };
    let employerMatch = annualPortfolioDataBeforeTaxes.employerMatch;
    let realizedGains = annualPortfolioDataBeforeTaxes.realizedGains;
    let earningsWithdrawn = annualPortfolioDataBeforeTaxes.earningsWithdrawn;
    let shortfall = annualPortfolioDataBeforeTaxes.shortfall;
    let shortfallRepaid = annualPortfolioDataBeforeTaxes.shortfallRepaid;

    const rmds = annualPortfolioDataBeforeTaxes.rmds;

    let contributionsByAccount: Record<string, AssetFlows> = {};
    let employerMatchByAccount: Record<string, number> = {};
    let withdrawalsByAccount: Record<string, AssetFlows> = {};
    let realizedGainsByAccount: Record<string, number> = {};
    let earningsWithdrawnByAccount: Record<string, number> = {};

    let discretionaryExpense = 0;
    if (taxesData.totalTaxesRefund > 0) {
      const res = this.processContributions(taxesData.totalTaxesRefund, null);
      contributions = addFlows(contributions, res.total);
      contributionsByAccount = res.byAccount;
      discretionaryExpense += res.discretionaryExpense;
      employerMatch += res.employerMatch;
      employerMatchByAccount = res.employerMatchByAccount;
      shortfallRepaid += res.shortfallRepaid;
    }

    let unseasonedConversionsWithdrawnByAccount: Record<string, number> = {};
    let unseasonedConversionsWithdrawn = annualPortfolioDataBeforeTaxes.unseasonedConversionsWithdrawn ?? 0;

    if (taxesData.totalTaxesDue > 0) {
      const res = this.processWithdrawals(-taxesData.totalTaxesDue);
      withdrawals = addFlows(withdrawals, res.total);
      withdrawalsByAccount = res.byAccount;
      realizedGains += res.realizedGains;
      realizedGainsByAccount = res.realizedGainsByAccount;
      earningsWithdrawn += res.earningsWithdrawn;
      earningsWithdrawnByAccount = res.earningsWithdrawnByAccount;
      if (res.unseasonedConversionsWithdrawn > 0) {
        unseasonedConversionsWithdrawnByAccount = res.unseasonedConversionsWithdrawnByAccount;
        unseasonedConversionsWithdrawn += res.unseasonedConversionsWithdrawn;
      }
      shortfall += res.shortfall;
    }

    const perAccountData: Record<string, AccountDataWithFlows> = this.buildPerAccountData(
      perAccountDataBeforeTaxes,
      contributionsByAccount,
      employerMatchByAccount,
      withdrawalsByAccount,
      realizedGainsByAccount,
      earningsWithdrawnByAccount,
      {},
      unseasonedConversionsWithdrawnByAccount
    );

    const portfolioData = this.buildPortfolioData(
      {
        withdrawals,
        contributions,
        employerMatch,
        realizedGains,
        earningsWithdrawn,
        rmds,
        shortfall,
        shortfallRepaid,
        conversions: annualPortfolioDataBeforeTaxes.conversions,
        ...(unseasonedConversionsWithdrawn > 0 ? { unseasonedConversionsWithdrawn } : {}),
        sepp: annualPortfolioDataBeforeTaxes.sepp,
        seppRecapture: annualPortfolioDataBeforeTaxes.seppRecapture,
      },
      perAccountData
    );

    return { portfolioData, discretionaryExpense };
  }

  private processContributions(
    netCashFlow: number,
    incomesData: IncomesData | null
  ): FlowsData & {
    discretionaryExpense: number;
    employerMatch: number;
    employerMatchByAccount: Record<string, number>;
    shortfallRepaid: number;
  } {
    const byAccount: Record<string, AssetFlows> = {};
    const employerMatchByAccount: Record<string, number> = {};
    if (!(netCashFlow > 0)) {
      return {
        total: zeroFlows(),
        byAccount,
        discretionaryExpense: 0,
        employerMatch: 0,
        employerMatchByAccount,
        shortfallRepaid: 0,
      };
    }

    const shortfallRepaid = Math.min(netCashFlow, this.outstandingShortfall);
    this.outstandingShortfall -= shortfallRepaid;

    this.contributionRules.resetMonthly();
    const contributionRules = this.contributionRules.getRules().sort((a, b) => a.getRank() - b.getRank());

    let employerMatch = 0;

    let remainingToContribute = netCashFlow - shortfallRepaid;
    let currentRuleIndex = 0;
    while (remainingToContribute > 0 && currentRuleIndex < contributionRules.length) {
      const rule = contributionRules[currentRuleIndex];

      const contributeToAccountID = rule.getAccountID();
      const contributeToAccount = this.simulationState.portfolio.getAccountById(contributeToAccountID);
      if (!contributeToAccount) {
        console.warn(`Contribution rule references non-existent account ID: ${contributeToAccountID}`);

        currentRuleIndex++;
        continue;
      }

      // The catch-up eligibility is the account owner's age, not the primary's (P1-P3): a partner's
      // 401(k) takes the partner's age-50 catch-up limit.
      const { contributionAmount, employerMatchAmount } = rule.calculateContribution(
        remainingToContribute,
        contributeToAccount,
        this.ageForAccount(contributeToAccount),
        incomesData
      );
      if (contributionAmount <= 0) {
        currentRuleIndex++;
        continue;
      }

      const contributionAllocation = this.getAllocationForContribution(contributionAmount + employerMatchAmount);
      const contributedAssets = contributeToAccount.applyContribution(contributionAmount, 'self', contributionAllocation);
      byAccount[contributeToAccountID] = addFlows(byAccount[contributeToAccountID] ?? zeroFlows(), contributedAssets);

      if (employerMatchAmount > 0) {
        const matchedAssets = contributeToAccount.applyContribution(employerMatchAmount, 'employer', contributionAllocation);
        byAccount[contributeToAccountID] = addFlows(byAccount[contributeToAccountID], matchedAssets);
      }

      employerMatchByAccount[contributeToAccountID] = (employerMatchByAccount[contributeToAccountID] ?? 0) + employerMatchAmount;
      employerMatch += employerMatchAmount;

      rule.recordContribution(contributionAmount, employerMatchAmount, contributeToAccount.getAccountType());

      remainingToContribute -= contributionAmount;
      currentRuleIndex++;
    }

    let discretionaryExpense = 0;
    if (remainingToContribute > 0) {
      const baseRule = this.contributionRules.getBaseRuleType();
      switch (baseRule) {
        case 'spend':
          discretionaryExpense = remainingToContribute;
          break;
        case 'save':
          const portfolioHasExtraSavingsAccount = this.simulationState.portfolio
            .getAccounts()
            .some((account) => account.getAccountID() === this.extraSavingsAccount.getAccountID());
          if (!portfolioHasExtraSavingsAccount) {
            this.simulationState.portfolio.addExtraSavingsAccount(this.extraSavingsAccount);
          }

          const contributionAllocation = this.getAllocationForContribution(remainingToContribute);
          const extraContributed = this.extraSavingsAccount.applyContribution(remainingToContribute, 'self', contributionAllocation);
          byAccount[this.extraSavingsAccount.getAccountID()] = addFlows(
            byAccount[this.extraSavingsAccount.getAccountID()] ?? zeroFlows(),
            extraContributed
          );

          remainingToContribute = 0;
          break;
      }
    }

    const total = Object.values(byAccount).reduce((acc, curr) => addFlows(acc, curr), zeroFlows());

    return { total, byAccount, discretionaryExpense, employerMatch, employerMatchByAccount, shortfallRepaid };
  }

  private processWithdrawals(
    netCashFlow: number,
    /**
     * What the strategy still allows this year, or `undefined` when it sets no ceiling (the
     * `ordered` default) — and also when this withdrawal is not spending at all: the tax
     * settlement calls here without a budget, because a liability cannot be capped away.
     */
    annualAllowance?: number
  ): FlowsData & {
    realizedGains: number;
    realizedGainsByAccount: Record<string, number>;
    earningsWithdrawn: number;
    earningsWithdrawnByAccount: Record<string, number>;
    unseasonedConversionsWithdrawn: number;
    unseasonedConversionsWithdrawnByAccount: Record<string, number>;
    shortfall: number;
  } {
    const byAccount: Record<string, AssetFlows> = {};
    const realizedGainsByAccount: Record<string, number> = {};
    const earningsWithdrawnByAccount: Record<string, number> = {};
    const unseasonedConversionsWithdrawnByAccount: Record<string, number> = {};
    if (!(netCashFlow < 0)) {
      return {
        total: zeroFlows(),
        byAccount,
        realizedGains: 0,
        realizedGainsByAccount,
        earningsWithdrawn: 0,
        earningsWithdrawnByAccount,
        unseasonedConversionsWithdrawn: 0,
        unseasonedConversionsWithdrawnByAccount,
        shortfall: 0,
      };
    }

    let realizedGains = 0;
    let earningsWithdrawn = 0;
    let unseasonedConversionsWithdrawn = 0;

    const withdrawalSteps = this.withdrawalStepsForMonth();
    const desiredWithdrawal = Math.abs(netCashFlow);
    let remainingToWithdraw = annualAllowance === undefined ? desiredWithdrawal : Math.min(desiredWithdrawal, Math.max(0, annualAllowance));
    let withdrawnTotal = 0;

    for (const { item, account } of withdrawalSteps) {
      if (remainingToWithdraw <= 0) break;

      const { modifier } = item;

      if (!(account.getBalance() > 0)) continue;

      let maxWithdrawable = account.getBalance();
      if (modifier === 'contributionsOnly' && account instanceof TaxFreeAccount) {
        maxWithdrawable = Math.min(maxWithdrawable, account.getContributionBasis());
      }

      const withdrawFromThisAccount = Math.min(remainingToWithdraw, maxWithdrawable);

      const withdrawalAllocation = this.getAllocationForWithdrawal(withdrawFromThisAccount);
      const startCalendarDate = {
        year: this.simulationContext.startDate.getFullYear(),
        month: this.simulationContext.startDate.getMonth() + 1,
        day: 1,
      };
      const currentMonthStart = addMonths(startCalendarDate, this.simulationState.time.month - 1);
      const currentDate = formatISODate({
        year: currentMonthStart.year,
        month: currentMonthStart.month,
        day: 1,
      });
      const {
        realizedGains: realizedGainsFromThisAccount,
        earningsWithdrawn: earningsWithdrawnFromThisAccount,
        unseasonedConversionsWithdrawn: unseasonedConversionsFromThisAccount,
        ...withdrawnAssets
      } = account.applyWithdrawal(withdrawFromThisAccount, 'regular', withdrawalAllocation, {
        date: currentDate,
        age: this.ageForAccount(account),
      });

      realizedGainsByAccount[account.getAccountID()] = (realizedGainsByAccount[account.getAccountID()] ?? 0) + realizedGainsFromThisAccount;
      realizedGains += realizedGainsFromThisAccount;

      earningsWithdrawnByAccount[account.getAccountID()] =
        (earningsWithdrawnByAccount[account.getAccountID()] ?? 0) + earningsWithdrawnFromThisAccount;
      earningsWithdrawn += earningsWithdrawnFromThisAccount;

      if (unseasonedConversionsFromThisAccount && unseasonedConversionsFromThisAccount > 0) {
        unseasonedConversionsWithdrawnByAccount[account.getAccountID()] =
          (unseasonedConversionsWithdrawnByAccount[account.getAccountID()] ?? 0) + unseasonedConversionsFromThisAccount;
        unseasonedConversionsWithdrawn += unseasonedConversionsFromThisAccount;
      }

      byAccount[account.getAccountID()] = addFlows(byAccount[account.getAccountID()] ?? zeroFlows(), withdrawnAssets);
      remainingToWithdraw -= withdrawFromThisAccount;
      withdrawnTotal += withdrawFromThisAccount;
    }

    const total = Object.values(byAccount).reduce((acc, curr) => addFlows(acc, curr), zeroFlows());

    // Any remaining amount that couldn't be withdrawn is recorded as a shortfall. That includes
    // what a capping strategy refused to fund: the spending still happened, and this is the cash
    // that could not be drawn for it. (Uncapped, this is the same expression as before strategies
    // existed — the cap only changes how `remainingToWithdraw` starts.)
    const shortfall = annualAllowance === undefined ? remainingToWithdraw : desiredWithdrawal - withdrawnTotal;
    this.outstandingShortfall += shortfall;

    if (annualAllowance !== undefined) {
      // Decrement what was actually taken rather than recomputing from this call's allowance: the
      // allowance may have been raised by the essential floor, and that raise is a one-month
      // exception, not new budget for the rest of the year.
      this.remainingAllowance = Math.max(0, (this.remainingAllowance ?? annualAllowance) - withdrawnTotal);
      this.annualWithdrawnTotal += withdrawnTotal;
    }

    return {
      total,
      byAccount,
      realizedGains,
      realizedGainsByAccount,
      earningsWithdrawn,
      earningsWithdrawnByAccount,
      unseasonedConversionsWithdrawn,
      unseasonedConversionsWithdrawnByAccount,
      shortfall,
    };
  }

  /**
   * The plan-axis age at which this account's RMDs begin (P1-P3 piece 1).
   *
   * Each member's own birth year decides their own RMD age, so two accounts of a couple can start
   * years apart. A context built without the per-owner map — a unit test, or a caller that
   * predates households — falls back to the context's single `rmdAge` for every account, which is
   * exactly the pre-household behaviour.
   */
  private rmdStartAgeFor(account: Account): number {
    const owner = this.simulationContext.accountOwners?.[account.getAccountID()] ?? 'primary';

    return this.simulationContext.rmdAgeByOwner?.[owner] ?? this.simulationContext.rmdAge;
  }

  /**
   * This account owner's age on the plan's axis (P1-P3).
   *
   * `simulationState.time.age` is the *primary's* age — the axis the clock runs on — so an owner of
   * a different age is that reading less the offset the engine resolved for the member. An account
   * with no recorded owner reads as `primary` (as `ownerOf` does everywhere else), and a context
   * built without the map — a unit test, or a caller that predates per-member ages — falls back to
   * the clock's own age for every account, which is exactly the pre-household behaviour.
   *
   * Every age a withdrawal is measured against reads this: the Roth seasoning rule on
   * `applyWithdrawal`, the withdrawal-order switch below, and (through the same offsets) the tax
   * layer's early-withdrawal gates. A gate read at one age and a penalty charged at another is the
   * contradiction this exists to prevent.
   */
  private ageForAccount(account: Account): number {
    const owner = this.simulationContext.accountOwners?.[account.getAccountID()] ?? 'primary';

    return this.simulationState.time.age - (this.simulationContext.ageOffsetByOwner?.[owner] ?? 0);
  }

  /**
   * The birth date a SEPP schedule's account owner is measured against (§72(t)(4): five years or
   * age 59½, whichever is later), from `birthYearByOwner` / `birthMonthByOwner`. A context built
   * without a household falls back to the plan's birth date, the pre-household behaviour.
   */
  private seppOwnerBirthDate(accountId: string, planBirth: { year: number; month: number }): ISODateString {
    const owner = this.simulationContext.accountOwners?.[accountId] ?? 'primary';
    const year = this.simulationContext.birthYearByOwner?.[owner] ?? planBirth.year;
    const month = this.simulationContext.birthMonthByOwner?.[owner] ?? planBirth.month;

    return formatISODate({ year, month, day: 1 });
  }

  /**
   * Processes Required Minimum Distributions for accounts subject to RMDs
   *
   * Calculates RMD amount using the IRS Uniform Lifetime Table, withdraws from
   * each eligible account, and deposits proceeds into a dedicated RMD savings account.
   * @returns Portfolio data reflecting RMD withdrawals and deposits
   */
  processRequiredMinimumDistributions(): PortfolioData {
    const age = this.simulationState.time.age;
    if (age < this.simulationContext.rmdAge)
      throw new Error(`RMDs should not be processed for ages under ${this.simulationContext.rmdAge}`);
    const withdrawalsByAccount: Record<string, AssetFlows> = {};
    const rmdsByAccount: Record<string, number> = {};

    const realizedGainsByAccount: Record<string, number> = {};
    const earningsWithdrawnByAccount: Record<string, number> = {};

    let total = 0;
    let realizedGains = 0;
    let earningsWithdrawn = 0;

    const accountsWithRMDs = this.simulationState.portfolio
      .getAccounts()
      .filter((account) => account.getHasRMDs() && age >= this.rmdStartAgeFor(account));
    for (const account of accountsWithRMDs) {
      if (!(account.getBalance() > 0)) continue;

      // IRS Uniform Lifetime Table (Treas. Reg. §1.401(a)(9)-9)
      const lookupAge = Math.min(Math.floor(age), 120);
      const rmdAmount = account.getBalance() / uniformLifetimeMap[lookupAge];

      const withdrawalAllocation = this.getAllocationForWithdrawal(rmdAmount);
      const {
        realizedGains: realizedGainsFromThisAccount,
        earningsWithdrawn: earningsWithdrawnFromThisAccount,
        ...withdrawnAssets
      } = account.applyWithdrawal(rmdAmount, 'rmd', withdrawalAllocation);

      realizedGainsByAccount[account.getAccountID()] = realizedGainsFromThisAccount;
      realizedGains += realizedGainsFromThisAccount;

      earningsWithdrawnByAccount[account.getAccountID()] = earningsWithdrawnFromThisAccount;
      earningsWithdrawn += earningsWithdrawnFromThisAccount;

      withdrawalsByAccount[account.getAccountID()] = { ...withdrawnAssets };
      rmdsByAccount[account.getAccountID()] = rmdAmount;
      total += rmdAmount;
    }

    const withdrawals = Object.values(withdrawalsByAccount).reduce((acc, curr) => addFlows(acc, curr), zeroFlows());

    const portfolioHasRmdSavingsAccount = this.simulationState.portfolio
      .getAccounts()
      .some((account) => account.getAccountID() === this.rmdSavingsAccount.getAccountID());
    if (!portfolioHasRmdSavingsAccount && total > 0) {
      this.simulationState.portfolio.addRmdSavingsAccount(this.rmdSavingsAccount);
    }

    const contributionsByAccount: Record<string, AssetFlows> = {};

    const contributionAllocation = this.getAllocationForContribution(total);
    const contributedAssets = this.rmdSavingsAccount.applyContribution(total, 'self', contributionAllocation);
    contributionsByAccount[this.rmdSavingsAccount.getAccountID()] = { ...contributedAssets };

    const perAccountData: Record<string, AccountDataWithFlows> = this.buildPerAccountData(
      {},
      contributionsByAccount,
      {},
      withdrawalsByAccount,
      realizedGainsByAccount,
      earningsWithdrawnByAccount,
      rmdsByAccount
    );

    const portfolioData = this.buildPortfolioData(
      {
        withdrawals,
        employerMatch: 0,
        contributions: { ...contributedAssets },
        realizedGains,
        earningsWithdrawn,
        rmds: total,
        shortfall: 0,
        shortfallRepaid: 0,
      },
      perAccountData
    );

    this.monthlyData.push(portfolioData);
    return portfolioData;
  }

  /**
   * Processes Roth conversions for the current year.
   *
   * Moves funds from tax-deferred accounts to Roth accounts without early withdrawal penalties.
   */
  processConversions(conversions: ConversionInputs[], currentDate?: ISODateString): PortfolioData {
    let total = 0;
    const conversionsByAccount: Record<string, number> = {};

    for (const conversion of conversions) {
      const fromAccount = this.simulationState.portfolio.getAccountById(conversion.fromAccountId);
      if (!fromAccount) throw new Error(`Conversion ${conversion.id}: source account ${conversion.fromAccountId} not found`);

      const toAccount = this.simulationState.portfolio.getAccountById(conversion.toAccountId);
      if (!toAccount) throw new Error(`Conversion ${conversion.id}: destination account ${conversion.toAccountId} not found`);

      const amountToConvert = 'amount' in conversion ? Math.min(conversion.amount, fromAccount.getBalance()) : 0;
      if (amountToConvert <= 0) continue;

      fromAccount.applyConversionOut(amountToConvert);
      toAccount.applyConversionIn(amountToConvert, currentDate);

      conversionsByAccount[conversion.fromAccountId] = (conversionsByAccount[conversion.fromAccountId] ?? 0) + amountToConvert;
      total += amountToConvert;
    }

    const perAccountData = Object.fromEntries(
      this.simulationState.portfolio.getAccounts().map((account) => {
        const accountID = account.getAccountID();
        const accountData = account.getAccountData();

        return [
          accountID,
          {
            ...accountData,
            contributions: zeroFlows(),
            employerMatch: 0,
            withdrawals: zeroFlows(),
            realizedGains: 0,
            earningsWithdrawn: 0,
            rmds: 0,
            ...(conversionsByAccount[accountID] && conversionsByAccount[accountID] > 0
              ? { conversions: conversionsByAccount[accountID] }
              : {}),
          },
        ];
      })
    );

    const portfolioData = this.buildPortfolioData(
      {
        withdrawals: zeroFlows(),
        employerMatch: 0,
        contributions: zeroFlows(),
        realizedGains: 0,
        earningsWithdrawn: 0,
        rmds: 0,
        shortfall: 0,
        shortfallRepaid: 0,
        ...(total > 0 ? { conversions: total } : {}),
      },
      perAccountData
    );

    this.monthlyData.push(portfolioData);
    return portfolioData;
  }

  /**
   * Records a conversion directly in the current month's portfolio data.
   */
  recordConversion(fromAccountId: string, toAccountId: string, amount: number): void {
    if (amount <= 0) return;
    const lastMonth = this.monthlyData[this.monthlyData.length - 1];
    if (lastMonth) {
      lastMonth.conversions = (lastMonth.conversions ?? 0) + amount;
      if (lastMonth.perAccountData[fromAccountId]) {
        lastMonth.perAccountData[fromAccountId].conversions = (lastMonth.perAccountData[fromAccountId].conversions ?? 0) + amount;
      }
      if (lastMonth.perAccountData[toAccountId]) {
        lastMonth.perAccountData[toAccountId].conversions = (lastMonth.perAccountData[toAccountId].conversions ?? 0) + amount;
      }
    }
  }

  /**
   * Processes Substantially Equal Periodic Payments (SEPP) under IRC §72(t)(2)(A)(iv).
   *
   * In month 1 of each year, calculates safe-harbor distributions, executes withdrawals,
   * deposits proceeds into savings, and assesses §72(t)(4) recapture penalty if stopped early.
   */
  processSeppDistributions(
    schedules: SeppScheduleInputs[],
    currentYear: number,
    planBirth: { year: number; month: number }
  ): PortfolioData | undefined {
    let totalSepp = 0;
    let totalRecapture = 0;
    const withdrawalsByAccount: Record<string, AssetFlows> = {};
    const seppByAccount: Record<string, number> = {};
    const realizedGainsByAccount: Record<string, number> = {};
    const earningsWithdrawnByAccount: Record<string, number> = {};

    for (const schedule of schedules) {
      if (schedule.disabled) continue;

      // Check if the schedule has stopped
      if (schedule.stopYear !== undefined && currentYear >= schedule.stopYear) {
        if (!this.seppRecaptureTriggered.has(schedule.id)) {
          this.seppRecaptureTriggered.add(schedule.id);
          const startDate = formatISODate({ year: schedule.startYear, month: 1, day: 1 });
          const birthDate = this.seppOwnerBirthDate(schedule.accountId, planBirth);
          const mustContinueUntil = seppMustContinueUntil({ startDate, birthDate });
          const stopDate = formatISODate({ year: schedule.stopYear, month: 1, day: 1 });
          if (stopDate < mustContinueUntil) {
            // Stopped prematurely before 5 years or age 59½: recapture 10% penalty on all prior distributions
            const priorDistributions = this.cumulativeSeppByScheduleId.get(schedule.id) ?? 0;
            totalRecapture += priorDistributions;
          }
        }
        continue;
      }

      // Not started yet
      if (currentYear < schedule.startYear) continue;

      const account = this.simulationState.portfolio.getAccountById(schedule.accountId);
      if (!account || !(account.getBalance() > 0)) continue;

      let annualAmount: number;
      if (schedule.annualAmount !== undefined) {
        annualAmount = schedule.annualAmount;
      } else if (schedule.method === 'rmd') {
        const period = singleLifeExpectancy(Math.floor(this.ageForAccount(account)));
        annualAmount = seppAnnualAmount({
          method: 'rmd',
          balance: account.getBalance(),
          rate: schedule.rate ?? 0,
          distributionPeriod: period,
        });
      } else {
        // fixedAmortization or fixedAnnuitization: computed once in year 1 and kept fixed
        if (this.fixedSeppPaymentByScheduleId.has(schedule.id)) {
          annualAmount = this.fixedSeppPaymentByScheduleId.get(schedule.id)!;
        } else {
          const firstMonth = `${schedule.startYear}-01` as SeppRateMonth;
          const tableResult = seppAnnualAmountFromTables({
            method: schedule.method,
            balance: account.getBalance(),
            age: Math.floor(this.ageForAccount(account)),
            firstDistributionMonth: firstMonth,
            rate: schedule.rate,
          });
          annualAmount = tableResult.annualAmount;
          this.fixedSeppPaymentByScheduleId.set(schedule.id, annualAmount);
        }
      }

      const withdrawAmount = Math.min(account.getBalance(), annualAmount);
      if (withdrawAmount > 0) {
        const withdrawalAllocation = this.getAllocationForWithdrawal(withdrawAmount);
        const {
          realizedGains: realizedGainsFromThisAccount,
          earningsWithdrawn: earningsWithdrawnFromThisAccount,
          ...withdrawnAssets
        } = account.applyWithdrawal(withdrawAmount, 'regular', withdrawalAllocation);

        realizedGainsByAccount[account.getAccountID()] = realizedGainsFromThisAccount;
        earningsWithdrawnByAccount[account.getAccountID()] = earningsWithdrawnFromThisAccount;
        withdrawalsByAccount[account.getAccountID()] = { ...withdrawnAssets };
        seppByAccount[account.getAccountID()] = withdrawAmount;
        totalSepp += withdrawAmount;

        const prior = this.cumulativeSeppByScheduleId.get(schedule.id) ?? 0;
        this.cumulativeSeppByScheduleId.set(schedule.id, prior + withdrawAmount);
      }
    }

    if (totalSepp === 0 && totalRecapture === 0) return undefined;

    const withdrawals = Object.values(withdrawalsByAccount).reduce((acc, curr) => addFlows(acc, curr), zeroFlows());

    const portfolioHasRmdSavingsAccount = this.simulationState.portfolio
      .getAccounts()
      .some((acc) => acc.getAccountID() === this.rmdSavingsAccount.getAccountID());
    if (!portfolioHasRmdSavingsAccount && totalSepp > 0) {
      this.simulationState.portfolio.addRmdSavingsAccount(this.rmdSavingsAccount);
    }

    const contributionsByAccount: Record<string, AssetFlows> = {};
    let contributedAssets: AssetFlows = zeroFlows();
    if (totalSepp > 0) {
      const contributionAllocation = this.getAllocationForContribution(totalSepp);
      contributedAssets = this.rmdSavingsAccount.applyContribution(totalSepp, 'self', contributionAllocation);
      contributionsByAccount[this.rmdSavingsAccount.getAccountID()] = { ...contributedAssets };
    }

    const perAccountData = this.buildPerAccountData(
      {},
      contributionsByAccount,
      {},
      withdrawalsByAccount,
      realizedGainsByAccount,
      earningsWithdrawnByAccount,
      {},
      {},
      seppByAccount
    );

    const portfolioData = this.buildPortfolioData(
      {
        withdrawals,
        employerMatch: 0,
        contributions: { ...contributedAssets },
        realizedGains: Object.values(realizedGainsByAccount).reduce((a, b) => a + b, 0),
        earningsWithdrawn: Object.values(earningsWithdrawnByAccount).reduce((a, b) => a + b, 0),
        rmds: 0,
        shortfall: 0,
        shortfallRepaid: 0,
        ...(totalSepp > 0 ? { sepp: totalSepp } : {}),
        ...(totalRecapture > 0 ? { seppRecapture: totalRecapture } : {}),
      },
      perAccountData
    );

    this.monthlyData.push(portfolioData);
    return portfolioData;
  }

  private buildPerAccountData(
    baseAccountData: Record<string, AccountDataWithFlows>,
    contributionsByAccount: Record<string, AssetFlows>,
    employerMatchByAccount: Record<string, number>,
    withdrawalsByAccount: Record<string, AssetFlows>,
    realizedGainsByAccount: Record<string, number>,
    earningsWithdrawnByAccount: Record<string, number>,
    rmdsByAccount: Record<string, number>,
    unseasonedConversionsByAccount: Record<string, number> = {},
    seppByAccount: Record<string, number> = {}
  ): Record<string, AccountDataWithFlows> {
    const addToBaseNumber = (accountID: string, field: keyof AccountDataWithFlows, value: number) => {
      return ((baseAccountData[accountID]?.[field] as number) ?? 0) + value;
    };

    const addToBaseFlows = (accountID: string, field: keyof AccountDataWithFlows, value: AssetFlows) => {
      const base = (baseAccountData[accountID]?.[field] as AssetFlows) ?? zeroFlows();
      return addFlows(base, value);
    };

    return Object.fromEntries(
      this.simulationState.portfolio.getAccounts().map((account) => {
        const accountID = account.getAccountID();
        const accountData = account.getAccountData();
        const totalUnseasoned = addToBaseNumber(
          accountID,
          'unseasonedConversionsWithdrawn',
          unseasonedConversionsByAccount[accountID] ?? 0
        );
        const totalSepp = addToBaseNumber(accountID, 'sepp', seppByAccount[accountID] ?? 0);

        return [
          accountID,
          {
            ...accountData,
            contributions: addToBaseFlows(accountID, 'contributions', contributionsByAccount[accountID] ?? zeroFlows()),
            employerMatch: addToBaseNumber(accountID, 'employerMatch', employerMatchByAccount[accountID] ?? 0),
            withdrawals: addToBaseFlows(accountID, 'withdrawals', withdrawalsByAccount[accountID] ?? zeroFlows()),
            realizedGains: addToBaseNumber(accountID, 'realizedGains', realizedGainsByAccount[accountID] ?? 0),
            earningsWithdrawn: addToBaseNumber(accountID, 'earningsWithdrawn', earningsWithdrawnByAccount[accountID] ?? 0),
            rmds: addToBaseNumber(accountID, 'rmds', rmdsByAccount[accountID] ?? 0),
            ...((baseAccountData[accountID]?.conversions as number) > 0 ? { conversions: baseAccountData[accountID]?.conversions } : {}),
            ...(totalUnseasoned > 0 ? { unseasonedConversionsWithdrawn: totalUnseasoned } : {}),
            ...(totalSepp > 0 ? { sepp: totalSepp } : {}),
          },
        ];
      })
    );
  }

  private buildPortfolioData(
    forPeriodData: {
      withdrawals: AssetFlows;
      contributions: AssetFlows;
      employerMatch: number;
      realizedGains: number;
      earningsWithdrawn: number;
      rmds: number;
      shortfall: number;
      shortfallRepaid: number;
      conversions?: number;
      unseasonedConversionsWithdrawn?: number;
      sepp?: number;
      seppRecapture?: number;
    },
    perAccountData: Record<string, AccountDataWithFlows>
  ): PortfolioData {
    return {
      totalValue: this.simulationState.portfolio.getTotalValue(),
      cumulativeWithdrawals: this.simulationState.portfolio.getCumulativeWithdrawals(),
      cumulativeContributions: this.simulationState.portfolio.getCumulativeContributions(),
      cumulativeEmployerMatch: this.simulationState.portfolio.getCumulativeEmployerMatch(),
      cumulativeRealizedGains: this.simulationState.portfolio.getCumulativeRealizedGains(),
      cumulativeEarningsWithdrawn: this.simulationState.portfolio.getCumulativeEarningsWithdrawn(),
      cumulativeRmds: this.simulationState.portfolio.getCumulativeRmds(),
      outstandingShortfall: this.outstandingShortfall,
      ...forPeriodData,
      ...(forPeriodData.conversions && forPeriodData.conversions > 0 ? { conversions: forPeriodData.conversions } : {}),
      ...(forPeriodData.sepp && forPeriodData.sepp > 0 ? { sepp: forPeriodData.sepp } : {}),
      ...(forPeriodData.seppRecapture && forPeriodData.seppRecapture > 0 ? { seppRecapture: forPeriodData.seppRecapture } : {}),
      perAccountData,
      assetAllocation: this.simulationState.portfolio.getWeightedAssetAllocation(),
    };
  }

  /**
   * The floor a strategy's cap may not go below: what this month's essential spending needs from the
   * portfolio (P1-P4).
   *
   * Only the part of essential spending this month's cash flow does not already cover needs a
   * withdrawal, so the floor is the smaller of the month's deficit and the essential total. It can
   * never exceed the deficit — the plan does not spend on essential items it is not paying for —
   * which is what keeps a cap's shortfall arithmetic honest.
   */
  private essentialWithdrawalFloor(netCashFlow: number, essentialSpending: number): number {
    if (!(essentialSpending > 0)) return 0;

    return Math.min(Math.max(0, -netCashFlow), essentialSpending);
  }

  /**
   * What the injected strategy still allows the current simulation year to withdraw for spending.
   *
   * `undefined` for a strategy that declares no cap — which is the `ordered` default — so the
   * default path does no bookkeeping at all and cannot drift from the pre-strategy behaviour.
   *
   * The cap is computed once per simulation year, from the portfolio's value at that moment, with
   * the previous year's spending withdrawals as the history Guyton-Klinger reads. It is clamped to
   * what the portfolio actually holds, so no strategy can propose withdrawing more than exists.
   *
   * @param essentialFloor - The month's essential spending that needs funding (see
   *   `essentialWithdrawalFloor`). Spending marked essential is never cut by the cap, so the
   *   month's allowance is the larger of what is left of the year's budget and this floor.
   */
  private currentYearWithdrawalAllowance(essentialFloor = 0): number | undefined {
    if (this.withdrawalStrategy.getAnnualCap === undefined) return undefined;

    const yearIndex = Math.ceil(this.simulationState.time.month / 12);
    if (yearIndex !== this.allowanceYearIndex) {
      this.allowanceYearIndex = yearIndex;
      this.previousAnnualWithdrawal = this.annualWithdrawnTotal > 0 ? this.annualWithdrawnTotal : undefined;
      this.annualWithdrawnTotal = 0;

      const portfolioValue = this.simulationState.portfolio.getTotalValue();
      const cap = this.withdrawalStrategy.getAnnualCap({
        age: this.simulationState.time.age,
        endAge: this.simulationContext.endAge,
        portfolioValue,
        previousWithdrawal: this.previousAnnualWithdrawal,
      });

      this.remainingAllowance = cap === undefined ? undefined : Math.max(0, Math.min(cap, portfolioValue));
    }

    if (this.remainingAllowance === undefined) return undefined;

    return Math.max(this.remainingAllowance, essentialFloor);
  }

  /**
   * The withdrawal order from the injected strategy, read at one age.
   *
   * The default (`ordered`) strategy returns exactly the age-based sequence this method used to
   * hardcode — before 59.5: savings -> taxable -> Roth contributions -> tax-deferred -> Roth
   * earnings -> HSA; after: savings -> tax-deferred -> taxable -> Roth -> HSA — so the default run
   * is unchanged. A capping strategy still withdraws *from* the same places, only less per year.
   */
  private getWithdrawalOrder(age: number): readonly WithdrawalOrderItem[] {
    return this.withdrawalStrategy.getOrder({
      age,
      endAge: this.simulationContext.endAge,
      portfolioValue: this.simulationState.portfolio.getTotalValue(),
    });
  }

  /**
   * The (sequence step, account) pairs a month's regular withdrawal walks, in order.
   *
   * The sequence is the strategy's, asked at *that account's own owner's* age (P1-P3): one sequence
   * per household cannot describe a couple where one member has reached 59.5 and the other has not,
   * and walking the primary's sequence would drain a younger owner's tax-deferred account ahead of
   * their taxable one — the very penalty the tax layer now charges them at their own age. So each
   * account takes the step index its type has for its owner's age, and the steps run in ascending
   * index order.
   *
   * `sort` is stable, so two accounts at the same index keep portfolio order, and a household where
   * every account resolves to one age (a single member, or a couple born on the same date) walks
   * exactly the sequence the strategy named — the pre-household behaviour, step for step.
   */
  private withdrawalStepsForMonth(): Array<{ item: WithdrawalOrderItem; account: Account }> {
    const orderByAge = new Map<number, readonly WithdrawalOrderItem[]>();
    const steps: Array<{ rank: number; item: WithdrawalOrderItem; account: Account }> = [];

    for (const account of this.simulationState.portfolio.getAccounts()) {
      const age = this.ageForAccount(account);
      let order = orderByAge.get(age);

      if (order === undefined) {
        order = this.getWithdrawalOrder(age);
        orderByAge.set(age, order);
      }

      order.forEach((item, rank) => {
        if (item.accountType === account.getAccountType()) steps.push({ rank, item, account });
      });
    }

    steps.sort((left, right) => left.rank - right.rank);

    return steps.map(({ item, account }) => ({ item, account }));
  }

  resetMonthlyData(): void {
    this.monthlyData = [];
    this.contributionRules.resetYTD();
  }

  getAnnualData(): PortfolioData {
    const lastMonthData = this.monthlyData[this.monthlyData.length - 1];

    const result = {
      ...lastMonthData,
      ...this.monthlyData.reduce<PortfolioFlowData>(
        (acc, curr) => {
          acc.contributions = addFlows(acc.contributions, curr.contributions);
          acc.employerMatch += curr.employerMatch;
          acc.withdrawals = addFlows(acc.withdrawals, curr.withdrawals);
          acc.realizedGains += curr.realizedGains;
          acc.earningsWithdrawn += curr.earningsWithdrawn;
          acc.rmds += curr.rmds;
          acc.shortfall += curr.shortfall;
          acc.shortfallRepaid += curr.shortfallRepaid;
          if (curr.conversions && curr.conversions > 0) {
            acc.conversions = (acc.conversions ?? 0) + curr.conversions;
          }
          if (curr.unseasonedConversionsWithdrawn && curr.unseasonedConversionsWithdrawn > 0) {
            acc.unseasonedConversionsWithdrawn = (acc.unseasonedConversionsWithdrawn ?? 0) + curr.unseasonedConversionsWithdrawn;
          }
          if (curr.sepp && curr.sepp > 0) {
            acc.sepp = (acc.sepp ?? 0) + curr.sepp;
          }
          if (curr.seppRecapture && curr.seppRecapture > 0) {
            acc.seppRecapture = (acc.seppRecapture ?? 0) + curr.seppRecapture;
          }

          for (const [accountID, accountData] of Object.entries(curr.perAccountData)) {
            const existing = acc.perAccountData[accountID];
            const totalAccountConversions = (existing?.conversions ?? 0) + (accountData.conversions ?? 0);
            const totalAccountUnseasoned =
              (existing?.unseasonedConversionsWithdrawn ?? 0) + (accountData.unseasonedConversionsWithdrawn ?? 0);
            const totalAccountSepp = (existing?.sepp ?? 0) + (accountData.sepp ?? 0);
            acc.perAccountData[accountID] = {
              ...accountData,
              contributions: addFlows(existing?.contributions ?? zeroFlows(), accountData.contributions),
              employerMatch: (existing?.employerMatch ?? 0) + accountData.employerMatch,
              withdrawals: addFlows(existing?.withdrawals ?? zeroFlows(), accountData.withdrawals),
              realizedGains: (existing?.realizedGains ?? 0) + accountData.realizedGains,
              earningsWithdrawn: (existing?.earningsWithdrawn ?? 0) + accountData.earningsWithdrawn,
              rmds: (existing?.rmds ?? 0) + accountData.rmds,
              ...(totalAccountConversions > 0 ? { conversions: totalAccountConversions } : {}),
              ...(totalAccountUnseasoned > 0 ? { unseasonedConversionsWithdrawn: totalAccountUnseasoned } : {}),
              ...(totalAccountSepp > 0 ? { sepp: totalAccountSepp } : {}),
            };
          }

          return acc;
        },
        {
          contributions: zeroFlows(),
          employerMatch: 0,
          withdrawals: zeroFlows(),
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
          shortfall: 0,
          shortfallRepaid: 0,
          perAccountData: {} as Record<string, AccountDataWithFlows>,
        } satisfies PortfolioFlowData
      ),
    };

    if (!result.conversions) {
      delete result.conversions;
    }
    if (!result.unseasonedConversionsWithdrawn) {
      delete result.unseasonedConversionsWithdrawn;
    }
    if (!result.sepp) {
      delete result.sepp;
    }
    if (!result.seppRecapture) {
      delete result.seppRecapture;
    }

    return result;
  }

  /** Rebalances portfolio toward glide path target allocation if enabled */
  private processRebalance(): {
    rebalanceOccurred: boolean;
    realizedGainsFromRebalance: number;
    realizedGainsByAccountFromRebalance: Record<string, number>;
  } {
    const realizedGainsByAccountFromRebalance: Record<string, number> = {};
    if (!this.glidePath?.enabled) return { rebalanceOccurred: false, realizedGainsFromRebalance: 0, realizedGainsByAccountFromRebalance };

    const totalValue = this.simulationState.portfolio.getTotalValue();
    if (totalValue <= 0) return { rebalanceOccurred: false, realizedGainsFromRebalance: 0, realizedGainsByAccountFromRebalance };

    const { stocks: currentStocksValue, bonds: currentBondsValue } = this.simulationState.portfolio.getCurrentAssetValues();
    const targetAllocation = this.getTargetAssetAllocation();

    const stocksExcess = currentStocksValue - totalValue * targetAllocation.stocks;
    const bondsExcess = currentBondsValue - totalValue * targetAllocation.bonds;

    const rebalanceOrder: Array<AccountInputs['type']> = [
      '401k',
      '403b',
      'ira',
      'hsa',
      'roth401k',
      'roth403b',
      'rothIra',
      'taxableBrokerage',
    ];

    let remainingStocksExcess = stocksExcess;
    let remainingBondsExcess = bondsExcess;
    let realizedGainsFromRebalance = 0;

    for (const accountType of rebalanceOrder) {
      if (Math.abs(remainingStocksExcess) < 1 && Math.abs(remainingBondsExcess) < 1) break;

      const accountsOfType = this.simulationState.portfolio.getAccounts().filter((account) => account.getAccountType() === accountType);
      if (accountsOfType.length === 0) continue;

      for (const account of accountsOfType) {
        if (Math.abs(remainingStocksExcess) < 1 && Math.abs(remainingBondsExcess) < 1) break;
        if (account.getBalance() <= 0) continue;
        if (!(account instanceof InvestmentAccount)) continue;

        const rebalance = account.applyRebalance(remainingStocksExcess, remainingBondsExcess);

        remainingStocksExcess -= rebalance.stocksSold;
        remainingBondsExcess -= rebalance.bondsSold;

        realizedGainsByAccountFromRebalance[account.getAccountID()] = rebalance.realizedGains;
        realizedGainsFromRebalance += rebalance.realizedGains;
      }
    }

    return { rebalanceOccurred: true, realizedGainsFromRebalance, realizedGainsByAccountFromRebalance };
  }

  /**
   * Calculates the current target asset allocation based on glide path progress
   *
   * Linearly interpolates between the initial allocation and the target allocation
   * based on time elapsed toward the glide path end point.
   */
  private getTargetAssetAllocation(): AssetAllocation {
    if (!this.initialAssetAllocation) console.warn('No initial asset allocation available; using default 60/40');

    const startAllocation = this.initialAssetAllocation ?? DEFAULT_ASSET_ALLOCATION;
    if (!this.glidePath?.enabled) return startAllocation;

    const targetAllocation: AssetAllocation = {
      stocks: 1 - this.glidePath.targetBondAllocation / 100,
      bonds: this.glidePath.targetBondAllocation / 100,
      cash: 0,
    };

    // Distance from the run's start to the glide path's end point, resolved by the shared
    // time binding (contract: one resolver for every dated event).
    const progress = timePointProgress(this.glidePath.endTimePoint, this.simulationState, this.simulationContext);

    return {
      stocks: startAllocation.stocks + (targetAllocation.stocks - startAllocation.stocks) * progress,
      bonds: startAllocation.bonds + (targetAllocation.bonds - startAllocation.bonds) * progress,
      cash: startAllocation.cash + (targetAllocation.cash - startAllocation.cash) * progress,
    };
  }

  private getAllocationForContribution(contributionAmount: number): AssetAllocation {
    const targetAllocation = this.getTargetAssetAllocation();
    const { stocks: currStocksValue, bonds: currBondsValue, cash: currCashValue } = this.simulationState.portfolio.getCurrentAssetValues();
    const currTotalValue = this.simulationState.portfolio.getTotalValue();
    const newTotalValue = currTotalValue + contributionAmount;

    const targetStocksValue = newTotalValue * targetAllocation.stocks;
    const targetBondsValue = newTotalValue * targetAllocation.bonds;
    const targetCashValue = newTotalValue * targetAllocation.cash;

    const stocksNeeded = Math.max(0, targetStocksValue - currStocksValue);
    const bondsNeeded = Math.max(0, targetBondsValue - currBondsValue);
    const cashNeeded = Math.max(0, targetCashValue - currCashValue);
    const totalNeeded = stocksNeeded + bondsNeeded + cashNeeded;

    if (totalNeeded <= 0) return targetAllocation;

    return {
      stocks: stocksNeeded / totalNeeded,
      bonds: bondsNeeded / totalNeeded,
      cash: cashNeeded / totalNeeded,
    };
  }

  private getAllocationForWithdrawal(withdrawalAmount: number): AssetAllocation {
    const targetAllocation = this.getTargetAssetAllocation();
    const { stocks: currStocksValue, bonds: currBondsValue, cash: currCashValue } = this.simulationState.portfolio.getCurrentAssetValues();
    const currTotalValue = this.simulationState.portfolio.getTotalValue();
    const newTotalValue = Math.max(0, currTotalValue - withdrawalAmount);

    const targetStocksValue = newTotalValue * targetAllocation.stocks;
    const targetBondsValue = newTotalValue * targetAllocation.bonds;
    const targetCashValue = newTotalValue * targetAllocation.cash;

    const stocksExcess = Math.max(0, currStocksValue - targetStocksValue);
    const bondsExcess = Math.max(0, currBondsValue - targetBondsValue);
    const cashExcess = Math.max(0, currCashValue - targetCashValue);
    const totalExcess = stocksExcess + bondsExcess + cashExcess;

    if (totalExcess <= 0) return targetAllocation;

    return {
      stocks: stocksExcess / totalExcess,
      bonds: bondsExcess / totalExcess,
      cash: cashExcess / totalExcess,
    };
  }
}

/** Point-in-time snapshot fields — taken from last month's data, not summed */
interface PortfolioSnapshotData {
  totalValue: number;
  cumulativeWithdrawals: AssetFlows;
  cumulativeContributions: AssetFlows;
  cumulativeEmployerMatch: number;
  cumulativeRealizedGains: number;
  cumulativeEarningsWithdrawn: number;
  cumulativeRmds: number;
  outstandingShortfall: number;
  assetAllocation: AssetAllocation | null;
}

/** Flow fields — summed across months in getAnnualData */
interface PortfolioFlowData {
  withdrawals: AssetFlows;
  contributions: AssetFlows;
  employerMatch: number;
  realizedGains: number;
  earningsWithdrawn: number;
  rmds: number;
  shortfall: number;
  shortfallRepaid: number;
  conversions?: number;
  unseasonedConversionsWithdrawn?: number;
  sepp?: number;
  seppRecapture?: number;
  perAccountData: Record<string, AccountDataWithFlows>;
}

export type PortfolioData = PortfolioSnapshotData & PortfolioFlowData;

/** Container for all investment accounts with aggregate operations */
export class Portfolio {
  private accounts: Account[];

  constructor(data: AccountInputs[]) {
    this.accounts = data.map((accountData) => {
      switch (accountData.type) {
        case 'savings':
          return new SavingsAccount(accountData);
        case 'taxableBrokerage':
          return new TaxableBrokerageAccount(accountData);
        case 'roth401k':
        case 'roth403b':
        case 'rothIra':
          return new TaxFreeAccount(accountData);
        case '401k':
        case '403b':
        case 'ira':
        case 'hsa':
          return new TaxDeferredAccount(accountData);
      }
    });
  }

  addExtraSavingsAccount(extraSavingsAccount: SavingsAccount): void {
    this.accounts.push(extraSavingsAccount);
  }

  addRmdSavingsAccount(rmdSavingsAccount: SavingsAccount): void {
    this.accounts.push(rmdSavingsAccount);
  }

  getWeightedAssetAllocation(): AssetAllocation | null {
    const totalValue = this.getTotalValue();
    if (totalValue === 0) return null;

    const weightedAllocation = this.accounts.reduce((acc, account) => {
      const weight = account.getBalance() / totalValue;

      return {
        stocks: acc.stocks + (account.getAccountData().assetAllocation.stocks ?? 0) * weight,
        bonds: acc.bonds + (account.getAccountData().assetAllocation.bonds ?? 0) * weight,
        cash: acc.cash + (account.getAccountData().assetAllocation.cash ?? 0) * weight,
      };
    }, zeroAssetAmounts<AssetAllocation>());

    return weightedAllocation;
  }

  getCurrentAssetValues(): AssetValues {
    return this.accounts.reduce(
      (acc, account) => ({
        stocks: acc.stocks + account.getBalance() * account.getAccountData().assetAllocation.stocks,
        bonds: acc.bonds + account.getBalance() * account.getAccountData().assetAllocation.bonds,
        cash: acc.cash + account.getBalance() * account.getAccountData().assetAllocation.cash,
      }),
      zeroAssetAmounts<AssetValues>()
    );
  }

  getAccounts(): Account[] {
    return this.accounts;
  }

  /**
   * One account's balance by id, or `0` when no account has that id.
   *
   * `0` rather than a throw, because the only caller is the mortgage offset lookup
   * (`paymentMethod.offsetAccountId`): an id that no longer names an account — a deleted account, a
   * plan imported from elsewhere — must behave like "no offset", not break the simulation.
   */
  getAccountBalance(accountId: string): number {
    return this.accounts.find((account) => account.getAccountID() === accountId)?.getBalance() ?? 0;
  }

  getTotalValue(): number {
    return this.accounts.reduce((acc, account) => acc + account.getBalance(), 0);
  }

  getCumulativeWithdrawals(): AssetFlows {
    return this.accounts.reduce((acc, account) => addFlows(acc, account.getCumulativeWithdrawals()), zeroFlows());
  }

  getCumulativeContributions(): AssetFlows {
    return this.accounts.reduce((acc, account) => addFlows(acc, account.getCumulativeContributions()), zeroFlows());
  }

  getCumulativeEmployerMatch(): number {
    return this.accounts.reduce((acc, account) => acc + account.getCumulativeEmployerMatch(), 0);
  }

  getCumulativeRealizedGains(): number {
    return this.accounts.reduce((acc, account) => acc + account.getCumulativeRealizedGains(), 0);
  }

  getCumulativeEarningsWithdrawn(): number {
    return this.accounts.reduce((acc, account) => acc + account.getCumulativeEarningsWithdrawn(), 0);
  }

  getCumulativeRmds(): number {
    return this.accounts.reduce((acc, account) => acc + account.getCumulativeRmds(), 0);
  }

  getCumulativeReturnAmounts(): AssetReturnAmounts {
    return this.accounts.reduce(
      (acc, curr) => addAssetAmounts(acc, curr.getCumulativeReturnAmounts()),
      zeroAssetAmounts<AssetReturnAmounts>()
    );
  }

  getAccountById(accountID: string): Account | undefined {
    return this.accounts.find((account) => account.getAccountID() === accountID);
  }

  /**
   * Applies return rates to all accounts and aggregates results
   * @param returnRates - Monthly return rates by asset class
   * @returns Total and per-account return amounts
   */
  applyReturns(returnRates: AssetReturnRates): {
    returnAmounts: AssetReturnAmounts;
    cumulativeReturnAmounts: AssetReturnAmounts;
    byAccount: Record<string, AccountDataWithReturns>;
  } {
    let returnAmounts = zeroAssetAmounts<AssetReturnAmounts>();
    let cumulativeReturnAmounts = zeroAssetAmounts<AssetReturnAmounts>();

    const byAccount: Record<string, AccountDataWithReturns> = {};

    this.accounts.forEach((account) => {
      const { returnAmounts: returnAmountsFromThisAccount, cumulativeReturnAmounts: cumulativeReturnAmountsFromThisAccount } =
        account.applyReturns(returnRates);

      returnAmounts = addAssetAmounts(returnAmounts, returnAmountsFromThisAccount);
      cumulativeReturnAmounts = addAssetAmounts(cumulativeReturnAmounts, cumulativeReturnAmountsFromThisAccount);

      byAccount[account.getAccountID()] = {
        name: account.getAccountName(),
        id: account.getAccountID(),
        type: account.getAccountType(),
        returnAmounts: returnAmountsFromThisAccount,
        cumulativeReturnAmounts: cumulativeReturnAmountsFromThisAccount,
      };
    });

    return { returnAmounts, cumulativeReturnAmounts, byAccount };
  }

  /**
   * Settles every taxable account's dividends and interest for the month, after returns: a
   * reinvesting account adds them to its basis, a paying-out account hands them over as cash.
   * @returns The month's investment income paid out as cash
   */
  settleInvestmentIncome(): number {
    let cash = 0;
    this.accounts.forEach((account) => {
      if (account instanceof TaxableBrokerageAccount) cash += account.settleInvestmentIncome();
    });
    return cash;
  }

  /**
   * Applies yield rates to all accounts and aggregates by tax category
   * @param yieldRates - Monthly yield rates by asset class
   * @returns Total and per-account yield amounts grouped by tax category
   */
  applyYields(yieldRates: AssetYieldRates): {
    yieldAmounts: Record<TaxCategory, AssetYieldAmounts>;
    cumulativeYieldAmounts: Record<TaxCategory, AssetYieldAmounts>;
  } {
    const yieldAmounts: Record<TaxCategory, AssetYieldAmounts> = {
      taxable: zeroAssetAmounts<AssetYieldAmounts>(),
      taxDeferred: zeroAssetAmounts<AssetYieldAmounts>(),
      taxFree: zeroAssetAmounts<AssetYieldAmounts>(),
      cashSavings: zeroAssetAmounts<AssetYieldAmounts>(),
    };
    const cumulativeYieldAmounts: Record<TaxCategory, AssetYieldAmounts> = {
      taxable: zeroAssetAmounts<AssetYieldAmounts>(),
      taxDeferred: zeroAssetAmounts<AssetYieldAmounts>(),
      taxFree: zeroAssetAmounts<AssetYieldAmounts>(),
      cashSavings: zeroAssetAmounts<AssetYieldAmounts>(),
    };

    this.accounts.forEach((account) => {
      const { yieldAmounts: yieldAmountsFromThisAccount, cumulativeYieldAmounts: cumulativeYieldAmountsFromThisAccount } =
        account.applyYields(yieldRates);

      const taxCategory = account.taxCategory;

      yieldAmounts[taxCategory] = addAssetAmounts(yieldAmounts[taxCategory], yieldAmountsFromThisAccount);
      cumulativeYieldAmounts[taxCategory] = addAssetAmounts(cumulativeYieldAmounts[taxCategory], cumulativeYieldAmountsFromThisAccount);
    });

    return { yieldAmounts, cumulativeYieldAmounts };
  }
}
