import { describe, it, expect } from 'vitest';

import { overlayDateLabel, overlayMarkerSign, toOverlayChartData, toOverlayPlotPoints } from './net-worth-overlay-chart-data';
import { DEFAULT_DEVIATION_BAND_PERCENT, buildNetWorthOverlay, type NetWorthJournalEntry, type NetWorthOverlay } from './net-worth-journal';
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

/** Two rows exactly 365 days apart, so an interpolated age has a hand-checkable weight. */
const yearProjection = [dataPoint('2025-12-31', 40, 0), dataPoint('2026-12-31', 41, 100_000)];

const entry = (id: string, date: string, balances: Record<string, number>): NetWorthJournalEntry => ({ id, date, balances });

const emptyOverlay: NetWorthOverlay = { points: [], issues: [], band: [] };

describe('toOverlayChartData: empty input', () => {
  it('returns empty arrays and no series for an empty overlay', () => {
    const chart = toOverlayChartData(emptyOverlay);

    expect(chart.rows).toEqual([]);
    expect(chart.markers).toEqual([]);
    expect(chart.issues).toEqual([]);
    expect(chart.hasSeries).toBe(false);
  });

  it('reports hasSeries: false when there is no projection even though entries were recorded', () => {
    const overlay = buildNetWorthOverlay([], [entry('a', '2026', { brokerage: 100_000 })]);
    const chart = toOverlayChartData(overlay);

    expect(chart.hasSeries).toBe(false);
    expect(chart.rows).toEqual([]);
    expect(chart.markers).toEqual([]);
    expect(chart.issues).toEqual([{ id: 'a:no-projection', message: 'There is no projection to align this entry with.' }]);
  });
});

describe('toOverlayChartData: band rows', () => {
  it('turns the deviation band into stacked lower + bandWidth rows', () => {
    const chart = toOverlayChartData(buildNetWorthOverlay(yearProjection, []));

    expect(chart.hasSeries).toBe(true);
    expect(chart.rows).toHaveLength(2);

    const [first, second] = chart.rows;
    expect(first).toMatchObject({ age: 40, date: '2025-12-31', lower: 0, upper: 0, bandWidth: 0, projectedNetWorth: 0 });
    expect(second).toMatchObject({ age: 41, date: '2026-12-31', projectedNetWorth: 100_000 });

    // Default ±5% band, expressed as an offset that stacks back to the upper bound.
    expect(second.upper).toBe(100_000 * (1 + DEFAULT_DEVIATION_BAND_PERCENT));
    expect(second.lower).toBe(100_000 * (1 - DEFAULT_DEVIATION_BAND_PERCENT));
    expect(second.bandWidth).toBe(second.upper - second.lower);
    expect(second.lower + second.bandWidth).toBeCloseTo(second.upper, 10);
  });

  it('keeps the band ordered where the projection is negative', () => {
    // A liability-heavy start: the overlay clamps lower/upper into [min, max] of the two bounds.
    const chart = toOverlayChartData(buildNetWorthOverlay([dataPoint('2026-12-31', 40, -50_000)], [], { bandPercent: 0.05 }));

    expect(chart.rows[0].lower).toBe(-52_500);
    expect(chart.rows[0].upper).toBe(-47_500);
    expect(chart.rows[0].bandWidth).toBe(5_000);
    expect(chart.rows[0].lower + chart.rows[0].bandWidth).toBeCloseTo(chart.rows[0].upper, 10);
  });
});

describe('toOverlayChartData: marker labels keep the recorded precision', () => {
  it('labels a year, a month and a day as recorded', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [
      entry('year', '2026', { brokerage: 100_000 }),
      entry('month', '2026-09', { brokerage: 80_000 }),
      entry('day', '2026-06-30', { brokerage: 40_000 }),
    ]);
    const chart = toOverlayChartData(overlay);

    const labels = Object.fromEntries(chart.markers.map((marker) => [marker.entryId, marker.dateLabel]));
    expect(labels).toEqual({ year: '2026', month: '2026-09', day: '2026-06-30' });
    // The canonical end-of-period date is NOT the label: a year is not "2026-12-31".
    expect(chart.markers.find((marker) => marker.entryId === 'year')?.dateLabel).not.toBe('2026-12-31');
  });

  it('maps each precision to the label it was recorded at', () => {
    expect(overlayDateLabel('2026-12-31', 'year')).toBe('2026');
    expect(overlayDateLabel('2026-09-30', 'month')).toBe('2026-09');
    expect(overlayDateLabel('2026-09-15', 'day')).toBe('2026-09-15');
  });
});

