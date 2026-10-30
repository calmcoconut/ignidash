/**
 * Compare mode's pure core (P2-P5).
 *
 * The properties that matter: identical plans compare to exactly zero, the sign convention
 * (`delta = a - b`) is honoured by every field, both sides run on the same clock, seed and trial
 * count, and the comparison is deterministic.
 */

import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { comparePlans, COMPARE_DELTA_MEANING, type CompareReport } from './compare';
import { simulate } from './simulate';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

const AS_OF = '2026-03-15';
const SEED = 9521;
const TRIALS = 100;

/** A plan whose only variable is annual spending, so a difference has an obvious sign. */
const createPlan = (expense: number, balance = 500000): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 88 },
    accounts: { '401k-1': create401kAccount({ id: '401k-1', balance }) },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
    expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: expense }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
  });

const options = { asOf: AS_OF, seed: SEED, trials: TRIALS } as const;

const byId = (report: CompareReport, id: string) => {
  const found = report.metrics.find((metric) => metric.id === id);
  if (!found) throw new Error(`compare: no metric "${id}"`);
  return found;
};

describe('comparePlans', () => {
  it('gives zero deltas on every field for identical plans', { timeout: 60_000 }, () => {
    const report = comparePlans(createPlan(60000), createPlan(60000), options);

    expect(report.metrics).toHaveLength(17);
    expect(report.yearly).toHaveLength(54);
    expect(report.metrics.every((metric) => metric.delta === 0)).toBe(true);
    expect(report.yearly.every((year) => year.delta === 0)).toBe(true);
    // ... and the two sides really did run: the values are not all zero or null.
    expect(report.yearly[report.yearly.length - 1].a).toBeGreaterThan(0);
    expect(byId(report, 'monteCarloSuccessRate').a).toBeGreaterThan(0);
  });

  it('states the sign convention once and honours it', { timeout: 60_000 }, () => {
    expect(COMPARE_DELTA_MEANING).toBe('a - b');

    // A spends less than B, so A should end richer and be less likely to need early withdrawals.
    const report = comparePlans(createPlan(50000), createPlan(65000), options);

    expect(byId(report, 'finalPortfolioValue').delta).toBeGreaterThan(0);
    expect(byId(report, 'monteCarloSuccessRate').delta).toBeGreaterThan(0);
    expect(byId(report, 'monteCarloMeanFinalValue').delta).toBeGreaterThan(0);
    expect(byId(report, 'lifetimeEarlyWithdrawalPenalties').delta).toBeLessThan(0);

    // Same timeline, so the age-based rows cannot differ.
    expect(byId(report, 'retirementAge').delta).toBe(0);

    // Year 0 is the same starting balance; the gap opens over time.
    expect(report.yearly[0].delta).toBe(0);
    expect(report.yearly[report.yearly.length - 1].delta).toBeGreaterThan(0);
  });

  it('negates every delta when the sides are swapped', { timeout: 60_000 }, () => {
    const forward = comparePlans(createPlan(50000), createPlan(65000), options);
    const reversed = comparePlans(createPlan(65000), createPlan(50000), options);

    for (const metric of forward.metrics) {
      const other = byId(reversed, metric.id);
      expect(other.a).toBe(metric.b);
      expect(other.b).toBe(metric.a);
      if (metric.delta === null) expect(other.delta).toBeNull();
      else expect(other.delta).toBeCloseTo(-metric.delta, 6);
    }

    for (let index = 0; index < forward.yearly.length; index++) {
      expect(reversed.yearly[index].delta).toBeCloseTo(-forward.yearly[index].delta, 6);
    }
  });

  it('runs both sides with the same seed and trial count', { timeout: 60_000 }, () => {
    const a = createPlan(50000);
    const b = createPlan(65000);
    const report = comparePlans(a, b, options);

    expect(report.seed).toBe(SEED);
    expect(report.trials).toBe(TRIALS);

    // Each side's Monte Carlo numbers are exactly what that plan produces on its own with the
    // report's seed and trials, so neither side ran on a different sample.
    const sideA = simulate(a, {
      mode: 'monteCarloStochasticReturns',
      seed: report.seed,
      asOf: AS_OF,
      monteCarlo: { trials: report.trials },
    });
    const sideB = simulate(b, {
      mode: 'monteCarloStochasticReturns',
      seed: report.seed,
      asOf: AS_OF,
      monteCarlo: { trials: report.trials },
    });
    if (sideA.mode !== 'monteCarloStochasticReturns' || sideB.mode !== 'monteCarloStochasticReturns') throw new Error('expected summaries');

    expect(byId(report, 'monteCarloSuccessRate').a).toBe(sideA.result.summary.successRate);
    expect(byId(report, 'monteCarloMeanFinalValue').a).toBe(sideA.result.summary.finalValue.mean);
    expect(byId(report, 'monteCarloSuccessRate').b).toBe(sideB.result.summary.successRate);
    expect(byId(report, 'monteCarloMeanFinalValue').b).toBe(sideB.result.summary.finalValue.mean);
  });

  it('keeps the Monte Carlo path on summary retention', { timeout: 60_000 }, () => {
    // A comparison only needs aggregates; it must not allocate two sets of full results.
    const report = comparePlans(createPlan(50000), createPlan(65000), options);

    // The summary only exposes aggregates, so this is checked structurally: the MC metrics are
    // present while nothing per-run is reachable from the report.
    expect(report.metrics.some((metric) => metric.group === 'monteCarlo' && metric.a !== null)).toBe(true);
    expect(Object.keys(report)).not.toContain('simulations');
  });

  it('treats the clock as an explicit input: identical plans stay zero, different clocks move the projection', { timeout: 60_000 }, () => {
    // Identical plans: zero at any clock, because the same date drives both sides.
    const sameEarly = comparePlans(createPlan(60000), createPlan(60000), { ...options, asOf: '2026-03-15' });
    const sameLate = comparePlans(createPlan(60000), createPlan(60000), { ...options, asOf: '2030-01-01' });
    expect(sameEarly.metrics.every((metric) => metric.delta === 0)).toBe(true);
    expect(sameLate.metrics.every((metric) => metric.delta === 0)).toBe(true);

    // Deterministic for a fixed clock.
    const twice = comparePlans(createPlan(50000), createPlan(65000), options);
    const again = comparePlans(createPlan(50000), createPlan(65000), options);
    expect(again).toStrictEqual(twice);

    // The clock does move the comparison, and that is intended: every plan ages, so the horizon
    // shortens and the gap between two different plans changes. Pinned here so nobody "fixes" it
    // by silently pinning a date.
    const later = comparePlans(createPlan(50000), createPlan(65000), { ...options, asOf: '2027-03-15' });
    expect(later.asOf).toBe('2027-03-15');
    expect(later.yearly.length).toBe(twice.yearly.length - 1);
    expect(byId(later, 'finalPortfolioValue').delta).not.toBe(byId(twice, 'finalPortfolioValue').delta);
  });

  it('rejects a trial count outside the supported Monte Carlo range', () => {
    expect(() => comparePlans(createPlan(50000), createPlan(65000), { ...options, trials: 99 })).toThrow(/between 100 and 5000/);
    expect(() => comparePlans(createPlan(50000), createPlan(65000), { ...options, trials: 5001 })).toThrow(/between 100 and 5000/);
  });

  it('rejects a plan with no timeline, like simulate() does', () => {
    const noTimeline = createSimulatorInputs({ timeline: null });

    expect(() => comparePlans(noTimeline, createPlan(60000), options)).toThrow(/timeline/);
  });
});
