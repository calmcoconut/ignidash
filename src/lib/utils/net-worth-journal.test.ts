import { describe, it, expect } from 'vitest';

import {
  buildNetWorthOverlay,
  daysFromCivil,
  daysInMonth,
  netWorthOfEntry,
  parseJournalDate,
  projectionRows,
  validateJournalEntry,
  DEFAULT_DEVIATION_BAND_PERCENT,
  type NetWorthJournalEntry,
} from './net-worth-journal';
import { createEmptyPortfolioData } from '@/lib/calc/__tests__/test-utils';
import type { SimulationDataPoint } from '@/lib/calc/simulation-engine';

/** A projection row: net worth is the portfolio value, with no assets or debts. */
const dataPoint = (date: string, age: number, netWorth: number): SimulationDataPoint => ({
  date,
  age,
  portfolio: { ...createEmptyPortfolioData(), totalValue: netWorth },
  incomes: null,
  expenses: null,
  debts: null,
  physicalAssets: null,
  phase: null,
  taxes: null,
  returns: null,
});

/** Ten days apart, so a midpoint interpolation has an exact, hand-checkable weight of 0.5. */
const tenDayProjection = [dataPoint('2026-01-01', 40, 100_000), dataPoint('2026-01-11', 41, 200_000)];

/** A one-year projection: 2025-12-31 → 2026-12-31 is exactly 365 days (2026 is not a leap year). */
const yearProjection = [dataPoint('2025-12-31', 40, 0), dataPoint('2026-12-31', 41, 100_000)];

const entry = (id: string, date: string, balances: Record<string, number>, note?: string): NetWorthJournalEntry => ({
  id,
  date,
  balances,
  ...(note === undefined ? {} : { note }),
});

describe('journal dates: partial dates resolve to the end of their period', () => {
  it('resolves a year to 31 December', () => {
    expect(parseJournalDate('2026')).toMatchObject({ precision: 'year', year: 2026, month: 12, day: 31, effectiveDate: '2026-12-31' });
  });

  it('resolves a year-month to the last day of that month', () => {
    expect(parseJournalDate('2026-09')).toMatchObject({ precision: 'month', effectiveDate: '2026-09-30' });
    expect(parseJournalDate('2026-02')).toMatchObject({ effectiveDate: '2026-02-28' });
    expect(parseJournalDate('2028-02')).toMatchObject({ effectiveDate: '2028-02-29' });
  });

  it('keeps an exact day as given', () => {
    expect(parseJournalDate('2026-09-15')).toMatchObject({ precision: 'day', effectiveDate: '2026-09-15' });
  });

  it('rejects anything that is not a real date in range', () => {
    for (const value of ['', '2026-9', '2026-13', '2026-00', '2026-02-30', '2026-02-00', '1899', '2101', 'garbage', '2026-01-01T00:00']) {
      expect(parseJournalDate(value), value).toBeNull();
    }
  });

  it('computes month lengths and day indices without a clock', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 12)).toBe(31);
    // Known offsets: 1970-01-01 is day 0, and a 2026 non-leap year has 365 days.
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2026, 12, 31) - daysFromCivil(2025, 12, 31)).toBe(365);
  });
});

describe('alignment rule: interpolate between the bracketing rows', () => {
  it('attaches an exact date to that row, with no interpolation error', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('a', '2026-01-01', { brokerage: 100_000 })]);

    expect(overlay.points).toHaveLength(1);
    expect(overlay.points[0]).toMatchObject({
      entryId: 'a',
      date: '2026-01-01',
      age: 40,
      actualNetWorth: 100_000,
      projectedNetWorth: 100_000,
      deviation: 0,
    });
  });

  it('attaches an exact date to the last row too', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('a', '2026-01-11', { brokerage: 210_000 })]);

    expect(overlay.points[0]).toMatchObject({ age: 41, projectedNetWorth: 200_000, deviation: 10_000 });
  });

  it('interpolates halfway between two rows (weight 0.5)', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('a', '2026-01-06', { brokerage: 160_000 })]);

    expect(overlay.points[0]).toMatchObject({ date: '2026-01-06', projectedNetWorth: 150_000, deviation: 10_000 });
    expect(overlay.points[0].age).toBeCloseTo(40.5, 10);
  });

  it('resolves a month-only date to month end, then interpolates against it', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [entry('a', '2026-09', { brokerage: 50_000 })]);

    // 2025-12-31 → 2026-09-30 is 273 days of the 365-day year.
    expect(overlay.points[0]).toMatchObject({ date: '2026-09-30', precision: 'month', actualNetWorth: 50_000 });
    expect(overlay.points[0].projectedNetWorth).toBeCloseTo((100_000 * 273) / 365, 6);
    expect(overlay.points[0].deviation).toBeCloseTo(50_000 - (100_000 * 273) / 365, 6);
  });

  it('resolves a year-only date to 31 December, which is the last row here', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [entry('a', '2026', { brokerage: 90_000 })]);

    expect(overlay.points[0]).toMatchObject({ date: '2026-12-31', precision: 'year', projectedNetWorth: 100_000, deviation: -10_000 });
  });
});