describe('toOverlayChartData: markers', () => {
  it('plots a mid-period actual at its interpolated age with its deviation and sign', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [entry('ahead', '2026-09', { brokerage: 80_000 })]);
    const [marker] = toOverlayChartData(overlay).markers;

    // 2026-09-30 is 273 of the 365 days from 2025-12-31 to 2026-12-31.
    expect(marker.age).toBeCloseTo(40 + 273 / 365, 10);
    expect(marker.age).not.toBe(Math.round(marker.age));
    expect(marker.actualNetWorth).toBe(80_000);
    expect(marker.projectedNetWorth).toBeCloseTo(100_000 * (273 / 365), 6);
    expect(marker.deviation).toBeCloseTo(80_000 - 100_000 * (273 / 365), 6);
    expect(marker.sign).toBe('ahead');
  });

  it('signs a behind actual and an exact match', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [
      entry('behind', '2026-06-30', { brokerage: 40_000 }),
      entry('exact', '2026-12-31', { brokerage: 100_000 }),
    ]);
    const signs = Object.fromEntries(toOverlayChartData(overlay).markers.map((marker) => [marker.entryId, marker.sign]));

    expect(signs).toEqual({ behind: 'behind', exact: 'on-plan' });
  });

  it('keeps a marker per entry in date order, with numeric (unformatted) amounts', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [
      entry('later', '2026-12-31', { brokerage: 90_000 }),
      entry('earlier', '2026-03', { brokerage: 10_000 }),
    ]);
    const chart = toOverlayChartData(overlay);

    expect(chart.markers.map((marker) => marker.entryId)).toEqual(['earlier', 'later']);
    for (const marker of chart.markers) {
      expect(typeof marker.actualNetWorth).toBe('number');
      expect(typeof marker.projectedNetWorth).toBe('number');
      expect(typeof marker.deviation).toBe('number');
    }
  });

  it('signs the deviation arithmetically', () => {
    expect(overlayMarkerSign(1)).toBe('ahead');
    expect(overlayMarkerSign(-1)).toBe('behind');
    expect(overlayMarkerSign(0)).toBe('on-plan');
  });
});

describe('toOverlayChartData: issues stay visible', () => {
  it('surfaces every unplottable entry as an id/message notice', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [
      entry('before', '2025-06', { brokerage: 1 }),
      entry('after', '2027', { brokerage: 1 }),
      entry('bogus', '2026-13', { brokerage: 1 }),
      entry('plotted', '2026-12-31', { brokerage: 100_000 }),
    ]);
    const chart = toOverlayChartData(overlay);

    expect(chart.markers).toHaveLength(1);
    expect(chart.hasSeries).toBe(true);
    expect(chart.issues).toHaveLength(3);
    expect(chart.issues.map((issue) => issue.id)).toEqual(['before:before-projection', 'after:after-projection', 'bogus:invalid-date']);
    expect(chart.issues.map((issue) => issue.message)).toEqual(overlay.issues.map((issue) => issue.message));
    for (const issue of chart.issues) expect(issue.message.length).toBeGreaterThan(0);
  });

  it('gives two entries with the same problem distinct notice ids', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [entry('a', '2027', { x: 1 }), entry('b', '2027', { x: 2 })]);
    const ids = toOverlayChartData(overlay).issues.map((issue) => issue.id);

    expect(ids).toEqual(['a:after-projection', 'b:after-projection']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the message at recorded precision, with no currency formatting added', () => {
    const overlay = buildNetWorthOverlay(yearProjection, [entry('after', '2027', { brokerage: 1 })]);
    const [issue] = toOverlayChartData(overlay).issues;

    expect(issue.message).toBe('2027-12-31 is after the projection ends (2026-12-31).');
    expect(issue.message).not.toContain('$');
  });
});

