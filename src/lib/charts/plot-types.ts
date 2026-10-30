/**
 * Plot types and renderer adapters for the declarative metric registry.
 *
 * A `MetricDefinition` describes one metric: which series it renders, in which chart
 * kinds, and how each series is plotted. Nothing here renders anything. The adapters
 * map resolved series onto the *existing* Recharts primitives (`LineSeries`,
 * `BarSeries`, `AreaSeries`, pie `Cell`s), so every chart shell keeps its own
 * semantics — line/area/bar/pie are deliberately not unified.
 */

/** A chart surface a metric can be rendered in. */
export type ChartKind = 'line' | 'area' | 'bar' | 'pie';

/** How a single series is drawn inside its chart. */
export type PlotKind = 'line' | 'area' | 'bar' | 'slice';

/** How a metric's values are formatted for display. */
export type MetricValueFormat = 'currency' | 'percent';

/** Chart categories. Mirrors the persisted `dataViews` record. */
export type MetricCategory = 'netWorth' | 'cashFlow' | 'taxes' | 'returns' | 'contributions' | 'withdrawals';

/** Minimal shape every metric data point must satisfy. */
export type MetricDataPoint = { readonly age: number };

/** Reads a numeric field from a metric data point, falling back to 0 when absent. */
export function metricValue(point: MetricDataPoint, key: string): number {
  const value = (point as unknown as Record<string, unknown>)[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * One declarative series inside a metric.
 *
 * `key` is the field name read from the chart data point (and the Recharts `dataKey`,
 * so tooltips keep working). `chartKinds` lists the chart surfaces that include this
 * series — the same metric can describe a different series set for the line chart and
 * the single-age bar chart, which is exactly what the existing charts do.
 */
export interface MetricSeriesDefinition {
  readonly key: string;
  readonly label: string;
  /** Short label used on cramped (mobile) axes. Falls back to `label`. */
  readonly shortLabel?: string;
  /** CSS colour token, e.g. `var(--chart-1)`. */
  readonly color: string;
  readonly chartKinds: readonly ChartKind[];
  /** How the series is drawn. Defaults to the plot implied by the chart kind. */
  readonly plot?: PlotKind;
  /** Display sign transform. Outflows are declared with `-1` so they render below zero. */
  readonly sign?: 1 | -1;
  /** Stack group; series sharing a stack id stack together. */
  readonly stackId?: string;
  /**
   * Pure derivation for a series that is not a plain numeric field on the data point.
   * Only metrics whose series are explicitly derived use this (see `realNetWorth`).
   */
  readonly derive?: (point: MetricDataPoint, index: number) => number;
}

/** A column of a metric's table equivalent (rendered by a later item, P4-P2). */
export interface MetricTableColumn {
  readonly key: string;
  readonly label: string;
  readonly format?: MetricValueFormat | 'number';
}

export interface MetricTableSpec {
  readonly columns: readonly MetricTableColumn[];
}

/**
 * Slot for event annotations (P4-P3). Declared so a metric can reserve one, never
 * populated by this item: the annotation extractor owns the semantics.
 */
export interface MetricAnnotationSlot {
  readonly kind: 'referenceLine' | 'referenceDot';
  readonly label: string;
}

/** A complete declarative metric. */
export interface MetricDefinition {
  readonly id: string;
  readonly category: MetricCategory;
  readonly chartKinds: readonly ChartKind[];
  readonly series: readonly MetricSeriesDefinition[];
  readonly table: MetricTableSpec;
  readonly annotations?: readonly MetricAnnotationSlot[];
  /** Recharts `stackOffset` for the metric's chart. Only `sign` is used today. */
  readonly stackOffset?: 'sign';
  readonly format?: MetricValueFormat;
}

/** A series resolved for one chart kind: metadata only, no data. */
export interface ResolvedSeries {
  readonly key: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly color: string;
  readonly plot: PlotKind;
  readonly sign: 1 | -1;
  readonly stackId: string | undefined;
  readonly derive: MetricSeriesDefinition['derive'] | undefined;
}

/** Default plot for a chart kind when a series does not override it. */
export const DEFAULT_PLOT_FOR_CHART_KIND: Record<ChartKind, PlotKind> = {
  line: 'line',
  area: 'area',
  bar: 'bar',
  pie: 'slice',
};

/**
 * Resolves a metric's series for one chart kind. Pure: same input, same output, and no
 * dependence on data, time or module state.
 *
 * @param definition - The metric definition to resolve
 * @param chartKind - The chart surface being rendered
 * @returns The series belonging to that chart kind, in declaration order
 */
export function resolveSeries(definition: MetricDefinition, chartKind: ChartKind): ResolvedSeries[] {
  if (!definition.chartKinds.includes(chartKind)) return [];

  return definition.series
    .filter((series) => series.chartKinds.includes(chartKind))
    .map((series) => ({
      key: series.key,
      label: series.label,
      shortLabel: series.shortLabel ?? series.label,
      color: series.color,
      plot: series.plot ?? DEFAULT_PLOT_FOR_CHART_KIND[chartKind],
      sign: series.sign ?? 1,
      stackId: series.stackId,
      derive: series.derive,
    }));
}

/** Reads one series value out of a data point, applying the series sign. */
export function seriesValue(point: MetricDataPoint, series: ResolvedSeries, index: number): number {
  const raw = series.derive ? series.derive(point, index) : metricValue(point, series.key);
  return Number.isFinite(raw) ? raw * series.sign : 0;
}

/** Reads a series across all data points, applying the series sign. */
export function seriesValues(points: readonly MetricDataPoint[], series: ResolvedSeries): number[] {
  return points.map((point, index) => seriesValue(point, series, index));
}

/**
 * Returns copies of the data points with signed series values written back under their
 * own keys, matching what the existing charts do inline (e.g. `expenses: -expenses`).
 * Keys that no resolved series mentions are preserved untouched.
 */
export function applySeriesSigns<T extends MetricDataPoint>(points: readonly T[], series: readonly ResolvedSeries[]): T[] {
  const signed = new Map<string, 1 | -1>();
  for (const entry of series) {
    if (entry.sign === -1) signed.set(entry.key, -1);
    else if (!signed.has(entry.key)) signed.set(entry.key, 1);
  }

  if (![...signed.values()].includes(-1)) return points.slice();

  return points.map((point) => {
    const next = { ...point } as unknown as Record<string, unknown>;
    for (const [key, sign] of signed) {
      if (sign !== -1) continue;
      const value = Number(next[key]);
      if (Number.isFinite(value)) next[key] = -value;
    }
    return next as T;
  });
}

// ================================
// RENDERER ADAPTERS
// ================================

/** Props accepted by the shared `LineSeries` primitive. */
export interface LineSeriesProps {
  dataKeys: string[];
  strokeColors: string[];
}

/** Props accepted by the shared `BarSeries` primitive. */
export interface BarSeriesProps {
  dataKeys: string[];
  barColors: string[];
  stackId: string | undefined;
}

/** Props accepted by the shared `AreaSeries` primitive. */
export interface AreaSeriesProps {
  dataKeys: string[];
  areaColors: string[];
  stackId: string | undefined;
}

/** One pie slice (rendered through a Recharts `Cell`). */
export interface PieSliceProps {
  dataKey: string;
  name: string;
  color: string;
}

/** Line renderer adapter: a composed line chart's line series. */
export function toLineSeriesProps(series: readonly ResolvedSeries[]): LineSeriesProps {
  const lines = series.filter((entry) => entry.plot === 'line');
  return { dataKeys: lines.map((entry) => entry.key), strokeColors: lines.map((entry) => entry.color) };
}

/** Bar renderer adapter: stacked bar series sharing the resolved stack id. */
export function toBarSeriesProps(series: readonly ResolvedSeries[]): BarSeriesProps {
  const bars = series.filter((entry) => entry.plot === 'bar');
  return { dataKeys: bars.map((entry) => entry.key), barColors: bars.map((entry) => entry.color), stackId: bars[0]?.stackId };
}

/** Area renderer adapter: stacked area series sharing the resolved stack id. */
export function toAreaSeriesProps(series: readonly ResolvedSeries[]): AreaSeriesProps {
  const areas = series.filter((entry) => entry.plot === 'area');
  return { dataKeys: areas.map((entry) => entry.key), areaColors: areas.map((entry) => entry.color), stackId: areas[0]?.stackId };
}

/** Pie renderer adapter: one slice per resolved series. */
export function toPieSlices(series: readonly ResolvedSeries[]): PieSliceProps[] {
  return series.filter((entry) => entry.plot === 'slice').map((entry) => ({ dataKey: entry.key, name: entry.label, color: entry.color }));
}

// ================================
// CATEGORICAL (SINGLE-AGE) BAR AND PIE ADAPTERS
// ================================

/**
 * One bar/pie series: the field it reads, its colour, and the two labels the old single-age
 * charts used (a desktop label and a short one for narrow screens).
 */
export interface ChartSeriesSpec {
  readonly key: string;
  readonly color: string;
  readonly label: string;
  readonly shortLabel?: string;
  /** Display sign: an outflow drawn as a negative bar declares `-1`. */
  readonly sign?: 1 | -1;
}

/**
 * A single-age bar chart view: the bars it draws, how their segments group, whether zero-height
 * bars are dropped, and the axis formatter.
 */
export interface BarChartDefinition {
  readonly series: readonly ChartSeriesSpec[];
  /**
   * Group sizes, one bar per group in order. A group of two or more becomes one stacked bar
   * (that is how the taxes chart draws a single "Taxable Income" bar out of two segments);
   * omitted means one bar per series.
   */
  readonly segments?: readonly number[];
  /** `false` for the views that deliberately keep zero-height bars (the old switch's flag). */
  readonly filterZeroValues?: boolean;
  readonly format?: MetricValueFormat;
}

/** A pie view: one slice per series. */
export interface PieChartDefinition {
  readonly series: readonly ChartSeriesSpec[];
}

export interface BarChartSegment {
  amount: number;
  color: string;
}

export interface CategoricalBar {
  name: string;
  segments: BarChartSegment[];
}

export interface BarChartDatum {
  name: string;
  amount: number;
  color: string;
}

export interface PieChartDatum {
  name: string;
  value: number;
  color: string;
}

/**
 * Splits a definition's series into bar groups.
 *
 * @param definition - The bar chart definition
 * @returns One array of series per bar, in drawing order
 */
function groupBarSeries(definition: BarChartDefinition): ChartSeriesSpec[][] {
  if (!definition.segments) return definition.series.map((series) => [series]);

  const groups: ChartSeriesSpec[][] = [];
  let index = 0;

  for (const size of definition.segments) {
    groups.push(definition.series.slice(index, index + size));
    index += size;
  }

  return groups;
}

/**
 * Reads a series value out of the selected row, applying the declared sign.
 *
 * @param point - The single-age chart data point
 * @param series - The series to read
 * @returns The signed amount (0 when the field is missing)
 */
function readChartSeriesValue(point: MetricDataPoint, series: ChartSeriesSpec): number {
  const raw = Number((point as unknown as Record<string, unknown>)[series.key]);
  return Number.isFinite(raw) ? raw * (series.sign ?? 1) : 0;
}

/**
 * Bar renderer adapter for the single-age charts: groups the definition's series into bars,
 * naming each from its first series' label (short label on narrow screens).
 *
 * @param point - The chart data point for the selected age
 * @param definition - The bar view definition
 * @param options - Screen class, which picks the short labels
 * @returns One categorical bar per group
 */
export function toCategoricalBars(
  point: MetricDataPoint,
  definition: BarChartDefinition,
  options: { isSmallScreen: boolean }
): CategoricalBar[] {
  const bars = groupBarSeries(definition).map((group) => {
    const [first] = group;

    return {
      name: options.isSmallScreen ? (first.shortLabel ?? first.label) : first.label,
      segments: group.map((series) => ({ amount: readChartSeriesValue(point, series), color: series.color })),
    };
  });

  return filterCategoricalBars(bars, definition);
}

/**
 * Drops bars whose segments are all zero, unless the view asked to keep them (the old
 * charts' per-view `filterZeroValues` flag).
 *
 * @param bars - Bars in drawing order
 * @param definition - The view definition that carries the flag
 * @returns The bars to render
 */
export function filterCategoricalBars(bars: readonly CategoricalBar[], definition: BarChartDefinition): CategoricalBar[] {
  if (definition.filterZeroValues === false) return [...bars];
  return bars.filter((bar) => bar.segments.some((segment) => segment.amount !== 0));
}

/**
 * Flattens a bar view to the one-segment-per-bar shape most single-age charts render.
 *
 * @param point - The chart data point for the selected age
 * @param definition - The bar view definition
 * @param options - Screen class, which picks the short labels
 * @returns `{ name, amount, color }` rows in declaration order
 */
export function toBarChartData(
  point: MetricDataPoint,
  definition: BarChartDefinition,
  options: { isSmallScreen: boolean }
): BarChartDatum[] {
  return toCategoricalBars(point, definition, options).flatMap((bar) =>
    bar.segments.map((segment) => ({ name: bar.name, amount: segment.amount, color: segment.color }))
  );
}

/**
 * Pie renderer adapter: one slice per series, named by its label and sized by its signed value.
 *
 * @param point - The chart data point for the selected age
 * @param definition - The pie view definition
 * @returns Slice rows for the pie chart and its legend
 */
export function toPieChartData(point: MetricDataPoint, definition: PieChartDefinition): PieChartDatum[] {
  return definition.series.map((series) => ({
    name: series.label,
    value: readChartSeriesValue(point, series),
    color: series.color,
  }));
}

/** Stable text form of a bar view, so a test can freeze every key, colour, sign and label. */
export function serializeBarChartDefinition(definition: BarChartDefinition): string {
  const series = definition.series
    .map((entry) => `${entry.key}|${entry.color}|${entry.sign ?? 1}|${entry.label}|${entry.shortLabel ?? entry.label}`)
    .join(';');

  return `${definition.format ?? 'currency'}#${series}#${(definition.segments ?? []).join(',')}#${
    definition.filterZeroValues === false ? 'keep-zero' : 'filter-zero'
  }`;
}

/** Stable text form of a pie view, so a test can freeze every key, colour, sign and label. */
export function serializePieChartDefinition(definition: PieChartDefinition): string {
  return definition.series.map((entry) => `${entry.key}|${entry.color}|${entry.sign ?? 1}|${entry.label}`).join(';');
}
