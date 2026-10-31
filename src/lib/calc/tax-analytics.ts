/**
 * Tax analytics over a completed simulation year (parity plan P3-P6).
 *
 * This module answers the questions a planner asks *after* the engine has settled a year — what
 * the next dollar costs, which bracket the conversion is filling, how much room is left, and which
 * cliff is close — without re-running the engine. It is a pure function of one year's
 * `TaxesData` and the tax ruleset resolved for that year: no store, no clock, no model mutation.
 * That is deliberate: §7-A3's agent needs a tool whose answer it can quote, and a pure function is
 * the only kind of tool that can be re-derived and checked.
 *
 * ## Where the numbers come from
 *
 * The analytics does not restate tax law. Every rate and threshold is read from the ruleset
 * (`getRules(taxYear)`) or from the payroll layer (`computeWagePayrollTaxes`,
 * `computeSelfEmploymentTaxes`), which the engine itself uses. What lives here is only the
 * *composition* — which line a dollar of a given kind touches — plus the two traversals the engine
 * also performs: a progressive bracket walk (IRC §1) and capital-gains stacking on top of ordinary
 * income (IRC §1(h)). `analyzeTaxYear` recomputes the year's federal lines this way, and the test
 * suite pins the recomputation to the engine's own output (`reported` vs `baseline`) so the two
 * cannot drift apart silently.
 *
 * ## What it does not compute (and why not)
 *
 * - **California income tax** is **not** on this list. P3-P8 landed, so the state return is settled
 *   by the engine and `jurisdictions.california` reports it verbatim, with the questions the state
 *   return still cannot answer (Covered California subsidies, California AMT, the HSA
 *   non-conformity) named separately in `jurisdictions.california.notModelled`.
 * - **ACA premium tax credit** — P3-P7b. Only half of it is on this list: the credit itself *is*
 *   computed. `tax-data/aca` vendors the poverty guidelines and applicable-percentage schedule for
 *   coverage years 2024–2027, `aca-premium-tax-credit` computes the credit and the 400 % cliff over
 *   them, the plan opts in through `taxSettings.aca` (SLCSP premium, household size, live premium),
 *   and the settled return returns it as `taxes.aca` — a refundable credit, so it is in
 *   `totalTaxesRefund`/`totalTaxesDue` rather than in a liability line. What this module reports for
 *   a year whose plan did **not** opt in is the prerequisite list, never an approximation; and what
 *   is not modelled at all is the Covered California state subsidy on top of the federal credit.
 *   `cliffs.aca` reports whichever of the two applies, and for the credit it reports the coverage
 *   year's own cliff — a dollar threshold, or `null` where §36B(i) suspends it (2024–2025) — plus the
 *   year whose law priced the credit, because a coverage year past the last vendored table is priced
 *   from the nearest prior row (`tax-data/aca` `getAcaTable`).
 * - **AMT credit machinery beyond the simplified §53 limit** — the engine charges the AMT top-up and
 *   applies a credit against it, but the deferral-item refinement of Form 8801 Part III is not
 *   modelled (Plan 3: "no full AMT credit machinery").
 * - **The marginal effect of an itemized deduction** — P3-P3 shipped, so the engine applies the four
 *   entered itemized lines (the §164 SALT cap with its MAGI phase-down, the §213 7.5%-of-AGI medical
 *   floor) and takes the larger of the two deductions. What is still missing is the *marginal*
 *   answer: this module reads the deduction the year's return took rather than re-deriving it, so a
 *   hypothetical dollar that would move the SALT phase-down or the medical floor is priced against a
 *   fixed deduction. What the return did deduct is reported in `deductions`.
 * - **The §72(t) additional tax on an early withdrawal** — the engine charges it from the account's
 *   age and type, not from a marginal rate, so a "next dollar of tax-deferred withdrawal" here is
 *   the income tax only. The list is returned per year in `notComputed`, so a consumer can say so.
 *
 * ## The senior deduction (a rule, not an amount)
 *
 * §151(d)(5)(C) allows the deduction per qualified individual, and the ruleset declares which filing
 * statuses may claim it at all (`tables.seniorDeduction.values.eligible`). The analytics reports
 * that flag for the requested status as `deductions.seniorDeduction.available`, with `deniedBy`
 * carrying the rule when the answer is no: on a separate return the deduction is forfeited outright,
 * and a smaller total deduction is not the whole statement. The flag is read from the table, so a
 * filing status added to the union is answered by the ruleset rather than by a branch here.
 *
 * ## The IRMAA table
 *
 * It lives in the ruleset (`tables.medicareIrmaa`, P3-P7a), not here: the tax engine charges the
 * surcharge as a liability line, so there is one table with the CMS provenance rather than a second
 * copy for the cliff. This module reads it to describe the tiers a MAGI lands in and what crossing
 * the next threshold costs.
 *
 * The two-year lookback is a *lookup* concern, not a rate concern: premiums for year Y+2 are set
 * from year Y's MAGI. `analyzeTaxYear` reports both directions — the tier this year's MAGI will
 * produce two years later (`projected`), and the tier implied by the MAGI from two years earlier
 * (`charged`) — and reports `null` rather than guessing when the caller cannot supply that year.
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import type { AcaPremiumTaxCreditResult } from './aca-premium-tax-credit';
import { parseISODateString } from './clock';
import { computeSelfEmploymentTaxes, computeWagePayrollTaxes } from './payroll-taxes';
import type { SimulationDataPoint } from './simulation-engine';
import { getRules } from './tax-data';
import { getAcaTable } from './tax-data/aca';
import { irmaaTierFor } from './tax-data/medicare-irmaa';
import { realDollarsIn } from './tax-data/real-dollars';
import type { CapitalGainsTaxBracket, ProgressiveBracket, TableMeta, TaxRuleset, TaxYear } from './tax-data/types';
import type { StateTaxesData, TaxesData } from './taxes';
/**
 * A ruleset's table in the plan's today-dollars.
 *
 * The analytics must agree with the engine about a threshold, and the engine deflates the tables
 * that are fixed by statute (see `tax-data/real-dollars.ts`). The analytics reads the same accessor
 * so a headroom figure is measured against the amount the return actually used.
 */
function realDollars<TValues>(table: TableMeta<TValues>, rules: TaxRuleset, taxYear: TaxYear, inflationRatePercent: number): TValues {
  return realDollarsIn(table, { rulesetYear: rules.year, simYear: taxYear, inflationRatePercent });
}

// ============================================================================
// Public shapes
// ============================================================================

