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

import type { SimulationState } from './simulation-engine';
import type { IncomesData } from './incomes';
import type { PortfolioData } from './portfolio';
import type { ReturnsData } from './returns';
import type { PhysicalAssetsData } from './physical-assets';
import { sumFlows } from './asset';
import { computeSelfEmploymentTaxes, zeroWagePayrollTaxes, type FicaTaxesData, type WagePayrollTaxes } from './payroll-taxes';
import { getRules, LATEST_TAX_YEAR } from './tax-data';
import { irmaaTierFor } from './tax-data/medicare-irmaa';
import { saltCapFor } from './tax-data/salt-cap';
import type {
  CapitalGainsTaxBracket,
  FederalIncomeTaxBracket,
  FederalTaxRuleset,
  SocialSecurityTaxThreshold,
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
export interface DeductionSettings {
  readonly itemizedDeductions?: ItemizedDeductionsInputs | undefined;
  readonly spouseQualifiesForSeniorDeduction?: boolean | undefined;
}

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
  incomeSources: IncomeSourcesData;
  /**
   * Everything the year owes, and exactly the sum of its lines:
   *
   *   federalIncomeTaxes.federalIncomeTaxAmount   regular income tax on ordinary income
   *   capitalGainsTaxes.capitalGainsTaxAmount     regular tax on gains and qualified dividends
   *   amt.netCharge                              AMT top-up (positive) or minimum-tax credit (negative)
   *   niit.niitAmount                            net investment income tax
   *   irmaa.total                                Medicare Part B + D income-related surcharge
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
  };
}

/** Computes annual federal taxes across all tax types for a simulation year */
export class TaxProcessor {
  private capitalLossCarryover = 0;
  private capitalLossCarryoverSnapshot: number | null = null;
  /** Minimum-tax credit available to later years (IRC §53), and its snapshot for the tax loop. */
  private minimumTaxCreditCarryforward = 0;
  private minimumTaxCreditSnapshot: number | null = null;
  /**
   * Adjusted gross income by tax year, for the IRMAA lookback. Keyed by year and *overwritten* on
   * every pass through a year, so the convergence loop (which re-settles a year up to ten times)
   * leaves one entry per year rather than ten.
   */
  private readonly magiByYear = new Map<TaxYear, number>();
  /**
   * The year being settled — the year *asked for*, not the year the rules resolved from. They differ
   * whenever `getRules` falls back (a 2028 return uses the 2026 ruleset today), and the IRMAA
   * lookback has to be keyed by the return's own year, not by the fallback's.
   */
  private taxYear: TaxYear;
  private ruleset: FederalTaxRuleset;

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
    private deductionSettings: DeductionSettings = {}
  ) {
    this.taxYear = taxYear;
    this.ruleset = rulesetOverride ?? getRules(taxYear);
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
   * Save carryover state before first tax calculation of the year.
   *
   * Both carryforwards are saved: the capital-loss carryover and the minimum-tax credit, which is
   * consumed by a year's return in exactly the same way (re-settling the year must not consume it
   * twice).
   */
  saveCarryoverSnapshot(): void {
    this.capitalLossCarryoverSnapshot = this.capitalLossCarryover;
    this.minimumTaxCreditSnapshot = this.minimumTaxCreditCarryforward;
  }

  /** Restore carryover state before each convergence iteration */
  restoreCarryoverSnapshot(): void {
    if (this.capitalLossCarryoverSnapshot !== null) {
      this.capitalLossCarryover = this.capitalLossCarryoverSnapshot;
    }
    if (this.minimumTaxCreditSnapshot !== null) {
      this.minimumTaxCreditCarryforward = this.minimumTaxCreditSnapshot;
    }
  }

  /**
   * Calculates all federal taxes for one simulation year
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

    // Which deduction the return takes (P3-P3): the larger of the standard deduction and the
    // itemized total, plus the senior deduction, which §151(d)(5)(C) allows on top of either.
    const deduction = this.processDeductions(incomeData.adjustedGrossIncome);
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
    const table = this.ruleset.tables.alternativeMinimumTax.values;

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
    this.magiByYear.set(taxYear, magi);

    const table = this.ruleset.tables.medicareIrmaa.values;
    const basisTaxYear = taxYear - table.lookbackYears;
    const basisMagi = this.magiByYear.get(basisTaxYear) ?? null;
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
  private processDeductions(adjustedGrossIncome: number): DeductionData {
    const standardDeduction = this.getStandardDeduction();
    const entered = this.deductionSettings.itemizedDeductions;
    const salt = saltCapFor(this.taxYear, adjustedGrossIncome);
    const medicalFloor = this.ruleset.tables.medicalExpenseFloor.values;

    const lines = {
      mortgageInterest: entered?.mortgageInterest ?? 0,
      charitable: entered?.charitable ?? 0,
      stateAndLocalTaxes: Math.min(entered?.stateAndLocalTaxes ?? 0, salt.cap),
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
        entered: entered?.stateAndLocalTaxes ?? 0,
        allowed: lines.stateAndLocalTaxes,
        phaseDown: (entered?.stateAndLocalTaxes ?? 0) - lines.stateAndLocalTaxes,
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
   * Hand check (2026, single, age 67, MAGI $80,000): 6,000 − 6% × (80,000 − 75,000) = $5,700.
   */
  private seniorDeductionFor(adjustedGrossIncome: number): number {
    const table = this.ruleset.tables.seniorDeduction.values;
    if (this.taxYear > table.lastTaxYear) return 0;

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
    let early401kAndIraWithdrawals = 0;
    let earlyHsaWithdrawals = 0;

    for (const account of Object.values(annualPortfolioDataBeforeTaxes.perAccountData)) {
      switch (account.type) {
        case 'roth401k':
        case 'roth403b':
        case 'rothIra': {
          if (age < regularQualifiedWithdrawalAge) {
            const annualEarningsWithdrawn = account.earningsWithdrawn;

            earlyRothEarningsWithdrawals += annualEarningsWithdrawn;
          }
          break;
        }
        case '401k':
        case '403b':
        case 'ira': {
          const annualWithdrawals = sumFlows(account.withdrawals);

          taxDeferredWithdrawals += annualWithdrawals;
          if (age < regularQualifiedWithdrawalAge) early401kAndIraWithdrawals += annualWithdrawals;
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
    const { rate, thresholds } = this.ruleset.tables.netInvestmentIncomeTax.values;
    const threshold = thresholds[this.filingStatus];

    const { taxableDividendIncome, taxableInterestIncome, capitalLossDeduction, realizedGains, adjustedGrossIncome } = incomeData;

    const otherInvestmentIncome = Math.max(0, taxableDividendIncome + taxableInterestIncome - capitalLossDeduction);
    const netInvestmentIncome = realizedGains + otherInvestmentIncome;

    const magiOverThreshold = Math.max(0, adjustedGrossIncome - threshold);
    const incomeSubjectToNiit = Math.min(netInvestmentIncome, magiOverThreshold);
    const niitAmount = incomeSubjectToNiit * rate;

    return { netInvestmentIncome, incomeSubjectToNiit, niitAmount, threshold };
  }

  /** Calculates early withdrawal penalties — IRC §72(t): 10% for 401k/IRA; IRC §223(f)(4): 20% for HSA */
  private processEarlyWithdrawalPenalties(earlyWithdrawalsData: IncomeSourcesData['earlyWithdrawals']): EarlyWithdrawalPenaltyData {
    const taxDeferredPenaltyAmount = earlyWithdrawalsData['401kAndIra'] * 0.1 + earlyWithdrawalsData.hsa * 0.2;
    const taxFreePenaltyAmount = earlyWithdrawalsData.rothEarnings * 0.1;

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
   * `taxablePercentage` — rather than hard-coded, so a ruleset that changes a tier amount
   * (e.g. the 85%-from-dollar-one flag in P3-P1b) flows through without touching this code.
   */
  private getTaxablePortionOfSocialSecurityIncome({
    provisionalIncome,
    socialSecurityIncome,
  }: {
    provisionalIncome: number;
    socialSecurityIncome: number;
  }): { taxableSocialSecurityIncome: number; maxTaxableSocialSecurityPercentage: number } {
    const tiers = this.getSocialSecurityTaxThresholds();
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
      .reduce((sum, account) => sum + (sumFlows(account.contributions) - account.employerMatch), 0);
  }

  private getStandardDeduction(): number {
    return this.ruleset.tables.standardDeduction.values[this.filingStatus];
  }

  private getFederalIncomeTaxBrackets(): FederalIncomeTaxBracket[] {
    return this.ruleset.tables.incomeTaxBrackets.values[this.filingStatus];
  }

  private getCapitalGainsTaxBrackets(): CapitalGainsTaxBracket[] {
    return this.ruleset.tables.capitalGainsTaxBrackets.values[this.filingStatus];
  }

  private getSocialSecurityTaxThresholds(): SocialSecurityTaxThreshold[] {
    return this.ruleset.tables.socialSecurityTaxation.values[this.filingStatus];
  }

  /** Applies Section 121 exclusion for primary residence sale gains */
  private getSection121Exclusion(physicalAssetsData: PhysicalAssetsData): {
    section121Exclusion: number;
    physicalAssetRealizedGains: number;
  } {
    const maxExclusion = this.ruleset.tables.section121Exclusion.values[this.filingStatus];

    // Technically, there should only be one primary residence asset, but just in case...
    const section121Exclusion = Object.values(physicalAssetsData.perAssetData)
      .filter((asset) => asset.assetType === 'primaryResidence' && asset.realizedGains > 0)
      .reduce((total, asset) => total + Math.min(asset.realizedGains, maxExclusion), 0);

    return { section121Exclusion, physicalAssetRealizedGains: physicalAssetsData.totalRealizedGains - section121Exclusion };
  }
}
