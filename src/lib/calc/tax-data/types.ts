/**
 * Tax ruleset contract.
 *
 * Every tax table lives inside a versioned ruleset for one tax year and one jurisdiction
 * (`years/<year>.ts` for federal, `states/CA/<year>.ts` for California). Rules are resolved
 * through `getRules(year)` in `./index`, which falls back to the nearest *prior* year and
 * throws when no ruleset exists at or before the requested year.
 *
 * Each table carries its own metadata, not just its values:
 * - `indexing` records whether the amounts are adjusted for inflation every year
 *   (`'indexed'`) or fixed by statute (`'fixed'`). The two get silently confused, and
 *   borrowing an indexed table for a statutory amount (or vice versa) is a wrong-number bug
 *   that no test would catch, so the declaration is required, not optional.
 * - `source` cites the authority for the amounts, so an annual update can be reviewed as a
 *   data diff against the published release.
 *
 * The shapes are split so a non-federal jurisdiction fits without rework: `TaxTables` holds
 * the table groups every jurisdiction has, and `FederalTaxTables` adds the groups that only
 * the federal return has (a state ruleset simply does not declare them — California taxes
 * long-term gains as ordinary income and has no NIIT or §86 tiers).
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

/** A calendar tax year, e.g. 2026. Rulesets are filed and resolved by this number. */
export type TaxYear = number;

/**
 * Jurisdictions the engine can model. `'federal'` and `'CA'` both have a registered ruleset in
 * `./index`. Resolving a jurisdiction without a registry throws.
 */
export type Jurisdiction = 'federal' | 'CA';

/**
 * Whether a table's amounts are adjusted for inflation each year (`'indexed'`) or fixed by
 * statute (`'fixed'`). An indexed table must be re-issued every year; a fixed table must be
 * copied forward byte-identical until the statute changes.
 */
export type Indexing = 'indexed' | 'fixed';

/** A table's values plus the two facts every consumer needs about them. */
export interface TableMeta<TValues> {
  readonly values: TValues;
  readonly indexing: Indexing;
  /** Citation for the amounts: the Code section and the published release they come from. */
  readonly source: string;
}

/** One row of a progressive schedule. `max` is exclusive; the top row uses `Infinity`. */
export interface ProgressiveBracket {
  readonly min: number;
  readonly max: number;
  readonly rate: number;
}

/** Ordinary-income bracket (IRC §1). */
export type FederalIncomeTaxBracket = ProgressiveBracket;

/** Long-term capital-gains bracket (IRC §1(h)). */
export type CapitalGainsTaxBracket = ProgressiveBracket;

/**
 * One Social Security taxation tier (IRC §86): the share of benefits taxable once provisional
 * income passes `min`. `taxablePercentage` is read by the tax processor — it is not a comment.
 */
export interface SocialSecurityTaxThreshold {
  readonly min: number;
  readonly max: number;
  readonly taxablePercentage: number;
}

/**
 * The §86 table: the tiers, plus the one filing status whose base amount is **zero**.
 *
 * §86(c)(1)(C) sets the base amount of a married individual filing a separate return to $0, and
 * §86(c)(2)(C) sets the adjusted base amount to $0 as well. With both at zero the three-tier
 * computation collapses: the 50% band has zero width, so the taxable share is 85% of provisional
 * income from the first dollar, capped at 85% of the benefits (which the tier row states as
 * `{ min: 0, max: Infinity, taxablePercentage: 0.85 }`).
 *
 * The flag is declared rather than inferred from `tiers.length === 1` because a ruleset could
 * legitimately have a single tier for another reason, and because the collapsed form is a
 * *different* computation, not the same one with different numbers: with a zero-width second tier
 * the general walk below cannot express it (its first test `provisionalIncome <= firstTier.max`
 * would be true for every income). Declaring the shape keeps the walk honest.
 *
 * **Not modelled**: the §86(c)(1)(C) exception for spouses who lived apart for the whole year
 * and file separately, which restores the single base amounts. The engine has no separate-return
 * `livedApart` input, and a plan that qualifies for it would need one; the flag therefore applies
 * to every separate return.
 */
export interface SocialSecurityTaxationTable {
  readonly tiers: ByFilingStatus<readonly SocialSecurityTaxThreshold[]>;
  /** True where the base and adjusted base amounts are both $0, i.e. the collapsed 85% rule. */
  readonly taxableFromFirstDollar: ByFilingStatus<boolean>;
}

