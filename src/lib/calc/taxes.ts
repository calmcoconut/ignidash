/**
 * Federal tax calculation engine
 *
 * Computes income tax, capital gains tax, NIIT, Social Security taxation,
 * payroll taxes (FICA, self-employment tax, California SDI) and early withdrawal penalties.
 * Handles progressive bracket stacking, capital loss carryover, and Section 121 primary
 * residence exclusion.
 *
 * Every amount comes from the ruleset for the tax year being settled
 * (`getRules(taxYear)` in `./tax-data`), never from a module-level constant, so a future year's
 * rules only apply to returns filed under them. The year is passed in explicitly by the engine
 * from its clock; see `setTaxYear`.
 *
 * Payroll tax moved here in P3-P4: the wage half arrives already withheld (see `PayrollTaxProcessor`
 * in `./payroll-taxes`, which the engine passes in per year) and the self-employment half is
 * computed here, because it is settled with the return. `totalTaxLiability` is the one reconciled
 * total: it equals the sum of the lines below it, and `totalTaxesDue` is that total less what was
 * already withheld from the paycheques.
 *
 * ## AMT and IRMAA (P3-P7a)
 *
 * The alternative minimum tax is a *parallel* computation compared with the regular income tax, and
 * the return pays the larger of the two. It is reported as a **top-up line, never a replacement**:
 * `federalIncomeTaxes.federalIncomeTaxAmount` and `capitalGainsTaxes.capitalGainsTaxAmount` stay the
 * regular tax, `amt.topUp` is `max(0, tentativeMinimumTax − regularIncomeTax)`, and
 * `amt.applied` says which tax the year actually paid (`'regular'` when the AMT is shadowed,
 * `'amt'` when it bites). Because the top-up is zero whenever the regular tax wins, one sum is
 * correct in both cases and nothing is double counted.
 *
 * `amt.netCharge` is the signed line the reconciliation adds: `topUp` less any prior-year
 * minimum-tax credit the year could use (IRC §53). A negative value is a credit reducing the bill.
 *
 * IRMAA is a Medicare premium surcharge, not an income tax, and it is charged on the return of the
 * year it is paid: the tier comes from the MAGI of `lookbackYears` earlier (two), which is why this
 * processor keeps a small MAGI history rather than looking at the current year alone.
 */

import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import type { FilingStatus, ItemizedDeductionsInputs } from '@/lib/schemas/inputs/tax-settings-form-schema';
import type { ConversionInputs } from '@/lib/schemas/inputs/conversion-form-schema';

import { type HouseholdMemberRole, type Owner, ownerOf } from '@/lib/schemas/inputs/household-schema';

import type { SimulationState } from './simulation-engine';
import type { IncomesData, OwnerIncomesData } from './incomes';
import type { PortfolioData } from './portfolio';
import type { ReturnsData } from './returns';
import type { PhysicalAssetData, PhysicalAssetsData } from './physical-assets';
import { type AccountDataWithFlows, taxCategoryForAccountType } from './account';
import { type AssetFlows, type TaxCategory, sumFlows, sumReturnAmounts, zeroAssetAmounts } from './asset';
import { computeSelfEmploymentTaxes, zeroWagePayrollTaxes, type FicaTaxesData, type WagePayrollTaxes } from './payroll-taxes';
import { getRules, LATEST_TAX_YEAR } from './tax-data';
import { prorateIraDistribution } from './retirement-rules/ira-basis';
import { irmaaTierFor } from './tax-data/medicare-irmaa';
import { saltCapFor } from './tax-data/salt-cap';
import { realDollarsIn } from './tax-data/real-dollars';
import type {
  CapitalGainsTaxBracket,
  FederalIncomeTaxBracket,
  FederalTaxRuleset,
  ProgressiveBracket,
  TableMeta,
  TaxYear,
} from './tax-data/types';
export interface CapitalGainsTaxesData {
  taxableIncomeTaxedAsCapitalGains: number;
  capitalGainsTaxAmount: number;
  effectiveCapitalGainsTaxRate: number;
  topMarginalCapitalGainsTaxRate: number;
  capitalGainsTaxBrackets: CapitalGainsTaxBracket[];
}

export interface FederalIncomeTaxesData {
  taxableIncomeTaxedAsOrdinary: number;
  federalIncomeTaxAmount: number;
  effectiveFederalIncomeTaxRate: number;
  topMarginalFederalIncomeTaxRate: number;
  federalIncomeTaxBrackets: FederalIncomeTaxBracket[];
  capitalLossDeduction?: number;
}

export interface NIITData {
  netInvestmentIncome: number;
  incomeSubjectToNiit: number;
  niitAmount: number;
  threshold: number;
}

/**
 * The alternative minimum tax, as a shadow computation beside the regular tax.
 *
 * `regularIncomeTax` is the income tax the regular return computed (ordinary + capital gains); the
 * AMT is measured against it, and `applied` records which one the year paid.
 */
export interface AlternativeMinimumTaxesData {
  /** The regular income tax this year: `federalIncomeTaxAmount + capitalGainsTaxAmount`. */
  regularIncomeTax: number;
  /** Alternative minimum taxable income: regular taxable income plus the disallowed deductions. */
  amtIncome: number;
  /** The deductions added back to reach `amtIncome` (IRC §56(b)(1)). */
  addbacks: number;
  /** The exemption after its 25% phase-out. */
  exemption: number;
  /** AMT on the ordinary slice: 26% up to the statutory ceiling, 28% above it. */
  ordinaryTax: number;
  /** AMT on the capital-gain slice, at the regular long-term rates stacked on the ordinary base. */
  capitalGainsTax: number;
  /** `ordinaryTax + capitalGainsTax` — the tax if the AMT were the only system. */
  tentativeMinimumTax: number;
  /** `max(0, tentativeMinimumTax − regularIncomeTax)`: the AMT actually owed on top of the regular tax. */
  topUp: number;
  /** Prior-year minimum-tax credit used this year (IRC §53, simplified limit). */
  creditApplied: number;
  /** `topUp − creditApplied`. The one signed line `totalTaxLiability` adds; negative means a credit. */
  netCharge: number;
  /** The tax the year paid, so a reader can tell "AMT applied" from "AMT shadowed". */
  applied: 'regular' | 'amt';
  /** Minimum-tax credit available to later years after this one. */
  creditCarryforward: number;
}

/** The Medicare income-related monthly adjustment charged in a year (Parts B and D). */
export interface IrmaaData {
  /** The MAGI the tier is based on, and the tax year it came from; `null` when unavailable. */
  basisMagi: number | null;
  basisTaxYear: TaxYear | null;
  /** The year the surcharge is charged in — the year being settled. */
  chargedInTaxYear: TaxYear;
  /** Tier index: 0 is the standard premium, 1-5 are the surcharge tiers. */
  tier: number;
  partBMonthly: number;
  partDMonthly: number;
  /** `(partBMonthly + partDMonthly) × 12`: the income-related surcharge for the year. */
  total: number;
}

/**
 * The plan's deduction settings (P3-P3), passed in by the caller.
 *
 * `itemizedDeductions` absent means "this plan does not itemize" — the standard deduction applies.
 * It is deliberately not defaulted to zeros: a plan that itemizes nothing and a plan that has never
 * heard of itemizing are the same arithmetic but different data, and the export envelope's v6
 * statement depends on the distinction.
 */
export interface TaxProcessorSettings {
  readonly itemizedDeductions?: ItemizedDeductionsInputs | undefined;
  readonly spouseQualifiesForSeniorDeduction?: boolean | undefined;
  /**
   * Which state files a return. Absent means **California**: this is a California instance (D2), the
   * payroll layer has charged CA SDI unconditionally since P3-P4, and a plan that is not a resident
   * says so explicitly with `'none'`. See the export envelope's version history for what an absent
   * flag means in a file.
   */
  readonly stateResidency?: StateResidency | undefined;
  /**
   * Whose each account and physical asset is, for the separate-return split (P3-P1b).
   *
   * The engine passes it from the plan's `owner` fields; an item with no owner reads as `primary`
   * (what `ownerOf` already means everywhere else), so a plan written before ownership existed
   * divides exactly as a single person's would. Incomes do not need an entry here: the incomes
   * processor reports its own per-owner totals in `IncomesData.perOwnerData`, because it is the
   * layer that knows how a `joint` income is shared month by month.
   *
   * Only the separate-return path reads it. A household filing one return is unaffected.
   */
  readonly ownership?: ReturnOwnership | undefined;
  /**
   * The plan's inflation assumption, as a percentage, for the tax tables that are **not** indexed.
   *
   * The engine works in today's dollars, but a statute-locked amount (the §86 base, the NIIT and
   * Additional Medicare thresholds, the §121 exclusion) keeps its nominal value forever, so in real
   * terms it shrinks. Absent means 0% — no deflation — which is what a direct construction in a
   * test wants and what the corpus looked like before the deflation existed.
   *
   * See `tax-data/real-dollars.ts` for which tables move and why `indexed` ones do not.
   */
  readonly inflationRatePercent?: number | undefined;
  /**
   * The after-tax (nondeductible) basis of each traditional IRA, keyed by account id.
   *
   * Form 8606 apportions **one** aggregate basis across every traditional, SEP and SIMPLE IRA the
   * owner holds (IRC §408(d)(2)), so the tax layer needs the per-account figures rather than a
   * total: a separate-return pair has to split them the same way the portfolio is split.
   *
   * Absent, or an account absent from the map, means **no after-tax basis** — every distributed
   * dollar is taxable, which is what every plan written before this field computed.
   */
  readonly iraBasisByAccount?: Readonly<Record<string, number>> | undefined;
}

/**
 * Who owns what, keyed by entity id, for the separate-return split (P3-P1b).
 *
 * A `joint` item is community property in California (E2, F10), so its amounts split 50/50 between
 * the two returns; a `primary` or `partner` item belongs wholly to that member. The engine builds
 * this from the plan's ownership fields, and `ownerOf`'s absent-means-`primary` default is applied
 * here as well, so an old plan with no ownership data behaves like a single person's.
 */
export interface ReturnOwnership {
  readonly accounts: Readonly<Record<string, Owner | undefined>>;
  readonly physicalAssets: Readonly<Record<string, Owner | undefined>>;
}

/** The states the engine can file: California, or none at all. */
export type StateResidency = 'CA' | 'none';

/**
 * What reduced taxable income this year, and which rule did it.
 *
 * The return takes the **larger** of the standard deduction and the itemized total (a tie goes to
 * the standard deduction), and then adds the §151(d)(5)(C) senior deduction, which is allowed on top
 * of either. `type` says which of the two was taken, so a reader never has to infer it from the
 * numbers.
 */
export interface DeductionData {
  type: 'standard' | 'itemized';
  standardDeduction: number;
  /** The itemized lines after the statutory limits; all zero when the standard deduction was taken. */
  itemized: {
    mortgageInterest: number;
    charitable: number;
    /** State and local taxes after the §164(b)(7) cap. */
    stateAndLocalTaxes: number;
    /** Medical expenses above the §213(a) floor. */
    medicalExpenses: number;
    total: number;
  };
  /** The SALT cap that applied, and what it did to the entered amount. */
  saltCap: { entered: number; allowed: number; phaseDown: number; resolvedYear: TaxYear };
  /** §151(d)(5)(C): $6,000 per qualified individual, phased out, additional to the deduction above. */
  seniorDeduction: number;
  /** `max(standardDeduction, itemized.total) + seniorDeduction`. */
  total: number;
}

/**
 * The state return's own numbers (P3-P8), so a reader can see what the state charged and why.
 *
 * `total` is a liability line in `totalTaxLiability`, beside the federal ones. `taxableIncome` and
 * the deduction are the state's own: California takes the larger of its standard deduction and its
 * itemized total, limits the itemized total above an AGI threshold, and taxes capital gains as
 * ordinary income — none of which the federal computation can supply.
 */
export interface StateTaxesData {
  /** `'none'` when the plan is not a California resident: every amount below is then zero. */
  jurisdiction: StateResidency;
  /** The ruleset year actually used; California's is the latest the FTB published. */
  resolvedYear: TaxYear | null;
  /** California income on which the state tax is figured: gains included, Social Security excluded. */
  income: number;
  deduction: {
    type: 'standard' | 'itemized';
    standard: number;
    /** The itemized total after the CA high-income limitation. */
    itemized: number;
    /** How much the CA limitation removed from the entered itemized total. */
    limitation: number;
    taken: number;
  };
  taxableIncome: number;
  /** The progressive bracket tax, before the surcharge and the credits. */
  bracketTax: number;
  /** The 1% Behavioral Health Services Tax (RTC §17043) on taxable income over $1,000,000. */
  behavioralHealthServicesTax: number;
  /** Personal exemption credits after the AGI limitation (a credit against tax, not a deduction). */
  exemptionCredits: number;
  /** `max(0, bracketTax + behavioralHealthServicesTax − exemptionCredits)`. */
  total: number;
}