/**
 * The kinds of income a marginal rate is reported for.
 *
 * These are not engines' income types: they are *marginal* categories, because two incomes of the
 * same gross amount can cost different amounts at the margin. `ordinary` covers a pension, a
 * traditional-IRA/401(k) distribution and a Roth conversion — all of which raise taxable ordinary
 * income by a dollar per dollar and are not investment income for §1411 or earned income for
 * payroll. `taxDeferredWithdrawal` is kept separate from `rothConversion` even though the marginal
 * path prices them alike today: neither is a modelled transaction, so both cost a dollar of ordinary
 * income. They diverge once a conversion can carry after-tax basis through §408(d)(2) — a conversion
 * of basis is not taxable — and §7-A3 needs the two labelled in its explanations. (Pro-rata basis
 * recovery *is* modelled for IRA withdrawals, in the settled return rather than at the margin.)
 */
export type MarginalIncomeType =
  | 'ordinary'
  | 'taxDeferredWithdrawal'
  | 'rothConversion'
  | 'wage'
  | 'selfEmployment'
  | 'longTermCapitalGain'
  | 'qualifiedDividend'
  | 'socialSecurity'
  | 'taxExempt';

export type TaxLineId =
  | 'federalOrdinaryIncomeTax'
  | 'federalCapitalGainsTax'
  | 'niit'
  | 'payrollSocialSecurity'
  | 'payrollMedicare'
  | 'payrollAdditionalMedicare'
  | 'payrollStateDisability'
  | 'selfEmploymentTax';

/** One labelled amount, in the currency of the year being analysed (nominal dollars). */
export interface TaxLine {
  id: TaxLineId;
  label: string;
  /** `federal` for the internal-revenue lines; `CA` for the California payroll line. */
  jurisdiction: 'federal' | 'CA';
  amount: number;
}

/** One bracket of a progressive schedule, with how much of it this year fills. */
export interface BracketRow {
  min: number;
  /** Exclusive upper bound; `null` for the unbounded top bracket. */
  max: number | null;
  rate: number;
  /** Income taxed at this bracket's rate. */
  taxableInBracket: number;
  /** Room left in the bracket at this bracket's rate; `null` when unbounded. */
  remainingInBracket: number | null;
  /** `taxableInBracket / (max - min)`, or `null` when unbounded. */
  shareFilled: number | null;
}

/** A forward-looking capacity: add this much income and the next rate applies. */
export interface HeadroomTarget {
  /** The rate that would apply to the last dollar of the additional income. */
  rate: number;
  /** How much more taxable income fits. `null` for the unbounded top bracket. */
  headroom: number | null;
  /** Taxable income reached at the end of the headroom. `null` when unbounded. */
  upToTaxableIncome: number | null;
}

export interface BracketFill {
  ordinary: {
    brackets: BracketRow[];
    /** Taxable ordinary income after adjustments and deductions (the engine's own figure). */
    taxableIncome: number;
    /** The rate the *next* marginal dollar of ordinary income pays. */
    nextDollarRate: number;
  };
  /**
   * Long-term gains and qualified dividends, stacked on ordinary income: the rows report the gain
   * dollars inside each bracket, and the room for more gains before the next rate applies.
   */
  capitalGains: {
    brackets: BracketRow[];
    taxableIncome: number;
    nextDollarRate: number;
    /** Ordinary income the gains are stacked on top of. */
    stackedOnOrdinaryIncome: number;
  };
}

/**
 * Bracket fill seen as capacity. Same computation as `bracketFill.ordinary`, exposed as the
 * question a conversion actually asks: "how much can I convert before the rate steps up?"
 */
export interface ConversionHeadroom {
  /** The implicit next bracket: the first rate above today's. `null` in the top bracket. */
  nextBracket: HeadroomTarget | null;
  /** Every higher rate and the income that reaches it, from the bracket table. */
  targets: HeadroomTarget[];
}

/** A threshold where one more dollar changes a cost or a surcharge rather than a bracket. */
export interface Cliff {
  id: 'niit' | 'additionalMedicare';
  label: string;
  /** The amount the cliff is measured on: MAGI, or earned income for additional Medicare. */
  measuredOn: 'magi' | 'earnedIncome';
  /** The threshold in force. */
  threshold: number;
  /** The measured amount today. */
  current: number;
  /** Distance to the threshold; `0` when already at or above it. */
  headroom: number;
  /** Annual cost of the *first* dollar past the threshold, as the ruleset defines it. */
  costOfCrossing: number;
  supported: true;
}

/** The IRMAA tier a MAGI lands in, and what crossing the next threshold would cost per year. */
export interface IrmaaTier {
  /** 0 is "standard premium", 1-5 are the surcharge tiers. */
  tier: number;
  min: number;
  /** `null` for the top tier. */
  max: number | null;
  /** Part B income-related adjustment per month. */
  monthlyAdjustment: number;
  /** The Part B premium actually paid: standard premium plus the adjustment. */
  monthlyPremium: number;
  /** Part D income-related adjustment per month. */
  partDMonthly: number;
  /** `(Part B adjustment + Part D adjustment) × 12` — the surcharge the tax engine charges. */
  annualSurcharge: number;
}

export interface IrmaaCliff {
  taxYear: TaxYear;
  filingStatus: FilingStatus;
  /** The tax year the premium year follows from: premiums in `premiumYear` use this year's MAGI. */
  magiTaxYear: TaxYear;
  premiumYear: TaxYear;
  magi: number;
  tier: IrmaaTier;
  /** Room before the next tier; `null` in the top tier. */
  headroomToNextTier: number | null;
  nextTier: (IrmaaTier & { /** Extra annual cost of crossing into it. */ stepUp: number }) | null;
  /** Both parts: the engine charges the Part B and Part D adjustments together. */
  includes: 'partB-and-partD';
}

export interface IrmaaLookback {
  /** The premium year whose tier this year's MAGI sets. */
  premiumYear: TaxYear;
  /** The tier this year's MAGI projects, i.e. what two years later will charge. */
  projected: IrmaaCliff;
  /**
   * The tier charged this year, from the MAGI of two years earlier. `null` when the caller could
   * not supply that year — the plan starts later, or the year is within the first two of the run.
   */
  charged: (IrmaaTier & { magi: number; magiTaxYear: TaxYear }) | null;
  /** Why `charged` is null, when it is. */
  unavailable: string | null;
}

/** A next-dollar experiment: the line-by-line movement caused by one extra chunk of income. */
export interface NextDollarDecomposition {
  incomeType: MarginalIncomeType;
  /** The amount added, in nominal dollars. */
  amount: number;
  /** Only the lines that moved; each entry sums into `totalDelta`. */
  lines: Array<{ id: TaxLineId; label: string; jurisdiction: 'federal' | 'CA'; delta: number }>;
  /** Sum of `lines[].delta`; the invariant the tests assert. */
  totalDelta: number;
  /** `totalDelta / amount`, i.e. the fully loaded marginal rate. */
  marginalRate: number;
  /** How much the year's taxable ordinary income moved (includes §86 phase-in effects). */
  taxableOrdinaryIncomeDelta: number;
  /** How much AGI moved. */
  magiDelta: number;
}

