import { describe, expect, it } from 'vitest';

import type { MarketAssumptionsInputs } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import type { TimePoint } from '@/lib/schemas/inputs/income-expenses-shared-schemas';

import {
  TimeBinding,
  calendarMonthsBetween,
  cumulativeInflationIndex,
  isRecurrenceOccurrence,
  isTimePointNotPassed,
  isTimePointReached,
  timePointDate,
  timePointProgress,
  yearsFromPlanStart,
  type TimeBindingClock,
  type TimeBindingContext,
} from './time-binding';

/**
 * Shared time binding (parity plan P1-P1).
 *
 * These tests pin the behaviour of the one resolver that replaced five private copies
 * (incomes.ts, expenses.ts, debts.ts, physical-assets.ts and the glide-path interpolation in
 * portfolio.ts), plus the two things it now owns: N-year recurrence and the real/nominal
 * distinction through `cumulativeInflationIndex`.
 */

const MARKET_ASSUMPTIONS: MarketAssumptionsInputs = {
  stockReturn: 9,
  stockYield: 2,
  bondReturn: 4,
  bondYield: 3.5,
  cashReturn: 3,
  inflationRate: 3,
};

const PLAN_START = new Date(2026, 9, 1); // 2026-10-01

const CONTEXT: TimeBindingContext = {
  startAge: 35,
  startDate: PLAN_START,
  marketAssumptions: MARKET_ASSUMPTIONS,
};

/** A clock at `age`, `date`, and `years` since the plan start. */
function clockAt(
  age: number,
  year: number,
  month: number,
  planYear = 0,
  phase: 'accumulation' | 'retirement' = 'accumulation'
): TimeBindingClock {
  return { time: { age, date: new Date(year, month - 1, 1), year: planYear }, phase: { name: phase } };
}

describe('isTimePointReached (start bound: at or after)', () => {
  const cases: Array<{ label: string; timePoint: TimePoint; before: TimeBindingClock; at: TimeBindingClock }> = [
    {
      label: 'now',
      timePoint: { type: 'now' },
      // `now` is already reached before the first processed month, and stays reached.
      before: clockAt(35, 2026, 10),
      at: clockAt(35 + 1 / 12, 2026, 11, 1 / 12),
    },
    {
      label: 'customAge',
      timePoint: { type: 'customAge', age: 40 },
      before: clockAt(39, 2030, 9),
      at: clockAt(40, 2031, 10),
    },
    {
      label: 'customDate',
      timePoint: { type: 'customDate', year: 2031, month: 10 },
      before: clockAt(40, 2031, 9),
      at: clockAt(40, 2031, 10),
    },
    {
      label: 'atRetirement',
      timePoint: { type: 'atRetirement' },
      before: clockAt(64, 2055, 1, 29, 'accumulation'),
      at: clockAt(65, 2056, 1, 30, 'retirement'),
    },
    {
      label: 'atLifeExpectancy',
      timePoint: { type: 'atLifeExpectancy' },
      before: clockAt(50, 2041, 10, 15),
      at: clockAt(87, 2078, 10, 52),
    },
  ];

  for (const { label, timePoint, before, at } of cases) {
    it(`${label}`, () => {
      expect(isTimePointReached(timePoint, before)).toBe(label === 'now');
      // atLifeExpectancy is never a start bound: an event anchored to it never starts.
      expect(isTimePointReached(timePoint, at)).toBe(label !== 'atLifeExpectancy');
    });
  }

  it('treats a custom point missing its value as unreachable instead of throwing', () => {
    expect(isTimePointReached({ type: 'customAge' }, clockAt(50, 2041, 10, 15))).toBe(false);
    expect(isTimePointReached({ type: 'customDate', year: 2041 }, clockAt(50, 2041, 10, 15))).toBe(false);
  });
});

