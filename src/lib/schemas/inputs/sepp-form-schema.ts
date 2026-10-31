/**
 * Substantially Equal Periodic Payments (SEPP) schema under IRC §72(t)(2)(A)(iv).
 *
 * Safe-harbor withdrawal schedules exempt from the 10% early distribution penalty.
 */

import { z } from 'zod';

import { seppRateWindow } from '../../calc/retirement-rules/sepp';
import {
  MID_TERM_RATES,
  NEWEST_MID_TERM_RATE_MONTH,
  offsetSeppRateMonth,
  parseSeppRateMonth,
  type SeppRateMonth,
} from '../../calc/retirement-rules/sepp-tables';

export const seppMethodSchema = z.enum(['rmd', 'fixedAmortization', 'fixedAnnuitization']);
export type SeppMethod = z.infer<typeof seppMethodSchema>;

/** The stored bounds of a start or stop year; the editor uses the same bounds for its inputs. */
export const SEPP_YEAR_RANGE = { min: 1900, max: 2200 } as const;

export const seppScheduleSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  accountId: z.string(),
  method: seppMethodSchema,
  startYear: z.number().int().min(SEPP_YEAR_RANGE.min).max(SEPP_YEAR_RANGE.max),
  rate: z.number().min(0).max(1).optional(),
  annualAmount: z.number().min(0).optional(),
  stopYear: z.number().int().min(SEPP_YEAR_RANGE.min).max(SEPP_YEAR_RANGE.max).optional(),
  disabled: z.boolean().optional(),
});

export type SeppScheduleInputs = z.infer<typeof seppScheduleSchema>;

/**
 * The start years a **fixed** method can actually be priced for, and the months that decide it.
 *
 * `processSeppDistributions` (`src/lib/calc/portfolio.ts`) prices a fixed-method schedule from
 * `${startYear}-01`, through `seppRateWindow`, which reads the federal mid-term rate for the two
 * months before the distribution begins (Notice 2022-6 §3.02(c)). Those rates are vendored monthly
 * and stop at `NEWEST_MID_TERM_RATE_MONTH`, so a start year whose window reaches past the last
 * vendored month has **no rate at all** — and `federalMidTermRate` throws rather than guessing.
 *
 * That throw is not survivable from the editor: it happens inside the simulation, which runs during
 * render, so a schedule the dialog accepts can leave a plan that will not render. The window is a
 * fact about the vendored data, not a modelling question, so it is checked before the payload is
 * written — here, so the dialog and the Convex mutation share one rule and one message.
 */
export interface SeppFixedRateCoverage {
  /** The earliest start year whose two-month window is fully vendored. */
  readonly earliestStartYear: number;
  /** The latest start year whose two-month window is fully vendored. */
  readonly latestStartYear: number;
  /** The oldest vendored rate month, `YYYY-MM`. */
  readonly firstCoveredMonth: string;
  /** The newest vendored rate month, `YYYY-MM`. */
  readonly lastCoveredMonth: string;
}

/** True when both months the Notice 2022-6 window needs for `startYear` are vendored. */
function startYearIsPriced(startYear: number): boolean {
  return [1, 2].every((monthsBefore) => MID_TERM_RATES[offsetSeppRateMonth(`${startYear}-01`, -monthsBefore)] !== undefined);
}

/**
 * The covered start-year range, derived from the vendored months rather than a hardcoded year, so
 * advancing `NEWEST_MID_TERM_RATE_MONTH` widens the range without touching this rule.
 *
 * The vendored months are contiguous by construction (`sepp-tables.ts` forbids deleting a month),
 * so the priced start years are contiguous too; the walk below still tests each year instead of
 * assuming the arithmetic, because a gap is a data defect this rule must not paper over.
 */
export function seppFixedRateCoverage(): SeppFixedRateCoverage {
  const coveredMonths = Object.keys(MID_TERM_RATES).sort();
  const firstCoveredMonth = coveredMonths[0];
  const lastCoveredMonth = NEWEST_MID_TERM_RATE_MONTH;

  const firstYear = parseSeppRateMonth(firstCoveredMonth).year;
  const lastYear = parseSeppRateMonth(lastCoveredMonth).year;
  const pricedYears: number[] = [];
  for (let year = firstYear; year <= lastYear + 2; year += 1) {
    if (startYearIsPriced(year)) pricedYears.push(year);
  }

  const earliestStartYear = pricedYears[0];
  const latestStartYear = pricedYears[pricedYears.length - 1];
  if (earliestStartYear === undefined || latestStartYear === undefined) {
    throw new Error(
      `No SEPP start year is priced from the vendored federal mid-term rates (${firstCoveredMonth} through ${lastCoveredMonth}). ` +
        'A fixed method needs two consecutive months before its first January; re-vendor the rates in ' +
        'src/lib/calc/retirement-rules/sepp-tables.ts rather than pricing from a neighbouring month.'
    );
  }

  return { earliestStartYear, latestStartYear, firstCoveredMonth, lastCoveredMonth };
}

/** The Notice 2022-6 rate ceiling one start year permits, and the month that set it. */
export interface SeppRateCap {
  /** The highest rate the two-month window allows, as a decimal (`0.05` = 5 %). */
  readonly maximumRate: number;
  /** The month whose 120 % cap won the window; `eligibleMonths` is newest first, so the later wins a tie. */
  readonly governingMonth: SeppRateMonth;
  /** That month's §1274(d) federal mid-term rate, as a decimal. */
  readonly governingMidTermRate: number;
}