describe('dates outside the projection are reported, never clamped', () => {
  it('reports a date after the last row', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('late', '2026-02', { brokerage: 300_000 })]);

    expect(overlay.points).toEqual([]);
    expect(overlay.issues).toHaveLength(1);
    expect(overlay.issues[0]).toMatchObject({ entryId: 'late', reason: 'after-projection' });
    expect(overlay.issues[0].message).toContain('2026-02-28');
    expect(overlay.issues[0].message).toContain('2026-01-11');
  });

  it('reports a date before the first row', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('early', '2020', { brokerage: 1_000 })]);

    expect(overlay.points).toEqual([]);
    expect(overlay.issues[0]).toMatchObject({ entryId: 'early', reason: 'before-projection' });
  });

  it('reports an unusable date rather than guessing', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, [entry('bad', 'not-a-date', { brokerage: 1 })]);

    expect(overlay.points).toEqual([]);
    expect(overlay.issues[0]).toMatchObject({ entryId: 'bad', reason: 'invalid-date' });
  });

  it('reports every entry when there is no projection at all', () => {
    const overlay = buildNetWorthOverlay([], [entry('a', '2026', { brokerage: 1 })]);

    expect(overlay.points).toEqual([]);
    expect(overlay.issues[0]).toMatchObject({ entryId: 'a', reason: 'no-projection' });
  });
});

describe('deviation and band', () => {
  it('signs the deviation as actual minus projected', () => {
    const ahead = buildNetWorthOverlay(tenDayProjection, [entry('a', '2026-01-01', { brokerage: 120_000 })]);
    const behind = buildNetWorthOverlay(tenDayProjection, [entry('a', '2026-01-01', { brokerage: 80_000 })]);

    expect(ahead.points[0].deviation).toBe(20_000);
    expect(behind.points[0].deviation).toBe(-20_000);
  });

  it('bands the projection by the default ±5% of each row', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, []);

    expect(DEFAULT_DEVIATION_BAND_PERCENT).toBe(0.05);
    expect(overlay.band).toEqual([
      { age: 40, date: '2026-01-01', projectedNetWorth: 100_000, lower: 95_000, upper: 105_000 },
      { age: 41, date: '2026-01-11', projectedNetWorth: 200_000, lower: 190_000, upper: 210_000 },
    ]);
  });

  it('honours a custom band width and keeps lower ≤ upper for negative net worth', () => {
    const negative = [dataPoint('2026-01-01', 40, -100_000)];
    const overlay = buildNetWorthOverlay(negative, [], { bandPercent: 0.25 });

    expect(overlay.band[0]).toEqual({ age: 40, date: '2026-01-01', projectedNetWorth: -100_000, lower: -125_000, upper: -75_000 });
  });

  it('refuses an unusable band width', () => {
    expect(() => buildNetWorthOverlay(tenDayProjection, [], { bandPercent: -0.1 })).toThrow(/bandPercent/);
    expect(() => buildNetWorthOverlay(tenDayProjection, [], { bandPercent: Number.NaN })).toThrow(/bandPercent/);
  });
});

describe('overlay is pure', () => {
  it('returns an empty overlay for an empty journal instead of throwing', () => {
    const overlay = buildNetWorthOverlay(tenDayProjection, []);

    expect(overlay).toEqual({ points: [], issues: [], band: buildNetWorthOverlay(tenDayProjection, []).band });
    expect(overlay.band).toHaveLength(2);
  });

  it('is deterministic, order-independent and does not mutate its inputs', () => {
    const entries = [entry('b', '2026-01-11', { brokerage: 205_000 }), entry('a', '2026-01-06', { brokerage: 150_000 }, 'Q1')];
    const projectionSnapshot = structuredClone(tenDayProjection);
    const entriesSnapshot = structuredClone(entries);

    const first = buildNetWorthOverlay(tenDayProjection, entries);
    const second = buildNetWorthOverlay(tenDayProjection, [...entries].reverse());

    expect(second).toEqual(first);
    expect(first.points.map((point) => point.entryId)).toEqual(['a', 'b']);
    expect(first.points[0].note).toBe('Q1');
    expect(tenDayProjection).toEqual(projectionSnapshot);
    expect(entries).toEqual(entriesSnapshot);
  });

  it('sorts and de-duplicates the projection rows it aligns against', () => {
    const rows = projectionRows([
      dataPoint('2026-01-11', 41, 200_000),
      dataPoint('2026-01-01', 40, 100_000),
      dataPoint('2026-01-11', 41, 999_999),
    ]);

    expect(rows).toEqual([
      { age: 40, date: '2026-01-01', netWorth: 100_000 },
      { age: 41, date: '2026-01-11', netWorth: 200_000 },
    ]);
  });
});

describe('journal entry validation', () => {
  it('accepts a complete entry, with and without a note', () => {
    expect(validateJournalEntry(entry('a', '2026-09', { brokerage: 1_000 }, 'end of Q3'))).toEqual({ ok: true });
    expect(validateJournalEntry(entry('a', '2026', { brokerage: -500 }))).toEqual({ ok: true });
  });

  it('reports every problem it finds', () => {
    const result = validateJournalEntry({ id: '  ', date: '2026-02-30', balances: { brokerage: Number.NaN, '': 10 }, note: 42 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(5);
    expect(result.issues.join(' ')).toContain('id');
    expect(result.issues.join(' ')).toContain('2026-02-30');
    expect(result.issues.join(' ')).toContain('brokerage');
    expect(result.issues.join(' ')).toContain('note');
    expect(result.issues.join(' ')).toContain('empty');
  });

  it('rejects non-objects and missing balances', () => {
    expect(validateJournalEntry(null).ok).toBe(false);
    expect(validateJournalEntry('2026').ok).toBe(false);
    expect(validateJournalEntry({ id: 'a', date: '2026' }).ok).toBe(false);
  });

  it('sums the recorded balances, negative liabilities included', () => {
    expect(netWorthOfEntry(entry('a', '2026', { brokerage: 500_000, mortgage: -320_000 }))).toBe(180_000);
  });
});
