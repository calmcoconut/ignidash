/**
 * Social Security rules that reach beyond one earner's own benefit (v20): children's benefits, the
 * family maximum, and the retirement earnings test.
 *
 * ## Children (Social Security Act §202(d))
 *
 * An unmarried child of an entitled or deceased worker is paid on the worker's record until 18, or
 * until 19 while a full-time elementary or secondary student (§202(d)(1)(B)). The rate is 50% of the
 * worker's PIA while the worker lives and is being paid, and 75% after the worker's death
 * (§202(d)(2)). A child entitled on two records is paid on whichever gives the larger amount.
 *
 * ## The family maximum (§203(a))
 *
 * What one record pays its whole family is capped by a progressive formula of the PIA. While the
 * worker lives the worker's own benefit is outside the cap's distribution, so the auxiliaries (spouse
 * and children) share `familyMaximum − PIA`; after the death the survivors share the whole maximum.
 * When the claims exceed the cap, each is reduced in proportion (§203(a)(1)). Simplifications, all
 * stated on the help page: the cap is applied to the *original* rates (50% or 75% of the PIA, and the
 * survivor's own rate) before any reduction for age, a spouse is counted only while their spousal
 * add-on is being paid, and a surviving spouse only while their survivor top-up is.
 *
 * ## The retirement earnings test (§203(b), (f))
 *
 * A beneficiary under FRA who works has benefits withheld: $1 for every $2 of earnings over the
 * annual exempt amount, or, in the calendar year FRA is reached, $1 for every $3 over a higher
 * amount, counting only the earnings before the FRA month. Withheld months are not lost: at FRA the
 * benefit is recomputed as if it had started that many months later (the adjustment of the reduction
 * factor, §202(q)(7)). Earnings are the member's wages and net self-employment income.
 *
 * Simplifications, stated on the help page: the test runs on the engine's plan years rather than
 * calendar years, withholding falls in the months after the excess is earned rather than at the
 * start of the year, and a worker's excess earnings withhold only the benefits paid to that worker
 * and to the children on their record — not a spouse's benefit on the same record.
 *
 * The dollar thresholds are wage-indexed (re-issued every year), so in the engine's today's dollars
 * the latest vendored year is the projection, the convention `getRules` follows for tax tables.
 */

/** One year's family-maximum bend points (§203(a)(1)); the percentages are statutory. */
export interface FamilyMaximumBendPoints {
  readonly year: number;
  readonly bendPoints: readonly [number, number, number];
  readonly source: string;
}

/**
 * Family-maximum bend points. SSA OACT, "Benefit Formula Bend Points" (ssa.gov/oact/cola/
 * bendpoints.html). Not re-read from ssa.gov in this change — the host was unreachable from the
 * build environment — and cross-checked against the 2026 AWI ratio (1.0485 × the 2025 figures):
 * verify against the OACT page when the 2027 row is added.
 */
export const FAMILY_MAXIMUM_BEND_POINTS: readonly FamilyMaximumBendPoints[] = [
  { year: 2025, bendPoints: [1567, 2262, 2950], source: 'SSA OACT, Benefit Formula Bend Points, maximum family benefit (2025).' },
  { year: 2026, bendPoints: [1643, 2371, 3093], source: 'SSA OACT, Benefit Formula Bend Points, maximum family benefit (2026).' },
];

/** The family-maximum percentages: 150%, 272%, 134% and 175% (§203(a)(1)(A)-(D)). */
const FAMILY_MAXIMUM_RATES = [1.5, 2.72, 1.34, 1.75] as const;

/** The nearest vendored row at or before `year`, else the earliest (see the module doc). */
function nearestPrior<T extends { readonly year: number }>(rows: readonly T[], year: number): T {
  return rows.reduce((chosen, row) => (row.year <= year && row.year > chosen.year ? row : chosen), rows[0]!);
}

