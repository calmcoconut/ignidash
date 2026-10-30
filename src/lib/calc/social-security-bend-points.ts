/**
 * Social Security PIA bend points (vendored, statutory).
 *
 * The Primary Insurance Amount is a progressive share of the Average Indexed Monthly Earnings:
 *
 *   90% of AIME up to the first bend point
 * + 32% of AIME between the first and second bend point
 * + 15% of AIME above the second bend point
 *
 * Both bend points are indexed every year, so a table is **per year** and must never be copied
 * forward. This file carries the year it was published for, and the calculation takes the table
 * as an argument, so a caller cannot silently use a stale year without choosing it.
 *
 * Source: Social Security Administration, "Benefit Formula Bend Points" (ssa.gov/oact/cola/
 * bendpoints.html). The 2025 figures are the 90/32/15 percentages applied to $1,226 and $7,391 —
 * the amounts SSA published for 2025 after the 2.5% cost-of-living adjustment.
 *
 * Not yet vendored: later years. They are re-issued by the annual-update pipeline (parity plan
 * P3-P2) from the SSA determination in the Federal Register, the same document
 * `tax-data/years/2026.ts` cites for the 2026 OASDI wage base. Until a year is added here,
 * `piaBendPointsFor` returns `undefined` for it rather than guessing.
 */

/** One year's bend points and the three replacement percentages. */
export interface PiaBendPoints {
  readonly year: number;
  /** AIME at which the 32% band starts. */
  readonly firstBendPoint: number;
  /** AIME at which the 15% band starts. */
  readonly secondBendPoint: number;
  /** The replacement percentages, as fractions: 0.9, 0.32, 0.15. */
  readonly replacementRates: { readonly first: number; readonly second: number; readonly third: number };
  readonly source: string;
}

export const PIA_BEND_POINTS_2025: PiaBendPoints = {
  year: 2025,
  firstBendPoint: 1226,
  secondBendPoint: 7391,
  replacementRates: { first: 0.9, second: 0.32, third: 0.15 },
  source: 'SSA, Benefit Formula Bend Points (2025): 90% of the first $1,226, 32% of AIME over $1,226 through $7,391, 15% above $7,391.',
};

/** Every vendored year, newest last. Append; never edit a published row. */
export const PIA_BEND_POINTS: readonly PiaBendPoints[] = [PIA_BEND_POINTS_2025];

/**
 * The bend points for a year, or `undefined` when that year is not vendored.
 *
 * Deliberately no fallback to an earlier year: a benefit formula applied to the wrong year is a
 * silently wrong number, and the caller of a planning estimate can decide what to do instead.
 */
export function piaBendPointsFor(year: number): PiaBendPoints | undefined {
  return PIA_BEND_POINTS.find((table) => table.year === year);
}
