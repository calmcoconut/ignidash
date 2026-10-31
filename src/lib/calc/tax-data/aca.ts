/**
 * ACA premium tax credit inputs, vendored (parity plan P3-P7b, tables only).
 *
 * Everything the premium tax credit (PTC) needs that is *statutory* lives here: the federal
 * poverty line, the applicable-percentage schedule, and the eligibility bounds. The arithmetic
 * over them is in `../aca-premium-tax-credit`, so a rules update is a data diff against the
 * published releases and never a code change.
 *
 * ## Which poverty guideline a coverage year uses — the rule that is easy to get wrong
 *
 * IRC §36B(d)(3)(B) pins the poverty line to "the most recently published poverty line as of the
 * 1st day of the regular enrollment period" for the coverage year; Treas. Reg. §1.36B-1(h) says the
 * same. Open enrollment for a coverage year begins in the *previous* calendar year, and HHS
 * publishes the guidelines (and the Federal Register prints them) in January — so a coverage year's
 * own guidelines always miss its own enrollment period. **The guidelines in force for coverage year
 * N are the N−1 guidelines.** A 2026 premium tax credit uses the 2025 guidelines ($15,650 base,
 * $5,500 per additional person); the 2026 guidelines ($15,960 / $5,680, 91 FR 1797) first apply to
 * coverage year 2027.
 *
 * Every key below is therefore the **coverage (tax) year**, which is what the engine asks for, and
 * each row's `povertyGuideline.source` names the guidelines year it carries and the Federal
 * Register citation. The two years are one apart by law, not by an off-by-one mistake.
 *
 * ## What is covered, and what is deliberately not
 *
 * | coverage year | poverty guidelines | applicable percentages | upper bound |
 * | --- | --- | --- | --- |
 * | 2024 | 2023 ($14,580 / $5,140) | ARPA-enhanced | none (§36B(i)) |
 * | 2025 | 2024 ($15,060 / $5,380) | ARPA-enhanced | none (§36B(i)) |
 * | 2026 | 2025 ($15,650 / $5,500) | pre-ARPA, indexed for 2026 | 400 % of the FPL |
 * | 2027 | 2026 ($15,960 / $5,680) | pre-ARPA, indexed for 2027 | 400 % of the FPL |
 *
 * - The enhanced schedule (§36B(b)(3)(A) as amended by the American Rescue Plan Act §9661) and
 *   the 8.5 %-above-400 % rule (§36B(i)) apply to tax years 2021–2025. Both expire after 2025,
 *   so a 2026 or later return reverts to the pre-ARPA schedule **and** the 400 % cliff.
 * - The pre-ARPA percentages are themselves indexed every year by §36B(b)(3)(B), and the IRS
 *   publishes the indexed amounts in its annual revenue procedure: Rev. Proc. 2025-25 §3.01 for
 *   tax year 2026 (2.10 / 3.14 / 4.19 / 6.60 / 8.44 / 9.96 %) and Rev. Proc. 2026-26 §3.01 for
 *   tax year 2027 (2.15 / 3.23 / 4.30 / 6.78 / 8.66 / 10.22 %). Neither procedure carries a
 *   poverty-line table — the FPL dollars come from the HHS notice, not from the revenue procedure.
 * - A coverage year newer than the last vendored row is priced from the newest row's law and the
 *   result says which year that was (see `getAcaTable`); a year *older* than the first row throws.
 *
 * The 2014 base text of the pre-ARPA schedule and of the 400 % cliff are still exported
 * (`PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS`, `PRE_ARPA_ELIGIBILITY_BOUNDS`) because they are the
 * statute's own text, and a test exercises the cliff by combining them with a vendored poverty line.
 *
 * Not modelled, and not to be inferred from these tables:
 * - Alaska and Hawaii poverty lines (higher); these are the 48 contiguous states and DC.
 * - The Medicaid-expansion interaction: California expanded Medicaid, so a household below 138 %
 *   of the FPL is a Medi-Cal household and receives no PTC even though §36B(c)(1) would allow one
 *   from 100 %. The statutory floor is what is implemented here; the engine does not raise it to
 *   138 % for a California plan.
 * - Households lawfully present with income below 100 % (§36B(e)), and the dependent rules of
 *   §36B(c)(1)(C)-(D).
 * - Covered California's state subsidies (the row excludes them; the UI must say so).
 */

import type { TableMeta, TaxYear } from './types';