describe('isTimePointNotPassed (end bound: at or before)', () => {
  const cases: Array<{ label: string; timePoint: TimePoint; inside: TimeBindingClock; outside: TimeBindingClock }> = [
    {
      label: 'customAge',
      timePoint: { type: 'customAge', age: 40 },
      inside: clockAt(40, 2031, 10),
      outside: clockAt(40 + 1 / 12, 2031, 11, 1 / 12),
    },
    {
      label: 'customDate',
      timePoint: { type: 'customDate', year: 2031, month: 10 },
      inside: clockAt(40, 2031, 10),
      outside: clockAt(40, 2031, 11),
    },
    {
      label: 'atRetirement',
      timePoint: { type: 'atRetirement' },
      inside: clockAt(64, 2055, 1, 29, 'accumulation'),
      outside: clockAt(65, 2056, 1, 30, 'retirement'),
    },
    {
      label: 'atLifeExpectancy',
      timePoint: { type: 'atLifeExpectancy' },
      inside: clockAt(50, 2041, 10, 15),
      // An event ending at life expectancy runs to the horizon: the bound is never passed.
      outside: clockAt(87, 2078, 10, 52),
    },
  ];

  for (const { label, timePoint, inside, outside } of cases) {
    it(`${label}`, () => {
      expect(isTimePointNotPassed(timePoint, inside)).toBe(true);
      expect(isTimePointNotPassed(timePoint, outside)).toBe(label === 'atLifeExpectancy');
    });
  }

  it('now is never a live end bound', () => {
    expect(isTimePointNotPassed({ type: 'now' }, clockAt(35, 2026, 10))).toBe(false);
  });

  it('treats a custom point missing its value as already passed', () => {
    expect(isTimePointNotPassed({ type: 'customAge' }, clockAt(50, 2041, 10, 15))).toBe(false);
    expect(isTimePointNotPassed({ type: 'customDate', year: 2041 }, clockAt(50, 2041, 10, 15))).toBe(false);
  });
});

describe('calendar arithmetic', () => {
  it('resolves a customDate to the first of its month', () => {
    expect(timePointDate({ year: 2031, month: 7 })).toEqual(new Date(2031, 6, 1));
  });

  it('counts whole calendar months across year boundaries', () => {
    expect(calendarMonthsBetween(new Date(2026, 9, 1), new Date(2031, 9, 1))).toBe(60);
    expect(calendarMonthsBetween(new Date(2026, 9, 1), new Date(2026, 9, 1))).toBe(0);
    expect(calendarMonthsBetween(new Date(2026, 9, 1), new Date(2031, 3, 1))).toBe(54);
  });

  it('measures years from the plan start by age and by date', () => {
    expect(yearsFromPlanStart({ type: 'now' }, CONTEXT)).toBe(0);
    expect(yearsFromPlanStart({ type: 'customAge', age: 45 }, CONTEXT)).toBe(10);
    expect(yearsFromPlanStart({ type: 'customDate', year: 2036, month: 10 }, CONTEXT)).toBe(10);
    expect(yearsFromPlanStart({ type: 'atRetirement' }, CONTEXT)).toBeUndefined();
  });
});

describe('timePointProgress (the glide path question)', () => {
  it('interpolates between the run start and a custom age', () => {
    // Halfway from 35 to 65.
    expect(timePointProgress({ type: 'customAge', age: 65 }, clockAt(50, 2041, 10, 15), CONTEXT)).toBeCloseTo(0.5, 10);
    // Before the start and past the end clamp to 0 and 1.
    expect(timePointProgress({ type: 'customAge', age: 65 }, clockAt(30, 2021, 10, -5), CONTEXT)).toBe(0);
    expect(timePointProgress({ type: 'customAge', age: 65 }, clockAt(70, 2061, 10, 35), CONTEXT)).toBe(1);
  });

  it('interpolates between the run start and a custom date', () => {
    // 2026-10-01 -> 2036-10-01 is ten calendar years; five years in is halfway (the span is
    // measured in milliseconds, as the glide path always did, so leap days shift the third decimal).
    expect(timePointProgress({ type: 'customDate', year: 2036, month: 10 }, clockAt(40, 2031, 10, 5), CONTEXT)).toBeCloseTo(0.5, 3);
  });

  it('reports fully at the target when the span is zero or negative', () => {
    expect(timePointProgress({ type: 'customAge', age: 35 }, clockAt(40, 2031, 10, 5), CONTEXT)).toBe(1);
    expect(timePointProgress({ type: 'customDate', year: 2020, month: 1 }, clockAt(40, 2031, 10, 5), CONTEXT)).toBe(1);
  });
});

