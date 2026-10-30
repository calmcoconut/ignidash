/**
 * Historical backtest modes (P2-P4).
 *
 * A historical run must say what it actually did: whether it ran past the vendored data and
 * looped, or held at the last vendored year because the plan asked for truncation. A no-wrap run
 * keeps exactly the context shape it had before this setting existed (the frozen corpus records
 * it), so the disclosure fields are present only when they apply.
 */

import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { getNyuDataRange } from './historical-data/nyu-returns';
import { LcgHistoricalBacktestReturnsProvider } from './returns-providers/lcg-historical-backtest-returns-provider';
import { LcgHistoricalBacktestSimulationEngine } from './simulation-engine';
import { fixedClock } from './clock';
import { simulate } from './simulate';
import { create401kAccount, createDefaultTimeline, createSimulatorInputs } from './__tests__/test-utils';

const AS_OF = '2026-03-15';
const VENDORED = getNyuDataRange();

/** Context keys a historical result has always carried; the corpus froze this shape. */
const BASELINE_CONTEXT_KEYS = [
  'startAge',
  'endAge',
  'yearsToSimulate',
  'startDate',
  'endDate',
  'retirementStrategy',
  'rmdAge',
  'historicalRanges',
];

type HistoricalContext = {
  historicalRanges?: Array<{ startYear: number; endYear: number }>;
  historicalWrapped?: boolean;
  truncatedAtYear?: number;
};

const createPlan = (options: { lifeExpectancy: number; startYear: number; mode?: 'looping' | 'truncate' }): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: options.lifeExpectancy },
    accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 300000 }) },
    simulationSettings: {
      simulationSeed: 9521,
      simulationMode: 'historicalReturns',
      historicalStartYearOverride: options.startYear,
      ...(options.mode ? { historicalBacktest: { mode: options.mode } } : {}),
    },
  });

function runHistorical(plan: SimulatorInputs) {
  const outcome = simulate(plan, { mode: 'historicalReturns', seed: 9521, asOf: AS_OF });
  if (outcome.mode !== 'historicalReturns') throw new Error('expected a historical run');

  return outcome.result;
}

describe('historical backtest modes', () => {
  it('defaults to looping and reports the wrap with the ranges it walked', () => {
    const result = runHistorical(createPlan({ lifeExpectancy: 90, startYear: 1990 }));
    const context = result.context as HistoricalContext;

    expect(context.historicalWrapped).toBe(true);
    expect(context.truncatedAtYear).toBeUndefined();

    const ranges = context.historicalRanges ?? [];
    expect(ranges.length).toBeGreaterThan(1);
    // It walked from the pinned start year to the vendored end, then restarted at the oldest year.
    expect(ranges[0].startYear).toBe(1990);
    expect(ranges[0].endYear).toBe(VENDORED.endYear);
    expect(ranges[1].startYear).toBe(VENDORED.startYear);
  });

  it('truncates at the last vendored year and reports where the data ran out', () => {
    const truncating = runHistorical(createPlan({ lifeExpectancy: 90, startYear: 1990, mode: 'truncate' }));
    const looping = runHistorical(createPlan({ lifeExpectancy: 90, startYear: 1990, mode: 'looping' }));
    const context = truncating.context as HistoricalContext;

    expect(context.historicalWrapped).toBeUndefined();
    expect(context.truncatedAtYear).toBe(VENDORED.endYear);

    // Every range stays inside the vendored data: nothing wrapped.
    for (const range of context.historicalRanges ?? []) {
      expect(range.startYear).toBeGreaterThanOrEqual(VENDORED.startYear);
      expect(range.endYear).toBeLessThanOrEqual(VENDORED.endYear);
    }

    // Same horizon, same length: truncation changes which data is used, not how long the run is.
    expect(truncating.data).toHaveLength(looping.data.length);
    // ... and it really did produce different numbers.
    expect(truncating.data[truncating.data.length - 1].portfolio.totalValue).not.toBe(
      looping.data[looping.data.length - 1].portfolio.totalValue
    );
  });

  it('keeps a no-wrap run byte-shaped exactly as before: no disclosure fields appear', () => {
    const result = runHistorical(createPlan({ lifeExpectancy: 60, startYear: 1995 }));
    const context = result.context as HistoricalContext;

    // The frozen corpus records this context shape for a no-wrap run; adding a field here would
    // move it, so the disclosure fields must be absent rather than `false`.
    expect(Object.keys(result.context)).toStrictEqual(BASELINE_CONTEXT_KEYS);
    expect(context.historicalWrapped).toBeUndefined();
    expect(context.truncatedAtYear).toBeUndefined();

    const ranges = context.historicalRanges ?? [];
    expect(ranges).toHaveLength(1);
    // The first data point consumes no return, so 26 rows walk 25 calendar years.
    expect(ranges[0]).toStrictEqual({ startYear: 1995, endYear: 1995 + result.data.length - 2 });
    expect(ranges[0].endYear).toBeLessThanOrEqual(VENDORED.endYear);
  });

  it('is deterministic: the same plan and clock give the same bytes in both modes', () => {
    for (const mode of ['looping', 'truncate'] as const) {
      const first = runHistorical(createPlan({ lifeExpectancy: 90, startYear: 1990, mode }));
      const second = runHistorical(createPlan({ lifeExpectancy: 90, startYear: 1990, mode }));

      expect(second).toStrictEqual(first);
    }
  });

  it('holds at the last vendored year when truncating, and keeps looping when looping', () => {
    const truncating = new LcgHistoricalBacktestReturnsProvider(1, VENDORED.endYear - 1, undefined, 'truncate');
    const looping = new LcgHistoricalBacktestReturnsProvider(1, VENDORED.endYear - 1, undefined, 'looping');

    // First two years are real data in both modes.
    expect(truncating.getReturns(null).returns).toStrictEqual(looping.getReturns(null).returns);
    expect(truncating.getReturns(null).returns).toStrictEqual(looping.getReturns(null).returns);

    // Third year is past the vendored end: truncate repeats the last year, looping restarts.
    const truncatingThird = truncating.getReturns(null);
    const loopingThird = looping.getReturns(null);
    expect(truncatingThird.returns).not.toStrictEqual(loopingThird.returns);

    const truncatingReport = truncating.getHistoricalReport();
    expect(truncatingReport.mode).toBe('truncate');
    expect(truncatingReport.wrapped).toBe(false);
    expect(truncatingReport.truncatedAtYear).toBe(VENDORED.endYear);
    expect(truncatingReport.vendoredRange).toStrictEqual(VENDORED);

    const loopingReport = looping.getHistoricalReport();
    expect(loopingReport.wrapped).toBe(true);
    expect(loopingReport.truncatedAtYear).toBeNull();
  });

  it('reports loops for the historical engine path that the Monte Carlo mode uses', () => {
    const plan = createPlan({ lifeExpectancy: 90, startYear: 1990, mode: 'truncate' });
    const engine = new LcgHistoricalBacktestSimulationEngine(plan, 9521, fixedClock(AS_OF));

    const single = engine.runSingleSimulation(9521, 1990, undefined);
    expect((single.context as HistoricalContext).truncatedAtYear).toBe(VENDORED.endYear);

    const multi = engine.runLcgHistoricalBacktest(2);
    expect(multi.simulations).toHaveLength(2);
    // Truncate mode never loops, whatever start year a trial drew.
    for (const [, result] of multi.simulations) {
      expect((result.context as HistoricalContext).historicalWrapped).toBeUndefined();
      expect((result.context as HistoricalContext).historicalRanges?.length).toBeGreaterThan(0);
    }
  });
});