export interface TaxesData {
  federalIncomeTaxes: FederalIncomeTaxesData;
  capitalGainsTaxes: CapitalGainsTaxesData;
  /** The alternative minimum tax, reported as a top-up over the regular tax (see the header). */
  amt: AlternativeMinimumTaxesData;
  /** The Medicare Part B/D income-related surcharge charged this year, from the two-year lookback. */
  irmaa: IrmaaData;
  niit: NIITData;
  earlyWithdrawalPenalties: EarlyWithdrawalPenaltyData;
  socialSecurityTaxes: SocialSecurityTaxesData;
  /** FICA and SDI withheld from wages, plus the self-employment tax settled with the return. */
  fica: FicaTaxesData;
  /** The state return (P3-P8); `jurisdiction: 'none'` for a non-resident plan. */
  state: StateTaxesData;
  incomeSources: IncomeSourcesData;
  /**
   * Everything the year owes, and exactly the sum of its lines:
   *
   *   federalIncomeTaxes.federalIncomeTaxAmount   regular income tax on ordinary income
   *   capitalGainsTaxes.capitalGainsTaxAmount     regular tax on gains and qualified dividends
   *   amt.netCharge                              AMT top-up (positive) or minimum-tax credit (negative)
   *   niit.niitAmount                            net investment income tax
   *   irmaa.total                                Medicare Part B + D income-related surcharge
   *   state.total                                the state return (California), zero when not a resident
   *   earlyWithdrawalPenalties.totalPenaltyAmount
   *   fica.total                                 payroll taxes (FICA + SDI + SE tax)
   *
   * The reconciliation test asserts exactly that equality, so a new line cannot be added without
   * being counted, and no line can be counted twice. The AMT enters as a *top-up* rather than as a
   * replacement of the regular tax precisely so this stays one plain sum (see the header).
   */
  totalTaxLiability: number;
  /** Liability that still has to be paid: `totalTaxLiability` less income-tax and payroll withholding. */
  totalTaxesDue: number;
  totalTaxesRefund: number;
  totalTaxableIncome: number;
  /** Above-the-line adjustments: tax-deferred contributions (401k/IRA/HSA), capital loss deduction, Section 121 exclusion, half of the SE tax */
  adjustments: Record<string, number>;
  /**
   * Below-the-line deductions actually taken, as a record: `standardDeduction` when the standard
   * deduction won, the itemized lines when they did, plus `seniorDeduction` either way.
   */
  deductions: Record<string, number>;
  /** The same deductions with the selection and the statutory limits made explicit. */
  deduction: DeductionData;
}

export interface EarlyWithdrawalPenaltyData {
  taxDeferredPenaltyAmount: number;
  taxFreePenaltyAmount: number;
  totalPenaltyAmount: number;
}

export interface SocialSecurityTaxesData {
  taxableSocialSecurityIncome: number;
  maxTaxablePercentage: number;
  actualTaxablePercentage: number;
  provisionalIncome: number;
}

/** Detailed breakdown of all income sources for tax computation */
export interface IncomeSourcesData {
  realizedGains: number;
  capitalLossDeduction: number;
  section121Exclusion: number;
  taxDeferredWithdrawals: number;
  taxableRetirementDistributions: number;
  taxableDividendIncome: number;
  taxableInterestIncome: number;
  earnedIncome: number;
  socialSecurityIncome: number;
  taxableSocialSecurityIncome: number;
  /** IRC §86 threshold result: 0, 0.5, or 0.85 depending on provisional income */
  maxTaxableSocialSecurityPercentage: number;
  /** AGI + 50% of SS benefits; determines SS taxation tier */
  provisionalIncome: number;
  taxFreeIncome: number;
  grossIncome: number;
  /** Income taxed at ordinary rates: earned income + retirement distributions + interest + taxable SS */
  incomeTaxedAsOrdinary: number;
  /** Income taxed at long-term capital gains rates: realized gains + qualified dividends */
  incomeTaxedAsLtcg: number;
  taxDeductibleContributions: number;
  adjustedGrossIncome: number;
  adjustedIncomeTaxedAsOrdinary: number;
  adjustedIncomeTaxedAsCapitalGains: number;
  totalIncome: number;
  earlyWithdrawals: {
    rothEarnings: number;
    '401kAndIra': number;
    hsa: number;
    unseasonedConversions?: number;
  };
}

// ============================================================================
// Separate returns (§6013, P3-P1b)
// ============================================================================

/** The two members whose separate returns a married couple files. */
const SEPARATE_RETURN_OWNERS = ['primary', 'partner'] as const;

/**
 * How much of an entity belongs on one member's separate return.
 *
 * A `joint` item is **community property** in California (E2, F10), so half of it is each member's
 * and half of its income belongs on each return. A `primary` or `partner` item belongs wholly to
 * that member. An absent owner reads as `primary`, which is `ownerOf`'s default everywhere else, so
 * a plan written before ownership existed divides as a single person's would.
 */