/**
 * A table that varies by filing status.
 *
 * Keyed by the current `FilingStatus` union, so adding `marriedFilingSeparately` (P3-P1b)
 * is a compile error on every table until the MFS amounts are filled in — the tables cannot
 * be left silently short of a filing status.
 */
export type ByFilingStatus<T> = Record<FilingStatus, T>;

/** Net investment income tax (IRC §1411): one rate and one threshold per filing status. */
export interface NetInvestmentIncomeTaxTable {
  readonly rate: number;
  readonly thresholds: ByFilingStatus<number>;
}

/**
 * The employee-share payroll rates and the self-employment equivalents (IRC §3101, §1401).
 *
 * Every rate here is statutory and none is indexed, which is why the whole group is one table
 * with `indexing: 'fixed'`: only the wage base below moves with inflation. The self-employment
 * figures are the *combined* employee-plus-employer shares, because a self-employed earner pays
 * both halves; `selfEmploymentDeduction` is the share of the resulting tax that IRC §164(f)
 * allows as an above-the-line deduction.
 */
export interface PayrollTaxRates {
  /** Employee OASDI share (IRC §3101(a)). */
  readonly socialSecurity: number;
  /** Employee Hospital Insurance share (IRC §3101(b)). */
  readonly medicare: number;
  /** Additional Medicare Tax on wages above the filing-status threshold (IRC §3101(b)(2)). */
  readonly additionalMedicare: number;
  /** Share of net self-employment earnings that is subject to SE tax (IRC §1402(a)(12)). */
  readonly selfEmploymentTaxablePercentage: number;
  /** Self-employed OASDI share: both halves (IRC §1401(a)). */
  readonly selfEmploymentSocialSecurity: number;
  /** Self-employed Hospital Insurance share: both halves (IRC §1401(b)). */
  readonly selfEmploymentMedicare: number;
  /** Share of the SE tax deductible above the line (IRC §164(f)). */
  readonly selfEmploymentDeduction: number;
}

/**
 * Alternative minimum tax parameters (IRC §55-§59).
 *
 * The exemption is indexed; the 26%/28% rates, the 25% phase-out rate and the $175,000 ceiling on
 * the 26% band are statutory and have not moved since 1993 (the ceiling is $87,500 on a separate
 * return). The table is declared `indexed` because the amounts that do move are the exemption and
 * its phase-out threshold; the fixed parts say so in their own source line, so the annual update
 * knows exactly what to re-issue and what to copy forward.
 *
 * `disallowedDeductions` names the below-the-line deductions the regular return allows and AMT does
 * not (IRC §56(b)(1)): the standard deduction, state and local taxes, and miscellaneous itemized
 * deductions. Qualified mortgage interest and charitable contributions are deliberately absent —
 * they survive. The engine has no itemized deductions yet (P3-P3), so only the standard deduction
 * entry is ever non-zero today; the list is the table the add-back is driven from, not an if.
 */
export interface AlternativeMinimumTaxTable {
  readonly exemption: ByFilingStatus<number>;
  /** AMTI above which the exemption phases out at 25 cents per dollar. */
  readonly exemptionPhaseOutThreshold: ByFilingStatus<number>;
  readonly exemptionPhaseOutRate: number;
  /** 26% on the AMT base up to `rateLowCeiling`, 28% above it. */
  readonly rateLow: number;
  readonly rateHigh: number;
  /** Statutory: $175,000, or $87,500 on a separate return. */
  readonly rateLowCeiling: ByFilingStatus<number>;
  readonly disallowedDeductions: readonly string[];
}

/**
 * One Medicare income-related monthly adjustment tier (42 U.S.C. §1395r(i)).
 *
 * `min` is exclusive and `max` inclusive, the way CMS publishes the table ("greater than X and
 * less than or equal to Y"); the top tier is unbounded. The amounts are per month and are
 * *surcharges*: the standard premium is not part of them.
 */
export interface MedicareIrmaaTier {
  readonly min: number;
  readonly max: number | null;
  /** Monthly Part B income-related adjustment. */
  readonly partBMonthly: number;
  /** Monthly Part D income-related adjustment. */
  readonly partDMonthly: number;
}

/**
 * Medicare IRMAA (Part B and Part D income-related monthly adjustment amounts).
 *
 * The thresholds and amounts are indexed annually, and the tier charged in a year is set from the
 * return filed **two years earlier** (`lookbackYears`), which is why the tax engine needs the MAGI
 * history rather than the current year's alone. CMS publishes one "individual" column, so a head of
 * household uses the single thresholds.
 */