/** A marginal rate, expressed as the lines that make it up. */
export interface MarginalRate {
  incomeType: MarginalIncomeType;
  rate: number;
  lines: Array<{ id: TaxLineId; label: string; jurisdiction: 'federal' | 'CA'; rate: number }>;
}

/**
 * Whether the return may claim the §151(d)(5)(C) senior deduction at all, and why not when it may not.
 *
 * A zero `claimed` is not one statement: a filer under 65 claims nothing because of age, a return for
 * a status the ruleset declares ineligible claims nothing because of the rule, and after the statute's
 * sunset no return claims anything. This block separates those, so an agent does not have to infer a
 * forfeiture from a total that came out smaller.
 */
export interface SeniorDeductionAvailability {
  /** Whether this filing status may claim it at all — `tables.seniorDeduction.values.eligible`. */
  available: boolean;
  /** Whether the deduction exists in `taxYear` at all: the statute sunsets it after `lastTaxYear`. */
  inForce: boolean;
  /** What the year's settled return claimed — copied from `TaxesData.deduction.seniorDeduction`. */
  claimed: number;
  /**
   * The rule that denies the deduction, as a sentence a consumer can quote; `null` when this status
   * may claim it in this year. Present when `available` is false or the year is past the sunset.
   */
  deniedBy: string | null;
  /** The ruleset year whose table decided `available` and `inForce`. */
  resolvedYear: TaxYear;
}

export interface TaxAnalyticsInput {
  /** The year being settled; resolves the ruleset. */
  taxYear: TaxYear;
  filingStatus: FilingStatus;
  /** That year's settled tax result, read-only. */
  taxes: TaxesData;
  /**
   * Wages and net self-employment earnings for the same year, from `IncomesData` on the data
   * point. Needed only to place a marginal wage or SE dollar against the OASDI base and the
   * additional-Medicare threshold; the baseline payroll figures come from `taxes.fica`.
   */
  earnedIncome: { wages: number; selfEmployment: number };
  /** MAGI from two tax years earlier, for the IRMAA lookback. Omit when unavailable. */
  priorYearMagi?: { taxYear: TaxYear; magi: number };
  /**
   * The plan's inflation assumption, as a percentage, so a statute-locked threshold is measured at
   * the same real value the return used. Absent means 0%, which is the no-deflation reading.
   */
  inflationRatePercent?: number;
}

export type AcaCliff = AcaCliffUnsupported | AcaCliffReported;

/**
 * The ACA block for a year whose plan did not opt in (or filed married-filing-separately): what is
 * missing, never a number.
 */
export interface AcaCliffUnsupported {
  readonly supported: false;
  readonly prerequisites: readonly string[];
}

/** The ACA block for a settled credit: the credit, the coverage year's own cliff, and the year that priced it. */
export interface AcaCliffReported {
  readonly supported: true;
  readonly credit: number;
  /**
   * The coverage year whose table priced the credit. Older than the return's tax year when the
   * engine asked for a year newer than the last vendored row, so a consumer quotes 2027 law for a
   * 2029 return instead of implying 2029 law exists in this module.
   */
  readonly resolvedYear: TaxYear;
  readonly householdIncome: number;
  readonly povertyLine: number;
  readonly fplPercent: number;
  readonly applicablePercentage: number;
  readonly requiredContribution: number;
  readonly slcspPremium: number;
  /**
   * The coverage year's upper cliff applied to `povertyLine`, or `null` when that year has no upper
   * cliff: §36B(i) suspends the 400 % ceiling for tax years 2021–2025, so the 2024 and 2025 rows
   * carry `maxFplPercent: null` and 4 × the FPL is not a threshold at all in those years.
   */
  readonly cliffThreshold: number | null;
  /** Distance in income to `cliffThreshold`; `null` when there is no cliff to reach. */
  readonly headroom: number | null;
}

export interface TaxAnalytics {
  taxYear: TaxYear;
  filingStatus: FilingStatus;
  /** What the engine actually charged, copied from the result — the numbers to quote. */
  reported: {
    federalIncomeTax: number;
    capitalGainsTax: number;
    niit: number;
    payrollTaxes: number;
    totalTaxLiability: number;
  };
  /** What the ruleset produces for the same taxable income. Equal to `reported`; the test pins it. */
  baseline: TaxLine[];
  /**
   * The deduction the year's return took, read from the result rather than re-derived: which of the
   * two won, what the return deducted in total, and whether the senior deduction was allowed to this
   * filing status at all.
   */
  deductions: {
    /** The larger of the two deductions, a tie going to the standard deduction. */
    type: 'standard' | 'itemized';
    /** `max(standardDeduction, itemized.total) + seniorDeduction`, summed across the returns filed. */
    total: number;
    seniorDeduction: SeniorDeductionAvailability;
  };
  bracketFill: BracketFill;
  conversionHeadroom: ConversionHeadroom;
  marginalRates: Record<MarginalIncomeType, MarginalRate>;
  cliffs: {
    niit: Cliff;
    additionalMedicare: Cliff;
    irmaa: IrmaaLookback;
    aca: AcaCliff;
  };
  /** The two returns the engine settles: the federal one, and California's (P3-P8). */
  jurisdictions: {
    federal: { supported: true; totalTaxLiability: number };
    /**
     * The California return as the engine settled it, copied from `TaxesData.state` rather than
     * re-derived here — one return, one set of numbers.
     *
     * `reported.jurisdiction` is the residency the return used, and it is the field that separates
     * "California taxed nothing" from "there is no California return": when it is `'none'` the plan
     * is not a resident, `resolvedYear` is `null`, and every amount is zero because nothing was
     * filed. A zero read as a low state tax is the one mistake this block is shaped to prevent.
     */
    california: {
      supported: true;
      reported: StateTaxesData;
      /**
       * California SDI withheld from wages. It is a payroll line (`TaxesData.fica`), not part of
       * `reported.total`, and it is charged whether or not a state return is filed.
       */
      stateDisability: number;
      /** The California questions this year's return does not answer, with the reason. */
      notModelled: string[];
    };
  };
  /** What this analysis cannot answer for this year, with the reason. Empty is the goal, not the norm. */
  notComputed: string[];
}

// ============================================================================
// Bracket traversal (the same two walks `TaxProcessor` performs, over the same tables)
// ============================================================================

/** The bracket whose rate applies to the next dollar at `taxable`. The top bracket wins ties. */
function bracketFor(taxable: number, brackets: readonly ProgressiveBracket[]): ProgressiveBracket {
  let found = brackets[0];
  for (const bracket of brackets) {
    if (taxable >= bracket.min) found = bracket;
  }
  return found;
}

