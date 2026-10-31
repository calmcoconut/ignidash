/**
 * ACA premium tax credit inputs, vendored (parity plan P3-P7b, tables only).
 *
 * Everything the premium tax credit (PTC) needs that is *statutory* lives here: the federal
 * poverty line, the applicable-percentage schedule, and the eligibility bounds. The arithmetic
 * over them is in `../aca-premium-tax-credit`, so a rules update is a data diff against the
 * published releases and never a code change.
 *
 * ## What is covered, and what is deliberately not
 *
 * | year | FPL | applicable percentages | upper bound |
 * | --- | --- | --- | --- |
 * | 2024 | HHS 2024 | ARPA-enhanced | none (§36B(i)) |
 * | 2025 | HHS 2025 | ARPA-enhanced | none (§36B(i)) |
 *
 * The engine's current tax year is 2026 and **no 2026 table is shipped**, on purpose:
 *
 * - The enhanced schedule (§36B(b)(3)(A) as amended by the American Rescue Plan Act §9661) and
 *   the 8.5 %-above-400 % rule (§36B(i)) apply to tax years 2021–2025. Both expire after 2025,
 *   so a 2026 run reverts to the pre-ARPA schedule **and** the 400 % cliff.
 * - The pre-ARPA percentages are themselves indexed every year by §36B(b)(3)(B), and the indexed
 *   amounts are published in the IRS's annual revenue procedure. This module does not carry a
 *   copy of any year's published table it cannot cite, so `getAcaTable(2026)` throws instead of
 *   borrowing 2025's enhanced rates (which would overstate the credit) or applying the 2014 base
 *   text unindexed (which would too, by a smaller margin).
 *
 * The pre-ARPA schedule and the 400 % cliff are still exported
 * (`PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS`, `PRE_ARPA_ELIGIBILITY_BOUNDS`) because they are the
 * statute's own base text and the behaviour a post-2025 year needs, but they are *not* filed under
 * a year: a ruleset needs a citable FPL for that year, and this module carries none for a
 * pre-2024 year. A test exercises the cliff by combining them with a year whose FPL it does have.
 *
 * Not modelled, and not to be inferred from these tables:
 * - Alaska and Hawaii poverty lines (higher); these are the 48 contiguous states and DC.
 * - The Medicaid-expansion interaction: California expanded Medicaid, so a household below 138 %
 *   of the FPL is a Medi-Cal household and receives no PTC even though §36B(c)(1) would allow one
 *   from 100 %. The statutory floor is what is implemented here; the wiring item must decide
 *   whether to raise it to 138 % for a California plan.
 * - Households lawfully present with income below 100 % (§36B(e)), and the dependent rules of
 *   §36B(c)(1)(C)-(D).
 * - Covered California's state subsidies (the row excludes them; the UI must say so).
 */

import type { TableMeta, TaxYear } from './types';

/**
 * The HHS poverty guideline for the 48 contiguous states and DC.
 *
 * HHS publishes it every January as `base` for a one-person household plus `perAdditionalPerson`
 * for each further member, so the line for any size is arithmetic rather than a lookup.
 */
export interface AcaPovertyGuideline {
  /** Annual income at 100 % of the FPL for a household of one. */
  readonly baseAmount: number;
  /** Added for each person after the first. */
  readonly perAdditionalPerson: number;
}

/** One tier of the applicable-percentage schedule; `startRate` applies at `minFplPercent`. */
export interface AcaApplicablePercentageBand {
  /** Tier floor, as a percentage of the federal poverty line (100 means 100 %). */
  readonly minFplPercent: number;
  /** Tier ceiling, as a percentage of the FPL; the next tier starts here. */
  readonly maxFplPercent: number;
  /** The share of household income owed at `minFplPercent` (0.02 = 2 %). */
  readonly startRate: number;
  /** The share owed at `maxFplPercent`; linear in between. */
  readonly endRate: number;
}

/**
 * Who may claim the credit, expressed on the FPL scale.
 *
 * `maxFplPercent: null` means there is no upper cliff — the ARPA rule for 2021–2025. A number is
 * the statutory cliff: at or below it the household is eligible, above it the credit is zero.
 */
