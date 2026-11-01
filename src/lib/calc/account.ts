/**
 * Investment account types and transaction logic
 *
 * Implements savings, taxable brokerage, tax-deferred (401k/IRA/HSA), and
 * tax-free (Roth) accounts with distinct deposit/withdrawal/return behaviors.
 * Tracks cost basis for taxable and contribution basis for Roth accounts.
 */

import type { AccountInputs, InvestmentAccountType } from '@/lib/schemas/inputs/account-form-schema';
import type { ISODateString } from './clock';
import { conversionSeasonsOn, type RothEvent } from './retirement-rules/roth-five-year';

import {
  type AssetReturnRates,
  type AssetReturnAmounts,
  type AssetAllocation,
  type AssetYieldRates,
  type AssetYieldAmounts,
  type TaxCategory,
  type AssetFlows,
  zeroAssetAmounts,
} from './asset';

type WithdrawalType = 'rmd' | 'regular';
type ContributionType = 'self' | 'employer';

/**
 * The tax category an account type is reported under.
 *
 * The classes below each declare their own `taxCategory`, which is the authority for the engine's
 * own aggregation. This map exists for the one place that has an account *type* and no instance: the
 * returns data, which carries a per-account `type` but not a category. It is derived from the same
 * four classes rather than from a second opinion, and it must move with them.
 */
export const taxCategoryForAccountType = (type: AccountInputs['type']): TaxCategory => {
  switch (type) {
    case 'savings':
      return 'cashSavings';
    case 'taxableBrokerage':
      return 'taxable';
    case 'roth401k':
    case 'roth403b':
    case 'rothIra':
      return 'taxFree';
    case '401k':
    case '403b':
    case 'ira':
    case 'hsa':
      return 'taxDeferred';
  }
};

/** Snapshot of account state including cumulative flow totals */
export interface AccountData {
  balance: number;
  cumulativeContributions: AssetFlows;
  cumulativeEmployerMatch: number;
  cumulativeWithdrawals: AssetFlows;
  cumulativeRealizedGains: number;
  cumulativeEarningsWithdrawn: number;
  cumulativeRmds: number;
  cumulativeConversions?: number;
  name: string;
  id: string;
  type: AccountInputs['type'];
  assetAllocation: AssetAllocation;
}

/** Account snapshot with current-period flow data */
export interface AccountDataWithFlows extends AccountData {
  contributions: AssetFlows;
  employerMatch: number;
  withdrawals: AssetFlows;
  realizedGains: number;
  earningsWithdrawn: number;
  rmds: number;
  conversions?: number;
  unseasonedConversionsWithdrawn?: number;
  sepp?: number;
}

/** Base class for all account types with shared cumulative tracking */
export abstract class Account {
  abstract readonly taxCategory: TaxCategory;

  constructor(
    protected balance: number,
    protected name: string,
    protected id: string,
    protected type: AccountInputs['type'],
    protected cumulativeReturnAmounts: AssetReturnAmounts,
    protected cumulativeContributions: AssetFlows,
    protected cumulativeEmployerMatch: number,
    protected cumulativeWithdrawals: AssetFlows,
    protected cumulativeRealizedGains: number,
    protected cumulativeEarningsWithdrawn: number,
    protected cumulativeRmds: number,
    protected cumulativeYieldAmounts: AssetYieldAmounts
  ) {}

  getBalance(): number {
    return this.balance;
  }

  getAccountName(): string {
    return this.name;
  }

  getAccountID(): string {
    return this.id;
  }

  getAccountType(): AccountInputs['type'] {
    return this.type;
  }

  getCumulativeReturnAmounts(): AssetReturnAmounts {
    return this.cumulativeReturnAmounts;
  }

  getCumulativeContributions(): AssetFlows {
    return this.cumulativeContributions;
  }

  getCumulativeEmployerMatch(): number {
    return this.cumulativeEmployerMatch;
  }

  getCumulativeWithdrawals(): AssetFlows {
    return this.cumulativeWithdrawals;
  }