describe('cumulativeInflationIndex', () => {
  it('is 1 today and compounds the plan inflation assumption', () => {
    expect(cumulativeInflationIndex(MARKET_ASSUMPTIONS, 0)).toBe(1);
    expect(cumulativeInflationIndex(MARKET_ASSUMPTIONS, 1)).toBeCloseTo(1.03, 12);
    expect(cumulativeInflationIndex(MARKET_ASSUMPTIONS, 10)).toBeCloseTo(Math.pow(1.03, 10), 12);
    expect(cumulativeInflationIndex(MARKET_ASSUMPTIONS, 30)).toBeCloseTo(Math.pow(1.03, 30), 12);
  });

  it('is zero-inflation neutral and deterministic for the same arguments', () => {
    const noInflation = { ...MARKET_ASSUMPTIONS, inflationRate: 0 };
    expect(cumulativeInflationIndex(noInflation, 25)).toBe(1);

    // Contract 3.1: no store, clock or module state, so repeated calls and a moved wall
    // clock cannot change the index.
    const first = cumulativeInflationIndex(MARKET_ASSUMPTIONS, 12.5);
    const second = cumulativeInflationIndex({ ...MARKET_ASSUMPTIONS }, 12.5);
    expect(first).toBe(second);
  });

  it('mirrors below 1 for a date before the plan start', () => {
    expect(cumulativeInflationIndex(MARKET_ASSUMPTIONS, -5)).toBeCloseTo(1 / Math.pow(1.03, 5), 12);
  });
});

describe('recurrence cadence', () => {
  it('matches the anchor, every cadence, and skips the years between', () => {
    // Boundaries: 0, N, 2N, and a non-multiple offset.
    expect(isRecurrenceOccurrence(5, undefined, 0)).toBe(true);
    expect(isRecurrenceOccurrence(5, undefined, 5)).toBe(true);
    expect(isRecurrenceOccurrence(5, undefined, 10)).toBe(true);
    expect(isRecurrenceOccurrence(5, undefined, 1)).toBe(false);
    expect(isRecurrenceOccurrence(5, undefined, 6)).toBe(false);
    expect(isRecurrenceOccurrence(5, undefined, 9)).toBe(false);
    expect(isRecurrenceOccurrence(5, undefined, 11)).toBe(false);
  });

  it('never matches before the anchor', () => {
    expect(isRecurrenceOccurrence(5, undefined, -1)).toBe(false);
    expect(isRecurrenceOccurrence(5, undefined, -5)).toBe(false);
  });

  it('stops after the recurrence span', () => {
    // Every 5 years for 12 years: occurrences at 0, 5 and 10, nothing at 15.
    expect(isRecurrenceOccurrence(5, 12, 0)).toBe(true);
    expect(isRecurrenceOccurrence(5, 12, 5)).toBe(true);
    expect(isRecurrenceOccurrence(5, 12, 10)).toBe(true);
    expect(isRecurrenceOccurrence(5, 12, 15)).toBe(false);

    // The span is exclusive: three years covers 0, 1, 2.
    expect(isRecurrenceOccurrence(1, 3, 2)).toBe(true);
    expect(isRecurrenceOccurrence(1, 3, 3)).toBe(false);
  });

  it('treats an absent or 1-year cadence as every year', () => {
    for (const index of [0, 1, 2, 25]) {
      expect(isRecurrenceOccurrence(undefined, undefined, index)).toBe(true);
      expect(isRecurrenceOccurrence(1, undefined, index)).toBe(true);
    }
  });
});

