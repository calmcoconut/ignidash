import { describe, it, expect, afterAll } from 'vitest';

import { addMonths, type CalendarDate } from '../clock';

import { taxYearFor } from './tax-year';

const ORIGINAL_TZ = process.env.TZ;

/** Runs `run` with the host timezone set to `timeZone` (Node re-reads `process.env.TZ`). */
function runInTimezone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** The first day of the month reached `months` months after `start` — the engine's annual-row date. */
function settlementDate(start: CalendarDate, months: number): CalendarDate {
  return { ...addMonths(start, months), day: 1 };
}

/**
 * The pre-fix derivation, kept only where it agreed with the calendar arithmetic: reading
 * `getUTCFullYear()` off the locally-constructed simulation date.
 */
function legacyGetterYear(date: CalendarDate): number {
  return new Date(date.year, date.month - 1, date.day).getUTCFullYear();
}

describe('taxYearFor', () => {
  it.each([
    ['the start year itself', { year: 2026, month: 10, day: 1 }, 0, 2026],
    ['a mid-year start, still in the same year', { year: 2026, month: 6, day: 15 }, 6, 2026],
    ['a mid-year start, past its anniversary', { year: 2026, month: 6, day: 15 }, 7, 2027],
    ['a January 1 start crossing into the next year', { year: 2026, month: 1, day: 1 }, 12, 2027],
    ['a December 31 start crossing a month boundary', { year: 2026, month: 12, day: 31 }, 1, 2027],
    ['a second full year', { year: 2026, month: 1, day: 1 }, 24, 2028],
    ['a December settlement that stays in the same year', { year: 2026, month: 1, day: 15 }, 11, 2026],
  ] as Array<[string, CalendarDate, number, number]>)('%s: %o + %i months → %i', (_label, start, monthsElapsed, expected) => {
    expect(taxYearFor(start, monthsElapsed)).toBe(expected);
  });

  it('agrees with the calendar date the engine stamps on the annual row', () => {
    const start: CalendarDate = { year: 2026, month: 10, day: 15 };

    for (let monthsElapsed = 0; monthsElapsed <= 36; monthsElapsed++) {
      expect(taxYearFor(start, monthsElapsed)).toBe(settlementDate(start, monthsElapsed).year);
    }
  });
});

describe('taxYearFor — timezone independence', () => {
  it('reports the calendar year for a January 1 settlement in a UTC+14 zone', () => {
    // The 12th month of a January 1 run settles on January 1 of the next year. In a UTC+14 zone,
    // local midnight on January 1 is still December 31 in UTC, which is exactly where the old
    // getter-based derivation went wrong.
    const start: CalendarDate = { year: 2026, month: 1, day: 1 };
    const settlement = settlementDate(start, 12);
    expect(settlement).toEqual({ year: 2027, month: 1, day: 1 });

    const observed = runInTimezone('Pacific/Kiritimati', () => ({
      // Proves the timezone switch really took effect: UTC+14 reports an offset of -840 minutes.
      offsetMinutes: new Date(2026, 0, 1).getTimezoneOffset(),
      taxYear: taxYearFor(start, 12),
    }));

    expect(observed.offsetMinutes).toBe(-840);
    // The calendar derivation reports the year the settlement date is in, on every host.
    expect(observed.taxYear).toBe(2027);
  });

  it('is a no-op in UTC and America/Los_Angeles, where the old getter already agreed', () => {
    const starts: CalendarDate[] = [
      { year: 2026, month: 1, day: 1 },
      { year: 2026, month: 2, day: 15 },
      { year: 2026, month: 7, day: 1 },
      { year: 2026, month: 12, day: 31 },
      { year: 2019, month: 1, day: 1 },
    ];

    for (const timeZone of ['UTC', 'America/Los_Angeles']) {
      const disagreements = runInTimezone(timeZone, () => {
        const found: string[] = [];
        for (const start of starts) {
          for (let monthsElapsed = 0; monthsElapsed <= 48; monthsElapsed++) {
            const settlement = settlementDate(start, monthsElapsed);
            const calendarYear = taxYearFor(start, monthsElapsed);
            if (legacyGetterYear(settlement) !== calendarYear) {
              found.push(`${timeZone} ${JSON.stringify(start)} +${monthsElapsed} → ${legacyGetterYear(settlement)}`);
            }
          }
        }
        return found;
      });

      // No year moves on a non-positive offset: this fix only corrects the UTC+ boundary.
      expect(disagreements).toEqual([]);
    }
  });
});