  getCumulativeRealizedGains(): number {
    return this.cumulativeRealizedGains;
  }

  getCumulativeEarningsWithdrawn(): number {
    return this.cumulativeEarningsWithdrawn;
  }

  getCumulativeRmds(): number {
    return this.cumulativeRmds;
  }

  getCumulativeYieldAmounts(): AssetYieldAmounts {
    return this.cumulativeYieldAmounts;
  }

  protected cumulativeConversions = 0;

  getCumulativeConversions(): number {
    return this.cumulativeConversions;
  }

  abstract getHasRMDs(): boolean;
  abstract getAccountData(): AccountData;
  abstract applyReturns(returnRates: AssetReturnRates): { returnAmounts: AssetReturnAmounts; cumulativeReturnAmounts: AssetReturnAmounts };
  abstract applyYields(yieldRates: AssetYieldRates): { yieldAmounts: AssetYieldAmounts; cumulativeYieldAmounts: AssetYieldAmounts };
  abstract applyContribution(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows;
  abstract applyWithdrawal(
    amount: number,
    type: WithdrawalType,
    withdrawalAllocation: AssetAllocation,
    context?: { date?: ISODateString; age?: number }
  ): AssetFlows & { realizedGains: number; earningsWithdrawn: number; unseasonedConversionsWithdrawn?: number };
  abstract applyConversionOut(amount: number): AssetFlows;
  abstract applyConversionIn(amount: number, date?: ISODateString): AssetFlows;
}

/** Cash-only account with no investment returns, no RMDs, no realized gains */
export class SavingsAccount extends Account {
  readonly taxCategory: TaxCategory = 'cashSavings';

  constructor(data: AccountInputs) {
    const cumulativeReturnAmounts: AssetReturnAmounts = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeContributions: AssetFlows = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeWithdrawals: AssetFlows = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeYieldAmounts: AssetYieldAmounts = { cash: 0, bonds: 0, stocks: 0 };

    super(
      data.balance,
      data.name,
      data.id,
      data.type,
      cumulativeReturnAmounts,
      cumulativeContributions,
      0,
      cumulativeWithdrawals,
      0,
      0,
      0,
      cumulativeYieldAmounts
    );
  }

  getHasRMDs(): boolean {
    return false;
  }

  getAccountData(): AccountData {
    const assetAllocation: AssetAllocation = { cash: 1, bonds: 0, stocks: 0 };

    return {
      balance: this.balance,
      cumulativeWithdrawals: { ...this.cumulativeWithdrawals },
      cumulativeContributions: { ...this.cumulativeContributions },
      cumulativeEmployerMatch: this.cumulativeEmployerMatch,
      cumulativeRealizedGains: this.cumulativeRealizedGains,
      cumulativeEarningsWithdrawn: this.cumulativeEarningsWithdrawn,
      cumulativeRmds: this.cumulativeRmds,
      ...(this.cumulativeConversions > 0 ? { cumulativeConversions: this.cumulativeConversions } : {}),
      name: this.name,
      id: this.id,
      type: this.type,
      assetAllocation,
    };
  }

  applyReturns(returnRates: AssetReturnRates): { returnAmounts: AssetReturnAmounts; cumulativeReturnAmounts: AssetReturnAmounts } {
    const cashReturnsAmount = this.balance * returnRates.cash;

    this.balance += cashReturnsAmount;
    this.cumulativeReturnAmounts.cash += cashReturnsAmount;

    return {
      returnAmounts: { cash: cashReturnsAmount, bonds: 0, stocks: 0 },
      cumulativeReturnAmounts: { ...this.cumulativeReturnAmounts },
    };
  }

  applyYields(yieldRates: AssetYieldRates): { yieldAmounts: AssetYieldAmounts; cumulativeYieldAmounts: AssetYieldAmounts } {
    const cashYieldAmount = this.balance * yieldRates.cash;
    this.cumulativeYieldAmounts.cash += cashYieldAmount;

    return {
      yieldAmounts: { cash: cashYieldAmount, bonds: 0, stocks: 0 },
      cumulativeYieldAmounts: { ...this.cumulativeYieldAmounts },
    };
  }