/** Total tax from a progressive schedule. A table walk, not a rule. */
function progressiveTax(taxable: number, brackets: readonly ProgressiveBracket[]): number {
  let tax = 0;
  for (const bracket of brackets) {
    if (taxable <= bracket.min) break;
    tax += (Math.min(taxable, bracket.max) - bracket.min) * bracket.rate;
  }
  return tax;
}

/** Capital gains stacked on ordinary income (IRC §1(h)): the engine's own traversal. */
function stackedCapitalGainsTax(taxableOrdinary: number, taxableGains: number, brackets: readonly CapitalGainsTaxBracket[]): number {
  const totalTaxable = taxableOrdinary + taxableGains;
  let tax = 0;
  for (const bracket of brackets) {
    if (totalTaxable <= bracket.min) break;
    const incomeInBracket = Math.min(totalTaxable, bracket.max) - bracket.min;
    const ordinaryInBracket = Math.max(0, Math.min(taxableOrdinary, bracket.max) - bracket.min);
    tax += (incomeInBracket - ordinaryInBracket) * bracket.rate;
  }
  return tax;
}

function bracketRows(taxable: number, brackets: readonly ProgressiveBracket[]): BracketRow[] {
  return brackets.map((bracket) => {
    const taxableInBracket = Math.max(0, Math.min(taxable, bracket.max) - bracket.min);
    const bounded = Number.isFinite(bracket.max);
    const remainingInBracket = bounded ? bracket.max - Math.max(bracket.min, Math.min(taxable, bracket.max)) : null;
    return {
      min: bracket.min,
      max: bounded ? bracket.max : null,
      rate: bracket.rate,
      taxableInBracket,
      remainingInBracket,
      shareFilled: bounded ? taxableInBracket / (bracket.max - bracket.min) : null,
    };
  });
}

/** Gain dollars inside each capital-gains bracket, plus the room for more gains in it. */
function capitalGainsBracketRows(taxableOrdinary: number, taxableGains: number, brackets: readonly CapitalGainsTaxBracket[]): BracketRow[] {
  const totalTaxable = taxableOrdinary + taxableGains;
  return brackets.map((bracket) => {
    const incomeInBracket = Math.max(0, Math.min(totalTaxable, bracket.max) - bracket.min);
    const ordinaryInBracket = Math.max(0, Math.min(taxableOrdinary, bracket.max) - bracket.min);
    const taxableInBracket = incomeInBracket - ordinaryInBracket;
    const bounded = Number.isFinite(bracket.max);
    return {
      min: bracket.min,
      max: bounded ? bracket.max : null,
      rate: bracket.rate,
      taxableInBracket,
      remainingInBracket: bounded ? bracket.max - Math.max(bracket.min, Math.min(totalTaxable, bracket.max)) : null,
      shareFilled: bounded ? incomeInBracket / (bracket.max - bracket.min) : null,
    };
  });
}

// ============================================================================
// IRMAA (a cost cliff, not a tax line — P3-P7a owns the liability)
// ============================================================================

/**
 * The IRMAA tier a MAGI lands in, and what crossing the next threshold costs.
 *
 * The thresholds are the ruleset's for `taxYear` (the year whose MAGI is used); the premium is
 * charged in `taxYear + lookbackYears`. Hand check (single, MAGI $108,000): tier 0, standard
 * $202.90/month, and $1,000 of room before the $109,000 threshold, where the premium would jump to
 * $284.10/month — $1,148.40 more per year in Part B and D together, for one dollar of MAGI. At MAGI
 * $110,000 the tier is 1 ($81.20 Part B + $14.50 Part D a month), with $27,000 of room before the
 * $137,000 threshold.
 */
export function irmaaCliff({
  magi,
  taxYear,
  filingStatus,
  inflationRatePercent = 0,
}: {
  magi: number;
  taxYear: TaxYear;
  filingStatus: FilingStatus;
  inflationRatePercent?: number;
}): IrmaaCliff {
  const rules = getRules(taxYear);
  // The IRMAA table is indexed, so this is a no-op today; it is read through the accessor so a
  // future ruleset that marks a tier amount `fixed` cannot leave the analytics on nominal dollars.
  const table = realDollars(rules.tables.medicareIrmaa, rules, taxYear, inflationRatePercent);
  const rows = table.tiers[filingStatus];
  const index = irmaaTierFor(magi, rows);
  const row = rows[index];
  const nextRow = rows[index + 1] ?? null;

  const toTier = (tier: number, values: (typeof rows)[number]): IrmaaTier => ({
    tier,
    min: values.min,
    max: values.max,
    monthlyAdjustment: values.partBMonthly,
    monthlyPremium: table.standardPartBMonthly + values.partBMonthly,
    partDMonthly: values.partDMonthly,
    annualSurcharge: (values.partBMonthly + values.partDMonthly) * 12,
  });

  const tier = toTier(index, row);
  const nextTier = nextRow === null ? null : toTier(index + 1, nextRow);

  return {
    taxYear,
    filingStatus,
    magiTaxYear: taxYear,
    premiumYear: taxYear + table.lookbackYears,
    magi,
    tier,
    headroomToNextTier: nextRow === null ? null : nextRow.min - magi,
    nextTier: nextTier === null ? null : { ...nextTier, stepUp: nextTier.annualSurcharge - tier.annualSurcharge },
    includes: 'partB-and-partD',
  };
}

// ============================================================================
// The year model
// ============================================================================

/**
 * One year's tax base, normalised so a hypothetical chunk of income can be applied to it.
 *
 * Every field is read from the settled result except the two bracket schedules, the NIIT table and
 * the §86 tier share, which are read from the ruleset. `taxableOrdinary` already includes taxable
 * Social Security and is already net of adjustments and the standard deduction, which is why a
 * hypothetical dollar can be added to it directly.
 */
interface YearModel {
  taxYear: TaxYear;
  filingStatus: FilingStatus;
  ordinaryBrackets: readonly ProgressiveBracket[];
  capitalGainsBrackets: readonly CapitalGainsTaxBracket[];
  niitRate: number;
  niitThreshold: number;

  taxableOrdinary: number;
  taxableCapitalGains: number;
  magi: number;
  /** Net investment income for §1411, as the engine computed it. */
  netInvestmentIncome: number;

  socialSecurityBenefits: number;
  taxableSocialSecurity: number;
  /** The share of the next provisional-income dollar that becomes taxable (IRC §86), from the tier. */
  socialSecurityPhaseInShare: number;
  /** How much Social Security can still become taxable; 0 once the 85% cap is reached. */
  socialSecurityPhaseInCapacity: number;

  wages: number;
  selfEmploymentEarnings: number;
  /** The year's own half-of-SE-tax deduction, already applied to `taxableOrdinary`. */
  selfEmploymentDeduction: number;
}

