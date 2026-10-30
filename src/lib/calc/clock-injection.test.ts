import { describe, it, expect, afterAll } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { FinancialSimulationEngine, MonteCarloSimulationEngine, type SimulationResult } from './simulation-engine';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { fixedClock } from './clock';
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
 * Clock injection (parity plan P2-P0).
 *
 * A run must be a pure function of its inputs plus an explicit clock: the same plan and the
 * same `asOf` must produce identical results on any day, in any host timezone, and two
 * different `asOf` dates must actually move the ages.
 */

const ORIGINAL_TZ = process.env.TZ;

/** Runs `run` with the host timezone set to `timeZone` (Node re-reads `process.env.TZ`). */
function runInTimezone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

/** Offset of a fixed winter instant, used to prove the timezone switch really took effect. */
function winterOffsetMinutes(): number {
  return new Date(2026, 0, 15).getTimezoneOffset();
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const createPlan = (): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 90 },
    accounts: {
      '401k-1': create401kAccount({ id: '401k-1', balance: 400000 }),
      'brokerage-1': createTaxableBrokerageAccount({ id: 'brokerage-1', balance: 150000 }),
    },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
    expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 45000 }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
  });

function runFixedPlan(inputs: SimulatorInputs, asOf: string): SimulationResult {
  const engine = new FinancialSimulationEngine(inputs, fixedClock(asOf));
  return engine.runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
}

describe('clock injection', () => {
  it('pins the whole run to the clock date instead of the wall clock', () => {
    const inputs = createPlan();
    const result = runFixedPlan(inputs, '2026-03-15');

    // First data point is "today" from the clock, not from the machine's date.
    expect(result.data[0].date).toBe('2026-03-15');
    expect(result.context.startDate).toBe('2026-03-15');
    // birthMonth 12/1990 → 36 years on 2026-03-15, minus 3 months of birthday distance.
    expect(result.data[0].age).toBeCloseTo(35 + 9 / 12, 10);
    expect(result.context.startAge).toBeCloseTo(35 + 9 / 12, 10);
    // Annual rows land on the first of the same month, one year apart.
    expect(result.data[1].date).toBe('2027-03-01');
    expect(result.data[2].date).toBe('2028-03-01');
  });

  it('gives different ages for two different clocks (the clock is what moves the numbers)', () => {
    const inputs = createPlan();
    const earlier = runFixedPlan(inputs, '2026-01-15');
    const later = runFixedPlan(inputs, '2027-01-15');

    expect(earlier.data[0].age).toBeCloseTo(35 + 7 / 12, 10);
    expect(later.data[0].age).toBeCloseTo(36 + 7 / 12, 10);
    expect(later.data[0].age - earlier.data[0].age).toBeCloseTo(1, 10);
    expect(earlier.data[0].date).toBe('2026-01-15');
    expect(later.data[0].date).toBe('2027-01-15');
    expect(earlier.data[1].date).toBe('2027-01-01');
    expect(later.data[1].date).toBe('2028-01-01');
    // One year older means one fewer simulated year to reach life expectancy.
    expect(earlier.data.length).toBe(later.data.length + 1);
  });

  it('produces identical results under three different host timezones', () => {
    const inputs = createPlan();
    const asOf = '2026-03-15';

    // Capture the offset inside the run so the assertion proves the switch really happened.
    const runIn = (timeZone: string) =>
      runInTimezone(timeZone, () => ({ offset: winterOffsetMinutes(), result: runFixedPlan(inputs, asOf) }));

    const utc = runIn('UTC');
    const losAngeles = runIn('America/Los_Angeles');
    const kiritimati = runIn('Pacific/Kiritimati');

    expect(utc.offset).toBe(0);
    expect(losAngeles.offset).toBe(480);
    expect(kiritimati.offset).toBe(-840);

    expect(losAngeles.result).toEqual(utc.result);
    expect(kiritimati.result).toEqual(utc.result);

    // Spot-check the labels and ages explicitly, not just the deep equality.
    expect(losAngeles.result.data[0].date).toBe('2026-03-15');
    expect(losAngeles.result.data[1].date).toBe('2027-03-01');
    expect(kiritimati.result.data[1].date).toBe('2027-03-01');
    expect(losAngeles.result.data[1].age).toBe(utc.result.data[1].age);
    expect(losAngeles.result.context).toEqual(utc.result.context);
  });

  it('produces identical Monte Carlo results under two different host timezones', () => {
    const inputs = createPlan();
    const asOf = '2026-03-15';
    const runMonteCarlo = () => new MonteCarloSimulationEngine(inputs, 4242, fixedClock(asOf)).runMonteCarloSimulation(3);

    const utc = runInTimezone('UTC', runMonteCarlo);
    const tokyo = runInTimezone('Asia/Tokyo', runMonteCarlo);

    expect(tokyo).toEqual(utc);
    expect(tokyo.simulations[0][1].context.startDate).toBe(asOf);
  });

  it('carries asOf across a structured clone, the way it crosses the worker boundary', () => {
    // The Monte Carlo workers run in their own JS realm, so the store passes `asOf` as a
    // plain argument and the worker rebuilds the clock with fixedClock(asOf). This asserts
    // that the value survives the clone and yields the same run as the main thread.
    const inputs = createPlan();
    const asOf = '2026-03-15';

    const mainThread = runFixedPlan(inputs, asOf);
    const clonedInputs = structuredClone(inputs);
    const clonedAsOf = structuredClone(asOf);
    const workerRealm = runFixedPlan(clonedInputs, clonedAsOf);

    expect(workerRealm).toEqual(mainThread);
    expect(workerRealm.context.startDate).toBe(asOf);
  });
});
