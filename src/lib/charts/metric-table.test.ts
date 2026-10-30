import { describe, it, expect } from 'vitest';

import {
  EMPTY_METRIC_TABLE_CELL,
  formatMetricTableValue,
  resolveMetricTableColumns,
  resolveMetricTableRows,
  type MetricTableRow,
} from './metric-table';
import { METRIC_DEFINITIONS, REAL_NET_WORTH_METRIC_ID, getMetric } from './metric-registry';
import { applySeriesSigns, resolveSeries, seriesValue } from './plot-types';
import type { MetricDataPoint, MetricDefinition } from './plot-types';
import { ChartDataExtractor } from '@/lib/calc/data-extractors/chart-data-extractor';
import { FinancialSimulationEngine } from '@/lib/calc/simulation-engine';
import { FixedReturnsProvider } from '@/lib/calc/returns-providers/fixed-returns-provider';
import {
  TEST_CLOCK,
  createContributionRule,
  createDebtInput,
  createFinancedAssetInput,
  createLivingExpense,
  createSavingsAccount,
  createSimulatorInputs,
  createWageIncome,
} from '@/lib/calc/__tests__/test-utils';

/**
 * Builds a metric data point from arbitrary fields. `MetricDataPoint` only guarantees
 * `age`; the registry's table columns name the rest of the runtime fields.
 */
const buildPoint = (fields: Record<string, number | null>): MetricDataPoint => ({ age: Number(fields.age), ...fields });

/** A synthetic data point carrying a distinct value for every column of a metric. */
const buildPointForMetric = (metric: MetricDefinition, index: number): MetricDataPoint => {
  const fields: Record<string, number | null> = { age: 40 + index };
  for (const column of metric.table.columns) {
    fields[column.key] = column.key === 'age' ? 40 + index : (index + 1) * (column.key.length * 100);
  }
  return buildPoint(fields);
};

const columnsExceptAge = (metric: MetricDefinition) => metric.table.columns.filter((column) => column.key !== 'age');

describe('metric table accessors', () => {
  it('gives every registry metric a non-empty column list led by the row key', () => {
    expect(METRIC_DEFINITIONS.length).toBeGreaterThan(0);

    for (const metric of METRIC_DEFINITIONS) {
      expect(metric.table.columns.length, metric.id).toBeGreaterThan(0);

      const columns = resolveMetricTableColumns(metric);
      expect(columns.length, metric.id).toBe(columnsExceptAge(metric).length + 1);
      expect(columns[0].key, metric.id).toBe('age');
      expect(
        columns.map((column) => column.key),
        metric.id
      ).toEqual(['age', ...columnsExceptAge(metric).map((column) => column.key)]);

      for (const column of columns) {
        expect(column.title.length, `${metric.id}.${String(column.key)}`).toBeGreaterThan(0);
        expect(typeof column.format).toBe('function');
      }
    }
  });

  it('gives every column a formatter that always returns a string', () => {
    for (const metric of METRIC_DEFINITIONS) {
      for (const column of resolveMetricTableColumns(metric)) {
        const label = `${metric.id}.${String(column.key)}`;

        expect(column.format(1234), label).toBeTypeOf('string');
        expect(column.format(1234).length, label).toBeGreaterThan(0);
        expect(column.format(null), label).toBe(EMPTY_METRIC_TABLE_CELL);
        expect(column.format(undefined), label).toBe(EMPTY_METRIC_TABLE_CELL);
        expect(column.format(Number.NaN), label).toBe(EMPTY_METRIC_TABLE_CELL);
      }
    }
  });

  it('only declares columns that the metric actually renders, so no cell is silently blank', () => {
    // A column key with no matching series would fall through to a null cell. Tying the
    // table to the series keys keeps the registry's two views of the same data in step.
    for (const metric of METRIC_DEFINITIONS) {
      const seriesKeys = new Set(metric.series.map((series) => series.key));

      for (const column of columnsExceptAge(metric)) {
        expect(seriesKeys.has(column.key), `${metric.id}.${column.key} is not a declared series`).toBe(true);
      }
    }
  });

  it('formats by the declared column format', () => {
    expect(formatMetricTableValue(1234, 'currency')).toBe('$1,234');
    expect(formatMetricTableValue(1234, 'number')).toBe('1234');
    expect(formatMetricTableValue(0.5, 'percent')).toBe('50.0%');
    expect(formatMetricTableValue(1234, undefined)).toBe('$1,234');
  });
});