function buildYearModel(input: TaxAnalyticsInput): YearModel {
  const rules = getRules(input.taxYear);
  const { taxes } = input;
  const inflationRatePercent = input.inflationRatePercent ?? 0;
  const inRealDollars = <TValues>(table: TableMeta<TValues>) => realDollars(table, rules, input.taxYear, inflationRatePercent);
  const tiers = inRealDollars(rules.tables.socialSecurityTaxation).tiers[input.filingStatus];
  const maxShare = tiers[tiers.length - 1].taxablePercentage;
  return {
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    ordinaryBrackets: inRealDollars(rules.tables.incomeTaxBrackets)[input.filingStatus],
    capitalGainsBrackets: inRealDollars(rules.tables.capitalGainsTaxBrackets)[input.filingStatus],
    niitRate: rules.tables.netInvestmentIncomeTax.values.rate,
    niitThreshold: inRealDollars(rules.tables.netInvestmentIncomeTax).thresholds[input.filingStatus],

    taxableOrdinary: taxes.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary,
    taxableCapitalGains: taxes.capitalGainsTaxes.taxableIncomeTaxedAsCapitalGains,
    magi: taxes.incomeSources.adjustedGrossIncome,
    netInvestmentIncome: taxes.niit.netInvestmentIncome,

    socialSecurityBenefits: taxes.incomeSources.socialSecurityIncome,
    taxableSocialSecurity: taxes.incomeSources.taxableSocialSecurityIncome,
    // The engine resolves this tier from the ruleset; reusing it keeps §86 in one place.
    socialSecurityPhaseInShare: taxes.socialSecurityTaxes.maxTaxablePercentage,
    socialSecurityPhaseInCapacity: Math.max(
      0,
      taxes.incomeSources.socialSecurityIncome * maxShare - taxes.incomeSources.taxableSocialSecurityIncome
    ),

    wages: input.earnedIncome.wages,
    selfEmploymentEarnings: input.earnedIncome.selfEmployment,
    selfEmploymentDeduction: taxes.fica.selfEmployment.halfDeduction,
  };
}

/**
 * The effect of `amount` of one kind of income on the year's tax base.
 *
 * The rules each line encodes are the composition questions, not rates:
 * - ordinary income (a pension, a distribution, a conversion) is not investment income and not
 *   earned income, so it moves only taxable ordinary income and AGI;
 * - wages are ordinary income *and* earned income, so payroll applies;
 * - self-employment earnings are ordinary income, earned income, and the base of the SE tax, whose
 *   half deduction lowers taxable income;
 * - gains and qualified dividends are taxed at capital-gains rates and are net investment income;
 * - a Social Security dollar raises provisional income by 50 cents (§86), so only the tier's share
 *   of *that* becomes taxable;
 * - exempt income moves nothing.
 */
function withDelta(model: YearModel, incomeType: MarginalIncomeType, amount: number): YearModel {
  if (amount === 0 || incomeType === 'taxExempt') return model;

  let ordinaryIncome = 0;
  let capitalGains = 0;
  let socialSecurity = 0;
  let provisionalIncome = 0;
  let wages = 0;
  let selfEmployment = 0;

  switch (incomeType) {
    case 'ordinary':
    case 'taxDeferredWithdrawal':
    case 'rothConversion':
      ordinaryIncome = amount;
      provisionalIncome = amount;
      break;
    case 'wage':
      ordinaryIncome = amount;
      provisionalIncome = amount;
      wages = amount;
      break;
    case 'selfEmployment':
      ordinaryIncome = amount;
      provisionalIncome = amount;
      selfEmployment = amount;
      break;
    case 'longTermCapitalGain':
    case 'qualifiedDividend':
      capitalGains = amount;
      provisionalIncome = amount;
      break;
    case 'socialSecurity':
      socialSecurity = amount;
      provisionalIncome = amount * 0.5;
      break;
    default: {
      // Exhaustiveness guard. The guarantee is the assignment below: a member added to
      // `MarginalIncomeType` without a treatment here fails to compile, because TypeScript narrows
      // the residual case to `never` — and a cast on that line would quietly remove the guarantee.
      // The throw is for a runtime call that bypassed the type; an unpriced type would otherwise
      // price at zero, and a zero in a tax figure reads as "free".
      const unpriced: never = incomeType;
      throw new Error(`tax-analytics: no marginal treatment for income type "${String(unpriced)}"`);
    }
  }

  const newlyTaxableSocialSecurity = Math.min(model.socialSecurityPhaseInShare * provisionalIncome, model.socialSecurityPhaseInCapacity);

  return {
    ...model,
    taxableOrdinary: model.taxableOrdinary + ordinaryIncome + newlyTaxableSocialSecurity,
    taxableCapitalGains: model.taxableCapitalGains + capitalGains,
    magi: model.magi + ordinaryIncome + capitalGains + newlyTaxableSocialSecurity,
    netInvestmentIncome: model.netInvestmentIncome + capitalGains,
    socialSecurityBenefits: model.socialSecurityBenefits + socialSecurity,
    taxableSocialSecurity: model.taxableSocialSecurity + newlyTaxableSocialSecurity,
    wages: model.wages + wages,
    selfEmploymentEarnings: model.selfEmploymentEarnings + selfEmployment,
  };
}

interface Evaluation {
  lines: TaxLine[];
  taxableOrdinary: number;
  taxableCapitalGains: number;
  magi: number;
}

/**
 * Prices one year's tax base. `delta` is applied first, so calling it twice is a marginal
 * experiment; calling it once is the baseline.
 *
 * The SE tax is computed before the income tax because its half is an above-the-line deduction and
 * therefore changes the base: the deduction already inside `model.taxableOrdinary` is subtracted
 * from the delta only, never twice.
 */
