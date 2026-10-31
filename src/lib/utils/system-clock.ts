/**
 * The single source of the simulation's `asOf` date.
 *
 * Everything under `src/lib/calc` and `src/lib/schemas` is forbidden from reading the
 * wall clock (enforced by the `no-restricted-syntax` rule in `eslint.config.mjs`).
 * Callers resolve a `Clock` here — at the store/UI boundary — and pass the resulting
 * `asOf` date into the engine explicitly, so a projection starts from the user's local
 * calendar date rather than a date the engine read for itself. Other UI code may read
 * the clock for its own defaults; this is the only read an `asOf` may come from.
 */

import { fixedClock, type Clock, type ISODateString } from '@/lib/calc/clock';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Today's calendar date in the host's local timezone, as `YYYY-MM-DD`. */
export function currentLocalISODate(now: Date = new Date()): ISODateString {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A clock pinned to the current local calendar date. */
export function systemClock(now: Date = new Date()): Clock {
  return fixedClock(currentLocalISODate(now));
}
