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
 * Jurisdictions the engine can model. Only `'federal'` has a ruleset today; `'CA'` is the
 * shape P3-P8 fills in. Resolving a jurisdiction without a registry throws.
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
  readonly socialSecurityTaxation: TableMeta<ByFilingStatus<SocialSecurityTaxThreshold[]>>;
  /** Primary-residence gain exclusion (IRC §121). */
  readonly section121Exclusion: TableMeta<ByFilingStatus<number>>;
  /** The alternative minimum tax (IRC §55-§59): exemption, phase-out, rates, disallowed deductions. */
  readonly alternativeMinimumTax: TableMeta<AlternativeMinimumTaxTable>;
  /** Medicare income-related monthly adjustment amounts, Parts B and D (42 U.S.C. §1395r(i)). */
  readonly medicareIrmaa: TableMeta<MedicareIrmaaTable>;
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

/** A federal ruleset, with the federal-only table groups present. */
export type FederalTaxRuleset = TaxRuleset<FederalTaxTables>;