  applyContribution(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows {
    this.balance += amount;
    this.cumulativeContributions.cash += amount;
    if (type === 'employer') this.cumulativeEmployerMatch += amount;

    return { stocks: 0, bonds: 0, cash: amount };
  }

  applyWithdrawal(
    amount: number,
    type: WithdrawalType,
    withdrawalAllocation: AssetAllocation
  ): AssetFlows & { realizedGains: number; earningsWithdrawn: number } {
    if (amount > this.balance) throw new Error('Insufficient funds for withdrawal');

    this.balance -= amount;
    this.cumulativeWithdrawals.cash += amount;

    return { stocks: 0, bonds: 0, cash: amount, realizedGains: 0, earningsWithdrawn: 0 };
  }

  applyConversionOut(amount: number): AssetFlows {
    if (amount < 0) throw new Error('Conversion amount must be non-negative');
    if (amount === 0) return { stocks: 0, bonds: 0, cash: 0 };
    if (amount > this.balance) throw new Error('Insufficient funds for conversion');

    this.balance -= amount;
    this.cumulativeConversions += amount;
    return { stocks: 0, bonds: 0, cash: amount };
  }

  applyConversionIn(amount: number): AssetFlows {
    if (amount < 0) throw new Error('Conversion amount must be non-negative');
    if (amount === 0) return { stocks: 0, bonds: 0, cash: 0 };

    this.balance += amount;
    return { stocks: 0, bonds: 0, cash: amount };
  }
}

/** Base class for stock/bond investment accounts with asset allocation tracking */
export abstract class InvestmentAccount extends Account {
  private currPercentBonds: number;
  /** The dividends and bond interest `applyYields` computed this month, for `settleInvestmentIncome`. */
  protected lastMonthYield: { bonds: number; stocks: number } = { bonds: 0, stocks: 0 };

  constructor(data: AccountInputs & { type: InvestmentAccountType }) {
    const cumulativeReturnAmounts: AssetReturnAmounts = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeContributions: AssetFlows = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeWithdrawals: AssetFlows = { cash: 0, bonds: 0, stocks: 0 };
    const cumulativeYieldAmounts: AssetYieldAmounts = { cash: 0, bonds: 0, stocks: 0 };

    super(
      data.balance,
      data.name,
      data.id,
      data.type,
      cumulativeReturnAmounts,
      cumulativeContributions,
      0,
      cumulativeWithdrawals,
      0,
      0,
      0,
      cumulativeYieldAmounts
    );
    this.currPercentBonds = data.percentBonds / 100;
  }

  getHasRMDs(): boolean {
    return this.type === 'ira' || this.type === '401k' || this.type === '403b';
  }

  getAccountData(): AccountData {
    const assetAllocation: AssetAllocation = { cash: 0, bonds: this.currPercentBonds, stocks: 1 - this.currPercentBonds };

    return {
      balance: this.balance,
      cumulativeWithdrawals: { ...this.cumulativeWithdrawals },
      cumulativeContributions: { ...this.cumulativeContributions },
      cumulativeEmployerMatch: this.cumulativeEmployerMatch,
      cumulativeRealizedGains: this.cumulativeRealizedGains,
      cumulativeEarningsWithdrawn: this.cumulativeEarningsWithdrawn,
      cumulativeRmds: this.cumulativeRmds,
      ...(this.cumulativeConversions > 0 ? { cumulativeConversions: this.cumulativeConversions } : {}),
      name: this.name,
      id: this.id,
      type: this.type,
      assetAllocation,
    };
  }