export function ownershipShare(owner: Owner | undefined, returnOwner: HouseholdMemberRole): number {
  const resolved = ownerOf({ owner });
  if (resolved === 'joint') return 0.5;

  return resolved === returnOwner ? 1 : 0;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const scaleFlows = (flows: AssetFlows, share: number): AssetFlows =>
  share === 1 ? flows : { stocks: flows.stocks * share, bonds: flows.bonds * share, cash: flows.cash * share };

/**
 * One owner's half of the year's portfolio flows.
 *
 * Only the fields the tax computation reads are divided — `perAccountData` (the account types and
 * their withdrawals, contributions and realised gains) and the aggregate `realizedGains`. The
 * snapshot fields (`totalValue`, the `cumulative*` totals) and the non-tax flow fields are not
 * attributable to a member of a household through a single number, and nothing on this path reads
 * them, so they are carried through unchanged rather than invented.
 *
 * `realizedGains` is rebuilt as the sum of the owner's shares of every account's gains. Those shares
 * partition the household's accounts exactly (1 + 0 for a separately owned account, ½ + ½ for a
 * community one), so the two returns' gains add up to the household's figure — which is what the
 * MFS-versus-MFJ fixture asserts.
 */
function portfolioForSeparateReturn(data: PortfolioData, ownership: ReturnOwnership, returnOwner: HouseholdMemberRole): PortfolioData {
  const perAccountData: Record<string, AccountDataWithFlows> = {};
  let realizedGains = 0;

  for (const [accountId, account] of Object.entries(data.perAccountData)) {
    const share = ownershipShare(ownership.accounts[accountId], returnOwner);
    if (share === 0) continue;

    const sharedAccount: AccountDataWithFlows = {
      ...account,
      contributions: scaleFlows(account.contributions, share),
      withdrawals: scaleFlows(account.withdrawals, share),
      employerMatch: account.employerMatch * share,
      realizedGains: account.realizedGains * share,
      earningsWithdrawn: account.earningsWithdrawn * share,
      rmds: account.rmds * share,
      conversions: (account.conversions ?? 0) * share,
    };

    perAccountData[accountId] = sharedAccount;
    realizedGains += sharedAccount.realizedGains;
  }

  return { ...data, perAccountData, realizedGains };
}

/**
 * The share of one tax category's investment income that belongs on one owner's return.
 *
 * This is an **allocation basis, not a measurement**. The engine aggregates yields by tax category
 * (`ReturnsData.yieldAmounts`), so it holds no per-account dividend or interest figure to split. What
 * it does hold per account is the year's return amounts (`ReturnsData.perAccountData[].
 * returnAmounts`), and this divides by those, attributed through `ownerOf`: a `primary` account's
 * investment income lands wholly on the primary's return, a `partner` account's wholly on the
 * partner's, and a `joint` (community-property) account's half on each.
 *
 * The consequence is visible and worth stating: the taxable-dividend line on a separate return is the
 * household's line times the owner's share of the returning accounts, so a couple whose taxable
 * brokerage sits entirely in the primary's name reports all of its dividends on the primary's return
 * and none on the partner's. An exact split needs per-account yields in `ReturnsData`, which is a
 * larger change than this item; until then this is the rule F10 implies.
 *
 * The weight is the **absolute** return amount, so a down year cannot turn a share negative, and it
 * falls back to the account's balance when every return in the category is exactly zero — the case
 * of a year with no price return at all, where yields are still paid.
 */
function investmentIncomeShare(
  data: ReturnsData,
  portfolio: PortfolioData,
  ownership: ReturnOwnership,
  returnOwner: HouseholdMemberRole,
  category: TaxCategory
): number {
  let total = 0;
  let mine = 0;

  for (const [accountId, account] of Object.entries(data.perAccountData)) {
    const accountData = portfolio.perAccountData[accountId];
    if (accountData === undefined || taxCategoryForAccountType(accountData.type) !== category) continue;

    const weight = Math.abs(sumReturnAmounts(account.returnAmounts)) || Math.abs(accountData.balance);
    total += weight;
    mine += weight * ownershipShare(ownership.accounts[accountId], returnOwner);
  }

  return total > 0 ? mine / total : 0;
}

/**
 * One owner's half of the year's investment income.
 *
 * Only `yieldAmounts` is read on the tax path, so only it is divided. The two categories that are
 * income at all are apportioned; tax-deferred and tax-free yields are not taxed on either return and
 * are zeroed rather than copied, because a projection here is one return's year, not the household's.
 */
function returnsForSeparateReturn(
  data: ReturnsData,
  portfolio: PortfolioData,
  ownership: ReturnOwnership,
  returnOwner: HouseholdMemberRole
): ReturnsData {
  return {
    ...data,
    yieldAmounts: {
      taxable: scaleFlows(data.yieldAmounts.taxable, investmentIncomeShare(data, portfolio, ownership, returnOwner, 'taxable')),
      cashSavings: scaleFlows(data.yieldAmounts.cashSavings, investmentIncomeShare(data, portfolio, ownership, returnOwner, 'cashSavings')),
      taxDeferred: zeroAssetAmounts(),
      taxFree: zeroAssetAmounts(),
    },
  };
}

/**
 * One owner's half of the year's physical assets.
 *
 * The §121 exclusion reads each asset's `realizedGains` and the total, so both are divided: community
 * property halves, a separately owned property belongs to its owner. The remaining asset fields are
 * not read on the tax path and are carried through unchanged.
 */
function physicalAssetsForSeparateReturn(
  data: PhysicalAssetsData,
  ownership: ReturnOwnership,
  returnOwner: HouseholdMemberRole
): PhysicalAssetsData {
  const perAssetData: Record<string, PhysicalAssetData> = {};
  let totalRealizedGains = 0;

  for (const [assetId, asset] of Object.entries(data.perAssetData)) {
    const share = ownershipShare(ownership.physicalAssets[assetId], returnOwner);
    if (share === 0) continue;

    perAssetData[assetId] = share === 1 ? asset : { ...asset, realizedGains: asset.realizedGains * share };
    totalRealizedGains += asset.realizedGains * share;
  }

  return { ...data, perAssetData, totalRealizedGains };
}

/** One owner's share of the year's withheld payroll tax, apportioned by that owner's wages. */
function wagePayrollForSeparateReturn(wages: WagePayrollTaxes, share: number): WagePayrollTaxes {
  if (share === 1) return wages;

  return {
    socialSecurity: wages.socialSecurity * share,
    medicare: wages.medicare * share,
    additionalMedicare: wages.additionalMedicare * share,
    stateDisability: wages.stateDisability * share,
    total: wages.total * share,
  };
}

/**
 * Each owner's share of the wage payroll tax withheld this year.
 *
 * The payroll layer withholds per paycheque and `IncomesData.perOwnerData` records what it withheld
 * for each owner, so that is the weight: the year's `WagePayrollTaxes` are apportioned in exactly
 * the proportion they were withheld in. When nothing was withheld the whole argument is zero, so
 * the split cannot change the result; the primary takes it then, which keeps the two shares summing
 * to 1.
 *
 * This is an **apportionment, not a recomputation**. The OASDI wage base was applied to the
 * household's wages in one sequence, so a couple whose two wages together exceed the base has the
 * household's withholding divided between them rather than re-withheld spouse by spouse. The
 * per-spouse wage base belongs to the payroll layer (§1-P3, P3-P4); a separate return only needs the
 * tax it already paid.
 */
function withheldPayrollShare(data: IncomesData, returnOwner: HouseholdMemberRole): number {
  const perOwner = data.perOwnerData;
  if (perOwner === undefined) return returnOwner === 'primary' ? 1 : 0;

  const total = perOwner.primary.totalFicaTax + perOwner.partner.totalFicaTax;

  return total > 0 ? perOwner[returnOwner].totalFicaTax / total : returnOwner === 'primary' ? 1 : 0;
}

/** A zeroed owner total, for the second return of a household that has only one earner record. */
const zeroOwnerTotals = (): OwnerIncomesData => ({
  totalIncome: 0,
  totalAmountWithheld: 0,
  totalFicaTax: 0,
  totalIncomeAfterPayrollDeductions: 0,
  totalTaxFreeIncome: 0,
  totalSocialSecurityIncome: 0,
  totalWageIncome: 0,
  totalSelfEmploymentIncome: 0,
});

/**
 * One owner's share of the year's income.
 *
 * `perOwnerData` is absent only for a household of one (see `IncomesData.perOwnerData`), where the
 * household's own totals already are the primary's — so the primary's return gets them unchanged and
 * the partner's return is an empty one, which is what a separate return with no income is.
 */
function incomesForSeparateReturn(data: IncomesData, totals: OwnerIncomesData | undefined, returnOwner: HouseholdMemberRole): IncomesData {
  if (totals !== undefined) return { ...data, ...totals };
  if (returnOwner === 'primary') return data;

  return { ...data, ...zeroOwnerTotals() };
}

/** Sums a record of amounts across the returns, so a key one return lacks is still carried. */
function sumRecordOfAmounts(records: readonly Record<string, number>[]): Record<string, number> {
  const keys = new Set(records.flatMap((record) => Object.keys(record)));

  return Object.fromEntries([...keys].map((key) => [key, sum(records.map((record) => record[key] ?? 0))]));
}

/** Sums the income-composition block, keeping the one ratio in it a maximum rather than a sum. */
function sumIncomeSources(records: readonly IncomeSourcesData[]): IncomeSourcesData {
  const amount = (key: Exclude<keyof IncomeSourcesData, 'earlyWithdrawals' | 'maxTaxableSocialSecurityPercentage'>) =>
    sum(records.map((record) => record[key]));

  return {
    realizedGains: amount('realizedGains'),
    capitalLossDeduction: amount('capitalLossDeduction'),
    section121Exclusion: amount('section121Exclusion'),
    taxDeferredWithdrawals: amount('taxDeferredWithdrawals'),
    taxableRetirementDistributions: amount('taxableRetirementDistributions'),
    taxableDividendIncome: amount('taxableDividendIncome'),
    taxableInterestIncome: amount('taxableInterestIncome'),
    earnedIncome: amount('earnedIncome'),
    socialSecurityIncome: amount('socialSecurityIncome'),
    taxableSocialSecurityIncome: amount('taxableSocialSecurityIncome'),
    // A share, not an amount: the household's top §86 percentage is the larger of the two returns'.
    maxTaxableSocialSecurityPercentage: Math.max(...records.map((record) => record.maxTaxableSocialSecurityPercentage)),
    provisionalIncome: amount('provisionalIncome'),
    taxFreeIncome: amount('taxFreeIncome'),
    grossIncome: amount('grossIncome'),
    incomeTaxedAsOrdinary: amount('incomeTaxedAsOrdinary'),
    incomeTaxedAsLtcg: amount('incomeTaxedAsLtcg'),
    taxDeductibleContributions: amount('taxDeductibleContributions'),
    adjustedGrossIncome: amount('adjustedGrossIncome'),
    adjustedIncomeTaxedAsOrdinary: amount('adjustedIncomeTaxedAsOrdinary'),
    adjustedIncomeTaxedAsCapitalGains: amount('adjustedIncomeTaxedAsCapitalGains'),
    totalIncome: amount('totalIncome'),
    earlyWithdrawals: {
      rothEarnings: sum(records.map((record) => record.earlyWithdrawals.rothEarnings)),
      '401kAndIra': sum(records.map((record) => record.earlyWithdrawals['401kAndIra'])),
      hsa: sum(records.map((record) => record.earlyWithdrawals.hsa)),
      ...(sum(records.map((record) => record.earlyWithdrawals.unseasonedConversions ?? 0)) > 0
        ? { unseasonedConversions: sum(records.map((record) => record.earlyWithdrawals.unseasonedConversions ?? 0)) }
        : {}),
    },
  };
}

/** Sums the deduction blocks of two returns. */
function sumDeductions(records: readonly DeductionData[]): DeductionData {
  return {
    // The household took an itemized deduction if either return did. `standardDeduction` then
    // carries the other return's standard deduction, which is truthful — that return took it.
    type: records.some((record) => record.type === 'itemized') ? 'itemized' : 'standard',
    standardDeduction: sum(records.map((record) => record.standardDeduction)),
    itemized: {
      mortgageInterest: sum(records.map((record) => record.itemized.mortgageInterest)),
      charitable: sum(records.map((record) => record.itemized.charitable)),
      stateAndLocalTaxes: sum(records.map((record) => record.itemized.stateAndLocalTaxes)),
      medicalExpenses: sum(records.map((record) => record.itemized.medicalExpenses)),
      total: sum(records.map((record) => record.itemized.total)),
    },
    saltCap: {
      entered: sum(records.map((record) => record.saltCap.entered)),
      allowed: sum(records.map((record) => record.saltCap.allowed)),
      phaseDown: sum(records.map((record) => record.saltCap.phaseDown)),
      resolvedYear: Math.max(...records.map((record) => record.saltCap.resolvedYear)),
    },
    seniorDeduction: sum(records.map((record) => record.seniorDeduction)),
    total: sum(records.map((record) => record.total)),
  };
}

/** Sums the two state returns. */
function sumStateTaxes(records: readonly StateTaxesData[]): StateTaxesData {
  const filed = records.filter((record) => record.jurisdiction !== 'none');
  const source = filed.length > 0 ? filed : records;

  return {
    jurisdiction: filed.length > 0 ? 'CA' : 'none',
    resolvedYear: source[0].resolvedYear,
    income: sum(records.map((record) => record.income)),
    deduction: {
      type: records.some((record) => record.deduction.type === 'itemized') ? 'itemized' : 'standard',
      standard: sum(records.map((record) => record.deduction.standard)),
      itemized: sum(records.map((record) => record.deduction.itemized)),
      limitation: sum(records.map((record) => record.deduction.limitation)),
      taken: sum(records.map((record) => record.deduction.taken)),
    },
    taxableIncome: sum(records.map((record) => record.taxableIncome)),
    bracketTax: sum(records.map((record) => record.bracketTax)),
    behavioralHealthServicesTax: sum(records.map((record) => record.behavioralHealthServicesTax)),
    exemptionCredits: sum(records.map((record) => record.exemptionCredits)),
    total: sum(records.map((record) => record.total)),
  };
}

/**
 * The household's tax block for a year it files **two** returns in: the two returns, line by line.
 *
 * Every liability line is the sum of the two returns' lines, because the household's cash position is
 * what the engine settles — two cheques for the same year are still one year's tax. The blocks that
 * describe *a return* rather than an amount (the bracket schedule, the NIIT threshold, the IRMAA
 * tier) are taken from the returns themselves rather than summed, since both returns file under the
 * same status and therefore the same table.
 *
 * Ratios are recomputed from the summed parts, never averaged: `effectiveFederalIncomeTaxRate` is the
 * household's tax over the household's income, which is the number a reader means by the phrase.
 */
function sumSeparateReturns(records: readonly TaxesData[]): TaxesData {
  const federalIncomeTaxAmount = sum(records.map((record) => record.federalIncomeTaxes.federalIncomeTaxAmount));
  const capitalGainsTaxAmount = sum(records.map((record) => record.capitalGainsTaxes.capitalGainsTaxAmount));
  const totalIncome = sum(records.map((record) => record.incomeSources.totalIncome));
  const adjustedGains = sum(records.map((record) => record.incomeSources.adjustedIncomeTaxedAsCapitalGains));
  const capitalLossDeduction = sum(records.map((record) => record.federalIncomeTaxes.capitalLossDeduction ?? 0));
  const socialSecurityIncome = sum(records.map((record) => record.socialSecurityTaxes.taxableSocialSecurityIncome));
  const grossSocialSecurity = sum(records.map((record) => record.incomeSources.socialSecurityIncome));
  const basisMagi = records.map((record) => record.irmaa.basisMagi).filter((magi): magi is number => magi !== null);
  const basisTaxYear = records.map((record) => record.irmaa.basisTaxYear).find((year) => year !== null) ?? null;

  return {
    federalIncomeTaxes: {
      taxableIncomeTaxedAsOrdinary: sum(records.map((record) => record.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary)),
      federalIncomeTaxAmount,
      effectiveFederalIncomeTaxRate: totalIncome > 0 ? federalIncomeTaxAmount / totalIncome : 0,
      topMarginalFederalIncomeTaxRate: Math.max(...records.map((record) => record.federalIncomeTaxes.topMarginalFederalIncomeTaxRate)),
      // Both returns are priced under the same filing status, so they carry the same schedule.
      federalIncomeTaxBrackets: records[0].federalIncomeTaxes.federalIncomeTaxBrackets,
      ...(capitalLossDeduction !== 0 ? { capitalLossDeduction } : {}),
    },
    capitalGainsTaxes: {
      taxableIncomeTaxedAsCapitalGains: sum(records.map((record) => record.capitalGainsTaxes.taxableIncomeTaxedAsCapitalGains)),
      capitalGainsTaxAmount,
      effectiveCapitalGainsTaxRate: adjustedGains > 0 ? capitalGainsTaxAmount / adjustedGains : 0,
      topMarginalCapitalGainsTaxRate: Math.max(...records.map((record) => record.capitalGainsTaxes.topMarginalCapitalGainsTaxRate)),
      capitalGainsTaxBrackets: records[0].capitalGainsTaxes.capitalGainsTaxBrackets,
    },
    amt: {
      regularIncomeTax: sum(records.map((record) => record.amt.regularIncomeTax)),
      amtIncome: sum(records.map((record) => record.amt.amtIncome)),
      addbacks: sum(records.map((record) => record.amt.addbacks)),
      exemption: sum(records.map((record) => record.amt.exemption)),
      ordinaryTax: sum(records.map((record) => record.amt.ordinaryTax)),
      capitalGainsTax: sum(records.map((record) => record.amt.capitalGainsTax)),
      tentativeMinimumTax: sum(records.map((record) => record.amt.tentativeMinimumTax)),
      topUp: sum(records.map((record) => record.amt.topUp)),
      creditApplied: sum(records.map((record) => record.amt.creditApplied)),
      netCharge: sum(records.map((record) => record.amt.netCharge)),
      applied: records.some((record) => record.amt.applied === 'amt') ? 'amt' : 'regular',
      creditCarryforward: sum(records.map((record) => record.amt.creditCarryforward)),
    },
    irmaa: {
      // Each return's surcharge is set by that return's own MAGI two years earlier, so the household
      // figure is the two surcharges added: two separate Part B bills, both paid.
      basisMagi: basisMagi.length > 0 ? sum(basisMagi) : null,
      basisTaxYear,
      chargedInTaxYear: records[0].irmaa.chargedInTaxYear,
      tier: Math.max(...records.map((record) => record.irmaa.tier)),
      partBMonthly: sum(records.map((record) => record.irmaa.partBMonthly)),
      partDMonthly: sum(records.map((record) => record.irmaa.partDMonthly)),
      total: sum(records.map((record) => record.irmaa.total)),
    },
    niit: {
      netInvestmentIncome: sum(records.map((record) => record.niit.netInvestmentIncome)),
      incomeSubjectToNiit: sum(records.map((record) => record.niit.incomeSubjectToNiit)),
      niitAmount: sum(records.map((record) => record.niit.niitAmount)),
      threshold: records[0].niit.threshold,
    },
    earlyWithdrawalPenalties: {
      taxDeferredPenaltyAmount: sum(records.map((record) => record.earlyWithdrawalPenalties.taxDeferredPenaltyAmount)),
      taxFreePenaltyAmount: sum(records.map((record) => record.earlyWithdrawalPenalties.taxFreePenaltyAmount)),
      totalPenaltyAmount: sum(records.map((record) => record.earlyWithdrawalPenalties.totalPenaltyAmount)),
    },
    socialSecurityTaxes: {
      taxableSocialSecurityIncome: socialSecurityIncome,
      maxTaxablePercentage: Math.max(...records.map((record) => record.socialSecurityTaxes.maxTaxablePercentage)),
      actualTaxablePercentage: grossSocialSecurity > 0 ? socialSecurityIncome / grossSocialSecurity : 0,
      provisionalIncome: sum(records.map((record) => record.socialSecurityTaxes.provisionalIncome)),
    },
    fica: {
      wages: {
        socialSecurity: sum(records.map((record) => record.fica.wages.socialSecurity)),
        medicare: sum(records.map((record) => record.fica.wages.medicare)),
        additionalMedicare: sum(records.map((record) => record.fica.wages.additionalMedicare)),
        stateDisability: sum(records.map((record) => record.fica.wages.stateDisability)),
        total: sum(records.map((record) => record.fica.wages.total)),
      },
      selfEmployment: {
        netEarnings: sum(records.map((record) => record.fica.selfEmployment.netEarnings)),
        taxableEarnings: sum(records.map((record) => record.fica.selfEmployment.taxableEarnings)),
        socialSecurity: sum(records.map((record) => record.fica.selfEmployment.socialSecurity)),
        medicare: sum(records.map((record) => record.fica.selfEmployment.medicare)),
        additionalMedicare: sum(records.map((record) => record.fica.selfEmployment.additionalMedicare)),
        total: sum(records.map((record) => record.fica.selfEmployment.total)),
        halfDeduction: sum(records.map((record) => record.fica.selfEmployment.halfDeduction)),
      },
      total: sum(records.map((record) => record.fica.total)),
    },
    state: sumStateTaxes(records.map((record) => record.state)),
    incomeSources: sumIncomeSources(records.map((record) => record.incomeSources)),
    totalTaxLiability: sum(records.map((record) => record.totalTaxLiability)),
    totalTaxesDue: sum(records.map((record) => record.totalTaxesDue)),
    totalTaxesRefund: sum(records.map((record) => record.totalTaxesRefund)),
    totalTaxableIncome: sum(records.map((record) => record.totalTaxableIncome)),
    adjustments: sumRecordOfAmounts(records.map((record) => record.adjustments)),
    deductions: sumRecordOfAmounts(records.map((record) => record.deductions)),
    deduction: sumDeductions(records.map((record) => record.deduction)),
  };
}

/** Computes annual federal taxes across all tax types for a simulation year */
export class TaxProcessor {
  /**
   * Carryover state, per **return** (P3-P1b).
   *
   * A married couple filing separately files two returns, and each carries its own capital-loss
   * carryover (the §1211(b) limit applies to a return) and its own minimum-tax credit (IRC §53). The
   * maps are keyed by `returnKey`, which is `''` for a household that files one return — so a single
   * or joint return keeps exactly the state it had before this item, and `process()`'s convergence
   * loop sees the same values it always did.
   *
   * The scalar accessors below are what the computation reads and writes; nothing else in the class
   * has to know which return it is pricing.
   */
  private readonly capitalLossCarryoverByReturn = new Map<string, number>();
  private readonly minimumTaxCreditByReturn = new Map<string, number>();
  /**
   * Unrecovered after-tax IRA basis per return (IRC §408(d)(2)).
   *
   * It is a carryforward like the two above — a year's tax-free share spends basis that later years
   * can no longer recover — so it is part of the re-settlement snapshot too. Seed from the plan's
   * accounts on first use and then spend it down; see `iraBasisAtStartOfYear`.
   */
  private readonly iraBasisRemainingByReturn = new Map<string, number>();
  private carryoverSnapshot: {
    capitalLoss: Map<string, number>;
    minimumTaxCredit: Map<string, number>;
    iraBasis: Map<string, number>;
  } | null = null;
  /**
   * Adjusted gross income by tax year, for the IRMAA lookback. Keyed by return, then by year, and
   * *overwritten* on every pass through a year, so the convergence loop (which re-settles a year up
   * to ten times) leaves one entry per year rather than ten. A separate return has its own MAGI
   * history, because the premium it pays is set by the return **it** filed two years earlier.
   */
  private readonly magiByYearByReturn = new Map<string, Map<TaxYear, number>>();
  /**
   * Which return is being priced right now: `''` for the household's single return, or the owning
   * member's role for one half of a separate-return pair. Set by `process()`/`processReturn()`.
   */
  private returnKey = '';
  /**
   * The year being settled — the year *asked for*, not the year the rules resolved from. They differ
   * whenever `getRules` falls back (a 2028 return uses the 2026 ruleset today), and the IRMAA
   * lookback has to be keyed by the return's own year, not by the fallback's.
   */
  private taxYear: TaxYear;
  private ruleset: FederalTaxRuleset;
  /** The state that files a return; absent settings mean California (see `TaxProcessorSettings`). */
  private readonly stateResidency: StateResidency;

  /**
   * @param taxYear - The tax year to settle, resolved through `getRules(taxYear)`.
   * @param rulesetOverride - Test-only injection of a ruleset (e.g. one whose `taxablePercentage`
   *   differs from the current law). Production callers resolve from `taxYear`.
   */
  constructor(
    private simulationState: SimulationState,
    private filingStatus: FilingStatus,
    taxYear: TaxYear = LATEST_TAX_YEAR,
    rulesetOverride?: FederalTaxRuleset,
    private deductionSettings: TaxProcessorSettings = {}
  ) {
    this.taxYear = taxYear;
    this.ruleset = rulesetOverride ?? getRules(taxYear);
    this.stateResidency = this.deductionSettings.stateResidency ?? 'CA';
  }

  /**
   * Points the processor at the ruleset for the year being settled. The engine calls this at each
   * annual reconciliation with the year its clock has reached, so a long projection does not
   * freeze the first year's rules for the whole run.
   */
  setTaxYear(taxYear: TaxYear): void {
    this.taxYear = taxYear;
    this.ruleset = getRules(taxYear);
  }

  /**
   * The plan's inflation assumption, as a percentage. Absent means none, which makes every
   * real-dollar divisor 1 and leaves a directly-constructed processor byte-identical to the code
   * before the deflation existed.
   */
  private get inflationRatePercent(): number {
    return this.deductionSettings.inflationRatePercent ?? 0;
  }

  /**
   * A table's dollar amounts in the plan's today-dollars.
   *
   * Federal tables resolve from `this.ruleset`, whose `year` can be older than `this.taxYear` (a
   * year with no ruleset of its own borrows the nearest prior one). California resolves its own
   * ruleset, so the caller passes that ruleset's year.
   *
   * Every reader of a dollar amount in a ruleset goes through here: an `indexed` table comes back
   * unchanged, a `fixed` one is deflated, and a rate is never touched.
   */
  private inRealDollars<TValues>(table: TableMeta<TValues>, rulesetYear: TaxYear = this.ruleset.year): TValues {
    return realDollarsIn(table, { rulesetYear, simYear: this.taxYear, inflationRatePercent: this.inflationRatePercent });
  }

  /**
   * Save carryover state before first tax calculation of the year.
   *
   * Both carryforwards are saved — the capital-loss carryover and the minimum-tax credit, which is
   * consumed by a year's return in exactly the same way, so re-settling the year must not consume it
   * twice — for **every** return the year files. A separate-return pair has two of each, and the
   * snapshot has to cover both or a re-settlement would spend one spouse's carryover twice.
   */
  saveCarryoverSnapshot(): void {
    this.carryoverSnapshot = {
      capitalLoss: new Map(this.capitalLossCarryoverByReturn),
      minimumTaxCredit: new Map(this.minimumTaxCreditByReturn),
      iraBasis: new Map(this.iraBasisRemainingByReturn),
    };
  }

  /** Restore carryover state before each convergence iteration */
  restoreCarryoverSnapshot(): void {
    if (this.carryoverSnapshot === null) return;

    this.capitalLossCarryoverByReturn.clear();
    for (const [key, value] of this.carryoverSnapshot.capitalLoss) this.capitalLossCarryoverByReturn.set(key, value);
    this.minimumTaxCreditByReturn.clear();
    for (const [key, value] of this.carryoverSnapshot.minimumTaxCredit) this.minimumTaxCreditByReturn.set(key, value);
    this.iraBasisRemainingByReturn.clear();
    for (const [key, value] of this.carryoverSnapshot.iraBasis) this.iraBasisRemainingByReturn.set(key, value);
  }

  /** The capital-loss carryover of the return being priced (IRC §1211(b)). */
  private get capitalLossCarryover(): number {
    return this.capitalLossCarryoverByReturn.get(this.returnKey) ?? 0;
  }

  private set capitalLossCarryover(value: number) {
    this.capitalLossCarryoverByReturn.set(this.returnKey, value);
  }

  /**
   * The after-tax IRA basis this return has left, at the start of the year being priced.
   *
   * Form 8606 line 2/5 is the basis at the beginning of the year; a distribution's tax-free share
   * spends it, and next year starts from what is left. The first call seeds it from the plan: a
   * single return owns every IRA's basis, and one half of a separate-return pair owns its share of
   * it by the same `ownershipShare` rule the portfolio split uses — an IRA cannot really be joint,
   * but the plan can say so, and reading it the same way everywhere is the only rule that cannot
   * disagree with itself.
   */
  private iraBasisAtStartOfYear(): number {
    const carried = this.iraBasisRemainingByReturn.get(this.returnKey);
    if (carried !== undefined) return carried;

    const byAccount = this.deductionSettings.iraBasisByAccount ?? {};
    const role = this.returnKey === '' ? null : (this.returnKey as HouseholdMemberRole);
    let initial = 0;
    for (const [accountId, basis] of Object.entries(byAccount)) {
      const share = role === null ? 1 : ownershipShare(this.deductionSettings.ownership?.accounts[accountId], role);
      initial += basis * share;
    }

    this.iraBasisRemainingByReturn.set(this.returnKey, initial);
    return initial;
  }

  /** The minimum-tax credit of the return being priced (IRC §53). */
  private get minimumTaxCreditCarryforward(): number {
    return this.minimumTaxCreditByReturn.get(this.returnKey) ?? 0;
  }

  private set minimumTaxCreditCarryforward(value: number) {
    this.minimumTaxCreditByReturn.set(this.returnKey, value);
  }

  /** The MAGI-by-year history of one return, created on first use. */
  private magiByYearFor(returnKey: string): Map<TaxYear, number> {
    let history = this.magiByYearByReturn.get(returnKey);
    if (history === undefined) {
      history = new Map<TaxYear, number>();
      this.magiByYearByReturn.set(returnKey, history);
    }

    return history;
  }

  /**
   * Calculates the year's taxes for the household.
   *
   * A household filing **one** return (single, joint, head of household) is priced by
   * `processReturn()` directly, and nothing about that path changed when the separate-return split
   * landed. A household filing **two** returns (§6013, `marriedFilingSeparately`) is priced by
   * `processSeparateReturns()`, which splits the year's inputs per owner and calls `processReturn()`
   * once for each — the same computation, twice, over two halves of the same year.
   *
   * @param annualPortfolioDataBeforeTaxes - Portfolio data before tax withdrawals
   * @param annualIncomesData - Aggregated annual income data
   * @param annualReturnsData - Annual investment return data
   * @param annualPhysicalAssetsData - Annual physical asset data
   * @param annualWagePayrollTaxes - Payroll tax already withheld from this year's wages, from
   *   `PayrollTaxProcessor`. Omitted means "no wages were paid" and every wage line is zero.
   * @returns Complete tax breakdown including income, capital gains, NIIT, FICA/SE and penalties
   */
  process(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualIncomesData: IncomesData,
    annualReturnsData: ReturnsData,
    annualPhysicalAssetsData: PhysicalAssetsData,
    annualWagePayrollTaxes: WagePayrollTaxes = zeroWagePayrollTaxes()
  ): TaxesData {
    if (this.filingStatus === 'marriedFilingSeparately') {
      return this.processSeparateReturns(
        annualPortfolioDataBeforeTaxes,
        annualIncomesData,
        annualReturnsData,
        annualPhysicalAssetsData,
        annualWagePayrollTaxes
      );
    }

    return this.processReturn(
      annualPortfolioDataBeforeTaxes,
      annualIncomesData,
      annualReturnsData,
      annualPhysicalAssetsData,
      annualWagePayrollTaxes
    );
  }

  /**
   * Calculates the conversion amount needed to fill the specified tax bracket up to its top.
   *
   * Evaluates taxable ordinary income (or CA taxable income) over [0, fromAccountBalance]
   * to find the conversion amount that lands within $1 of the bracket ceiling.
   */
  calculateFillToBracketAmount(
    conversion: ConversionInputs,
    fromAccountBalance: number,
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualIncomesData: IncomesData,
    annualReturnsData: ReturnsData,
    annualPhysicalAssetsData: PhysicalAssetsData,
    wagePayrollTaxes: WagePayrollTaxes = zeroWagePayrollTaxes()
  ): number {
    if (fromAccountBalance <= 0) return 0;
    if (!('fillToBracket' in conversion) || conversion.fillToBracket === undefined) return 0;

    const targetRate = typeof conversion.fillToBracket === 'number' ? conversion.fillToBracket : conversion.fillToBracket.targetBracketRate;
    const jurisdiction =
      typeof conversion.fillToBracket === 'object' && conversion.fillToBracket.jurisdiction
        ? conversion.fillToBracket.jurisdiction
        : 'federal';

    let ceiling: number;
    if (jurisdiction === 'california') {
      const caRules = getRules(this.taxYear, 'CA');
      const brackets = this.inRealDollars(caRules.tables.incomeTaxBrackets, caRules.year)[this.filingStatus];
      const targetBracket = brackets.find((b) => Math.abs(b.rate - targetRate) < 0.0001);
      if (!targetBracket) {
        throw new Error(
          `Target bracket rate ${targetRate} not found in California brackets for year ${this.taxYear} (${this.filingStatus})`
        );
      }
      ceiling = targetBracket.max;
    } else {
      const brackets = this.inRealDollars(this.ruleset.tables.incomeTaxBrackets, this.ruleset.year)[this.filingStatus];
      const targetBracket = brackets.find((b) => Math.abs(b.rate - targetRate) < 0.0001);
      if (!targetBracket) {
        throw new Error(`Target bracket rate ${targetRate} not found in federal brackets for year ${this.taxYear} (${this.filingStatus})`);
      }
      ceiling = targetBracket.max;
    }

    if (ceiling === Infinity) {
      return fromAccountBalance;
    }

    const evaluateTaxable = (candidateAmount: number): number => {
      const existingFromAccount = annualPortfolioDataBeforeTaxes.perAccountData[conversion.fromAccountId];
      const baseAccountData = existingFromAccount ?? {
        id: conversion.fromAccountId,
        type: 'ira' as const,
        balance: fromAccountBalance,
        costBasis: 0,
        contributions: zeroAssetAmounts(),
        withdrawals: zeroAssetAmounts(),
        yieldAmounts: zeroAssetAmounts(),
        conversions: 0,
      };

      const candidateData: PortfolioData = {
        ...annualPortfolioDataBeforeTaxes,
        conversions: (annualPortfolioDataBeforeTaxes.conversions ?? 0) + candidateAmount,
        perAccountData: {
          ...annualPortfolioDataBeforeTaxes.perAccountData,
          [conversion.fromAccountId]: {
            ...baseAccountData,
            conversions: (baseAccountData.conversions ?? 0) + candidateAmount,
            balance: Math.max(0, fromAccountBalance - candidateAmount),
          },
        },
      };

      this.saveCarryoverSnapshot();
      try {
        const taxes = this.process(candidateData, annualIncomesData, annualReturnsData, annualPhysicalAssetsData, wagePayrollTaxes);
        return jurisdiction === 'california' ? taxes.state.taxableIncome : taxes.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary;
      } finally {
        this.restoreCarryoverSnapshot();
      }
    };

    const baselineTaxable = evaluateTaxable(0);
    if (baselineTaxable >= ceiling) {
      return 0;
    }

    const maxTaxable = evaluateTaxable(fromAccountBalance);
    if (maxTaxable <= ceiling) {
      return fromAccountBalance;
    }

    let low = 0;
    let high = fromAccountBalance;
    for (let iter = 0; iter < 25; iter++) {
      const mid = (low + high) / 2;
      const taxable = evaluateTaxable(mid);
      if (taxable < ceiling) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return Math.round(low * 100) / 100;
  }

  /**
   * Prices **one** return: the whole of a single/joint/HOH household's year, or one spouse's half of
   * a separate-return year.
   *
   * This is the computation the class always performed, moved behind a method so it can be called
   * twice. It is deliberately unchanged in every other respect: the single-return path passes the
   * year's own inputs and the default `returnKey` of `''`, so its arithmetic and its carryover state
   * are what they were before the split existed (the frozen golden corpus is the witness).
   *
   * @param returnKey - Which return's carryover state and MAGI history to use: `''` for a
   *   household's only return, or the owning member's role for one half of a separate-return pair.
   */
  private processReturn(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualIncomesData: IncomesData,
    annualReturnsData: ReturnsData,
    annualPhysicalAssetsData: PhysicalAssetsData,
    annualWagePayrollTaxes: WagePayrollTaxes = zeroWagePayrollTaxes(),
    returnKey = ''
  ): TaxesData {
    this.returnKey = returnKey;

    const fica = this.processPayrollTaxes(annualIncomesData, annualWagePayrollTaxes);

    const incomeData = this.getTaxableIncomeData(
      annualPortfolioDataBeforeTaxes,
      annualIncomesData,
      annualReturnsData,
      annualPhysicalAssetsData,
      fica.selfEmployment.halfDeduction
    );

    const socialSecurityTaxes: SocialSecurityTaxesData = {
      taxableSocialSecurityIncome: incomeData.taxableSocialSecurityIncome,
      maxTaxablePercentage: incomeData.maxTaxableSocialSecurityPercentage,
      actualTaxablePercentage:
        incomeData.socialSecurityIncome > 0 ? incomeData.taxableSocialSecurityIncome / incomeData.socialSecurityIncome : 0,
      provisionalIncome: incomeData.provisionalIncome,
    };

    // The state return first (P3-P8): the federal itemized deduction includes state income tax paid,
    // so the federal SALT line cannot be figured until the state tax is. Nothing here is circular —
    // California's tax depends on the year's income and its own deduction rules, not on the federal
    // tax — so one pass is enough.
    const state = this.processStateTaxes(incomeData);

    // Which deduction the return takes (P3-P3): the larger of the standard deduction and the
    // itemized total, plus the senior deduction, which §151(d)(5)(C) allows on top of either. The
    // SALT line is the state tax just computed plus the property and local taxes the plan entered.
    const deduction = this.processDeductions(incomeData.adjustedGrossIncome, state.total);
    const deductionUsedForOrdinary = Math.min(deduction.total, incomeData.adjustedIncomeTaxedAsOrdinary);
    const deductionUsedForGains = deduction.total - deductionUsedForOrdinary;

    const taxableIncomeTaxedAsOrdinary = Math.max(0, incomeData.adjustedIncomeTaxedAsOrdinary - deductionUsedForOrdinary);
    const taxableIncomeTaxedAsCapitalGains = Math.max(0, incomeData.adjustedIncomeTaxedAsCapitalGains - deductionUsedForGains);

    const { federalIncomeTaxAmount, topMarginalFederalIncomeTaxRate, federalIncomeTaxBrackets } = this.processFederalIncomeTaxes({
      taxableIncomeTaxedAsOrdinary,
    });
    const federalIncomeTaxes: FederalIncomeTaxesData = {
      taxableIncomeTaxedAsOrdinary,
      federalIncomeTaxAmount,
      effectiveFederalIncomeTaxRate: incomeData.totalIncome > 0 ? federalIncomeTaxAmount / incomeData.totalIncome : 0,
      topMarginalFederalIncomeTaxRate,
      federalIncomeTaxBrackets,
      capitalLossDeduction: incomeData.capitalLossDeduction !== 0 ? incomeData.capitalLossDeduction : undefined,
    };

    const { capitalGainsTaxAmount, topMarginalCapitalGainsTaxRate, capitalGainsTaxBrackets } = this.processCapitalGainsTaxes({
      taxableIncomeTaxedAsCapitalGains,
      taxableIncomeTaxedAsOrdinary,
    });
    const capitalGainsTaxes: CapitalGainsTaxesData = {
      taxableIncomeTaxedAsCapitalGains,
      capitalGainsTaxAmount,
      effectiveCapitalGainsTaxRate:
        incomeData.adjustedIncomeTaxedAsCapitalGains > 0 ? capitalGainsTaxAmount / incomeData.adjustedIncomeTaxedAsCapitalGains : 0,
      topMarginalCapitalGainsTaxRate,
      capitalGainsTaxBrackets,
    };

    const niit = this.processNIIT(incomeData);

    const earlyWithdrawalPenalties = this.processEarlyWithdrawalPenalties(incomeData.earlyWithdrawals);

    // AMT is measured against the regular income tax (ordinary + gains), which is why it is computed
    // from the two lines above rather than from the reconciled total: payroll taxes and NIIT are not
    // part of the tax the alternative minimum tax competes with.
    const amt = this.processAlternativeMinimumTax({
      taxableIncome: taxableIncomeTaxedAsOrdinary + taxableIncomeTaxedAsCapitalGains,
      // The lines actually taken, scaled by how much of the deduction the year's income could use.
      // §56(b)(1) then adds back the disallowed ones — the standard deduction, or the SALT line —
      // which is how itemized preferences reach AMTI without any itemized-specific code.
      appliedDeductions: this.deductionsTaken(deduction),
      deductionUsedFraction:
        deduction.total > 0
          ? Math.min(1, (incomeData.adjustedIncomeTaxedAsOrdinary + incomeData.adjustedIncomeTaxedAsCapitalGains) / deduction.total)
          : 0,
      netCapitalGains: taxableIncomeTaxedAsCapitalGains,
      regularIncomeTax: federalIncomeTaxes.federalIncomeTaxAmount + capitalGainsTaxes.capitalGainsTaxAmount,
    });

    const irmaa = this.processIrmaa({ magi: incomeData.adjustedGrossIncome, taxYear: this.taxYear });

    // The one reconciled total. Every tax line is added here and nowhere else, and the
    // reconciliation test in `taxes.test.ts` asserts this equality line by line.
    const totalTaxLiability =
      federalIncomeTaxes.federalIncomeTaxAmount +
      capitalGainsTaxes.capitalGainsTaxAmount +
      amt.netCharge +
      niit.niitAmount +
      irmaa.total +
      state.total +
      earlyWithdrawalPenalties.totalPenaltyAmount +
      fica.total;

    // Payroll tax on wages was withheld from the paycheque as the year went by, so only the
    // self-employment tax inside `fica` is still owed (plus or minus the income-tax true-up).
    const withheld = annualIncomesData.totalAmountWithheld + fica.wages.total;
    const difference = totalTaxLiability - withheld;

    return {
      federalIncomeTaxes,
      capitalGainsTaxes,
      amt,
      irmaa,
      niit,
      earlyWithdrawalPenalties,
      socialSecurityTaxes,
      fica,
      state,
      incomeSources: incomeData,
      totalTaxLiability,
      totalTaxesDue: difference > 0 ? difference : 0,
      totalTaxesRefund: difference < 0 ? Math.abs(difference) : 0,
      totalTaxableIncome: taxableIncomeTaxedAsOrdinary + taxableIncomeTaxedAsCapitalGains,
      adjustments: {
        taxDeductibleContributions: incomeData.taxDeductibleContributions,
        capitalLossDeduction: incomeData.capitalLossDeduction,
        section121Exclusion: incomeData.section121Exclusion,
        selfEmploymentTaxDeduction: fica.selfEmployment.halfDeduction,
      },
      deductions: { ...this.deductionsTaken(deduction), seniorDeduction: deduction.seniorDeduction },
      deduction,
    };
  }

  /**
   * Prices a **separate-return** year (§6013, P3-P1b): one return per spouse, then the two added.
   *
   * Each return is the ordinary computation over its own half of the year, so the split is the whole
   * of this method's work. California is a community-property state (E2, F10), and the rule the
   * helpers below apply is:
   *
   * | item | on each return |
   * | --- | --- |
   * | a `primary`/`partner` account, asset or income | its owner's return, in full |
   * | a `joint` (community) item | half on each — the Form 8958 allocation |
   * | an absent owner | reads as `primary`, as `ownerOf` does everywhere |
   *
   * `portfolioForSeparateReturn`, `returnsForSeparateReturn`, `physicalAssetsForSeparateReturn` and
   * `incomesForSeparateReturn` do the entity-level dividing. Three things are not entity data and are
   * handled here: the plan-level itemized deductions (halved, see `separateReturnDeductionSettings`),
   * the wage payroll tax already withheld (apportioned, see `withheldPayrollShare`), and the pairing
   * of the two results (`sumSeparateReturns`).
   *
   * Each return is priced with its own `returnKey`, so the three pieces of processor state that
   * belong to a *return* rather than to a household stay separate: the capital-loss carryover
   * (§1211(b)), the minimum-tax credit (§53) and the IRMAA lookback (a premium is set by the return
   * that was filed two years earlier).
   *
   * Two things are deliberately not modelled. The §86(c)(1)(C) lived-apart exception: a separate
   * return is always the collapsed 85%-from-dollar-one rule (see
   * `getTaxablePortionOfSocialSecurityIncome`). And the partner's own age where the computation asks
   * for one — the early-withdrawal gate and the senior deduction read `simulationState`, which runs on
   * the primary's plan axis, so a partner of a different age is treated as the primary's age for those
   * two gates. Per-member RMD ages are the engine's business (§1-P3) and are unaffected.
   */
  private processSeparateReturns(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualIncomesData: IncomesData,
    annualReturnsData: ReturnsData,
    annualPhysicalAssetsData: PhysicalAssetsData,
    annualWagePayrollTaxes: WagePayrollTaxes
  ): TaxesData {
    // No recorded ownership means every item reads as `primary` — `ownerOf`'s own default — so the
    // partner's return is an empty one. A plan written before ownership existed therefore divides
    // exactly as a single person's would, which is the only reading its data supports.
    const ownership: ReturnOwnership = this.deductionSettings.ownership ?? { accounts: {}, physicalAssets: {} };
    const householdSettings = this.deductionSettings;

    try {
      // Both returns take the same split settings (each deducts half the household's itemized
      // lines). The state that differs per return is `returnKey`, which `processReturn()` sets.
      this.deductionSettings = this.separateReturnDeductionSettings();

      const returns = SEPARATE_RETURN_OWNERS.map((returnOwner) =>
        this.processReturn(
          portfolioForSeparateReturn(annualPortfolioDataBeforeTaxes, ownership, returnOwner),
          incomesForSeparateReturn(annualIncomesData, annualIncomesData.perOwnerData?.[returnOwner], returnOwner),
          returnsForSeparateReturn(annualReturnsData, annualPortfolioDataBeforeTaxes, ownership, returnOwner),
          physicalAssetsForSeparateReturn(annualPhysicalAssetsData, ownership, returnOwner),
          wagePayrollForSeparateReturn(annualWagePayrollTaxes, withheldPayrollShare(annualIncomesData, returnOwner)),
          returnOwner
        )
      );

      return sumSeparateReturns(returns);
    } finally {
      this.deductionSettings = householdSettings;
    }
  }

  /**
   * One separate return's slice of the plan-level deduction settings.
   *
   * The itemized block is a **household** figure — one mortgage, one property-tax bill, one
   * charitable total — and in California the property those expenses are paid on is community
   * property (F10), so each return deducts half of every entered line. That keeps the two returns
   * adding up to the household's figure: giving each return the whole block would deduct the
   * mortgage twice, and giving it all to the primary would put a community expense on one return.
   *
   * The SALT cap needs no halving here: `saltCapFor` applies §164(b)(7) to the separate return's cap
   * and phase-down threshold itself, and each return's SALT line then carries its own California tax
   * plus its half of the entered property and local taxes.
   *
   * `spouseQualifiesForSeniorDeduction` is dropped rather than halved: a separate return may not
   * claim the senior deduction at all, which the table declares
   * (`SeniorDeductionTable.eligible`). Ownership and the state residency carry through unchanged.
   */
  private separateReturnDeductionSettings(): TaxProcessorSettings {
    const entered = this.deductionSettings.itemizedDeductions;

    return {
      ...this.deductionSettings,
      itemizedDeductions:
        entered === undefined
          ? undefined
          : {
              mortgageInterest: entered.mortgageInterest / 2,
              charitable: entered.charitable / 2,
              stateAndLocalTaxes: entered.stateAndLocalTaxes / 2,
              medicalExpenses: entered.medicalExpenses / 2,
            },
      spouseQualifiesForSeniorDeduction: undefined,
    };
  }

  /**
   * The alternative minimum tax, computed beside the regular tax (IRC §55).
   *
   * The AMT is a parallel system: AMTI starts from the regular taxable income, adds back the
   * deductions §56(b)(1) disallows, subtracts an exemption that phases out at 25 cents per dollar,
   * and applies 26%/28% to the ordinary slice. Long-term gains keep their preferential rates, so
   * they are taxed against the same capital-gains brackets, stacked on the AMT ordinary base. The
   * tentative minimum tax is then compared with the regular income tax, and **only the excess is
   * charged** — that is what keeps `totalTaxLiability` a plain sum (see the header).
   *
   * Hand check (2026, single, $150,000 of wages, no other income, no capital gains):
   *   regular taxable income = 150,000 − 16,100 = $133,900
   *   AMTI  = 133,900 + 16,100 (the standard deduction is disallowed)        = $150,000
   *   exemption = 90,100 (AMTI is below the $500,000 phase-out start)        = $90,100
   *   AMT base = 150,000 − 90,100 = $59,900, below the $175,000 28% ceiling
   *   tentative minimum tax = 59,900 × 26%                                   = $15,574
   *   regular tax on 133,900 = 1,240 + 4,560 + 12,166 + 28,200 × 24%         = $24,734
   *   topUp = max(0, 15,574 − 24,734) = $0 → `applied: 'regular'` (the AMT is shadowed)
   *
   * Hand check (2026, single, $1,000,000 of wages):
   *   regular taxable income = 983,900
   *   AMTI = $1,000,000; exemption = 90,100 − 25% × (1,000,000 − 500,000) = $0 (fully phased out)
   *   AMT base = 1,000,000; ordinary tax = 175,000 × 26% + 825,000 × 28% = $276,500
   *   regular tax on 983,900 ≈ $313,518 (see the bracket table) → the AMT is still shadowed;
   *   the phase-out is what the exemption test exercises, not the payment.
   */
  private processAlternativeMinimumTax({
    taxableIncome,
    appliedDeductions,
    deductionUsedFraction,
    netCapitalGains,
    regularIncomeTax,
  }: {
    taxableIncome: number;
    appliedDeductions: Record<string, number>;
    /** How much of the deduction the year's income could actually use (1 when income covers it). */
    deductionUsedFraction: number;
    netCapitalGains: number;
    regularIncomeTax: number;
  }): AlternativeMinimumTaxesData {
    const table = this.inRealDollars(this.ruleset.tables.alternativeMinimumTax);

    // The deductions the regular return took that AMT does not allow (IRC §56(b)(1)): the standard
    // deduction, or the itemized lines it names — state and local taxes, miscellaneous itemized
    // deductions. Qualified mortgage interest and charitable contributions survive, so they are
    // simply not on the list. Scaling by the fraction the income could use keeps AMTI from
    // inheriting a deduction the regular return never got to take.
    const addbacks = table.disallowedDeductions.reduce((total, id) => total + (appliedDeductions[id] ?? 0) * deductionUsedFraction, 0);

    const amtIncome = taxableIncome + addbacks;

    const exemption = Math.max(
      0,
      table.exemption[this.filingStatus] -
        table.exemptionPhaseOutRate * Math.max(0, amtIncome - table.exemptionPhaseOutThreshold[this.filingStatus])
    );

    const amtBase = Math.max(0, amtIncome - exemption);
    const gainsInBase = Math.min(amtBase, Math.max(0, netCapitalGains));
    const ordinaryInBase = amtBase - gainsInBase;

    const lowCeiling = table.rateLowCeiling[this.filingStatus];
    const ordinaryTax = Math.min(ordinaryInBase, lowCeiling) * table.rateLow + Math.max(0, ordinaryInBase - lowCeiling) * table.rateHigh;

    // The preferential rates apply to the gain slice exactly as they do on the regular return; the
    // same bracketing traversal is reused so the two systems cannot disagree about the brackets.
    const capitalGainsTax = this.processCapitalGainsTaxes({
      taxableIncomeTaxedAsCapitalGains: gainsInBase,
      taxableIncomeTaxedAsOrdinary: ordinaryInBase,
    }).capitalGainsTaxAmount;

    const tentativeMinimumTax = ordinaryTax + capitalGainsTax;
    const topUp = Math.max(0, tentativeMinimumTax - regularIncomeTax);

    // IRC §53: a prior-year minimum tax is creditable against the excess of the regular tax over the
    // tentative minimum tax. The simplified limit only — the deferral-item refinement of Form 8801
    // Part III is not modelled (Plan 3: "no full AMT credit machinery").
    const creditApplied = Math.min(this.minimumTaxCreditCarryforward, Math.max(0, regularIncomeTax - tentativeMinimumTax));
    this.minimumTaxCreditCarryforward = this.minimumTaxCreditCarryforward - creditApplied + topUp;

    return {
      regularIncomeTax,
      amtIncome,
      addbacks,
      exemption,
      ordinaryTax,
      capitalGainsTax,
      tentativeMinimumTax,
      topUp,
      creditApplied,
      netCharge: topUp - creditApplied,
      applied: topUp > 0 ? 'amt' : 'regular',
      creditCarryforward: this.minimumTaxCreditCarryforward,
    };
  }

  /**
   * The Medicare Part B + D income-related monthly adjustment charged in the year being settled.
   *
   * The tier is set from the return filed `lookbackYears` earlier (two), so this processor keeps the
   * MAGI of each settled year. The first `lookbackYears` years of a run charge nothing: there is no
   * earlier return to look at, and assuming one would be worse than charging zero.
   *
   * Hand check (2026, single, MAGI $110,000 two years earlier):
   *   tier 1 (> $109,000, ≤ $137,000): Part B $81.20 + Part D $14.50 = $95.70 a month
   *   the year charges 95.70 × 12 = $1,148.40
   */
  private processIrmaa({ magi, taxYear }: { magi: number; taxYear: TaxYear }): IrmaaData {
    // The lookback follows the *return*, not the household: a separate return's premium is set by
    // the MAGI on that return two years earlier (P3-P1b).
    const magiByYear = this.magiByYearFor(this.returnKey);
    magiByYear.set(taxYear, magi);

    const table = this.inRealDollars(this.ruleset.tables.medicareIrmaa);
    const basisTaxYear = taxYear - table.lookbackYears;
    const basisMagi = magiByYear.get(basisTaxYear) ?? null;
    const tiers = table.tiers[this.filingStatus];

    if (basisMagi === null) {
      return {
        basisMagi: null,
        basisTaxYear,
        chargedInTaxYear: taxYear,
        tier: 0,
        partBMonthly: 0,
        partDMonthly: 0,
        total: 0,
      };
    }

    const tierIndex = irmaaTierFor(basisMagi, tiers);
    const tier = tiers[tierIndex];

    return {
      basisMagi,
      basisTaxYear,
      chargedInTaxYear: taxYear,
      tier: tierIndex,
      partBMonthly: tier.partBMonthly,
      partDMonthly: tier.partDMonthly,
      total: (tier.partBMonthly + tier.partDMonthly) * 12,
    };
  }

  /**
   * A progressive walk over a bracket schedule, for the state return.
   *
   * The federal walk is inline in `processFederalIncomeTaxes` (it also reports the top marginal
   * rate); the state one only needs the amount, so it lives here rather than being duplicated.
   */
  private progressiveTaxOn(taxableIncome: number, brackets: readonly ProgressiveBracket[]): number {
    let tax = 0;
    for (const bracket of brackets) {
      if (taxableIncome <= bracket.min) break;
      tax += (Math.min(taxableIncome, bracket.max) - bracket.min) * bracket.rate;
    }
    return tax;
  }

  /**
   * The California return (P3-P8).
   *
   * California starts from its own income base, not the federal taxable income: Social Security is
   * excluded entirely, capital gains and qualified dividends are ordinary income, and the deduction
   * is the state's own choice between its standard deduction and its itemized total (limited above
   * an AGI threshold). Each of those differences is a flag in the ruleset's `conformity` table, so
   * the state pass reads the table rather than testing `jurisdiction === 'CA'` in five places.
   *
   * Hand check (2025 ruleset, single, $100,000 of wages and nothing else):
   *   CA income = $100,000; standard deduction $5,706 (no itemized lines, so standard wins)
   *   CA taxable income = $94,294 → Schedule X, 9.3% band:
   *     3,201.97 (the schedule's tax at $72,724) + 9.3% × (94,294 − 72,724 = 21,570)
   *     = 3,201.97 + 2,006.01 = $5,207.98
   *   less the $153 personal exemption credit (AGI is under the $252,203 limit) = $5,054.98
   */
  private processStateTaxes(incomeData: IncomeSourcesData): StateTaxesData {
    const zero: StateTaxesData = {
      jurisdiction: 'none',
      resolvedYear: null,
      income: 0,
      deduction: { type: 'standard', standard: 0, itemized: 0, limitation: 0, taken: 0 },
      taxableIncome: 0,
      bracketTax: 0,
      behavioralHealthServicesTax: 0,
      exemptionCredits: 0,
      total: 0,
    };

    if (this.stateResidency === 'none') return zero;

    const rules = getRules(this.taxYear, 'CA');
    const conformity = this.inRealDollars(rules.tables.conformity, rules.year);
    const agi = incomeData.adjustedGrossIncome;
    const entered = this.deductionSettings.itemizedDeductions;

    // The income base: everything the federal return taxes as income, with two ruleset flags
    // deciding the differences. Capital gains are ordinary here, so they are in the base with no
    // preferential schedule to stack them on.
    let income =
      incomeData.earnedIncome +
      incomeData.taxableRetirementDistributions +
      incomeData.taxableInterestIncome +
      incomeData.taxableDividendIncome +
      incomeData.realizedGains;
    if (conformity.taxesSocialSecurity) income += incomeData.taxableSocialSecurityIncome;

    // The itemized lines, keyed so the ruleset's `disallowed` list can filter them: California does
    // not allow a deduction for state income tax, SDI or sales tax, and does allow property tax,
    // mortgage interest, charitable contributions and medical expenses above the floor.
    const itemizedLines: Record<string, number> = {
      propertyTax: entered?.stateAndLocalTaxes ?? 0,
      mortgageInterest: entered?.mortgageInterest ?? 0,
      charitable: entered?.charitable ?? 0,
      medicalExpenses: Math.max(0, (entered?.medicalExpenses ?? 0) - conformity.medicalExpenseFloor * agi),
    };
    // The CA high-income limitation: 6% of AGI over the threshold, capped at 80% of the deduction.
    const limit = this.inRealDollars(rules.tables.itemizedDeductionLimit, rules.year);
    const itemizedEntered = Object.entries(itemizedLines)
      .filter(([id]) => !limit.disallowed.includes(id))
      .reduce((total, [, amount]) => total + amount, 0);
    const excessAgi = Math.max(0, agi - limit.agiThreshold[this.filingStatus]);
    const limitation = Math.min(itemizedEntered * limit.maxReductionShare, limit.rate * excessAgi);
    const itemized = Math.max(0, itemizedEntered - limitation);

    const standard = this.inRealDollars(rules.tables.standardDeduction, rules.year)[this.filingStatus];
    const deductionType: 'standard' | 'itemized' = itemized > standard ? 'itemized' : 'standard';
    const seniorDeduction = conformity.allowsFederalSeniorDeduction ? this.seniorDeductionFor(agi) : 0;
    const deductionTaken = (deductionType === 'itemized' ? itemized : standard) + seniorDeduction;

    const taxableIncome = Math.max(0, income - deductionTaken);
    const bracketTax = this.progressiveTaxOn(
      taxableIncome,
      this.inRealDollars(rules.tables.incomeTaxBrackets, rules.year)[this.filingStatus]
    );

    const surcharge = this.inRealDollars(rules.tables.behavioralHealthServicesTax, rules.year);
    const behavioralHealthServicesTax = Math.max(0, taxableIncome - surcharge.threshold[this.filingStatus]) * surcharge.rate;

    // Personal exemption credits: one per taxpayer, reduced by $6 for each $2,500 (or part) of AGI
    // over the limit — $1,250 on a separate return, which is why the step is per filing status. It
    // is a credit against the tax, so it cannot make the tax negative. A separate return is one
    // taxpayer, so `taxpayers` counts the joint return only.
    const credit = this.inRealDollars(rules.tables.personalExemptionCredit, rules.year);
    const taxpayers = this.filingStatus === 'marriedFilingJointly' ? 2 : 1;
    const stepsOver = Math.ceil(Math.max(0, agi - credit.agiLimit[this.filingStatus]) / credit.reductionStep[this.filingStatus]);
    const exemptionCredits = Math.max(0, credit.perTaxpayer * taxpayers - stepsOver * credit.reductionPerStep);

    return {
      jurisdiction: 'CA',
      resolvedYear: rules.year,
      income,
      deduction: { type: deductionType, standard, itemized, limitation, taken: deductionTaken },
      taxableIncome,
      bracketTax,
      behavioralHealthServicesTax,
      exemptionCredits,
      total: Math.max(0, bracketTax + behavioralHealthServicesTax - exemptionCredits),
    };
  }

  /**
   * The deduction the return takes, and why (P3-P3).
   *
   * The rule is the larger of the standard deduction and the itemized total, with a tie going to the
   * standard deduction, plus the §151(d)(5)(C) senior deduction on top. Two statutory limits are
   * applied here rather than by the user: the SALT cap (with its MAGI phase-down) and the 7.5%-of-AGI
   * floor on medical expenses.
   *
   * Hand check (2026, single, AGI $200,000, itemized: SALT $50,000, mortgage interest $20,000,
   * charitable $10,000, medical $30,000):
   *   SALT: cap 40,400 (MAGI is under the $505,000 phase-down) → min(50,000, 40,400) = $40,400
   *   medical: 30,000 − 7.5% × 200,000 = 30,000 − 15,000            = $15,000
   *   itemized total = 40,400 + 20,000 + 10,000 + 15,000            = $85,400
   *   standard = $16,100 → itemized wins; senior = 0 (under 65)      → total $85,400
   */
  private processDeductions(adjustedGrossIncome: number, stateIncomeTax: number): DeductionData {
    const standardDeduction = this.getStandardDeduction();
    const entered = this.deductionSettings.itemizedDeductions;
    const salt = saltCapFor(this.taxYear, adjustedGrossIncome, this.filingStatus, this.inflationRatePercent);
    const medicalFloor = this.inRealDollars(this.ruleset.tables.medicalExpenseFloor);

    // The federal SALT deduction is state income tax **plus** the property and local taxes the plan
    // entered. With California on, the income-tax half is the CA tax just computed rather than an
    // estimate the user typed; with it off, the entered amount is all there is. (This is why the
    // itemized field is described as property and local taxes: the engine knows the state income
    // tax, the plan knows the rest.)
    const enteredSalt = entered?.stateAndLocalTaxes ?? 0;
    const saltBeforeCap = stateIncomeTax + enteredSalt;

    const lines = {
      mortgageInterest: entered?.mortgageInterest ?? 0,
      charitable: entered?.charitable ?? 0,
      stateAndLocalTaxes: Math.min(saltBeforeCap, salt.cap),
      medicalExpenses: Math.max(0, (entered?.medicalExpenses ?? 0) - medicalFloor * adjustedGrossIncome),
    };
    const itemizedTotal = lines.mortgageInterest + lines.charitable + lines.stateAndLocalTaxes + lines.medicalExpenses;

    // A tie goes to the standard deduction: it is simpler to explain and it is what the form does
    // when the two are equal (there is nothing to itemize *for*).
    const type: 'standard' | 'itemized' = itemizedTotal > standardDeduction ? 'itemized' : 'standard';
    const base = type === 'itemized' ? itemizedTotal : standardDeduction;
    const seniorDeduction = this.seniorDeductionFor(adjustedGrossIncome);

    return {
      type,
      standardDeduction,
      itemized: { ...lines, total: itemizedTotal },
      saltCap: {
        entered: saltBeforeCap,
        allowed: lines.stateAndLocalTaxes,
        phaseDown: saltBeforeCap - lines.stateAndLocalTaxes,
        resolvedYear: salt.resolvedYear,
      },
      seniorDeduction,
      total: base + seniorDeduction,
    };
  }

  /**
   * The lines the return actually deducted, keyed by the names §56(b)(1) uses.
   *
   * This is the record the AMT addback reads: it names the standard deduction when that was taken,
   * or the itemized lines when they were, and never both.
   */
  private deductionsTaken(deduction: DeductionData): Record<string, number> {
    if (deduction.type === 'itemized') {
      const { mortgageInterest, charitable, stateAndLocalTaxes, medicalExpenses } = deduction.itemized;
      return { mortgageInterest, charitable, stateAndLocalTaxes, medicalExpenses };
    }

    return { standardDeduction: deduction.standardDeduction };
  }

  /**
   * The temporary senior deduction (IRC §151(d)(5)(C), P.L. 119-21 §70103).
   *
   * $6,000 for each individual on the return who is 65 or older at the end of the year, reduced by
   * 6% of MAGI over $75,000 ($150,000 on a joint return), for tax years beginning before 2029 — the
   * sunset is read from the table, so a 2029 return gets nothing rather than last year's amount.
   *
   * The primary's age is the simulation clock's age (the plan axis). A spouse's age is not part of
   * the tax inputs, so a joint return counts the spouse only when the plan says so; absent means
   * "under 65", the conservative reading.
   *
   * A married individual filing separately claims nothing: the paragraph denies the deduction where
   * the individual's spouse also claims it, and this engine prices one return at a time, so it
   * cannot see the spouse's return to decide. The table declares the status ineligible, which is a
   * statement about the return rather than a computed zero.
   *
   * Hand check (2026, single, age 67, MAGI $80,000): 6,000 − 6% × (80,000 − 75,000) = $5,700.
   */
  private seniorDeductionFor(adjustedGrossIncome: number): number {
    const table = this.inRealDollars(this.ruleset.tables.seniorDeduction);
    if (this.taxYear > table.lastTaxYear) return 0;
    // Declared, not computed: a separate return may not claim the deduction at all (P3-P1b). See
    // `SeniorDeductionTable.eligible` — a zero amount would look like a computed value.
    if (!table.eligible[this.filingStatus]) return 0;

    const primaryQualifies = this.simulationState.time.age >= 65;
    const spouseQualifies =
      this.filingStatus === 'marriedFilingJointly' && this.deductionSettings.spouseQualifiesForSeniorDeduction === true;
    const qualifiedIndividuals = (primaryQualifies ? 1 : 0) + (spouseQualifies ? 1 : 0);
    if (qualifiedIndividuals === 0) return 0;

    const excess = Math.max(0, adjustedGrossIncome - table.phaseOutThreshold[this.filingStatus]);
    return Math.max(0, table.perIndividual * qualifiedIndividuals - table.phaseOutRate * excess);
  }

  /**
   * Assembles the payroll-tax group: wages already withheld, plus the self-employment tax on the
   * year's net self-employment earnings.
   *
   * Hand check (2026, single, no wages, $100,000 of net self-employment earnings):
   *   SE tax   = 92,350 × 15.3%  = $14,129.55
   *   half     = $7,064.775      → above-the-line deduction
   *   fica.total = 0 + 14,129.55 = $14,129.55, of which `fica.wages.total` is 0 (nothing withheld)
   */
  private processPayrollTaxes(annualIncomesData: IncomesData, annualWagePayrollTaxes: WagePayrollTaxes): FicaTaxesData {
    const wages = { ...annualWagePayrollTaxes };

    // The OASDI wage base is shared between wages and self-employment earnings, and the Additional
    // Medicare threshold is a combined one, so the SE calculation needs the year's wage total.
    const selfEmployment = computeSelfEmploymentTaxes({
      netEarnings: annualIncomesData.totalSelfEmploymentIncome ?? 0,
      wages: annualIncomesData.totalWageIncome ?? 0,
      filingStatus: this.filingStatus,
      taxYear: this.ruleset.year,
      inflationRatePercent: this.inflationRatePercent,
    });

    return { wages, selfEmployment, total: wages.total + selfEmployment.total };
  }

  /** Assembles all income sources and computes adjusted gross income */
  private getTaxableIncomeData(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualIncomesData: IncomesData,
    annualReturnsData: ReturnsData,
    annualPhysicalAssetsData: PhysicalAssetsData,
    selfEmploymentTaxDeduction: number
  ): IncomeSourcesData {
    const age = this.simulationState.time.age;

    const regularQualifiedWithdrawalAge = 59.5;
    const hsaQualifiedWithdrawalAge = 65;

    let taxDeferredWithdrawals = 0;
    let earlyRothEarningsWithdrawals = 0;
    let earlyUnseasonedConversions = 0;
    let early401kAndIraWithdrawals = 0;
    let earlyHsaWithdrawals = 0;
    // The §408(d)(2) aggregate: only an `ira` is apportioned by Form 8606, so its distributions and
    // its year-end balance are tracked apart from the employer plans sharing `taxDeferredWithdrawals`.
    let iraDistributions = 0;
    let iraYearEndBalance = 0;
    let earlyIraWithdrawals = 0;

    for (const account of Object.values(annualPortfolioDataBeforeTaxes.perAccountData)) {
      switch (account.type) {
        case 'roth401k':
        case 'roth403b':
        case 'rothIra': {
          if (age < regularQualifiedWithdrawalAge) {
            const annualEarningsWithdrawn = account.earningsWithdrawn;

            earlyRothEarningsWithdrawals += annualEarningsWithdrawn;
          }
          if (account.unseasonedConversionsWithdrawn && account.unseasonedConversionsWithdrawn > 0) {
            earlyUnseasonedConversions += account.unseasonedConversionsWithdrawn;
          }
          break;
        }
        case '401k':
        case '403b': {
          const annualWithdrawals = sumFlows(account.withdrawals);
          const annualConversions = account.conversions ?? 0;

          taxDeferredWithdrawals += annualWithdrawals + annualConversions;
          if (age < regularQualifiedWithdrawalAge) early401kAndIraWithdrawals += annualWithdrawals;
          break;
        }
        case 'ira': {
          const annualWithdrawals = sumFlows(account.withdrawals);
          const annualConversions = account.conversions ?? 0;

          taxDeferredWithdrawals += annualWithdrawals + annualConversions;
          iraDistributions += annualWithdrawals + annualConversions;
          // Form 8606 line 6 is the 12/31 balance, which `balance` already is: the year's
          // withdrawals and conversions have left it. The fraction adds the distributions back to get the balance
          // the basis is measured against.
          iraYearEndBalance += account.balance;
          if (age < regularQualifiedWithdrawalAge) {
            early401kAndIraWithdrawals += annualWithdrawals;
            earlyIraWithdrawals += annualWithdrawals;
          }
          break;
        }
        case 'hsa': {
          const annualWithdrawals = sumFlows(account.withdrawals);

          taxDeferredWithdrawals += annualWithdrawals;
          if (age < hsaQualifiedWithdrawalAge) earlyHsaWithdrawals += annualWithdrawals;
          break;
        }
        default:
          break;
      }
    }

    // IRC §408(d)(2): one basis is shared by every traditional IRA the owner holds, and every
    // distribution carries the same tax-free fraction — basis / (year-end balance + distributions).
    // The recovered basis is spent, so later years measure against what is left.
    const iraSplit = prorateIraDistribution({
      yearEndBalance: iraYearEndBalance,
      basis: this.iraBasisAtStartOfYear(),
      distribution: iraDistributions,
    });
    this.iraBasisRemainingByReturn.set(this.returnKey, iraSplit.remainingBasis);
    // Only the includible part is income — and §72(t)'s 10% additional tax is charged on the
    // includible part alone, so the early-withdrawal base shrinks by the same amount.
    taxDeferredWithdrawals -= iraSplit.nontaxableAmount;
    const nontaxableEarlyIra = earlyIraWithdrawals > 0 ? earlyIraWithdrawals * iraSplit.exclusionRatio : 0;
    early401kAndIraWithdrawals = Math.max(0, early401kAndIraWithdrawals - nontaxableEarlyIra);

    const taxableRetirementDistributions = taxDeferredWithdrawals + earlyRothEarningsWithdrawals;
    const { realizedGains, capitalLossDeduction, section121Exclusion } = this.getRealizedGainsAndCapLossDeductionData(
      annualPortfolioDataBeforeTaxes,
      annualPhysicalAssetsData
    );
    const taxableDividendIncome = annualReturnsData.yieldAmounts.taxable.stocks;
    const taxableInterestIncome = annualReturnsData.yieldAmounts.taxable.bonds + annualReturnsData.yieldAmounts.cashSavings.cash;

    const totalIncomeFromIncomes = annualIncomesData.totalIncome;
    const socialSecurityIncome = annualIncomesData.totalSocialSecurityIncome;
    const taxFreeIncome = annualIncomesData.totalTaxFreeIncome;
    const earnedIncome = totalIncomeFromIncomes - socialSecurityIncome - taxFreeIncome;

    const incomeTaxedAsOrdinaryExceptSocSec = earnedIncome + taxableRetirementDistributions + taxableInterestIncome;
    const incomeTaxedAsLtcg = realizedGains + taxableDividendIncome;
    const grossIncomeExceptSocSec = incomeTaxedAsOrdinaryExceptSocSec + incomeTaxedAsLtcg;

    const taxDeferredAccountTypes: AccountInputs['type'][] = ['401k', '403b', 'ira', 'hsa'];
    const taxDeductibleContributions = this.getEmployeeContributionsForAccountTypes(
      annualPortfolioDataBeforeTaxes,
      taxDeferredAccountTypes
    );

    const totalAdjustments = taxDeductibleContributions + capitalLossDeduction + selfEmploymentTaxDeduction;
    const adjustmentsAppliedToOrdinary = Math.min(totalAdjustments, incomeTaxedAsOrdinaryExceptSocSec);
    const adjustmentsAppliedToCapitalGains = totalAdjustments - adjustmentsAppliedToOrdinary;

    const adjustedIncomeTaxedAsOrdinaryExceptSocSec = incomeTaxedAsOrdinaryExceptSocSec - adjustmentsAppliedToOrdinary;
    const adjustedIncomeTaxedAsCapitalGains = Math.max(0, incomeTaxedAsLtcg - adjustmentsAppliedToCapitalGains);
    const adjustedGrossIncomeExceptSocSec = adjustedIncomeTaxedAsOrdinaryExceptSocSec + adjustedIncomeTaxedAsCapitalGains;

    const provisionalIncome = adjustedGrossIncomeExceptSocSec + socialSecurityIncome * 0.5;
    const { taxableSocialSecurityIncome, maxTaxableSocialSecurityPercentage } = this.getTaxablePortionOfSocialSecurityIncome({
      provisionalIncome,
      socialSecurityIncome,
    });

    const incomeTaxedAsOrdinary = incomeTaxedAsOrdinaryExceptSocSec + taxableSocialSecurityIncome;
    const adjustedIncomeTaxedAsOrdinary = adjustedIncomeTaxedAsOrdinaryExceptSocSec + taxableSocialSecurityIncome;
    const adjustedGrossIncome = adjustedIncomeTaxedAsOrdinary + adjustedIncomeTaxedAsCapitalGains;

    const grossIncome = grossIncomeExceptSocSec + taxableSocialSecurityIncome;
    const totalIncome = grossIncome + taxFreeIncome + (socialSecurityIncome - taxableSocialSecurityIncome);

    return {
      realizedGains,
      capitalLossDeduction,
      section121Exclusion,
      taxDeferredWithdrawals,
      taxableRetirementDistributions,
      taxableDividendIncome,
      taxableInterestIncome,
      earnedIncome,
      socialSecurityIncome,
      taxableSocialSecurityIncome,
      maxTaxableSocialSecurityPercentage,
      provisionalIncome,
      taxFreeIncome,
      grossIncome,
      incomeTaxedAsOrdinary,
      incomeTaxedAsLtcg,
      taxDeductibleContributions,
      adjustedGrossIncome,
      adjustedIncomeTaxedAsOrdinary,
      adjustedIncomeTaxedAsCapitalGains,
      totalIncome,
      earlyWithdrawals: {
        rothEarnings: earlyRothEarningsWithdrawals,
        '401kAndIra': early401kAndIraWithdrawals,
        hsa: earlyHsaWithdrawals,
        ...(earlyUnseasonedConversions > 0 ? { unseasonedConversions: earlyUnseasonedConversions } : {}),
      },
    };
  }

  /**
   * Applies capital loss carryover and computes the $3,000 annual capital loss deduction
   * (IRC §1211(b)). Losses exceeding $3,000 are carried forward to future years.
   */
  private getRealizedGainsAndCapLossDeductionData(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    annualPhysicalAssetsData: PhysicalAssetsData
  ): {
    realizedGains: number;
    capitalLossDeduction: number;
    section121Exclusion: number;
  } {
    const { section121Exclusion, physicalAssetRealizedGains } = this.getSection121Exclusion(annualPhysicalAssetsData);

    const realizedGainsAfterCarryover =
      annualPortfolioDataBeforeTaxes.realizedGains + physicalAssetRealizedGains + this.capitalLossCarryover;

    if (realizedGainsAfterCarryover >= 0) {
      this.capitalLossCarryover = 0;
      return { realizedGains: realizedGainsAfterCarryover, capitalLossDeduction: 0, section121Exclusion };
    }

    // Annual capital loss deduction capped at $3,000
    const capitalLossDeduction = -Math.max(-3000, realizedGainsAfterCarryover);
    this.capitalLossCarryover = realizedGainsAfterCarryover + capitalLossDeduction;
    return { realizedGains: 0, capitalLossDeduction, section121Exclusion };
  }

  /** Calculates progressive income tax across ordinary income brackets (IRC §1) */
  private processFederalIncomeTaxes({ taxableIncomeTaxedAsOrdinary }: { taxableIncomeTaxedAsOrdinary: number }): {
    federalIncomeTaxAmount: number;
    topMarginalFederalIncomeTaxRate: number;
    federalIncomeTaxBrackets: FederalIncomeTaxBracket[];
  } {
    let federalIncomeTaxAmount = 0;
    let topMarginalFederalIncomeTaxRate = 0;

    const federalIncomeTaxBrackets = this.getFederalIncomeTaxBrackets();
    for (const bracket of federalIncomeTaxBrackets) {
      if (taxableIncomeTaxedAsOrdinary <= bracket.min) break;

      const taxableInBracket = Math.min(taxableIncomeTaxedAsOrdinary, bracket.max) - bracket.min;
      federalIncomeTaxAmount += taxableInBracket * bracket.rate;
      topMarginalFederalIncomeTaxRate = bracket.rate;
    }

    return { federalIncomeTaxAmount, topMarginalFederalIncomeTaxRate, federalIncomeTaxBrackets };
  }

  /**
   * Calculates capital gains tax with bracket stacking (IRC §1(h))
   *
   * Capital gains are stacked on top of ordinary income to determine
   * the applicable bracket, then only the gains portion is taxed.
   */
  private processCapitalGainsTaxes({
    taxableIncomeTaxedAsCapitalGains,
    taxableIncomeTaxedAsOrdinary,
  }: {
    taxableIncomeTaxedAsCapitalGains: number;
    taxableIncomeTaxedAsOrdinary: number;
  }): {
    capitalGainsTaxAmount: number;
    topMarginalCapitalGainsTaxRate: number;
    capitalGainsTaxBrackets: CapitalGainsTaxBracket[];
  } {
    const totalTaxableIncome = taxableIncomeTaxedAsOrdinary + taxableIncomeTaxedAsCapitalGains;

    let capitalGainsTaxAmount = 0;
    let topMarginalCapitalGainsTaxRate = 0;

    const capitalGainsTaxBrackets = this.getCapitalGainsTaxBrackets();
    for (const bracket of capitalGainsTaxBrackets) {
      if (totalTaxableIncome <= bracket.min) break;

      const incomeInBracket = Math.min(totalTaxableIncome, bracket.max) - bracket.min;
      // Bracket stacking: ordinary income fills brackets first, gains taxed on the remainder
      const ordinaryIncomeInBracket = Math.max(0, Math.min(taxableIncomeTaxedAsOrdinary, bracket.max) - bracket.min);
      const capitalGainsInBracket = incomeInBracket - ordinaryIncomeInBracket;

      capitalGainsTaxAmount += capitalGainsInBracket * bracket.rate;
      topMarginalCapitalGainsTaxRate = bracket.rate;
    }

    return { capitalGainsTaxAmount, topMarginalCapitalGainsTaxRate, capitalGainsTaxBrackets };
  }

  /** Calculates Net Investment Income Tax — IRC §1411: 3.8% on lesser of NII or MAGI over threshold */
  private processNIIT(incomeData: IncomeSourcesData): NIITData {
    const { rate, thresholds } = this.inRealDollars(this.ruleset.tables.netInvestmentIncomeTax);
    const threshold = thresholds[this.filingStatus];

    const { taxableDividendIncome, taxableInterestIncome, capitalLossDeduction, realizedGains, adjustedGrossIncome } = incomeData;

    const otherInvestmentIncome = Math.max(0, taxableDividendIncome + taxableInterestIncome - capitalLossDeduction);
    const netInvestmentIncome = realizedGains + otherInvestmentIncome;

    const magiOverThreshold = Math.max(0, adjustedGrossIncome - threshold);
    const incomeSubjectToNiit = Math.min(netInvestmentIncome, magiOverThreshold);
    const niitAmount = incomeSubjectToNiit * rate;

    return { netInvestmentIncome, incomeSubjectToNiit, niitAmount, threshold };
  }

  /** Calculates early withdrawal penalties — IRC §72(t): 10% for 401k/IRA/unseasoned Roth conversions; IRC §223(f)(4): 20% for HSA */
  private processEarlyWithdrawalPenalties(earlyWithdrawalsData: IncomeSourcesData['earlyWithdrawals']): EarlyWithdrawalPenaltyData {
    const taxDeferredPenaltyAmount = earlyWithdrawalsData['401kAndIra'] * 0.1 + earlyWithdrawalsData.hsa * 0.2;
    const taxFreePenaltyAmount = (earlyWithdrawalsData.rothEarnings + (earlyWithdrawalsData.unseasonedConversions ?? 0)) * 0.1;

    return { taxDeferredPenaltyAmount, taxFreePenaltyAmount, totalPenaltyAmount: taxDeferredPenaltyAmount + taxFreePenaltyAmount };
  }

  /**
   * Determines taxable portion of Social Security benefits (IRC §86)
   *
   * Uses provisional income (AGI + tax-exempt interest + 50% of SS benefits) to
   * determine 0%, 50%, or up to 85% taxable. Maximum 85% of benefits can be
   * taxed regardless of income level.
   *
   * Every percentage below is read from the ruleset's §86 tiers — the dataset's
   * `taxablePercentage` — rather than hard-coded, so a ruleset that changes a tier amount flows
   * through without touching this code.
   *
   * The one shape the three-tier walk cannot express is a **zero base amount**, which is what
   * §86(c)(1)(C) and (c)(2)(C) give a married individual filing a separate return: both the base and
   * the adjusted base amount are $0, so the 50% band has no width and the rule collapses to 85% of
   * provisional income, capped at 85% of the benefits. The table declares that with
   * `taxableFromFirstDollar`, and the collapsed form is applied from the tier row's own percentage
   * rather than a literal 0.85. The lived-apart exception of §86(c)(1)(C) — which restores the
   * single base amounts for spouses who were apart for the whole year — is **not modelled**: the
   * engine has no separate-return input for it.
   *
   * Hand check (2026, separate return, $20,000 of benefits, $10,000 of other AGI):
   *   provisional income = 10,000 + 50% × 20,000 = $20,000
   *   taxable = min(85% × 20,000, 85% × 20,000) = $17,000 — the whole 85% of the benefit, from the
   *   first dollar, where a single filer with the same numbers would report $0 (its first tier runs
   *   to $25,000).
   */
  private getTaxablePortionOfSocialSecurityIncome({
    provisionalIncome,
    socialSecurityIncome,
  }: {
    provisionalIncome: number;
    socialSecurityIncome: number;
  }): { taxableSocialSecurityIncome: number; maxTaxableSocialSecurityPercentage: number } {
    const table = this.inRealDollars(this.ruleset.tables.socialSecurityTaxation);
    const tiers = table.tiers[this.filingStatus];

    if (table.taxableFromFirstDollar[this.filingStatus]) {
      const collapsed = tiers[tiers.length - 1];
      return {
        taxableSocialSecurityIncome: Math.min(
          provisionalIncome * collapsed.taxablePercentage,
          socialSecurityIncome * collapsed.taxablePercentage
        ),
        maxTaxableSocialSecurityPercentage: collapsed.taxablePercentage,
      };
    }

    const [firstTier, secondTier] = tiers;

    if (provisionalIncome <= firstTier.max) {
      return { taxableSocialSecurityIncome: 0, maxTaxableSocialSecurityPercentage: firstTier.taxablePercentage };
    }

    if (provisionalIncome > secondTier.min && provisionalIncome <= secondTier.max) {
      const excessIncome = provisionalIncome - secondTier.min;
      return {
        taxableSocialSecurityIncome: Math.min(
          excessIncome * secondTier.taxablePercentage,
          socialSecurityIncome * secondTier.taxablePercentage
        ),
        maxTaxableSocialSecurityPercentage: secondTier.taxablePercentage,
      };
    }

    const topTier = tiers[tiers.length - 1];

    const tier1Excess = secondTier.max - secondTier.min;
    const tier1Amount = Math.min(tier1Excess * secondTier.taxablePercentage, socialSecurityIncome * secondTier.taxablePercentage);

    const tier2Excess = provisionalIncome - topTier.min;
    const tier2Amount = tier2Excess * topTier.taxablePercentage;

    return {
      taxableSocialSecurityIncome: Math.min(tier1Amount + tier2Amount, socialSecurityIncome * topTier.taxablePercentage),
      maxTaxableSocialSecurityPercentage: topTier.taxablePercentage,
    };
  }

  private getEmployeeContributionsForAccountTypes(
    annualPortfolioDataBeforeTaxes: PortfolioData,
    accountTypes: AccountInputs['type'][]
  ): number {
    return Object.values(annualPortfolioDataBeforeTaxes.perAccountData)
      .filter((account) => accountTypes.includes(account.type))
      .reduce((total, account) => total + (sumFlows(account.contributions) - account.employerMatch), 0);
  }

  private getStandardDeduction(): number {
    return this.inRealDollars(this.ruleset.tables.standardDeduction)[this.filingStatus];
  }

  private getFederalIncomeTaxBrackets(): FederalIncomeTaxBracket[] {
    return this.inRealDollars(this.ruleset.tables.incomeTaxBrackets)[this.filingStatus];
  }

  private getCapitalGainsTaxBrackets(): CapitalGainsTaxBracket[] {
    return this.inRealDollars(this.ruleset.tables.capitalGainsTaxBrackets)[this.filingStatus];
  }

  /** Applies Section 121 exclusion for primary residence sale gains */
  private getSection121Exclusion(physicalAssetsData: PhysicalAssetsData): {
    section121Exclusion: number;
    physicalAssetRealizedGains: number;
  } {
    const maxExclusion = this.inRealDollars(this.ruleset.tables.section121Exclusion)[this.filingStatus];

    // Technically, there should only be one primary residence asset, but just in case...
    const section121Exclusion = Object.values(physicalAssetsData.perAssetData)
      .filter((asset) => asset.assetType === 'primaryResidence' && asset.realizedGains > 0)
      .reduce((total, asset) => total + Math.min(asset.realizedGains, maxExclusion), 0);

    return { section121Exclusion, physicalAssetRealizedGains: physicalAssetsData.totalRealizedGains - section121Exclusion };
  }
}
