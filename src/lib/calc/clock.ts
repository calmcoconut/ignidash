/**
 * Deterministic clock for financial simulations.
 *
 * A simulation run must be a pure function of its inputs plus an explicit clock. Nothing
 * under `src/lib/calc` or `src/lib/schemas` may read the wall clock: argument-less
 * `new Date()` and `Date.now()` are banned there by the `no-restricted-syntax` rule in
 * `eslint.config.mjs`.
 *
 * A `Clock` carries the only wall-clock fact a run needs — the calendar date the
 * projection starts from (`asOf`) — as an ISO date string. Calendar values are parsed
 * from that string and never read back through a host-timezone getter, so the
 * simulation's ages, month arithmetic and date labels are identical on every host,
 * timezone and day.
 *
 * The app's single wall-clock read lives in `src/lib/utils/system-clock.ts`; the store
 * resolves a `Clock` there and passes it into the engine (and across the worker
 * boundary) explicitly.
 */

/** An ISO 8601 calendar date, `YYYY-MM-DD`, with no time or timezone component. */
export type ISODateString = string;

/** A timezone-free calendar date. `month` is 1-12. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A pinned source of "today" for a simulation run. */
export interface Clock {
  readonly asOf: ISODateString;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * Parses and validates a `YYYY-MM-DD` string using pure calendar arithmetic.
 * Never consults the host timezone; throws on a malformed or impossible date.
 */
export function parseISODateString(asOf: ISODateString): CalendarDate {
  const match = ISO_DATE_PATTERN.exec(asOf);
  if (!match) throw new Error(`Invalid ISO date "${asOf}": expected YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trip through UTC to reject calendar dates that would roll over (e.g. 2026-02-30).
  // Date.UTC is used only to validate the components, never to read them back from an instant.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`Invalid ISO date "${asOf}": not a real calendar date`);
  }

  return { year, month, day };
}

export function isISODateString(value: string): boolean {
  try {
    parseISODateString(value);
    return true;
  } catch {
    return false;
  }
}

/** Formats a calendar date as `YYYY-MM-DD`. */
export function formatISODate(date: CalendarDate): ISODateString {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Formats a calendar month as its first day, `YYYY-MM-01`. */
export function formatISOMonth(year: number, month: number): ISODateString {
  return `${pad(year, 4)}-${pad(month, 2)}-01`;
}

/** Adds whole months to a calendar date with integer month arithmetic (no `Date`, no timezone). */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const totalMonths = date.year * 12 + (date.month - 1) + months;
  return { year: Math.floor(totalMonths / 12), month: (((totalMonths % 12) + 12) % 12) + 1, day: date.day };
}

/** Creates a clock pinned to a calendar date. Throws if the date is not a valid `YYYY-MM-DD`. */
export function fixedClock(asOf: ISODateString): Clock {
  return { asOf: formatISODate(parseISODateString(asOf)) };
}

/**
 * Builds the `Date` the engine stores in `SimulationState.time`.
 *
 * The timeline processors (`incomes`, `expenses`, `debts`, `physical-assets`) build their
 * `customDate` time points with the `new Date(year, month - 1, day)` constructor and
 * compare them against the simulation date, so the simulation date has to be built the
 * same way to stay comparable. The calendar values come from the clock's ISO string,
 * never from the host timezone, so both the arithmetic and the ISO labels stay
 * timezone-independent.
 */
export function toSimulationDate(date: CalendarDate): Date {
  return new Date(date.year, date.month - 1, date.day);
}