/**
 * The HHS poverty guideline for the 48 contiguous states and DC.
 *
 * HHS publishes it every January as `base` for a one-person household plus `perAdditionalPerson`
 * for each further member, so the line for any size is arithmetic rather than a lookup. The values a
 * table carries are the guidelines **in force for its coverage year**, which are the previous
 * calendar year's notice (IRC §36B(d)(3)(B)).
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

/**
 * The citation for one coverage year's poverty guideline, naming the guidelines year it carries.
 *
 * The guidelines year is always `coverageYear - 1` (IRC §36B(d)(3)(B): the line in force on the
 * first day of the regular enrollment period, which opens in the previous calendar year). Writing it
 * out beside the Federal Register citation is the point: the two-year pairing is what a later reader
 * is most likely to "fix" into an off-by-one bug.
 */
const fplSource = (coverageYear: TaxYear, citation: string): string =>
  `${FPL_SOURCE} Coverage year ${coverageYear} uses the ${coverageYear - 1} guidelines: ${citation}.`;

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
 * This is the statute's own text, not a year's indexed table: every year after 2014 is indexed and
 * published separately (see `PRE_ARPA_INDEXED_PERCENTAGE_BANDS` and `PRE_ARPA_2027_PERCENTAGE_BANDS`).
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
 * The pre-ARPA schedule indexed for tax year 2026 under IRC §36B(b)(3)(A)(i) and IRS Rev. Proc. 2025-25 §3.01:
 * 2.10% up to 133%, 3.14% to 4.19% (133–150%), 4.19% to 6.60% (150–200%), 6.60% to 8.44% (200–250%),
 * 8.44% to 9.96% (250–300%), and 9.96% flat from 300% to the 400% cliff. 9.96% is also §3.02's
 * required contribution percentage for that year.
 *
 * Carried by the 2026 row only. A later coverage year gets its own published table, never this one.
 */
export const PRE_ARPA_INDEXED_PERCENTAGE_BANDS = [
  { minFplPercent: 100, maxFplPercent: 133, startRate: 0.021, endRate: 0.021 },
  { minFplPercent: 133, maxFplPercent: 150, startRate: 0.0314, endRate: 0.0419 },
  { minFplPercent: 150, maxFplPercent: 200, startRate: 0.0419, endRate: 0.066 },
  { minFplPercent: 200, maxFplPercent: 250, startRate: 0.066, endRate: 0.0844 },
  { minFplPercent: 250, maxFplPercent: 300, startRate: 0.0844, endRate: 0.0996 },
  { minFplPercent: 300, maxFplPercent: 400, startRate: 0.0996, endRate: 0.0996 },
] as const satisfies readonly AcaApplicablePercentageBand[];

/**
 * The pre-ARPA schedule indexed for tax year 2027 under IRC §36B(b)(3)(A)(i) and IRS Rev. Proc. 2026-26 §3.01
 * (IRB 2026-31): 2.15% up to 133%, 3.23% to 4.30% (133–150%), 4.30% to 6.78% (150–200%), 6.78% to
 * 8.66% (200–250%), 8.66% to 10.22% (250–300%), and 10.22% flat from 300% to the 400% cliff. 10.22%
 * is also §3.02's required contribution percentage for that year.
 *
 * Carried by the 2027 row. Like the 2026 table it steps up at 133 % (2.15 % → 3.23 %), which is the
 * statute's own discontinuity, not an interpolation.
 */