function evaluate(model: YearModel, delta?: { incomeType: MarginalIncomeType; amount: number }): Evaluation {
  const base = delta ? withDelta(model, delta.incomeType, delta.amount) : model;

  const wagePayroll = computeWagePayrollTaxes({ wages: base.wages, filingStatus: model.filingStatus, taxYear: model.taxYear });
  const selfEmploymentTax = computeSelfEmploymentTaxes({
    netEarnings: base.selfEmploymentEarnings,
    wages: base.wages,
    filingStatus: model.filingStatus,
    taxYear: model.taxYear,
  });

  const addedSelfEmploymentDeduction = selfEmploymentTax.halfDeduction - model.selfEmploymentDeduction;
  const taxableOrdinary = Math.max(0, base.taxableOrdinary - addedSelfEmploymentDeduction);
  const magi = Math.max(0, base.magi - addedSelfEmploymentDeduction);

  const ordinaryTax = progressiveTax(taxableOrdinary, model.ordinaryBrackets);
  const capitalGainsTax = stackedCapitalGainsTax(taxableOrdinary, base.taxableCapitalGains, model.capitalGainsBrackets);
  const magiOverThreshold = Math.max(0, magi - model.niitThreshold);
  const niit = Math.min(base.netInvestmentIncome, magiOverThreshold) * model.niitRate;

  const lines: TaxLine[] = [
    { id: 'federalOrdinaryIncomeTax', label: 'Federal income tax on ordinary income', jurisdiction: 'federal', amount: ordinaryTax },
    {
      id: 'federalCapitalGainsTax',
      label: 'Federal tax on long-term gains and qualified dividends',
      jurisdiction: 'federal',
      amount: capitalGainsTax,
    },
    { id: 'niit', label: 'Net investment income tax', jurisdiction: 'federal', amount: niit },
    { id: 'payrollSocialSecurity', label: 'OASDI (employee share)', jurisdiction: 'federal', amount: wagePayroll.socialSecurity },
    { id: 'payrollMedicare', label: 'Medicare (employee share)', jurisdiction: 'federal', amount: wagePayroll.medicare },
    { id: 'payrollAdditionalMedicare', label: 'Additional Medicare Tax', jurisdiction: 'federal', amount: wagePayroll.additionalMedicare },
    { id: 'payrollStateDisability', label: 'California SDI', jurisdiction: 'CA', amount: wagePayroll.stateDisability },
    { id: 'selfEmploymentTax', label: 'Self-employment tax', jurisdiction: 'federal', amount: selfEmploymentTax.total },
  ];

  return { lines, taxableOrdinary, taxableCapitalGains: base.taxableCapitalGains, magi };
}

const sumLines = (lines: readonly TaxLine[]): number => lines.reduce((total, line) => total + line.amount, 0);

function headroomTargets(taxable: number, brackets: readonly ProgressiveBracket[], nextDollarRate: number): HeadroomTarget[] {
  // The headroom for a bracket is the distance to its *floor*: that is the amount of income it
  // takes to reach the next rate. (The bracket's ceiling is where the rate after it begins, which
  // is the next target's floor.) Every floor is finite, so `null` only appears for no target at
  // all — the top bracket has no higher rate to reach.
  return brackets
    .filter((bracket) => bracket.rate > nextDollarRate && bracket.min > taxable)
    .map((bracket) => ({ rate: bracket.rate, headroom: bracket.min - taxable, upToTaxableIncome: bracket.min }));
}

// ============================================================================
// Entry points
// ============================================================================

/** The clause that keeps a consumer from claiming more than this module can support. */
const NOT_COMPUTED = [
  'ACA premium tax credit and its cliff — P3-P7b. The credit itself is computed: `tax-data/aca` vendors the poverty guidelines and indexed applicable percentages for coverage years 2024–2027, `aca-premium-tax-credit` computes the credit and the 400 % cliff over them, and a plan that opts in (`taxSettings.aca`) gets the refundable credit on its settled return as `taxes.aca`. What is *not* modelled, and all this entry can claim: the Covered California state subsidy on top of the federal credit, the Alaska and Hawaii poverty lines, and the 138 %-of-FPL Medi-Cal floor — so the credit reported is the federal §36B amount only. `cliffs.aca` falls back to a prerequisite list, never a number, for a year whose plan did not opt in (or filed married-filing-separately, which §36B(c)(1)(C) makes ineligible).',
  'The AMT credit beyond the simplified §53 limit — the deferral-item refinement of Form 8801 Part III is not modelled (P3-P7a).',
  'The non-income-related Medicare Part B and Part D premiums — only the IRMAA surcharge is a liability line.',
  'The marginal effect of an itemized deduction — the engine applies the four entered itemized lines (with the §164 SALT cap and its MAGI phase-down and the §213 7.5%-of-AGI medical floor) and takes the larger of the two deductions, but this analysis reads the deduction the settled return took and never re-derives it: a dollar that would move the SALT phase-down or the medical floor is priced against a fixed deduction. The entered lines also carry no §170 charitable AGI limit and no §163(h)(3) mortgage-debt cap — they are taken as entered.',
  'The §72(t) 10% additional tax and the §223(f)(4) 20% HSA tax on a marginal early withdrawal — the engine charges those from the account type and age, not from a marginal rate.',
  'Pro-rata basis on a Roth conversion (§408(d)(2)) — P3-P5. A conversion dollar here is fully taxable, so its rate is an upper bound.',
] as const;

/**
 * The California questions this analytics cannot answer, even though the return itself is settled.
 *
 * These are not absences of the state return — `reported` carries it — but the parts of California
 * taxation the engine does not compute, listed so an answer names the limit instead of implying the
 * return is complete.
 */
const CALIFORNIA_NOT_MODELLED = [
  'Covered California premium subsidies — the state assistance layered on top of the federal §36B premium tax credit. The federal credit itself *is* modelled (`tax-data/aca`, `aca-premium-tax-credit`), so what is missing here is only the state subsidy (P3-P7b); no subsidy figure exists on either the federal or the state return.',
  'California AMT — the state alternative minimum tax (RTC §17062) is not computed, so the state figure is the regular tax plus the Behavioral Health Services Tax, less the exemption credits.',
] as const;

/**
 * The senior deduction as the ruleset declares it for one filing status (§151(d)(5)(C), P3-P1b).
 *
 * Both facts come from the table, never from a comparison against one status's name: `available` is
 * `tables.seniorDeduction.values.eligible[filingStatus]` and `inForce` is the statute's sunset
 * (`lastTaxYear`, which `TaxProcessor.seniorDeductionFor` also reads). `claimed` is the return's own
 * figure, copied — so "the rule denies it" and "the year allows it but nothing was claimed" stay
 * distinguishable in one object.
 */
function seniorDeductionAvailability(
  taxYear: TaxYear,
  filingStatus: FilingStatus,
  claimed: number,
  inflationRatePercent: number
): SeniorDeductionAvailability {
  const rules = getRules(taxYear);
  // `eligible` and `lastTaxYear` are not dollars; reading through the accessor keeps this function
  // honest if the table's money is deflated (it is: `perIndividual` and the phase-out threshold).
  const table = realDollars(rules.tables.seniorDeduction, rules, taxYear, inflationRatePercent);
  const available = table.eligible[filingStatus];
  const inForce = taxYear <= table.lastTaxYear;

  let deniedBy: string | null = null;
  if (!inForce) {
    deniedBy =
      `Denied by rule: the §151(d)(5)(C) senior deduction does not exist for tax year ${taxYear} — the statute allows it ` +
      `only through ${table.lastTaxYear}, so the return claims nothing for it.`;
  } else if (!available) {
    deniedBy =
      `Denied by rule: the federal ${rules.year} ruleset declares the ${filingStatus} filing status ineligible for the ` +
      `§151(d)(5)(C) senior deduction (\`eligible.${filingStatus}\` is false). The paragraph allows it per qualified ` +
      'individual and denies it where the individual’s spouse also claims it, and the engine prices one return at a ' +
      'time, so it cannot check the spouse’s: the return claims nothing for it, not a smaller amount.';
  }

  return { available, inForce, claimed, deniedBy, resolvedYear: rules.year };
}

