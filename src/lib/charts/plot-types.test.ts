import { describe, it, expect } from 'vitest';

import {
  filterCategoricalBars,
  serializeBarChartDefinition,
  serializePieChartDefinition,
  toBarChartData,
  toCategoricalBars,
  toPieChartData,
  type BarChartDefinition,
  type MetricDataPoint,
  type PieChartDefinition,
} from './plot-types';

/** A chart data point with the fields the definitions below read. */
/** `MetricDataPoint` only guarantees `age`; the views below name the rest of the fields. */
const buildPoint = (fields: Record<string, unknown>): MetricDataPoint => ({ age: Number(fields.age), ...fields });

const point = buildPoint({ age: 40, alpha: 100, beta: -25, gamma: 0, delta: 7 });

const flatView: BarChartDefinition = {
  format: 'currency',
  series: [
    { key: 'alpha', color: 'var(--chart-1)', label: 'Alpha Value', shortLabel: 'Alpha' },
    { key: 'beta', color: 'var(--chart-2)', label: 'Beta Value', shortLabel: 'Beta', sign: -1 },
    { key: 'gamma', color: 'var(--chart-3)', label: 'Gamma Value', shortLabel: 'Gamma' },
  ],
};

const groupedView: BarChartDefinition = {
  format: 'currency',
  series: [
    { key: 'alpha', color: 'var(--chart-1)', label: 'One Bar', shortLabel: 'One' },
    { key: 'delta', color: 'var(--chart-2)', label: 'One Bar', shortLabel: 'One' },
    { key: 'beta', color: 'var(--chart-3)', label: 'Other Bar', shortLabel: 'Other' },
  ],
  segments: [2, 1],
};

describe('toCategoricalBars', () => {
  it('draws one bar per series, named by its desktop label', () => {
    const bars = toCategoricalBars(point, flatView, { isSmallScreen: false });

    expect(bars).toEqual([
      { name: 'Alpha Value', segments: [{ amount: 100, color: 'var(--chart-1)' }] },
      { name: 'Beta Value', segments: [{ amount: 25, color: 'var(--chart-2)' }] },
    ]);
  });

  it('uses the short label on a narrow screen', () => {
    expect(toCategoricalBars(point, flatView, { isSmallScreen: true }).map((bar) => bar.name)).toEqual(['Alpha', 'Beta']);
  });

  it('applies the declared sign, so an outflow renders negative', () => {
    // beta is -25 in the data and declared with sign -1: two negatives make the positive 25.
    const betaSeries = flatView.series[1];
    const bars = toCategoricalBars(point, { format: 'currency', series: [betaSeries] }, { isSmallScreen: false });
    expect(bars[0].segments[0].amount).toBe(25);

    const unsigned = toCategoricalBars(point, { format: 'currency', series: [{ ...betaSeries, sign: 1 }] }, { isSmallScreen: false });
    expect(unsigned[0].segments[0].amount).toBe(-25);
  });

  it('merges a group of two or more series into one stacked bar', () => {
    const bars = toCategoricalBars(point, groupedView, { isSmallScreen: false });

    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      name: 'One Bar',
      segments: [
        { amount: 100, color: 'var(--chart-1)' },
        { amount: 7, color: 'var(--chart-2)' },
      ],
    });
    // No sign declared on this series, so the raw (negative) value is kept.
    expect(bars[1]).toEqual({ name: 'Other Bar', segments: [{ amount: -25, color: 'var(--chart-3)' }] });
  });

  it('drops all-zero bars by default, and keeps them when the view says so', () => {
    // gamma is 0, so the default view renders two bars; `keepZero` keeps the third.
    expect(toCategoricalBars(point, flatView, { isSmallScreen: false })).toHaveLength(2);
    expect(toCategoricalBars(point, { ...flatView, filterZeroValues: false }, { isSmallScreen: false })).toHaveLength(3);
  });

  it('keeps a grouped bar when only one of its segments is non-zero', () => {
    const zeroSegmentGroup: BarChartDefinition = { ...groupedView, segments: undefined };
    // Both members of the group read the same value here, so use an explicit zero pair.
    const bars = toCategoricalBars(
      point,
      { ...zeroSegmentGroup, series: [{ key: 'gamma', color: 'c', label: 'G' }] },
      { isSmallScreen: false }
    );

    expect(bars).toEqual([]);
  });

  it('treats a missing field as zero', () => {
    const bars = toCategoricalBars(
      point,
      { format: 'currency', series: [{ key: 'nope', color: 'c', label: 'Nope' }] },
      { isSmallScreen: false }
    );
    expect(bars).toEqual([]);
  });

  it('does not mutate the point or the definition', () => {
    const pointSnapshot = { ...point };
    const definitionSnapshot = serializeBarChartDefinition(groupedView);

    toCategoricalBars(point, groupedView, { isSmallScreen: true });

    expect({ ...point }).toEqual(pointSnapshot);
    expect(serializeBarChartDefinition(groupedView)).toBe(definitionSnapshot);
  });
});

