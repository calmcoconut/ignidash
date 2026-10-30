'use client';

import { useMemo } from 'react';

import type { MetricDataPoint } from '@/lib/charts/plot-types';
import { getMetric } from '@/lib/charts/metric-registry';
import { resolveMetricTableColumns, resolveMetricTableRows, type MetricTableRow } from '@/lib/charts/metric-table';

import { ChartEmptyState } from '../charts/chart-primitives';
import Table from './table';

interface MetricTableProps {
  /** Registry id of the metric to tabulate (e.g. `'cashFlow.cashFlow'`). */
  metricId: string;
  /** That metric's chart data points, already sliced to the window the chart shows. */
  points: readonly MetricDataPoint[];
  /** CSV filename for the existing table's export button. */
  exportFilename?: string;
}

/**
 * Renders a registry metric as a table through the existing `Table` component (P4-P2).
 *
 * The metric supplies the columns, labels and formatters; this component only maps the
 * registry's table definition onto props `Table` already understands, so there is a
 * single table implementation and a single formatter stack.
 */
export default function MetricTable({ metricId, points, exportFilename }: MetricTableProps) {
  const metric = getMetric(metricId);

  const columns = useMemo(() => (metric ? resolveMetricTableColumns(metric) : []), [metric]);
  const rows = useMemo(() => (metric ? resolveMetricTableRows(metric, points) : []), [metric, points]);

  if (!metric || rows.length === 0) {
    return <ChartEmptyState message="No data available for this metric." />;
  }

  return (
    <Table<MetricTableRow>
      columns={columns}
      data={rows}
      keyField="age"
      exportFilename={exportFilename ?? `${metric.id.replace('.', '-')}-table.csv`}
      // `Table`'s root is its own `Card` (border + shadow), which is right at section level
      // and wrong here: this table sits inside `ChartCard`'s Card. Cancel the table's own
      // chrome so it reads flush, including the `sm:border` variant, without changing
      // `table.tsx`'s defaults for its existing callers.
      className="mx-0 my-0 border-0 shadow-none sm:border-0"
    />
  );
}
