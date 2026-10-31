// @vitest-environment jsdom
/**
 * The net-worth overlay chart (P4-P7).
 *
 * The invariant this file pins is the one that is invisible until it breaks: the band, the
 * projection line and the actuals all come from ONE array handed to `<ComposedChart data>`, and
 * the `<Scatter>` carries no `data` of its own. Recharts derives the axis domain and the tooltip
 * ticks from any graphical item carrying `data`, so a second dataset would silently clip the band
 * to the journal's span. Recharts itself is stubbed here — the props that reach it are the
 * component's output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { NetWorthOverlayChartMarker, NetWorthOverlayChartRow } from '@/lib/utils/net-worth-overlay-chart-data';
import { toOverlayPlotPoints } from '@/lib/utils/net-worth-overlay-chart-data';

interface CapturedElement {
  name: string;
  props: Record<string, unknown>;
}

const { captured } = vi.hoisted(() => ({ captured: [] as CapturedElement[] }));

vi.mock('recharts', () => {
  const stub = (name: string) => {
    // Recharts primitives are children of `<ComposedChart>`, so the stub renders them on; each
    // one records the props it was given.
    const Component = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
      captured.push({ name, props });
      return children ?? null;
    };
    Component.displayName = name;
    return Component;
  };

  return {
    CartesianGrid: stub('CartesianGrid'),
    XAxis: stub('XAxis'),
    YAxis: stub('YAxis'),
    ReferenceLine: stub('ReferenceLine'),
    ReferenceDot: stub('ReferenceDot'),
    Line: stub('Line'),
    Bar: stub('Bar'),
    Area: stub('Area'),
    Cell: stub('Cell'),
    ComposedChart: stub('ComposedChart'),
    Scatter: stub('Scatter'),
    Tooltip: stub('Tooltip'),
  };
});

// The y-axis reads the viewport; jsdom has no layout, and the breakpoint is not what is under test.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import SingleSimulationNetWorthOverlayChart from './single-simulation-net-worth-overlay-chart';

const rows: NetWorthOverlayChartRow[] = [
  { age: 40, date: '2025-12-31', lower: 90_000, bandWidth: 20_000, upper: 110_000, projectedNetWorth: 100_000 },
  { age: 41, date: '2026-12-31', lower: 180_000, bandWidth: 40_000, upper: 220_000, projectedNetWorth: 200_000 },
  { age: 42, date: '2027-12-31', lower: 270_000, bandWidth: 60_000, upper: 330_000, projectedNetWorth: 300_000 },
];

const markers: NetWorthOverlayChartMarker[] = [
  {
    entryId: 'mid',
    age: 40.5,
    dateLabel: '2026-06',
    actualNetWorth: 160_000,
    projectedNetWorth: 150_000,
    deviation: 10_000,
    sign: 'ahead',
  },
  {
    entryId: 'on-row',
    age: 42,
    dateLabel: '2027',
    actualNetWorth: 290_000,
    projectedNetWorth: 300_000,
    deviation: -10_000,
    sign: 'behind',
  },
];

const propsOf = (name: string) => captured.filter((element) => element.name === name).map((element) => element.props);

const renderChart = () => render(<SingleSimulationNetWorthOverlayChart rows={rows} markers={markers} />);

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the single dataset the band is drawn from', () => {
  it('hands the composed chart exactly the merged plot points', () => {
    renderChart();

    const [chart] = propsOf('ComposedChart');
    expect(chart.data).toStrictEqual(toOverlayPlotPoints(rows, markers));
    // Three projection rows plus the one actual that falls between them; the actual on a row
    // merges into that row instead of adding a duplicate x value.
    expect(chart.data).toHaveLength(rows.length + 1);
  });

  it('gives the scatter no data of its own, so it inherits the merged array', () => {
    renderChart();

    const [scatter] = propsOf('Scatter');
    expect(scatter).not.toHaveProperty('data');
    expect(scatter.dataKey).toBe('actualNetWorth');
  });

  it('draws the band as two stacked areas whose heights add back up to the upper bound', () => {
    renderChart();

    const areas = propsOf('Area');
    expect(areas.map((area) => area.dataKey)).toStrictEqual(['lower', 'bandWidth']);
    expect(areas.map((area) => area.stackId)).toStrictEqual(['band', 'band']);

    const data = propsOf('ComposedChart')[0].data as Array<NetWorthOverlayChartRow>;
    for (const point of data) {
      expect(point.lower + point.bandWidth).toBeCloseTo(point.upper, 6);
    }
  });

  it('draws the projection line and the actuals from that same array', () => {
    renderChart();

    expect(propsOf('Line')[0]).toMatchObject({ dataKey: 'projectedNetWorth' });
    // The numeric x-axis is what lets a fractional age (40.5) be placed at all.
    expect(propsOf('XAxis')[0]).toMatchObject({ dataKey: 'age', type: 'number' });

    const data = propsOf('ComposedChart')[0].data as Array<{ age: number; actualNetWorth?: number }>;
    expect(data.map((point) => point.age)).toEqual([40, 40.5, 41, 42]);
    expect(data.filter((point) => point.actualNetWorth !== undefined).map((point) => point.age)).toEqual([40.5, 42]);
  });
});

describe('without a projection', () => {
  it('says there is nothing to compare against instead of drawing an empty chart', () => {
    render(<SingleSimulationNetWorthOverlayChart rows={[]} markers={markers} />);

    expect(screen.getByText('No projection to compare against.')).toBeTruthy();
    expect(captured).toHaveLength(0);
  });
});