/**
 * The most a **fixed** method may use for a `startYear`, priced by the engine's own `seppRateWindow`:
 * `max(5 %, 120 % × the federal mid-term rate)` for whichever of the two preceding months is higher
 * (Notice 2022-6 §3.02(c)). Nothing is restated here, so the editor's bound, the mutation's refusal
 * and `seppAnnualAmountFromTables`' throw cannot disagree about the cap.
 *
 * `null` means there is no window to read — an unknown start year, or one whose months are not
 * vendored (the case `seppRateWindowProblem` refuses first). A caller bound to a native control
 * reads `null` as "no bound to state", never as a cap of zero.
 */
export function seppRateCapForStartYear(startYear: number): SeppRateCap | null {
  if (!Number.isInteger(startYear)) return null;
  if (startYear < SEPP_YEAR_RANGE.min || startYear > SEPP_YEAR_RANGE.max) return null;
  if (!startYearIsPriced(startYear)) return null;

  // The year is a four-digit integer in `SEPP_YEAR_RANGE` by the checks above, so `${startYear}-01`
  // is a well-formed rate month and this asks the engine for the same window it prices the run from.
  const window = seppRateWindow(`${startYear}-01`);
  const governing = window.eligibleMonths.reduce((best, entry) => (entry.maximumRate > best.maximumRate ? entry : best));

  return {
    maximumRate: window.maximumRate,
    governingMonth: governing.month,
    governingMidTermRate: governing.federalMidTermRate,
  };
}

/** A rate as a percentage with up to four decimals: `0.05` → `5%`, `0.05785` → `5.785%`. */
function asPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(4))}%`;
}

/**
 * The cap as a percentage a reader can retype, **floored** to two decimals — the largest figure that
 * is always safe to enter.
 *
 * Rounding would sometimes name a figure above the cap it is describing: 2025's cap is
 * `1.2 × 4.18 %` = 5.015999…, which `toFixed(2)` shows as 5.02 %, and a reader who typed 5.02 %
 * would hand the engine 0.0502 > 0.050159999999999996 — refused, by the very message that suggested
 * it. Flooring cannot do that. Two decimals is the precision the vendored rates are published at, and
 * the message also names the month and its rate, so the exact derivation is on screen.
 */
function capPercent(maximumRate: number): string {
  return `${(Math.floor(maximumRate * 100 * 100) / 100).toFixed(2)}%`;
}

/**
 * Why a schedule cannot be priced, or `null` when it can.
 *
 * Three rules, all about facts that would otherwise throw from inside the simulation:
 *
 * 1. The start year must be a whole year in `SEPP_YEAR_RANGE`. Every method needs that — the engine
 *    compares it against the simulation year and builds a date from it — and `seppScheduleSchema`
 *    already says so, but the Convex validator is looser, so the mutation asks here too.
 * 2. A **fixed** method additionally needs its Notice 2022-6 rate window vendored (see
 *    `SeppFixedRateCoverage`). `rmd` never reads a rate — the engine divides the balance by the
 *    Single Life Table period — so it is never refused for the window, whatever its start year.
 * 3. A **fixed** method's explicit `rate` must not exceed the cap that window sets (see
 *    `seppRateCapForStartYear`). `seppAnnualAmountFromTables` throws on an out-of-cap rate —
 *    understating the rate is permitted, overstating it is a §72(t) modification — and that throw
 *    lands in the same render-blocking place as the missing-month one. A blank rate is absent, not
 *    zero, and means "use the maximum", so it is accepted. An `rmd` schedule is never refused for
 *    a stray rate: the method reads none, and the editor drops it.
 *
 * The messages name the covered months, the covered start years and the applicable cap (with the
 * month it came from), so a reader can fix the row without opening the source.
 */
export function seppRateWindowProblem(
  schedule: Pick<SeppScheduleInputs, 'method' | 'startYear'> & { readonly rate?: number | undefined }
): string | null {
  const { startYear, method, rate } = schedule;
  if (!Number.isInteger(startYear)) return `A SEPP schedule needs a whole start year; got ${startYear}.`;
  if (startYear < SEPP_YEAR_RANGE.min || startYear > SEPP_YEAR_RANGE.max) {
    return `A SEPP schedule start year must be between ${SEPP_YEAR_RANGE.min} and ${SEPP_YEAR_RANGE.max}; got ${startYear}.`;
  }
  if (method === 'rmd') return null;

  const cap = seppRateCapForStartYear(startYear);
  if (cap === null) {
    const methodLabel = method === 'fixedAmortization' ? 'Fixed amortization' : 'Fixed annuitization';
    const { earliestStartYear, latestStartYear, firstCoveredMonth, lastCoveredMonth } = seppFixedRateCoverage();

    return (
      `${methodLabel} can only start in ${earliestStartYear}–${latestStartYear}: the vendored federal mid-term rates ` +
      `(Notice 2022-6) run ${firstCoveredMonth} through ${lastCoveredMonth}, so ${startYear} has no rate to price from. ` +
      `Use the required-minimum-distribution method, which reads no rate, or move the start year into ` +
      `${earliestStartYear}–${latestStartYear}.`
    );
  }

  if (rate !== undefined && rate > cap.maximumRate) {
    return (
      `A rate of ${asPercent(rate)} is above the Notice 2022-6 maximum for a ${startYear} start ` +
      `(${capPercent(cap.maximumRate)}): the cap is the greater of 5% or 120% of the federal mid-term rate for one of ` +
      `the two preceding months, and the ${cap.governingMonth} rate is ${asPercent(cap.governingMidTermRate)}. ` +
      `Enter a rate at or below ${capPercent(cap.maximumRate)}, or leave it blank to use the maximum.`
    );
  }

  return null;
}