export interface AcaEligibilityBounds {
  readonly minFplPercent: number;
  readonly maxFplPercent: number | null;
}

/** One tax year's PTC inputs, each with the metadata every vendored table carries. */
export interface AcaYearTable {
  readonly year: TaxYear;
  readonly povertyGuideline: TableMeta<AcaPovertyGuideline>;
  readonly applicablePercentages: TableMeta<readonly AcaApplicablePercentageBand[]>;
  readonly eligibility: TableMeta<AcaEligibilityBounds>;
}

const FPL_SOURCE = 'HHS Annual Update of the HHS Poverty Guidelines (Federal Register), 48 contiguous states and DC.';

const ARPA_SOURCE =
  'IRC §36B(b)(3)(A) as amended by the American Rescue Plan Act of 2021 §9661; §36B(i) for the 8.5 % rate above 400 % of the FPL.';

const ARPA_BOUNDS_SOURCE = 'IRC §36B(c)(1)(A) (100 % floor) and §36B(i) (the 400 % ceiling is suspended for tax years 2021 through 2025).';

/**
 * The ARPA-enriched schedule, in force for 2021–2025: nothing below 150 % of the FPL, then a
 * slide to 2 %, 4 %, 6 % and 8.5 % at 200/250/300/400 %. `§36B(i)` then holds the share at 8.5 %
 * above 400 % instead of cutting the credit off.
 */
const ARPA_PERCENTAGE_BANDS = [
  { minFplPercent: 100, maxFplPercent: 133, startRate: 0, endRate: 0 },
  { minFplPercent: 133, maxFplPercent: 150, startRate: 0, endRate: 0 },
  { minFplPercent: 150, maxFplPercent: 200, startRate: 0, endRate: 0.02 },
  { minFplPercent: 200, maxFplPercent: 250, startRate: 0.02, endRate: 0.04 },
  { minFplPercent: 250, maxFplPercent: 300, startRate: 0.04, endRate: 0.06 },
  { minFplPercent: 300, maxFplPercent: 400, startRate: 0.06, endRate: 0.085 },
] as const satisfies readonly AcaApplicablePercentageBand[];

/**
 * The pre-ARPA schedule as enacted by the ACA (§36B(b)(3)(A), the 2014 base-year text): 2 % up to
 * 133 %, then 3→4 %, 4→6.3 %, 6.3→8.05 %, 8.05→9.5 %, flat 9.5 % from 300 % to the 400 % cliff.
 * Every year after 2014's indexation is a published table this module does not carry.
 */
export const PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS = [
  { minFplPercent: 100, maxFplPercent: 133, startRate: 0.02, endRate: 0.02 },
  { minFplPercent: 133, maxFplPercent: 150, startRate: 0.03, endRate: 0.04 },
  { minFplPercent: 150, maxFplPercent: 200, startRate: 0.04, endRate: 0.063 },
  { minFplPercent: 200, maxFplPercent: 250, startRate: 0.063, endRate: 0.0805 },
  { minFplPercent: 250, maxFplPercent: 300, startRate: 0.0805, endRate: 0.095 },
  { minFplPercent: 300, maxFplPercent: 400, startRate: 0.095, endRate: 0.095 },
] as const satisfies readonly AcaApplicablePercentageBand[];

/**
 * The pre-ARPA schedule indexed for tax year 2026 under IRC §36B(b)(3)(A)(ii) and IRS Rev. Proc. 2025-25:
 * 2.10% up to 133%, 3.14% to 4.19% (133–150%), 4.19% to 6.60% (150–200%), 6.60% to 8.44% (200–250%),
 * 8.44% to 9.96% (250–300%), and 9.96% flat from 300% to the 400% cliff.
 */
export const PRE_ARPA_2026_PERCENTAGE_BANDS = [
  { minFplPercent: 100, maxFplPercent: 133, startRate: 0.021, endRate: 0.021 },
  { minFplPercent: 133, maxFplPercent: 150, startRate: 0.0314, endRate: 0.0419 },
  { minFplPercent: 150, maxFplPercent: 200, startRate: 0.0419, endRate: 0.066 },
  { minFplPercent: 200, maxFplPercent: 250, startRate: 0.066, endRate: 0.0844 },
  { minFplPercent: 250, maxFplPercent: 300, startRate: 0.0844, endRate: 0.0996 },
  { minFplPercent: 300, maxFplPercent: 400, startRate: 0.0996, endRate: 0.0996 },
] as const satisfies readonly AcaApplicablePercentageBand[];