  applyReturns(returnRates: AssetReturnRates): { returnAmounts: AssetReturnAmounts; cumulativeReturnAmounts: AssetReturnAmounts } {
    const bondsPercent = this.currPercentBonds;
    const stocksPercent = 1 - bondsPercent;

    const currentBondsValue = this.balance * bondsPercent;
    const currentStocksValue = this.balance * stocksPercent;

    const bondReturnsAmount = currentBondsValue * returnRates.bonds;
    this.cumulativeReturnAmounts.bonds += bondReturnsAmount;
    const newBondsValue = currentBondsValue + bondReturnsAmount;

    const stockReturnsAmount = currentStocksValue * returnRates.stocks;
    this.cumulativeReturnAmounts.stocks += stockReturnsAmount;
    const newStocksValue = currentStocksValue + stockReturnsAmount;

    this.balance = newBondsValue + newStocksValue;
    this.currPercentBonds = this.balance ? newBondsValue / this.balance : this.currPercentBonds;

    return {
      returnAmounts: { cash: 0, bonds: bondReturnsAmount, stocks: stockReturnsAmount },
      cumulativeReturnAmounts: { ...this.cumulativeReturnAmounts },
    };
  }

  applyYields(yieldRates: AssetYieldRates): { yieldAmounts: AssetYieldAmounts; cumulativeYieldAmounts: AssetYieldAmounts } {
    const { stocks: dividendYield, bonds: bondYield } = yieldRates;

    const bondsPercent = this.currPercentBonds;
    const stocksPercent = 1 - bondsPercent;

    const currentBondsValue = this.balance * bondsPercent;
    const currentStocksValue = this.balance * stocksPercent;

    const bondYieldAmount = currentBondsValue * bondYield;
    const dividendYieldAmount = currentStocksValue * dividendYield;

    this.cumulativeYieldAmounts.bonds += bondYieldAmount;
    this.cumulativeYieldAmounts.stocks += dividendYieldAmount;
    this.lastMonthYield = { bonds: bondYieldAmount, stocks: dividendYieldAmount };

    return {
      yieldAmounts: { bonds: bondYieldAmount, stocks: dividendYieldAmount, cash: 0 },
      cumulativeYieldAmounts: { ...this.cumulativeYieldAmounts },
    };
  }

  /**
   * Takes this month's dividends and interest out of the balance as cash, sleeve by sleeve: the
   * dividend from the stocks, the interest from the bonds. The total return already holds them
   * (`applyReturns`), so removing them is what paying them out *means*. Returns the cash removed.
   */
  protected payOutIncomeShared(): number {
    const bondsValue = this.balance * this.currPercentBonds;
    const stocksValue = this.balance - bondsValue;
    const fromBonds = Math.min(Math.max(0, this.lastMonthYield.bonds), Math.max(0, bondsValue));
    const fromStocks = Math.min(Math.max(0, this.lastMonthYield.stocks), Math.max(0, stocksValue));
    const newBalance = this.balance - fromBonds - fromStocks;

    this.currPercentBonds = newBalance > 0 ? (bondsValue - fromBonds) / newBalance : this.currPercentBonds;
    this.balance = newBalance;

    return fromBonds + fromStocks;
  }

