/**
 * Table accessors for registry metrics (P4-P2).
 *
 * The registry's `table` field declares which columns a metric exposes. This module turns
 * that metadata plus a metric's chart data points into rows and columns for the existing
 * `outputs/tables/table.tsx` component: no second table implementation and no second
 * formatter stack — `formatCurrency` / `formatPercentage` are the same ones the
 * simulation data tables use.
 *
 * Two deliberate conventions:
 *
 * 1. Cells carry the underlying quantity, NOT the chart's plot sign. An outflow that the
 *    chart stacks below zero (declared with `sign: -1`) reads as a positive magnitude here,
 *    exactly as the simulation data table on the same page shows it. The chart's downward
 *    bar and negative tooltip value are a plotting convention, not a different number. A
 *    value that is genuinely negative in the data (e.g. `netCashFlow`) stays negative.
 * 2. A missing value stays `null` so the cell renders as an em dash instead of a
 *    misleading zero (e.g. `savingsRate` is null when there is no income to save from).
 *
 * The accessors are pure and read the points without touching them, so switching a card
 * to its table view cannot mutate or reorder the series the chart renders.
 */

import { formatCurrency, formatPercentage } from '@/lib/utils/number-formatters';

import type { MetricDataPoint, MetricDefinition, MetricTableColumn } from './plot-types';

/** Rendered placeholder for a column with no value in that year. */
export const EMPTY_METRIC_TABLE_CELL = '–';

/** One table row: the row key (`age`) plus one cell per declared column. */
export type MetricTableRow = { age: number } & Record<string, number | null>;

/**
 * A cell as the accessor hands it to a formatter: a number, or absent. `undefined` is part
 * of the type because a row can lack a key entirely (e.g. a data point without the field),
 * and the formatter must render that as an em dash rather than `NaN`.
 */
export type MetricTableCell = number | null | undefined;

/** Column shape produced here. Assignable to `TableColumn<MetricTableRow>`. */
export interface MetricTableColumnDefinition {
  key: keyof MetricTableRow;
  title: string;
  format: (value: MetricTableCell) => string;
}

/**
 * Formats one cell of a registry metric's table.
 *
 * @param value - Raw cell value, or null/undefined when the year has no value
 * @param format - The column's declared format (defaults to currency)
 * @returns Display string; never throws
 */
export function formatMetricTableValue(value: MetricTableCell, format: MetricTableColumn['format']): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_METRIC_TABLE_CELL;

  switch (format) {
    case 'percent':
      return formatPercentage(value);
    case 'number':
      return String(value);
    case 'currency':
    default:
      return formatCurrency(value);
  }
}

/**
 * Reads a raw cell value from a data point.
 *
 * `null` / `undefined` / non-numeric values become `null` (rendered as an em dash) rather
 * than `0`, which would claim the year had a real zero.
 */
function readCell(point: MetricDataPoint, key: string): number | null {
  // SAFETY: MetricDataPoint only guarantees `age`; the registry's table columns name the
  // runtime fields of the specific chart data point a metric is rendered from, so the
  // index read is valid whenever the registry and the extractor agree (asserted in tests).
  const value = (point as unknown as Record<string, unknown>)[key];
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Finds the pure derivation a metric declares for a column key, if any. */
function deriveFor(metric: MetricDefinition, key: string): ((point: MetricDataPoint, index: number) => number) | undefined {
  return metric.series.find((series) => series.key === key)?.derive;
}

/**
 * The columns of a metric's table, as the existing table component expects them.
 *
 * The first column is always the row key (`age`), even if a metric forgets to declare it,
 * because `table.tsx` needs a unique key field.
 *
 * @param metric - A registry metric
 * @returns TableColumn definitions with the metric's labels and formatters
 */
export function resolveMetricTableColumns(metric: MetricDefinition): MetricTableColumnDefinition[] {
  const declared = metric.table.columns.filter((column) => column.key !== 'age');
  const columns: MetricTableColumn[] = [{ key: 'age', label: 'Age', format: 'number' }, ...declared];

  return columns.map((column) => ({
    key: column.key,
    title: column.label,
    format: (value: MetricTableCell) => formatMetricTableValue(value, column.format),
  }));
}

/**
 * Builds the table rows for a metric from its chart data points, in the order given.
 *
 * @param metric - A registry metric
 * @param points - Chart data points for that metric (already sliced to the visible window)
 * @returns One row per point, plus an empty array when there are no points
 */
export function resolveMetricTableRows(metric: MetricDefinition, points: readonly MetricDataPoint[]): MetricTableRow[] {
  const valuesKeys = metric.table.columns.map((column) => column.key).filter((key) => key !== 'age');

  return points.map((point, index) => {
    const row: MetricTableRow = { age: point.age };

    for (const key of valuesKeys) {
      const derive = deriveFor(metric, key);
      const value = derive ? derive(point, index) : readCell(point, key);
      row[key] = value != null && Number.isFinite(value) ? value : null;
    }

    return row;
  });
}