describe('filterCategoricalBars', () => {
  it('keeps every bar for a keep-zero view', () => {
    const bars = [{ name: 'A', segments: [{ amount: 0, color: 'c' }] }];
    expect(filterCategoricalBars(bars, { series: [], filterZeroValues: false })).toHaveLength(1);
  });

  it('drops an all-zero bar but keeps a partially filled one', () => {
    const bars = [
      {
        name: 'Zero',
        segments: [
          { amount: 0, color: 'a' },
          { amount: 0, color: 'b' },
        ],
      },
      {
        name: 'Partial',
        segments: [
          { amount: 0, color: 'a' },
          { amount: 5, color: 'b' },
        ],
      },
    ];

    expect(filterCategoricalBars(bars, { series: [] }).map((bar) => bar.name)).toEqual(['Partial']);
  });
});

describe('toBarChartData', () => {
  it('flattens one-segment bars into name/amount/colour rows', () => {
    expect(toBarChartData(point, flatView, { isSmallScreen: true })).toEqual([
      { name: 'Alpha', amount: 100, color: 'var(--chart-1)' },
      { name: 'Beta', amount: 25, color: 'var(--chart-2)' },
    ]);
  });

  it('emits one row per segment for a stacked bar', () => {
    const rows = toBarChartData(point, groupedView, { isSmallScreen: false });

    expect(rows.map((row) => row.amount)).toEqual([100, 7, -25]);
  });
});

const pie: PieChartDefinition = {
  series: [
    { key: 'alpha', color: 'var(--chart-1)', label: 'Alpha Slice' },
    { key: 'beta', color: 'var(--chart-2)', label: 'Beta Slice' },
    { key: 'delta', color: 'var(--chart-3)', label: 'Delta Slice', sign: -1 },
  ],
};

describe('toPieChartData', () => {
  it('emits one slice per series, in declaration order', () => {
    expect(toPieChartData(point, pie)).toEqual([
      { name: 'Alpha Slice', value: 100, color: 'var(--chart-1)' },
      { name: 'Beta Slice', value: -25, color: 'var(--chart-2)' },
      { name: 'Delta Slice', value: -7, color: 'var(--chart-3)' },
    ]);
  });

  it('applies a negative sign so a liability slice charts as a negative value', () => {
    const liability: PieChartDefinition = { series: [{ key: 'alpha', color: 'c', label: 'Debt', sign: -1 }] };
    expect(toPieChartData(point, liability)[0].value).toBe(-100);
  });

  it('reads a missing field as zero rather than NaN', () => {
    expect(toPieChartData(point, { series: [{ key: 'missing', color: 'c', label: 'Missing' }] })[0].value).toBe(0);
  });
});

describe('serializers', () => {
  it('writes a bar view as format#series#segments#zero-filter', () => {
    expect(serializeBarChartDefinition(flatView)).toBe(
      'currency#alpha|var(--chart-1)|1|Alpha Value|Alpha;beta|var(--chart-2)|-1|Beta Value|Beta;gamma|var(--chart-3)|1|Gamma Value|Gamma##filter-zero'
    );
    expect(serializeBarChartDefinition({ ...groupedView, filterZeroValues: false })).toBe(
      'currency#alpha|var(--chart-1)|1|One Bar|One;delta|var(--chart-2)|1|One Bar|One;beta|var(--chart-3)|1|Other Bar|Other#2,1#keep-zero'
    );
  });

  it('writes a pie view as key|colour|sign|label rows', () => {
    expect(serializePieChartDefinition(pie)).toBe(
      'alpha|var(--chart-1)|1|Alpha Slice;beta|var(--chart-2)|1|Beta Slice;delta|var(--chart-3)|-1|Delta Slice'
    );
  });
});