/**
 * The IRMAA tier *charged* this year, derived from the MAGI of two years earlier.
 *
 * The MAGI comes from the lookback return; the thresholds are the premium year's, which is how the
 * programme works (each year's thresholds are published for that year's premiums). This is the half
 * of the lookback a single year cannot answer on its own, which is why the input carries
 * `priorYearMagi` and why this returns a reason instead of a number when it is missing.
 */
function resolveIrmaaLookback(input: TaxAnalyticsInput): {
  charged: (IrmaaTier & { magi: number; magiTaxYear: TaxYear }) | null;
  unavailable: string | null;
} {
  const prior = input.priorYearMagi;

  if (!prior) {
    return {
      charged: null,
      unavailable:
        `The result carries no MAGI for ${input.taxYear - 2}, so the tier charged this year cannot be derived ` +
        '(the plan starts later, or this is one of its first two years).',
    };
  }

  if (prior.taxYear !== input.taxYear - 2) {
    return {
      charged: null,
      unavailable:
        `The lookback year is ${input.taxYear - 2}, but the caller supplied ${prior.taxYear}. ` +
        'Premiums are set from the MAGI of exactly two years earlier.',
    };
  }

  // The thresholds applied are the premium year's; only the MAGI comes from the lookback year.
  const tier = irmaaCliff({
    magi: prior.magi,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    inflationRatePercent: input.inflationRatePercent ?? 0,
  }).tier;
  return { charged: { ...tier, magi: prior.magi, magiTaxYear: prior.taxYear }, unavailable: null };
}

/**
 * The ACA cliff block for one settled credit, derived from the coverage year's own table.
 *
 * The threshold is the table's `eligibility.maxFplPercent` applied to the poverty line the credit
 * used — not a hard-coded 400 %. IRC §36B(i) suspends the 400 % ceiling for tax years 2021–2025, so
 * the 2024 and 2025 rows carry `maxFplPercent: null` and those years report a `null` threshold and a
 * `null` headroom: there is no cliff to cross, and 4 × the FPL would name one the law does not have.
 *
 * It reads the table that *priced* the credit (`resolvedYear`), not the return's tax year, because a
 * coverage year past the last vendored row is priced from the nearest prior row; that year is
 * reported alongside, so no consumer has to infer it.
 *
 * Exported because the suspension cannot be exercised through `analyzeTaxYear`: the engine has no
 * federal ruleset before 2026 (`getRules` throws), so no ARPA coverage year can be settled today.
 */
export function acaCliffFor(aca: AcaPremiumTaxCreditResult): AcaCliffReported {
  const { maxFplPercent } = getAcaTable(aca.resolvedYear).eligibility.values;
  const cliffThreshold = maxFplPercent === null ? null : aca.povertyLine * (maxFplPercent / 100);

  return {
    supported: true,
    credit: aca.credit,
    resolvedYear: aca.resolvedYear,
    householdIncome: aca.householdIncome,
    povertyLine: aca.povertyLine,
    fplPercent: aca.fplPercent,
    applicablePercentage: aca.applicablePercentage,
    requiredContribution: aca.requiredContribution,
    slcspPremium: aca.slcspPremium,
    cliffThreshold,
    headroom: cliffThreshold === null ? null : Math.max(0, cliffThreshold - aca.householdIncome),
  };
}

/**
 * Answers the P3-P6 questions for one settled year.
 *
 * @example
 * const analytics = analyzeTaxYear({ taxYear: 2026, filingStatus: 'single', taxes, earnedIncome });
 * analytics.marginalRates.wage.rate;                            // e.g. 0.3095
 * analytics.conversionHeadroom.nextBracket?.headroom;           // room before the next rate
 * analytics.cliffs.irmaa.projected.headroomToNextTier;          // MAGI before the next Part B tier
 */