export const PRE_ARPA_2027_PERCENTAGE_BANDS = [
  { minFplPercent: 100, maxFplPercent: 133, startRate: 0.0215, endRate: 0.0215 },
  { minFplPercent: 133, maxFplPercent: 150, startRate: 0.0323, endRate: 0.043 },
  { minFplPercent: 150, maxFplPercent: 200, startRate: 0.043, endRate: 0.0678 },
  { minFplPercent: 200, maxFplPercent: 250, startRate: 0.0678, endRate: 0.0866 },
  { minFplPercent: 250, maxFplPercent: 300, startRate: 0.0866, endRate: 0.1022 },
  { minFplPercent: 300, maxFplPercent: 400, startRate: 0.1022, endRate: 0.1022 },
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
 * The coverage years that have a table of their own. A year newer than the last one is priced from
 * the nearest prior row (see `getAcaTable`); a year older than the first has nothing to fall back
 * to and throws.
 */
export const ACA_TABLE_YEARS: readonly TaxYear[] = [2024, 2025, 2026, 2027];

const ACA_TABLES: Record<number, AcaYearTable> = {
  2024: {
    year: 2024,
    povertyGuideline: {
      values: { baseAmount: 14_580, perAdditionalPerson: 5_140 },
      indexing: 'indexed',
      source: fplSource(2024, '88 FR 3424 (Jan 19, 2023)'),
    },
    applicablePercentages: { values: ARPA_PERCENTAGE_BANDS, indexing: 'fixed', dollarFields: [], source: ARPA_SOURCE },
    eligibility: { values: { minFplPercent: 100, maxFplPercent: null }, indexing: 'fixed', dollarFields: [], source: ARPA_BOUNDS_SOURCE },
  },
  2025: {
    year: 2025,
    povertyGuideline: {
      values: { baseAmount: 15_060, perAdditionalPerson: 5_380 },
      indexing: 'indexed',
      source: fplSource(2025, '89 FR 2961 (Jan 17, 2024)'),
    },
    applicablePercentages: { values: ARPA_PERCENTAGE_BANDS, indexing: 'fixed', dollarFields: [], source: ARPA_SOURCE },
    eligibility: { values: { minFplPercent: 100, maxFplPercent: null }, indexing: 'fixed', dollarFields: [], source: ARPA_BOUNDS_SOURCE },
  },
  2026: {
    year: 2026,
    povertyGuideline: {
      values: { baseAmount: 15_650, perAdditionalPerson: 5_500 },
      indexing: 'indexed',
      source: fplSource(2026, '90 FR 5917 (Jan 17, 2025)'),
    },
    applicablePercentages: {
      values: PRE_ARPA_INDEXED_PERCENTAGE_BANDS,
      indexing: 'fixed',
      dollarFields: [],
      source: 'IRC §36B(b)(3)(A)(i) and Rev. Proc. 2025-25 §3.01 (the tax-year-2026 table).',
    },
    eligibility: {
      values: { minFplPercent: 100, maxFplPercent: 400 },
      indexing: 'fixed',
      dollarFields: [],
      source: 'IRC §36B(c)(1)(A) (100 % floor and 400 % ceiling).',
    },
  },
  2027: {
    year: 2027,
    povertyGuideline: {
      values: { baseAmount: 15_960, perAdditionalPerson: 5_680 },
      indexing: 'indexed',
      source: fplSource(2027, '91 FR 1797 (Jan 15, 2026)'),
    },
    applicablePercentages: {
      values: PRE_ARPA_2027_PERCENTAGE_BANDS,
      indexing: 'fixed',
      dollarFields: [],
      source:
        'IRC §36B(b)(3)(A)(i) and Rev. Proc. 2026-26 §3.01 (the tax-year-2027 applicable percentage table); ' +
        '§3.02 required contribution percentage for 2027: 10.22 %.',
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
 * The table for `year`, falling back to the nearest prior coverage year — the same resolution
 * `getRules` uses (src/lib/calc/tax-data/index.ts), and the same one `getSaltCap` uses.
 *
 * Resolution never borrows a *later* row: a table written for 2027 describes law that does not apply
 * to a 2026 return. It does borrow an *earlier* one, because the caller passes the calendar tax year
 * and cannot name a year the module has no row for: a plan simulated past the last vendored year is
 * priced from the newest row's law rather than killing the run mid-engine.
 *
 * **The resolved year is the returned table's `year`** (the engine's `TaxProcessor` asks for a year
 * it may not have, so `AcaYearTable.year` and the request can differ). Consumers that disclose
 * provenance — `calculatePremiumTaxCredit` → `TaxesData.aca.resolvedYear` → `cliffs.aca` — report
 * that field, so a 2029 return says it was priced under 2027 law instead of implying 2029 law.
 *
 * @throws when `year` is before the first table, rather than inventing a poverty line.
 */
export function getAcaTable(year: TaxYear): AcaYearTable {
  if (!Number.isInteger(year)) throw new Error(`Tax year must be an integer, received ${year}`);

  let resolvedYear: TaxYear | undefined;
  for (const candidate of ACA_TABLE_YEARS) {
    if (candidate <= year && (resolvedYear === undefined || candidate > resolvedYear)) resolvedYear = candidate;
  }

  if (resolvedYear === undefined) {
    const earliest = Math.min(...ACA_TABLE_YEARS);
    throw new Error(
      `No ACA premium-tax-credit table for ${year} or any earlier year (earliest available: ${earliest}). ` +
        'Add the year from the published releases (HHS poverty guidelines, and the IRS revenue procedure that ' +
        "indexes the §36B(b)(3)(B) applicable percentages) — a later year's table must never be borrowed backwards."
    );
  }

  return ACA_TABLES[resolvedYear];
}
