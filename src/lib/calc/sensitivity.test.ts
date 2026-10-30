import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { simulate } from './simulate';
import { KeyMetricsExtractor } from './data-extractors/key-metrics-extractor';
import { DEFAULT_SENSITIVITY_SWEEPS, SENSITIVITY_VARIABLES, oneAtATimeSensitivity, type SensitivityReport } from './sensitivity';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * P2-P7: one-at-a-time sensitivity sweeps.
 *
 * The sweeps only *read* the engine, through `simulate()`, so the properties worth pinning are
 * the ones a chart and a decision depend on: the same plan gives the same report, every variable
 * appears once, the bars are ordered by size, the base case is the unperturbed run, and the
 * obvious directions hold (more spending cannot help; better returns must).
 */

const AS_OF = '2026-03-15';

const createPlan = (overrides?: Partial<SimulatorInputs>): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 90 },
    accounts: {
      '401k-1': create401kAccount({ id: '401k-1', balance: 400000 }),
      'brokerage-1': createTaxableBrokerageAccount({ id: 'brokerage-1', balance: 150000 }),
    },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
    expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 45000 }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
    ...overrides,
  });

const entryFor = (report: SensitivityReport, variable: string) => {
  const entry = report.entries.find((candidate) => candidate.variable === variable);
  if (!entry) throw new Error(`no "${variable}" entry in [${report.entries.map((e) => e.variable).join(', ')}]`);
  return entry;
};

describe('determinism', () => {
  it('two sweeps of the same plan are byte-identical', () => {
    const plan = createPlan();

    expect(oneAtATimeSensitivity(plan, { asOf: AS_OF })).toStrictEqual(oneAtATimeSensitivity(plan, { asOf: AS_OF }));
  });

  it('does not mutate the plan it was given', () => {
    const plan = createPlan();
    const before = structuredClone(plan);

    oneAtATimeSensitivity(plan, { asOf: AS_OF });

    expect(plan).toStrictEqual(before);
  });

  it('echoes the clock and the sweep sizes it used', () => {
    const plan = createPlan();
    const report = oneAtATimeSensitivity(plan, { asOf: AS_OF });

    expect(report.asOf).toBe(AS_OF);
    expect(report.metric).toBe('finalPortfolio');
    expect(report.sweeps).toStrictEqual(DEFAULT_SENSITIVITY_SWEEPS);

    // A partial override keeps the other defaults.
    expect(oneAtATimeSensitivity(plan, { asOf: AS_OF, sweeps: { spendingDeltaPct: 25 } }).sweeps).toStrictEqual({
      ...DEFAULT_SENSITIVITY_SWEEPS,
      spendingDeltaPct: 25,
    });
  });
});

describe('the base case is the unperturbed run', () => {
  it('equals a direct simulate() of the plan', () => {
    const plan = createPlan();
    const direct = KeyMetricsExtractor.extractSingleSimulationMetrics(
      simulate(plan, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }).result
    );
    const report = oneAtATimeSensitivity(plan, { asOf: AS_OF });

    expect(report.baseOutcome).toBe(direct.finalPortfolio);
    for (const entry of report.entries) {
      expect(entry.base.outcome).toBe(direct.finalPortfolio);
      expect(entry.base.success).toBe(direct.success);
    }
  });
});

describe('the tornado data', () => {
  it('has each variable exactly once and is ordered by absolute effect', () => {
    const report = oneAtATimeSensitivity(createPlan(), { asOf: AS_OF });

    // Exactly the four variables, each once — in effect order, not declaration order, so the
    // set is what is asserted here and the ranking is asserted below.
    const variables = report.entries.map((entry) => entry.variable);
    expect([...variables].sort()).toEqual([...SENSITIVITY_VARIABLES].sort());
    expect(variables).toHaveLength(SENSITIVITY_VARIABLES.length);
    expect(new Set(variables).size).toBe(variables.length);

    // Bar length is the gap between the two cases, never negative...
    for (const entry of report.entries) {
      expect(entry.effect).toBe(Math.abs(entry.high.outcome - entry.low.outcome));
      expect(entry.effect).toBeGreaterThanOrEqual(0);
      // ...and it moves with the perturbed input, not around it.
      expect(entry.low.input).toBeLessThan(entry.high.input);
    }

    // ...and the ranking is by that length, largest first, so a chart can draw `entries` as-is.
    const effects = report.entries.map((entry) => entry.effect);
    expect(effects).toEqual([...effects].sort((a, b) => b - a));
  });

  it('reports the low and high input each case used', () => {
    const report = oneAtATimeSensitivity(createPlan(), { asOf: AS_OF });
    const returns = entryFor(report, 'returns');

    expect(returns.low.input).toBe(9 - DEFAULT_SENSITIVITY_SWEEPS.returnDeltaPct);
    expect(returns.high.input).toBe(9 + DEFAULT_SENSITIVITY_SWEEPS.returnDeltaPct);
    expect(entryFor(report, 'inflation').low.input).toBe(3 - DEFAULT_SENSITIVITY_SWEEPS.inflationDeltaPct);
    expect(entryFor(report, 'retirementAge').high.input).toBe(65 + DEFAULT_SENSITIVITY_SWEEPS.retirementAgeDeltaYears);
    expect(entryFor(report, 'spending').low.input).toBe(1 - DEFAULT_SENSITIVITY_SWEEPS.spendingDeltaPct / 100);
  });

  it('leaves out a variable the plan has no room for', () => {
    // A SWR-target plan has no retirement age to move, so a bar for it would be invented.
    const report = oneAtATimeSensitivity(
      createPlan({ timeline: { ...createDefaultTimeline(), retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 } } }),
      {
        asOf: AS_OF,
      }
    );

    expect(report.entries.map((entry) => entry.variable)).toEqual(['returns', 'inflation', 'spending']);
  });
});

describe('monotonicity', () => {
  it('more spending never produces a better outcome', () => {
    const report = oneAtATimeSensitivity(createPlan(), { asOf: AS_OF });
    const spending = entryFor(report, 'spending');

    // 10% less spending is at least as good as 10% more.
    expect(spending.high.outcome).toBeLessThanOrEqual(spending.low.outcome);
    expect(spending.high.outcome).toBeLessThan(spending.low.outcome);
  });

  it('a larger spending perturbation cannot improve on a smaller one', () => {
    const plan = createPlan();
    const small = entryFor(oneAtATimeSensitivity(plan, { asOf: AS_OF, sweeps: { spendingDeltaPct: 10 } }), 'spending');
    const large = entryFor(oneAtATimeSensitivity(plan, { asOf: AS_OF, sweeps: { spendingDeltaPct: 25 } }), 'spending');

    expect(large.high.input).toBeGreaterThan(small.high.input);
    expect(large.high.outcome).toBeLessThanOrEqual(small.high.outcome);
    // And the bar is longer, which is what makes the sweep useful.
    expect(large.effect).toBeGreaterThan(small.effect);
  });

  it('better returns produce a strictly better outcome', () => {
    const report = oneAtATimeSensitivity(createPlan(), { asOf: AS_OF });
    const returns = entryFor(report, 'returns');

    // 2 points more return on every asset compounds for 50 years here; the direction is the
    // assertion, not a magnitude.
    expect(returns.high.outcome).toBeGreaterThan(returns.low.outcome);
    expect(returns.high.outcome).toBeGreaterThan(report.baseOutcome);
    expect(returns.low.outcome).toBeLessThan(report.baseOutcome);
  });
});
