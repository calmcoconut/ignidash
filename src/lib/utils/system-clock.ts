/**
 * The application's single wall-clock read.
 *
 * Everything under `src/lib/calc` and `src/lib/schemas` is forbidden from reading the
 * wall clock (enforced by the `no-restricted-syntax` rule in `eslint.config.mjs`).
 * Callers resolve a `Clock` here — at the store/UI boundary — and pass the resulting
 * `asOf` date into the engine explicitly. Because this is the only read, it is also the
 * only place where "today" depends on the host: it uses the user's local calendar date,
 * which is what a projection should start from.
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