/**
 * The monthly family maximum for a PIA (§203(a)(1)), today's dollars.
 *
 * Worked case (2026 bend points, PIA $3,000): 150% × 1,643 + 272% × (2,371 − 1,643) + 134% × (3,000 −
 * 2,371) = 2,464.50 + 1,980.16 + 842.86 = $5,287.52.
 */
export function familyMaximum(pia: number, year: number): number {
  const [first, second, third] = nearestPrior(FAMILY_MAXIMUM_BEND_POINTS, year).bendPoints;
  const bands = [
    Math.min(pia, first),
    Math.max(0, Math.min(pia, second) - first),
    Math.max(0, Math.min(pia, third) - second),
    Math.max(0, pia - third),
  ];

  return bands.reduce((total, band, index) => total + band * FAMILY_MAXIMUM_RATES[index]!, 0);
}

/**
 * Scales a record's claims down to the share of the family maximum they may divide (§203(a)(1)).
 * @returns the factor (≤ 1) every claim on the record is multiplied by
 */
export function familyMaximumFactor(pot: number, claims: readonly number[]): number {
  const total = claims.reduce((sum, claim) => sum + Math.max(0, claim), 0);
  if (total <= 0) return 1;

  return Math.min(1, Math.max(0, pot) / total);
}

/** A child's rate on a living worker's record, and on a deceased worker's (§202(d)(2)). */
export const CHILD_SHARE_LIVING_WORKER = 0.5;
export const CHILD_SHARE_DECEASED_WORKER = 0.75;

/** Whether a child of this age is entitled (§202(d)(1)(B)): under 18, or under 19 as a student. */
export function isChildEntitled(childAge: number, student: boolean): boolean {
  return childAge >= 0 && (childAge < 18 || (student && childAge < 19));
}

/** One year's retirement earnings test exempt amounts (§203(f)(8)), annual. */
export interface EarningsTestAmounts {
  readonly year: number;
  /** For a beneficiary under FRA all year: $1 withheld per $2 above this. */
  readonly annualExempt: number;
  /** In the year FRA is reached, counting earnings before the FRA month: $1 per $3 above this. */
  readonly fraYearExempt: number;
  readonly source: string;
}

/**
 * SSA OACT, "Exempt Amounts under the Earnings Test" (ssa.gov/oact/cola/rtea.html), and the 2026 COLA
 * fact sheet. Not re-read from ssa.gov in this change (the host was unreachable from the build
 * environment); the figures match SSA's published announcements as quoted by secondary sources.
 */
export const EARNINGS_TEST_AMOUNTS: readonly EarningsTestAmounts[] = [
  { year: 2025, annualExempt: 23400, fraYearExempt: 62160, source: 'SSA OACT, Earnings Test exempt amounts (2025): $23,400 and $62,160.' },
  { year: 2026, annualExempt: 24480, fraYearExempt: 65160, source: 'SSA OACT, Earnings Test exempt amounts (2026): $24,480 and $65,160.' },
];

/** The exempt amounts for a year (nearest vendored year at or before it; see the module doc). */
export function earningsTestAmountsFor(year: number): EarningsTestAmounts {
  return nearestPrior(EARNINGS_TEST_AMOUNTS, year);
}

/** $1 withheld per $2 of excess before the FRA year, $1 per $3 in it (§203(f)(3)). */
export const EARNINGS_TEST_WITHHOLDING_RATE = 1 / 2;
export const EARNINGS_TEST_FRA_YEAR_WITHHOLDING_RATE = 1 / 3;

/**
 * The benefits withheld for a year's earnings: `rate × max(0, earnings − exempt)`.
 *
 * Worked cases (2026): under FRA all year with $44,480 of wages → (44,480 − 24,480) / 2 = $10,000;
 * the FRA year with $80,160 earned before the FRA month → (80,160 − 65,160) / 3 = $5,000.
 */
export function earningsTestWithholding(earnings: number, exempt: number, rate: number): number {
  return Math.max(0, earnings - exempt) * rate;
}
