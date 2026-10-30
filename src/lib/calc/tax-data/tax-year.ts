/**
 * Tax-year derivation.
 *
 * The tax year a settlement covers is a calendar fact, so it is derived with the same integer
 * month arithmetic the engine uses for its result dates — never through a `Date` getter.
 *
 * Why the getter is wrong: `SimulationState.time.date` is built with the host-timezone
 * constructor `new Date(year, month - 1, day)`. Reading `getUTCFullYear()` on that instant is
 * only safe when the host offset is ≤ 0. In a UTC+ zone, local midnight on January 1 is still
 * December 31 in UTC, so the getter reports the *previous* year and the return would silently be
 * settled under the prior year's ruleset. Settlement dates in this engine are always the first of
 * a month, which makes January 1 an ordinary case rather than an edge case.
 *
 * `CalendarDate` arithmetic has no such boundary: it never constructs an instant, so the result is
 * identical on every host and timezone.
 */

import { addMonths, type CalendarDate } from '../clock';

import type { TaxYear } from './types';

/**
 * The tax year reached `monthsElapsed` whole months after the run's start date.
 *
 * This is the year of the calendar date the engine records for the annual row
 * (`monthStartAfter(startCalendarDate, monthsElapsed)`, which spreads the same `addMonths` result
 * and only pins the day to the 1st), computed without a `Date`.
 */
export function taxYearFor(start: CalendarDate, monthsElapsed: number): TaxYear {
  return addMonths(start, monthsElapsed).year;
}