describe('metric table rows', () => {
  it('produces one row per point, in the order given, keyed by age', () => {
    for (const metric of METRIC_DEFINITIONS) {
      const points = [buildPointForMetric(metric, 0), buildPointForMetric(metric, 1), buildPointForMetric(metric, 2)];
      const rows = resolveMetricTableRows(metric, points);

      expect(rows, metric.id).toHaveLength(points.length);
      expect(
        rows.map((row) => row.age),
        metric.id
      ).toEqual(points.map((point) => point.age));
      // The order is the caller's, never re-sorted.
      expect(
        rows.map((row) => row.age),
        metric.id
      ).toEqual([40, 41, 42]);
    }
  });

  it('reads plain series values straight off the data point', () => {
    for (const metric of METRIC_DEFINITIONS) {
      const points = [buildPointForMetric(metric, 0), buildPointForMetric(metric, 1)];
      const rows = resolveMetricTableRows(metric, points);

      for (const [index, row] of rows.entries()) {
        for (const column of columnsExceptAge(metric)) {
          // Derived columns are covered separately below.
          if (metric.series.find((series) => series.key === column.key)?.derive) continue;

          const expected = (index + 1) * (column.key.length * 100);
          expect(row[column.key], `${metric.id}.${column.key}`).toBe(expected);
        }
      }
    }
  });

  it('derives the realNetWorth canary column instead of reading it off the point', () => {
    const metric = getMetric(REAL_NET_WORTH_METRIC_ID);
    if (!metric) throw new Error('missing canary metric');

    const rows = resolveMetricTableRows(metric, [
      buildPoint({ age: 40, netWorth: 100_000, cumulativeInflationFactor: 1 }),
      buildPoint({ age: 41, netWorth: 110_000, cumulativeInflationFactor: 1.1 }),
    ]);

    expect(rows[0].realNetWorth).toBeCloseTo(100_000, 6);
    expect(rows[1].realNetWorth).toBeCloseTo(100_000, 6);
  });

  it('keeps missing values null so the cell renders as an em dash, not a zero', () => {
    const metric = getMetric('cashFlow.savingsRate');
    if (!metric) throw new Error('missing savings-rate metric');

    const rows = resolveMetricTableRows(metric, [buildPoint({ age: 40, savingsRate: null }), buildPoint({ age: 41, savingsRate: 0.2 })]);

    expect(rows[0].savingsRate).toBeNull();
    expect(rows[1].savingsRate).toBeCloseTo(0.2, 6);

    const savingsColumn = resolveMetricTableColumns(metric).find((column) => column.key === 'savingsRate');
    if (!savingsColumn) throw new Error('missing savings-rate column');
    expect(savingsColumn.format(rows[0].savingsRate)).toBe(EMPTY_METRIC_TABLE_CELL);
    expect(savingsColumn.format(rows[1].savingsRate)).toBe('20.0%');
  });

  it('returns no rows for no points, which is the component empty state', () => {
    for (const metric of METRIC_DEFINITIONS) {
      expect(resolveMetricTableRows(metric, []), metric.id).toEqual([]);
      // The columns still resolve, so the empty state is a data condition, not a crash.
      expect(resolveMetricTableColumns(metric).length, metric.id).toBeGreaterThan(0);
    }
  });

  it('shows quantities, not the chart plot sign, for outflows', () => {
    // The chart stacks expenses below zero (sign: -1) and its tooltip shows the signed
    // value; the table shows the magnitude, matching the simulation data table.
    const metric = getMetric('cashFlow.cashFlow');
    if (!metric) throw new Error('missing cash-flow metric');

    const point = buildPoint({ age: 40, expenses: 60_000, netCashFlow: -500, income: 100_000 });
    const rows = resolveMetricTableRows(metric, [point]);

    expect(rows[0].expenses).toBe(60_000);

    const expensesSeries = resolveSeries(metric, 'line').find((series) => series.key === 'expenses');
    if (!expensesSeries) throw new Error('missing expenses series');
    expect(seriesValue(point, expensesSeries, 0)).toBe(-60_000);

    // A value that is genuinely negative in the data stays negative.
    expect(rows[0].netCashFlow).toBe(-500);
  });
});