export interface MedicareIrmaaTable {
  readonly tiers: ByFilingStatus<readonly MedicareIrmaaTier[]>;
  /** Years between the MAGI that sets the premium and the year the premium is charged. */
  readonly lookbackYears: number;
  /** Standard Part B premium, so a report can show the total premium and not only the surcharge. */
  readonly standardPartBMonthly: number;
}

/**
 * The temporary senior deduction (IRC §151(d)(5)(C), added by P.L. 119-21 §70103).
 *
 * $6,000 for each individual on the return who is 65 or older at the end of the year, reduced by 6%
 * of MAGI over $75,000 ($150,000 on a joint return), for tax years beginning before 2029. It is
 * **fixed** by statute — not indexed — and it is *not* an itemized deduction: it is allowed on top
 * of the standard deduction or the itemized total, and it survives into AMTI because §56 does not
 * add it back. `lastTaxYear` carries the sunset so a later year's return reads zero from the table
 * rather than borrowing the last year the deduction existed.
 */
export interface SeniorDeductionTable {
  readonly perIndividual: number;
  readonly phaseOutThreshold: ByFilingStatus<number>;
  /**
   * Whether the status may claim the deduction at all (P3-P1b). Declared, not a zero amount: a
   * zero would read as a computed value ("$0 of senior deduction this year") instead of "this
   * return cannot claim it", and the two are not the same statement.
   *
   * §151(d)(5)(C) allows the deduction per qualified individual and denies it where the individual's
   * spouse also claims it for the year — which is exactly the pair of separate returns this engine
   * cannot see across simultaneously. Rather than model spouse coordination, the table declares a
   * separate return ineligible. The consequence is real and shows up in the MFS-versus-MFJ
   * comparison: a couple of two 65-year-olds filing separately deducts nothing here, where filing
   * jointly deducts $12,000 before the MAGI phase-down.
   */
  readonly eligible: ByFilingStatus<boolean>;
  readonly phaseOutRate: number;
  /** The last tax year the deduction exists (the statute's "before January 1, 2029"). */
  readonly lastTaxYear: TaxYear;
}

/** Table groups every jurisdiction has. */
export interface TaxTables {
  /** Progressive ordinary-income schedule (federal: IRC §1). */
  readonly incomeTaxBrackets: TableMeta<ByFilingStatus<ProgressiveBracket[]>>;
  /** Standard deduction (federal: IRC §63). */
  readonly standardDeduction: TableMeta<ByFilingStatus<number>>;
}

/** Table groups that only the federal return has. */
export interface FederalTaxTables extends TaxTables {
  /** Long-term capital-gains and qualified-dividend schedule (IRC §1(h)). */
  readonly capitalGainsTaxBrackets: TableMeta<ByFilingStatus<ProgressiveBracket[]>>;
  /**
   * The OASDI contribution and benefit base (the "Social Security wage base", IRC §230). Indexed
   * every year by the national average wage index, so it must be re-issued annually and must
   * never be borrowed from a later year.
   */
  readonly socialSecurityWageBase: TableMeta<number>;
  /** Employee-share payroll rates and the self-employment equivalents. Statutory, not indexed. */
  readonly payrollTaxRates: TableMeta<PayrollTaxRates>;
  /**
   * Additional Medicare Tax thresholds (IRC §3101(b)(2), §1401(b)(2)). Fixed by statute since
   * 2013 — deliberately *not* indexed — and they differ by filing status, so a filing status
   * added later is a compile error here rather than a silently missing threshold.
   */
  readonly additionalMedicareThreshold: TableMeta<ByFilingStatus<number>>;
  /** Net investment income tax (IRC §1411). */
  readonly netInvestmentIncomeTax: TableMeta<NetInvestmentIncomeTaxTable>;
  /** Social Security benefit taxation tiers (IRC §86). */
  readonly socialSecurityTaxation: TableMeta<SocialSecurityTaxationTable>;
  /** Primary-residence gain exclusion (IRC §121). */
  readonly section121Exclusion: TableMeta<ByFilingStatus<number>>;
  /** The alternative minimum tax (IRC §55-§59): exemption, phase-out, rates, disallowed deductions. */
  readonly alternativeMinimumTax: TableMeta<AlternativeMinimumTaxTable>;
  /** Medicare income-related monthly adjustment amounts, Parts B and D (42 U.S.C. §1395r(i)). */
  readonly medicareIrmaa: TableMeta<MedicareIrmaaTable>;
  /** The temporary senior deduction (IRC §151(d)(5)(C)). */
  readonly seniorDeduction: TableMeta<SeniorDeductionTable>;
  /** The AGI floor on the medical-expense itemized deduction (IRC §213(a)); a rate, not an amount. */
  readonly medicalExpenseFloor: TableMeta<number>;
}