  protected applyContributionShared(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows {
    if (amount < 0) throw new Error('Contribution amount must be non-negative');
    if (amount === 0) return zeroAssetAmounts<AssetFlows>();

    const currentBondsValue = this.balance * this.currPercentBonds;
    const currentStocksValue = this.balance * (1 - this.currPercentBonds);

    const bondContribution = amount * contributionAllocation.bonds;
    const stockContribution = amount * (1 - contributionAllocation.bonds);

    const newBondsValue = currentBondsValue + bondContribution;
    const newStocksValue = currentStocksValue + stockContribution;
    const newBalance = newBondsValue + newStocksValue;

    this.balance = newBalance;
    this.currPercentBonds = newBalance > 0 ? newBondsValue / newBalance : this.currPercentBonds;

    this.cumulativeContributions.stocks += stockContribution;
    this.cumulativeContributions.bonds += bondContribution;
    if (type === 'employer') this.cumulativeEmployerMatch += amount;

    return { stocks: stockContribution, bonds: bondContribution, cash: 0 };
  }

  protected applyWithdrawalShared(amount: number, type: WithdrawalType, withdrawalAllocation: AssetAllocation): AssetFlows {
    if (amount < 0) throw new Error('Withdrawal amount must be non-negative');
    if (amount === 0) return zeroAssetAmounts<AssetFlows>();
    if (amount > this.balance) throw new Error('Insufficient funds for withdrawal');

    const currentBondsValue = this.balance * this.currPercentBonds;
    const currentStocksValue = this.balance * (1 - this.currPercentBonds);

    const targetBondWithdrawal = Math.min(amount * withdrawalAllocation.bonds, currentBondsValue);
    const bondWithdrawal = Math.max(targetBondWithdrawal, amount - currentStocksValue);
    const stockWithdrawal = amount - bondWithdrawal;

    const newBondsValue = currentBondsValue - bondWithdrawal;
    const newStocksValue = currentStocksValue - stockWithdrawal;
    const newBalance = newBondsValue + newStocksValue;

    this.balance = Math.max(0, newBalance);
    this.currPercentBonds = newBalance > 0 ? newBondsValue / newBalance : this.currPercentBonds;

    this.cumulativeWithdrawals.stocks += stockWithdrawal;
    this.cumulativeWithdrawals.bonds += bondWithdrawal;
    if (type === 'rmd') this.cumulativeRmds += amount;

    return { stocks: stockWithdrawal, bonds: bondWithdrawal, cash: 0 };
  }

  applyRebalance(stocksExcess: number, bondsExcess: number): { stocksSold: number; bondsSold: number; realizedGains: number } {
    const currentBondsValue = this.balance * this.currPercentBonds;
    const currentStocksValue = this.balance * (1 - this.currPercentBonds);

    let stocksSold = 0;
    if (stocksExcess > 0) stocksSold = Math.min(stocksExcess, currentStocksValue);

    let bondsSold = 0;
    if (bondsExcess > 0) bondsSold = Math.min(bondsExcess, currentBondsValue);

    const newBondsValue = currentBondsValue - bondsSold + stocksSold;
    this.currPercentBonds = this.balance > 0 ? newBondsValue / this.balance : this.currPercentBonds;

    const realizedGains = this.calculateRebalanceGains(stocksSold, bondsSold);

    return { stocksSold, bondsSold, realizedGains };
  }

  protected calculateRebalanceGains(stocksSold: number, bondsSold: number): number {
    return 0;
  }

  applyConversionOut(amount: number): AssetFlows {
    if (amount < 0) throw new Error('Conversion amount must be non-negative');
    if (amount === 0) return zeroAssetAmounts<AssetFlows>();
    if (amount > this.balance) throw new Error('Insufficient funds for conversion');

    const currentBondsValue = this.balance * this.currPercentBonds;
    const currentStocksValue = this.balance * (1 - this.currPercentBonds);

    const bondWithdrawal = amount * this.currPercentBonds;
    const stockWithdrawal = amount - bondWithdrawal;

    const newBondsValue = currentBondsValue - bondWithdrawal;
    const newStocksValue = currentStocksValue - stockWithdrawal;
    const newBalance = newBondsValue + newStocksValue;

    this.balance = Math.max(0, newBalance);
    this.currPercentBonds = newBalance > 0 ? newBondsValue / newBalance : this.currPercentBonds;
    this.cumulativeConversions += amount;

    return { stocks: stockWithdrawal, bonds: bondWithdrawal, cash: 0 };
  }

  applyConversionIn(amount: number, _date?: ISODateString): AssetFlows {
    if (amount < 0) throw new Error('Conversion amount must be non-negative');
    if (amount === 0) return zeroAssetAmounts<AssetFlows>();

    const currentBondsValue = this.balance * this.currPercentBonds;
    const currentStocksValue = this.balance * (1 - this.currPercentBonds);

    const bondContribution = amount * this.currPercentBonds;
    const stockContribution = amount - bondContribution;

    const newBondsValue = currentBondsValue + bondContribution;
    const newStocksValue = currentStocksValue + stockContribution;
    const newBalance = newBondsValue + newStocksValue;

    this.balance = newBalance;
    this.currPercentBonds = newBalance > 0 ? newBondsValue / newBalance : this.currPercentBonds;

    return { stocks: stockContribution, bonds: bondContribution, cash: 0 };
  }
}

/**
 * Taxable brokerage account with cost basis tracking
 *
 * Withdrawals realize capital gains proportional to the gain/basis ratio.
 * Rebalancing also triggers proportional realized gains.
 */
export class TaxableBrokerageAccount extends InvestmentAccount {
  readonly taxCategory: TaxCategory = 'taxable';