describe('TimeBinding', () => {
  it('keeps a plain event active across its whole window, as before', () => {
    const binding = new TimeBinding({ type: 'customAge', age: 40 }, { type: 'customAge', age: 45 }, CONTEXT);

    expect(binding.isActiveAt(clockAt(39.9, 2031, 8))).toBe(false);
    expect(binding.isActiveAt(clockAt(40, 2031, 10))).toBe(true);
    expect(binding.isActiveAt(clockAt(45, 2036, 10))).toBe(true);
    expect(binding.isActiveAt(clockAt(45.1, 2036, 11))).toBe(false);
  });

  it('gates activity to the occurrence years of a cadence', () => {
    const binding = new TimeBinding({ type: 'customAge', age: 40, everyNYears: 5 }, undefined, CONTEXT);

    // Year 0 (age 40) -> active; ages 41-44 -> inactive; age 45 -> active again.
    expect(binding.isActiveAt(clockAt(40, 2031, 10, 5))).toBe(true);
    expect(binding.isActiveAt(clockAt(41, 2032, 10, 6))).toBe(false);
    expect(binding.isActiveAt(clockAt(44, 2035, 10, 9))).toBe(false);
    expect(binding.isActiveAt(clockAt(45, 2036, 10, 10))).toBe(true);
    expect(binding.isActiveAt(clockAt(50, 2041, 10, 15))).toBe(true);
    expect(binding.isActiveAt(clockAt(51, 2042, 10, 16))).toBe(false);
  });

  it('respects the recurrence span even when the end bound is open', () => {
    const binding = new TimeBinding({ type: 'now', everyNYears: 2, recurrenceYears: 5 }, undefined, CONTEXT);

    // Plan years 0, 2, 4 are occurrences; 5 and 6 are past the span.
    expect(binding.isActiveAt(clockAt(35, 2026, 10, 0))).toBe(true);
    expect(binding.isActiveAt(clockAt(37, 2028, 10, 2))).toBe(true);
    expect(binding.isActiveAt(clockAt(39, 2030, 10, 4))).toBe(true);
    expect(binding.isActiveAt(clockAt(40, 2031, 10, 5))).toBe(false);
    expect(binding.isActiveAt(clockAt(41, 2032, 10, 6))).toBe(false);
  });

  it('anchors a customDate cadence on the event date, not the plan year', () => {
    const binding = new TimeBinding({ type: 'customDate', year: 2027, month: 7, everyNYears: 3 }, undefined, CONTEXT);

    expect(binding.isActiveAt(clockAt(36, 2026, 10, 0))).toBe(false);
    expect(binding.isActiveAt(clockAt(36, 2027, 7, 0.75))).toBe(true);
    expect(binding.isActiveAt(clockAt(37, 2028, 7, 1.75))).toBe(false);
    expect(binding.isActiveAt(clockAt(40, 2030, 7, 3.75))).toBe(true);
  });

  it('reports the occurrence index only for a repeating event', () => {
    const plain = new TimeBinding({ type: 'now' }, undefined, CONTEXT);
    expect(plain.occurrenceIndexAt(clockAt(35, 2026, 10, 0))).toBeNull();
    expect(plain.isRecurring()).toBe(false);

    const recurring = new TimeBinding({ type: 'customAge', age: 40, everyNYears: 2 }, undefined, CONTEXT);
    expect(recurring.isRecurring()).toBe(true);
    expect(recurring.occurrenceIndexAt(clockAt(40, 2031, 10, 5))).toBe(0);
    expect(recurring.occurrenceIndexAt(clockAt(43, 2034, 10, 8))).toBe(3);
  });

  it('does not scale real amounts and cannot scale without a plan context', () => {
    expect(new TimeBinding({ type: 'customDate', year: 2036, month: 10 }, undefined, CONTEXT).amountScale('real')).toBe(1);
    expect(new TimeBinding({ type: 'customDate', year: 2036, month: 10 }, undefined, CONTEXT).amountScale(undefined)).toBe(1);
    expect(new TimeBinding({ type: 'customDate', year: 2036, month: 10 }, undefined, undefined).amountScale('nominal')).toBe(1);
    // A phase-anchored amount has no calendar location of its own.
    expect(new TimeBinding({ type: 'atRetirement' }, undefined, CONTEXT).amountScale('nominal')).toBe(1);
  });

  it('converts a nominal amount with the cumulative index (bought forward N years)', () => {
    const nominal = 10_000;
    const yearsOut = 10;
    const binding = new TimeBinding({ type: 'customDate', year: 2036, month: 10 }, undefined, CONTEXT);

    const real = nominal * binding.amountScale('nominal');

    // nominal = real * index(N), exactly the contract the plan states.
    expect(nominal).toBeCloseTo(real * cumulativeInflationIndex(MARKET_ASSUMPTIONS, yearsOut), 8);
    expect(real).toBeCloseTo(nominal / Math.pow(1.03, yearsOut), 8);
  });
});