describe('toOverlayPlotPoints: one dataset for the chart', () => {
  const chartData = (entries: NetWorthJournalEntry[]) => toOverlayChartData(buildNetWorthOverlay(yearProjection, entries));

  it('returns nothing without a projection', () => {
    expect(toOverlayPlotPoints([], [])).toEqual([]);
    expect(toOverlayPlotPoints([], chartData([entry('a', '2026', { brokerage: 1 })]).markers)).toEqual([]);
  });

  it('returns exactly the band rows when there are no actuals', () => {
    const { rows, markers } = chartData([]);
    const points = toOverlayPlotPoints(rows, markers);

    expect(markers).toEqual([]);
    expect(points).toHaveLength(rows.length);
    expect(points).toEqual(rows.map((row) => ({ ...row })));
  });

  it('inserts a mid-period actual as its own row with the band interpolated around it', () => {
    const { rows, markers } = chartData([entry('mid', '2026-09', { brokerage: 80_000 })]);
    const points = toOverlayPlotPoints(rows, markers);
    const marker = markers[0];

    expect(points).toHaveLength(rows.length + 1);
    expect(points.map((point) => point.age)).toEqual([...points.map((point) => point.age)].sort((a, b) => a - b));
    expect(points[1]).toMatchObject({ age: marker.age, entryId: 'mid', dateLabel: '2026-09', actualNetWorth: 80_000, sign: 'ahead' });
  });

  it('interpolates the band at a marker age onto the drawn projection line', () => {
    const { rows, markers } = chartData([entry('mid', '2026-09', { brokerage: 80_000 })]);
    const marker = markers[0];
    const point = toOverlayPlotPoints(rows, markers).find((candidate) => candidate.entryId === 'mid');

    // The inserted point must lie exactly on the straight line between the bracketing rows,
    // otherwise the line and the band would visibly kink at every actual.
    const weight = (marker.age - rows[0].age) / (rows[1].age - rows[0].age);
    const onLine = (from: number, to: number) => from + weight * (to - from);

    expect(point?.projectedNetWorth).toBeCloseTo(onLine(rows[0].projectedNetWorth, rows[1].projectedNetWorth), 6);
    expect(point?.lower).toBeCloseTo(onLine(rows[0].lower, rows[1].lower), 6);
    expect(point?.upper).toBeCloseTo(onLine(rows[0].upper, rows[1].upper), 6);
    expect(point?.bandWidth).toBeCloseTo((point?.upper ?? 0) - (point?.lower ?? 0), 6);
    // The band's own line and the marker's projected value come from the same interpolation.
    expect(point?.projectedNetWorth).toBeCloseTo(marker.projectedNetWorth, 6);
    expect(point?.lower ?? 0).toBeLessThanOrEqual(point?.projectedNetWorth ?? 0);
  });

  it('attaches an actual that lands on a projection row instead of duplicating that age', () => {
    const { rows, markers } = chartData([entry('onRow', '2026', { brokerage: 110_000 })]);
    const points = toOverlayPlotPoints(rows, markers);
    const last = points[points.length - 1];

    expect(markers[0].age).toBe(rows[rows.length - 1].age);
    expect(points).toHaveLength(rows.length);
    expect(last).toMatchObject({ entryId: 'onRow', dateLabel: '2026', actualNetWorth: 110_000, sign: 'ahead' });
    // The band fields are the row's own, untouched by the merge.
    expect(last.lower).toBe(rows[rows.length - 1].lower);
    expect(last.bandWidth).toBe(rows[rows.length - 1].bandWidth);
  });

  it('keeps every projection row even when actuals cluster at one end', () => {
    const { rows, markers } = chartData([entry('a', '2026-01-15', { brokerage: 1 }), entry('b', '2026-02-15', { brokerage: 2 })]);
    const points = toOverlayPlotPoints(rows, markers);

    expect(points).toHaveLength(rows.length + markers.length);
    // The first and last projection ages survive, so the axis keeps its full span.
    expect(points[0].age).toBe(rows[0].age);
    expect(points[points.length - 1].age).toBe(rows[rows.length - 1].age);
    expect(points.filter((point) => point.entryId === undefined)).toHaveLength(rows.length);
  });
});