  private costBasis: number;

  /** Whether dividends and interest are paid out as cash instead of reinvested (v20). */
  private readonly distributesIncome: boolean;

  constructor(data: AccountInputs & { type: 'taxableBrokerage' }) {
    super(data);
    this.costBasis = data.costBasis!;
    this.distributesIncome = data.distributeIncome === true;
  }

  /**
   * Settles this month's dividends and interest, after `applyReturns`. Returns the cash paid out.
   *
   * Either way the income is taxed in the year it is earned (`taxes.ts` reads `yieldAmounts`):
   *
   * - **Reinvested** (the default): the income buys more shares, so it adds to the cost basis —
   *   Treas. Reg. §1.1012-1(c), the basis of a share bought with a dividend is the dividend. Without
   *   this the same dollars were taxed again as a capital gain when the shares were sold.
   * - **Paid out**: the income leaves the account as cash for the month's spending, and the basis is
   *   unchanged, because no shares were bought.
   */
  settleInvestmentIncome(): number {
    if (this.distributesIncome) return this.payOutIncomeShared();

    this.costBasis += Math.max(0, this.lastMonthYield.bonds) + Math.max(0, this.lastMonthYield.stocks);
    return 0;
  }

  getCostBasis(): number {
    return this.costBasis;
  }

  /**
   * Steps the cost basis toward the account's market value (IRC §1014, at a member's death).
   *
   * `fraction` is the share of the account whose basis is reset: 1 for community property, where
   * §1014(b)(6) steps up both halves, 0.5 for the deceased's half of separate or joint-tenancy
   * property, and 0 for property the survivor already owned. The whole balance is the account's
   * market value — returns are applied to the balance and withdrawals realize gains pro rata
   * against this basis — so a full step-up sets the basis to the balance and every later
   * withdrawal realizes only the gain that accrues afterward. Withdrawals and rebalancing keep
   * the pair in step; nothing else in this class needs to know a step-up happened.
   */
  applyBasisStepUp(fraction: number): void {
    const steppedUpShare = Math.min(Math.max(fraction, 0), 1);
    this.costBasis += (this.balance - this.costBasis) * steppedUpShare;
  }

  applyContribution(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows {
    const contributed = super.applyContributionShared(amount, type, contributionAllocation);
    this.costBasis += amount;
    return contributed;
  }

  applyWithdrawal(
    amount: number,
    type: WithdrawalType,
    withdrawalAllocation: AssetAllocation
  ): AssetFlows & { realizedGains: number; earningsWithdrawn: number } {
    // Pro-rata cost basis: withdrawals realize gains proportional to unrealized gain ratio
    const basisProportion = this.costBasis / this.balance;
    const basisWithdrawn = Math.min(amount * basisProportion, this.costBasis);
    this.costBasis -= basisWithdrawn;

    const realizedGains = amount - basisWithdrawn;
    this.cumulativeRealizedGains += realizedGains;

    const withdrawn = super.applyWithdrawalShared(amount, type, withdrawalAllocation);

    return { ...withdrawn, realizedGains, earningsWithdrawn: 0 };
  }

  protected calculateRebalanceGains(stocksSold: number, bondsSold: number): number {
    const totalSold = stocksSold + bondsSold;
    if (totalSold <= 0) return 0;

    const basisProportion = this.costBasis / this.balance;
    const basisSold = Math.min(totalSold * basisProportion, this.costBasis);

    const realizedGains = totalSold - basisSold;
    this.cumulativeRealizedGains += realizedGains;

    this.costBasis += realizedGains;

    return realizedGains;
  }
}

/** Tax-deferred account (401k, 403b, IRA, HSA) — all withdrawals taxed as ordinary income */
export class TaxDeferredAccount extends InvestmentAccount {
  readonly taxCategory: TaxCategory = 'taxDeferred';