/**
 * One year's rules for one jurisdiction.
 *
 * `tables` is generic with a default of the shared `TaxTables` shape, so a California
 * ruleset is `TaxRuleset<CaliforniaTaxTables>` — same type, same resolution, different
 * table groups. Nothing here assumes a federal table exists.
 */
export interface TaxRuleset<TTables extends TaxTables = TaxTables> {
  readonly jurisdiction: Jurisdiction;
  readonly year: TaxYear;
  /** Provenance for the ruleset as a whole; each table also cites its own authority. */
  readonly source: string;
  readonly tables: TTables;
}

// ============================================================================
// California (P3-P8)
// ============================================================================

/**
 * The Behavioral Health Services Tax (R&TC §17043), called the Mental Health Services Tax before
 * 2025: 1% of taxable income above $1,000,000 for every filing status except a separate return,
 * which uses $500,000.
 */
export interface BehavioralHealthServicesTaxTable {
  readonly rate: number;
  readonly threshold: ByFilingStatus<number>;
}

/**
 * The personal exemption credit (R&TC §17054), which is a **credit against tax**, not a deduction,
 * and is limited above an AGI threshold by $6 for each $2,500 (or part) of excess — $1,250 on a
 * separate return, which is why the step is per filing status rather than one number.
 *
 * The dependent credit is carried so the table is complete, but the engine models no dependents;
 * the blind and senior credits are separate R&TC sections and are out of scope.
 */
export interface PersonalExemptionCreditTable {
  readonly perTaxpayer: number;
  readonly dependent: number;
  readonly agiLimit: ByFilingStatus<number>;
  /** $2,500, or $1,250 on a separate return (540 line 32 AGI Limitation Worksheet). */
  readonly reductionStep: ByFilingStatus<number>;
  readonly reductionPerStep: number;
}

/**
 * California's itemized-deduction limitation (Schedule CA (540), Part II, line 29): the deduction
 * is reduced by 6% of federal AGI over the threshold, but never by more than 80% of itself.
 *
 * `disallowed` names the itemized lines California does not allow at all, keyed the same way the
 * federal §56(b)(1) list is. State and local income tax and SDI are on it; property tax is not.
 */
export interface CaliforniaItemizedDeductionLimitTable {
  readonly agiThreshold: ByFilingStatus<number>;
  readonly rate: number;
  readonly maxReductionShare: number;
  readonly disallowed: readonly string[];
}

/**
 * How California's return differs from the federal one, as flags rather than `if`s.
 *
 * Every one of these is a place where a naive reuse of the federal computation would be wrong, and
 * each is read by the state pass:
 * - `preferentialCapitalGains: false` — gains and qualified dividends are ordinary income;
 * - `taxesSocialSecurity: false` — Social Security is excluded entirely, with no §86 equivalent;
 * - `allowsFederalSeniorDeduction: false` — the OBBBA senior deduction is a federal change
 *   California does not conform to (the 540 booklet says so explicitly);
 * - `allowsStateIncomeTaxDeduction: false` — no CA deduction for state income tax, SDI or sales tax
 *   (Schedule CA (540) line 5a), which is also why the CA tax cannot be deducted on the CA return;
 * - `medicalExpenseFloor` — CA conforms to the federal 7.5%-of-AGI floor.
 */
export interface CaliforniaConformityTable {
  readonly preferentialCapitalGains: boolean;
  readonly taxesSocialSecurity: boolean;
  readonly allowsFederalSeniorDeduction: boolean;
  readonly allowsStateIncomeTaxDeduction: boolean;
  readonly medicalExpenseFloor: number;
}

/** Table groups a California ruleset adds to the shared ones. */
export interface CaliforniaTaxTables extends TaxTables {
  readonly behavioralHealthServicesTax: TableMeta<BehavioralHealthServicesTaxTable>;
  readonly personalExemptionCredit: TableMeta<PersonalExemptionCreditTable>;
  readonly itemizedDeductionLimit: TableMeta<CaliforniaItemizedDeductionLimitTable>;
  readonly conformity: TableMeta<CaliforniaConformityTable>;
}

/** A California ruleset. */
export type CaliforniaTaxRuleset = TaxRuleset<CaliforniaTaxTables>;

/** A federal ruleset, with the federal-only table groups present. */
export type FederalTaxRuleset = TaxRuleset<FederalTaxTables>;