/** The pre-ARPA cliff: eligible from 100 % to 400 % of the FPL inclusive, nothing above it. */
export const PRE_ARPA_ELIGIBILITY_BOUNDS: AcaEligibilityBounds = { minFplPercent: 100, maxFplPercent: 400 };

/** The FPL for a household size, from the published base and increment. */
export function povertyLineForSize(guideline: AcaPovertyGuideline, householdSize: number): number {
  const size = Math.max(1, Math.floor(householdSize));

  return guideline.baseAmount + (size - 1) * guideline.perAdditionalPerson;
}

/** Household income as a percentage of the poverty line (150 means 150 % of the FPL). */
export function federalPovertyLinePercent(householdIncome: number, povertyLine: number): number {
  return povertyLine > 0 ? (householdIncome / povertyLine) * 100 : Number.POSITIVE_INFINITY;
}

/**
 * The years this module can cite. A year not listed has no table and `getAcaTable` refuses it,
 * exactly as `getRules` refuses a tax year nobody has filed yet.
 */
export const ACA_TABLE_YEARS: readonly TaxYear[] = [2024, 2025, 2026];

const ACA_TABLES: Record<number, AcaYearTable> = {
  2024: {
    year: 2024,
    povertyGuideline: {
      values: { baseAmount: 15_060, perAdditionalPerson: 5_380 },
      indexing: 'indexed',
      source: FPL_SOURCE,
    },
    applicablePercentages: { values: ARPA_PERCENTAGE_BANDS, indexing: 'fixed', dollarFields: [], source: ARPA_SOURCE },
    eligibility: { values: { minFplPercent: 100, maxFplPercent: null }, indexing: 'fixed', dollarFields: [], source: ARPA_BOUNDS_SOURCE },
  },
  2025: {
    year: 2025,
    povertyGuideline: {
      values: { baseAmount: 15_650, perAdditionalPerson: 5_500 },
      indexing: 'indexed',
      source: FPL_SOURCE,
    },
    applicablePercentages: { values: ARPA_PERCENTAGE_BANDS, indexing: 'fixed', dollarFields: [], source: ARPA_SOURCE },
    eligibility: { values: { minFplPercent: 100, maxFplPercent: null }, indexing: 'fixed', dollarFields: [], source: ARPA_BOUNDS_SOURCE },
  },
  2026: {
    year: 2026,
    povertyGuideline: {
      values: { baseAmount: 15_960, perAdditionalPerson: 5_680 },
      indexing: 'indexed',
      source: FPL_SOURCE,
    },
    applicablePercentages: {
      values: PRE_ARPA_2026_PERCENTAGE_BANDS,
      indexing: 'fixed',
      dollarFields: [],
      source: 'IRC §36B(b)(3)(A)(i) and Rev. Proc. 2025-25.',
    },
    eligibility: {
      values: { minFplPercent: 100, maxFplPercent: 400 },
      indexing: 'fixed',
      dollarFields: [],
      source: 'IRC §36B(c)(1)(A) (100 % floor and 400 % ceiling).',
    },
  },
};

/**
 * The table for `year`, or a loud failure.
 *
 * No fallback to a nearby year: borrowing an expired enhanced schedule into 2026 overstates the
 * credit, and borrowing a pre-ARPA one understates what the household contributes. Both are
 * wrong-number bugs, so the year has to be added deliberately from its published release.
 */
export function getAcaTable(year: TaxYear): AcaYearTable {
  const table = ACA_TABLES[year];
  if (table !== undefined) return table;

  throw new Error(
    `No ACA premium-tax-credit table for ${year}. Covered years: ${ACA_TABLE_YEARS.join(', ')}. ` +
      'Add the year from the published releases (HHS poverty guidelines, and the IRS revenue procedure ' +
      'that indexes the §36B(b)(3)(B) applicable percentages); do not borrow an adjacent year.'
  );
}