  constructor(data: AccountInputs & { type: 'ira' | '401k' | '403b' | 'hsa' }) {
    super(data);
  }

  applyContribution(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows {
    return super.applyContributionShared(amount, type, contributionAllocation);
  }

  applyWithdrawal(
    amount: number,
    type: WithdrawalType,
    withdrawalAllocation: AssetAllocation
  ): AssetFlows & { realizedGains: number; earningsWithdrawn: number } {
    const withdrawn = super.applyWithdrawalShared(amount, type, withdrawalAllocation);
    return { ...withdrawn, realizedGains: 0, earningsWithdrawn: 0 };
  }
}

/**
 * Tax-free (Roth) account with contribution basis tracking
 *
 * Withdrawals first draw from contribution basis (tax/penalty-free),
 * then from earnings (potentially subject to early withdrawal penalties).
 */
export class TaxFreeAccount extends InvestmentAccount {
  readonly taxCategory: TaxCategory = 'taxFree';

  private contributionBasis: number;
  private rothEvents: RothEvent[] = [];
  private conversions: Array<{ date: ISODateString; amount: number }> = [];

  constructor(data: AccountInputs & { type: 'rothIra' | 'roth401k' | 'roth403b' }) {
    super(data);
    this.contributionBasis = data.contributionBasis!;
  }

  getContributionBasis(): number {
    return this.contributionBasis;
  }

  getRothEvents(): readonly RothEvent[] {
    return this.rothEvents;
  }

  override applyConversionIn(amount: number, date?: ISODateString): AssetFlows {
    const flows = super.applyConversionIn(amount, date);
    if (amount > 0) {
      const convDate = date ?? '2026-01-01';
      this.rothEvents.push({
        date: convDate,
        kind: 'conversion',
        amount,
      });
      this.conversions.push({
        date: convDate,
        amount,
      });
    }
    return flows;
  }

  applyContribution(amount: number, type: ContributionType, contributionAllocation: AssetAllocation): AssetFlows {
    const contributed = super.applyContributionShared(amount, type, contributionAllocation);
    this.contributionBasis += amount;
    return contributed;
  }

  applyWithdrawal(
    amount: number,
    type: WithdrawalType,
    withdrawalAllocation: AssetAllocation,
    context?: { date?: ISODateString; age?: number }
  ): AssetFlows & { realizedGains: number; earningsWithdrawn: number; unseasonedConversionsWithdrawn?: number } {
    // IRC §408A(d)(1) Roth ordering:
    // 1. Contributions withdrawn first (tax-free and penalty-free)
    const contributionWithdrawn = Math.min(amount, this.contributionBasis);
    this.contributionBasis -= contributionWithdrawn;
    let remaining = amount - contributionWithdrawn;

    // 2. Converted principal (FIFO in date order, tax-free, 10% penalty if unseasoned and under 59.5)
    let unseasonedConversionsWithdrawn = 0;
    const withdrawalDate = context?.date;
    const age = context?.age;

    for (const conv of this.conversions) {
      if (remaining <= 0) break;
      const taken = Math.min(remaining, conv.amount);
      if (taken <= 0) continue;
      conv.amount -= taken;
      remaining -= taken;

      if (age === undefined || age < 59.5) {
        if (!withdrawalDate || withdrawalDate < conversionSeasonsOn(conv.date)) {
          unseasonedConversionsWithdrawn += taken;
        }
      }
    }

    // 3. Earnings
    const earningsWithdrawn = remaining;
    this.cumulativeEarningsWithdrawn += earningsWithdrawn;

    const withdrawn = super.applyWithdrawalShared(amount, type, withdrawalAllocation);

    return {
      ...withdrawn,
      earningsWithdrawn,
      realizedGains: 0,
      ...(unseasonedConversionsWithdrawn > 0 ? { unseasonedConversionsWithdrawn } : {}),
    };
  }
}