describe('metric table purity', () => {
  it('does not mutate the chart data points it reads', () => {
    for (const metric of METRIC_DEFINITIONS) {
      const points = [buildPointForMetric(metric, 0), buildPointForMetric(metric, 1)];
      const snapshot = structuredClone(points);

      const rows = resolveMetricTableRows(metric, points);
      rows[0].age = -1;
      rows[0][columnsExceptAge(metric)[0].key] = -999;

      expect(points, metric.id).toEqual(snapshot);
      expect(resolveMetricTableRows(metric, points), metric.id).toEqual(resolveMetricTableRows(metric, points));
    }
  });

  it('leaves the chart series order and colours untouched', () => {
    for (const metric of METRIC_DEFINITIONS) {
      const before = resolveSeries(metric, 'line').map((series) => `${series.key}:${series.color}:${series.sign}`);
      const signedBefore = applySeriesSigns([buildPointForMetric(metric, 0)], resolveSeries(metric, 'line'));

      const rows = resolveMetricTableRows(metric, [buildPointForMetric(metric, 0), buildPointForMetric(metric, 1)]);
      expect(rows).toHaveLength(2);

      const after = resolveSeries(metric, 'line').map((series) => `${series.key}:${series.color}:${series.sign}`);
      const signedAfter = applySeriesSigns([buildPointForMetric(metric, 0)], resolveSeries(metric, 'line'));

      expect(after, metric.id).toEqual(before);
      expect(signedAfter, metric.id).toEqual(signedBefore);
    }
  });

  it('keeps the row shape aligned with the declared columns', () => {
    const metric = getMetric('cashFlow.cashFlow');
    if (!metric) throw new Error('missing cash-flow metric');

    const rows: MetricTableRow[] = resolveMetricTableRows(metric, [buildPointForMetric(metric, 0)]);
    const expectedKeys = ['age', ...columnsExceptAge(metric).map((column) => column.key)].sort();

    expect(Object.keys(rows[0]).sort()).toEqual(expectedKeys);
  });
});

describe('metric tables over a real simulation', () => {
  const inputs = createSimulatorInputs({
    incomes: { salary: createWageIncome({ amount: 120000 }) },
    expenses: { living: createLivingExpense({ amount: 55000 }) },
    accounts: { savings: createSavingsAccount({ balance: 40000 }) },
    contributionRules: { rule: createContributionRule({ accountId: 'savings-1', contributionType: 'unlimited' }) },
    physicalAssets: { residence: createFinancedAssetInput({}) },
    debts: { card: createDebtInput({}) },
  });
  const simulation = new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
  const cashFlowPoints = ChartDataExtractor.extractSingleSimulationCashFlowData(simulation);

  it('fills every cash-flow column from real extractor output', () => {
    expect(cashFlowPoints.length).toBeGreaterThan(0);

    for (const metricId of ['cashFlow.surplusDeficit', 'cashFlow.cashFlow', 'cashFlow.incomes', 'cashFlow.expenses']) {
      const metric = getMetric(metricId);
      if (!metric) throw new Error(`missing metric ${metricId}`);
      const rows = resolveMetricTableRows(metric, cashFlowPoints);

      expect(rows, metricId).toHaveLength(cashFlowPoints.length);
      for (const row of rows) {
        expect(row.age, metricId).toBeTypeOf('number');
        for (const column of columnsExceptAge(metric)) {
          expect(row[column.key], `${metricId}.${column.key} at age ${row.age}`).not.toBeNull();
        }
      }
    }
  });

  it('renders the savings rate column, including years with no rate to report', () => {
    const metric = getMetric('cashFlow.savingsRate');
    if (!metric) throw new Error('missing savings-rate metric');
    const rows = resolveMetricTableRows(metric, cashFlowPoints);
    const column = resolveMetricTableColumns(metric).find((entry) => entry.key === 'savingsRate');
    if (!column) throw new Error('missing savings-rate column');

    expect(rows).toHaveLength(cashFlowPoints.length);
    for (const row of rows) {
      const formatted = column.format(row.savingsRate);
      expect(formatted.length).toBeGreaterThan(0);
      if (row.savingsRate === null) expect(formatted).toBe(EMPTY_METRIC_TABLE_CELL);
    }
  });

  it('renders the net-worth canary from real net-worth points', () => {
    const metric = getMetric(REAL_NET_WORTH_METRIC_ID);
    if (!metric) throw new Error('missing canary metric');

    const netWorthPoints = ChartDataExtractor.extractSingleSimulationNetWorthData(simulation);
    const rows = resolveMetricTableRows(metric, netWorthPoints);

    expect(rows).toHaveLength(netWorthPoints.length);
    for (const [index, row] of rows.entries()) {
      expect(row.age).toBe(netWorthPoints[index].age);
      expect(row.realNetWorth).toBeTypeOf('number');
      expect(Number.isFinite(row.realNetWorth)).toBe(true);
    }
    // The canary deflates by the cumulative inflation factor, so it must track nominal net
    // worth down as inflation accumulates.
    const nominal = netWorthPoints.map((point) => point.netWorth);
    const real = rows.map((row) => row.realNetWorth as number);
    expect(real[real.length - 1]).not.toBeCloseTo(nominal[nominal.length - 1], 0);
  });
});