export function analyzeTaxYear(input: TaxAnalyticsInput): TaxAnalytics {
  const model = buildYearModel(input);
  const baseline = evaluate(model);

  const ordinaryRate = bracketFor(model.taxableOrdinary, model.ordinaryBrackets).rate;
  const capitalGainsNextDollarRate = bracketFor(model.taxableOrdinary + model.taxableCapitalGains, model.capitalGainsBrackets).rate;

  const ordinaryRows = bracketRows(model.taxableOrdinary, model.ordinaryBrackets);
  const capitalGainsRows = capitalGainsBracketRows(model.taxableOrdinary, model.taxableCapitalGains, model.capitalGainsBrackets);

  const marginalRateFor = (incomeType: MarginalIncomeType): MarginalRate => {
    const decomposition = decompose(model, incomeType, 1);
    return {
      incomeType,
      rate: decomposition.marginalRate,
      lines: decomposition.lines.map((line) => ({ id: line.id, label: line.label, jurisdiction: line.jurisdiction, rate: line.delta })),
    };
  };

  // One entry per member of `MarginalIncomeType`, written out rather than built from a list: an
  // object literal annotated with the record type is checked key by key, so a member the union gains
  // and this object lacks is a compile error — not a `marginalRates.someType` that reads as
  // `undefined` and then as a zero rate.
  const marginalRates: Record<MarginalIncomeType, MarginalRate> = {
    ordinary: marginalRateFor('ordinary'),
    taxDeferredWithdrawal: marginalRateFor('taxDeferredWithdrawal'),
    rothConversion: marginalRateFor('rothConversion'),
    wage: marginalRateFor('wage'),
    selfEmployment: marginalRateFor('selfEmployment'),
    longTermCapitalGain: marginalRateFor('longTermCapitalGain'),
    qualifiedDividend: marginalRateFor('qualifiedDividend'),
    socialSecurity: marginalRateFor('socialSecurity'),
    taxExempt: marginalRateFor('taxExempt'),
  };

  const rules = getRules(input.taxYear);
  const niitHeadroom = Math.max(0, model.niitThreshold - model.magi);
  const additionalMedicareThreshold = realDollars(
    rules.tables.additionalMedicareThreshold,
    rules,
    input.taxYear,
    input.inflationRatePercent ?? 0
  )[input.filingStatus];
  const additionalMedicareHeadroom = Math.max(0, additionalMedicareThreshold - model.wages);

  const projectedIrmaa = irmaaCliff({
    magi: model.magi,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    inflationRatePercent: input.inflationRatePercent ?? 0,
  });
  const lookback = resolveIrmaaLookback(input);
  const acaCliff = input.taxes.aca === undefined ? undefined : acaCliffFor(input.taxes.aca);

  return {
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    reported: {
      federalIncomeTax: input.taxes.federalIncomeTaxes.federalIncomeTaxAmount,
      capitalGainsTax: input.taxes.capitalGainsTaxes.capitalGainsTaxAmount,
      niit: input.taxes.niit.niitAmount,
      payrollTaxes: input.taxes.fica.total,
      totalTaxLiability: input.taxes.totalTaxLiability,
    },
    baseline: baseline.lines,
    deductions: {
      type: input.taxes.deduction.type,
      total: input.taxes.deduction.total,
      seniorDeduction: seniorDeductionAvailability(
        input.taxYear,
        input.filingStatus,
        input.taxes.deduction.seniorDeduction,
        input.inflationRatePercent ?? 0
      ),
    },
    bracketFill: {
      ordinary: { brackets: ordinaryRows, taxableIncome: model.taxableOrdinary, nextDollarRate: ordinaryRate },
      capitalGains: {
        brackets: capitalGainsRows,
        taxableIncome: model.taxableCapitalGains,
        nextDollarRate: capitalGainsNextDollarRate,
        stackedOnOrdinaryIncome: model.taxableOrdinary,
      },
    },
    conversionHeadroom: {
      nextBracket: headroomTargets(model.taxableOrdinary, model.ordinaryBrackets, ordinaryRate)[0] ?? null,
      targets: headroomTargets(model.taxableOrdinary, model.ordinaryBrackets, ordinaryRate),
    },
    marginalRates,
    cliffs: {
      niit: {
        id: 'niit',
        label: 'Net investment income tax (§1411)',
        measuredOn: 'magi',
        threshold: model.niitThreshold,
        current: model.magi,
        headroom: niitHeadroom,
        costOfCrossing: model.niitRate,
        supported: true,
      },
      additionalMedicare: {
        id: 'additionalMedicare',
        label: 'Additional Medicare Tax',
        measuredOn: 'earnedIncome',
        threshold: additionalMedicareThreshold,
        current: model.wages,
        headroom: additionalMedicareHeadroom,
        costOfCrossing: rules.tables.payrollTaxRates.values.additionalMedicare,
        supported: true,
      },
      irmaa: {
        premiumYear: input.taxYear + 2,
        projected: projectedIrmaa,
        ...lookback,
      },
      aca: acaCliff ?? {
        supported: false,
        prerequisites: [
          'the plan opting in — `taxSettings.aca.optIn`, which no year sets on its own, so a plan without it has no credit to report',
          'the marketplace second-lowest-cost silver premium (SLCSP) for the coverage year — the optional plan input `taxSettings.aca.slcsp`, which must be greater than zero',
          'the household size for the coverage year — optional, `taxSettings.aca.householdSize`, defaulting to 2 on a joint return and 1 otherwise',
          'whether the enhanced subsidies are in force, which decides whether the 400% FPL cliff exists at all — the vendored tables answer that for coverage years 2024–2027',
        ],
      },
    },
    jurisdictions: {
      federal: { supported: true, totalTaxLiability: sumLines(baseline.lines.filter((line) => line.jurisdiction === 'federal')) },
      california: {
        supported: true,
        reported: input.taxes.state,
        stateDisability: baseline.lines.find((line) => line.id === 'payrollStateDisability')?.amount ?? 0,
        notModelled: [...CALIFORNIA_NOT_MODELLED],
      },
    },
    notComputed: [...NOT_COMPUTED],
  };
}

function decompose(model: YearModel, incomeType: MarginalIncomeType, amount: number): NextDollarDecomposition {
  const before = evaluate(model);
  const after = evaluate(model, { incomeType, amount });

  const lines = after.lines
    .map((line, index) => ({ ...line, delta: line.amount - before.lines[index].amount }))
    .filter((line) => Math.abs(line.delta) > 1e-9);

  const totalDelta = lines.reduce((total, line) => total + line.delta, 0);

  return {
    incomeType,
    amount,
    lines: lines.map(({ id, label, jurisdiction, delta }) => ({ id, label, jurisdiction, delta })),
    totalDelta,
    marginalRate: amount === 0 ? 0 : totalDelta / amount,
    taxableOrdinaryIncomeDelta: after.taxableOrdinary - before.taxableOrdinary,
    magiDelta: after.magi - before.magi,
  };
}

/**
 * What one more chunk of income of a given kind would cost, line by line.
 *
 * The lines are the difference between two priced years, so they always sum to `totalDelta`: there
 * is no separate "total" formula that could disagree with its parts. A consumer that needs to
 * explain a number (§7-A3) can name each line and its contribution.
 *
 * @example decomposeNextDollar(input, { incomeType: 'ordinary', amount: 1000 })
 */
export function decomposeNextDollar(
  input: TaxAnalyticsInput,
  request: { incomeType: MarginalIncomeType; amount: number }
): NextDollarDecomposition {
  if (!Number.isFinite(request.amount) || request.amount < 0) {
    throw new Error(`Amount must be a finite, non-negative number, received ${request.amount}`);
  }
  return decompose(buildYearModel(input), request.incomeType, request.amount);
}

/**
 * The same analysis, wired from a completed simulation: it finds the year, resolves its tax year
 * from the row's own date (never from a clock), and hands the analytics the MAGI from two rows
 * earlier so the IRMAA lookback is answered rather than guessed.
 *
 * @param params.data - `result.data` from `simulate()`, unchanged.
 * @param params.index - Which row to analyse. Row 0 is the initial state and has no tax result.
 */
export function analyzeSimulationTaxYear(params: {
  data: readonly SimulationDataPoint[];
  index: number;
  filingStatus: FilingStatus;
  /** The plan's inflation assumption, so a statute-locked threshold matches the return's. */
  inflationRatePercent?: number;
}): TaxAnalytics {
  const dataPoint = params.data[params.index];
  if (!dataPoint) throw new Error(`No simulation data point at index ${params.index}`);
  if (!dataPoint.taxes) {
    throw new Error(`The data point at index ${params.index} has no settled tax result (row 0 is the initial state).`);
  }

  const taxYear = parseISODateString(dataPoint.date).year;
  const lookbackPoint = params.index >= 2 ? params.data[params.index - 2] : undefined;
  const priorYearMagi =
    lookbackPoint?.taxes !== null && lookbackPoint?.taxes !== undefined
      ? { taxYear: parseISODateString(lookbackPoint.date).year, magi: lookbackPoint.taxes.incomeSources.adjustedGrossIncome }
      : undefined;

  return analyzeTaxYear({
    taxYear,
    filingStatus: params.filingStatus,
    taxes: dataPoint.taxes,
    earnedIncome: {
      wages: dataPoint.incomes?.totalWageIncome ?? 0,
      selfEmployment: dataPoint.incomes?.totalSelfEmploymentIncome ?? 0,
    },
    priorYearMagi,
    inflationRatePercent: params.inflationRatePercent,
  });
}
