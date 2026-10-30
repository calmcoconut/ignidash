'use client';

import { memo, useMemo } from 'react';
import { Area, ComposedChart, Line, Scatter, Tooltip, XAxis } from 'recharts';

import { formatCompactCurrency, formatCurrency } from '@/lib/utils/number-formatters';
import { useChartTheme } from '@/hooks/use-chart-theme';
import {
  toOverlayPlotPoints,
  type NetWorthOverlayChartMarker,
  type NetWorthOverlayChartRow,
} from '@/lib/utils/net-worth-overlay-chart-data';
import { ChartEmptyState, ChartGrid, TimeSeriesChartContainer, TimeSeriesYAxis, TooltipEntryRow } from '../chart-primitives';

/** The projection line reuses the foreground colour, like the other net-worth series. */
const PROJECTION_COLOR = 'var(--foreground)';
/** The tolerance band sits behind the line in the second palette slot, kept translucent. */
const BAND_COLOR = 'var(--chart-2)';
/** Actuals are solid so they read against the band in both themes. */
const ACTUAL_COLOR = 'var(--chart-4)';

const isMarkerPayload = (value: unknown): value is NetWorthOverlayChartMarker => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NetWorthOverlayChartMarker>;
  return typeof candidate.dateLabel === 'string' && typeof candidate.actualNetWorth === 'number' && typeof candidate.sign === 'string';
};

const isRowPayload = (value: unknown): value is NetWorthOverlayChartRow => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NetWorthOverlayChartRow>;
  return typeof candidate.date === 'string' && typeof candidate.bandWidth === 'number' && typeof candidate.projectedNetWorth === 'number';
};

const formatSignedCurrency = (amount: number): string => (amount > 0 ? `+${formatCurrency(amount)}` : formatCurrency(amount));

interface OverlayTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ readonly payload?: unknown }>;
}

/**
 * Two kinds of hover, because the chart draws two kinds of thing: a projection row (band and line)
 * and a recorded actual (a Scatter point, which carries its own datum). A marker wins when both are
 * present under the cursor, since the actual is what the reader is looking for.
 */
const OverlayTooltip = memo(({ active, payload }: OverlayTooltipProps) => {
  if (!active || !payload?.length) return null;

  const marker = payload.map((entry) => entry.payload).find(isMarkerPayload);
  if (marker) {
    return (
      <div className="text-foreground bg-background rounded-lg border p-2 shadow-md">
        <p className="mx-1 mb-2 text-sm font-semibold">{marker.dateLabel}</p>
        <div className="flex flex-col gap-1">
          <TooltipEntryRow dataKey="actualNetWorth" color={ACTUAL_COLOR} formattedValue={formatCurrency(marker.actualNetWorth)} />
          <TooltipEntryRow dataKey="projectedNetWorth" color={PROJECTION_COLOR} formattedValue={formatCurrency(marker.projectedNetWorth)} />
        </div>
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="mr-2">Deviation:</span>
          <span className="ml-1 font-semibold">{formatSignedCurrency(marker.deviation)}</span>
        </p>
      </div>
    );
  }

  const row = payload.map((entry) => entry.payload).find(isRowPayload);
  if (!row) return null;

  return (
    <div className="text-foreground bg-background rounded-lg border p-2 shadow-md">
      <p className="mx-1 mb-2 text-sm font-semibold">{row.date}</p>
      <div className="flex flex-col gap-1">
        <TooltipEntryRow dataKey="projectedNetWorth" color={PROJECTION_COLOR} formattedValue={formatCurrency(row.projectedNetWorth)} />
        <p className="text-muted-foreground mx-1 flex justify-between text-xs">
          <span className="mr-2">Band:</span>
          <span className="ml-1">{`${formatCompactCurrency(row.lower, 1)} – ${formatCompactCurrency(row.upper, 1)}`}</span>
        </p>
      </div>
    </div>
  );
});

OverlayTooltip.displayName = 'OverlayTooltip';

interface SingleSimulationNetWorthOverlayChartProps {
  /** Projection band and line rows, from `toOverlayChartData`. */
  rows: readonly NetWorthOverlayChartRow[];
  /** Journal actuals, from `toOverlayChartData`; ages are interpolated and may be fractional. */
  markers: readonly NetWorthOverlayChartMarker[];
}

/**
 * Net-worth actual-vs-projected overlay.
 *
 * AXIS: `type="number"` on purpose. Actuals sit at interpolated ages (40.75, not 41), and the
 * categorical `<XAxis dataKey="age">` the other charts use would silently fail to place them —
 * no error, no dots.
 *
 * DATA: one array, built by `toOverlayPlotPoints`, holding the band rows and the actuals together.
 * Giving the Scatter its own `data` prop would make Recharts derive the axis domain and the
 * tooltip ticks from the actuals alone, clipping the projection to the journal's span; one array
 * keeps the domain on the whole projection and the tooltip indexes aligned. On the plot, points
 * without a recorded actual simply have no marker.
 *
 * Marks, back to front: the ±band as two stacked areas (an invisible `lower` base plus the filled
 * `bandWidth` on top, so the band stays correct even below zero), the projection as a line through
 * it, and the actuals as Scatter points. Not ReferenceDot: those do not produce tooltip entries.
 */
export default function SingleSimulationNetWorthOverlayChart({ rows, markers }: SingleSimulationNetWorthOverlayChartProps) {
  const { foregroundColor, foregroundMutedColor, backgroundColor } = useChartTheme();
  const plotPoints = useMemo(() => toOverlayPlotPoints(rows, markers), [rows, markers]);

  if (rows.length === 0) {
    return <ChartEmptyState message="No projection to compare against." />;
  }

  return (
    <TimeSeriesChartContainer>
      <ComposedChart
        responsive
        width="100%"
        height="100%"
        data={plotPoints}
        className="text-xs"
        margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
        tabIndex={-1}
      >
        <ChartGrid />
        <XAxis
          dataKey="age"
          type="number"
          domain={['dataMin', 'dataMax']}
          allowDecimals={false}
          tick={{ fill: foregroundMutedColor }}
          axisLine={false}
          tickLine={false}
        />
        <TimeSeriesYAxis formatter={(value: number) => formatCompactCurrency(value, 1)} />
        <Area type="monotone" dataKey="lower" stackId="band" stroke="none" fill="none" activeDot={false} />
        <Area type="monotone" dataKey="bandWidth" stackId="band" stroke="none" fill={BAND_COLOR} fillOpacity={0.18} activeDot={false} />
        <Line
          type="monotone"
          dataKey="projectedNetWorth"
          stroke={PROJECTION_COLOR}
          strokeWidth={2}
          dot={false}
          activeDot={{ stroke: backgroundColor, strokeWidth: 2 }}
        />
        <Scatter dataKey="actualNetWorth" fill={ACTUAL_COLOR} stroke={backgroundColor} strokeWidth={1.5} />
        <Tooltip content={<OverlayTooltip />} cursor={{ stroke: foregroundColor }} />
      </ComposedChart>
    </TimeSeriesChartContainer>
  );
}
