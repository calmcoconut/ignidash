import { describe, it, expect, afterAll } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';

import { cumulativeInflationIndex as cumulativeInflationIndexFromTimeBinding } from './time-binding';
import type { SimulationResult } from './simulation-engine';
import { mergeMonteCarloSummaries, runMonteCarloRange, type MonteCarloRunResult } from './monte-carlo';
import { getNyuDataRange } from './historical-data/nyu-returns';
import { cumulativeInflationIndex, DEFAULT_MONTE_CARLO_TRIALS, MONTE_CARLO_MAX_TRIALS, simulate, type SimulateOptions } from './simulate';
import type { Household } from '@/lib/schemas/inputs/household-schema';
import { runStoreSingleSimulation } from '@/lib/stores/single-run';
import {
  create401kAccount,
  createContributionRule,
  createDefaultMarketAssumptions,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * P2-P1a: `simulate()` must be the engine behind one pure function.
 *
 * Four properties are pinned here:
 * 1. determinism — identical arguments give deep-equal results;
 * 2. host independence — identical results whatever the process timezone is;
 * 3. extraction, not a change — the store's single-run path (`runStoreSingleSimulation`) equals a
 *    direct `simulate()` call, with the store's policy visible as explicit inputs;
 * 4. the Monte Carlo worker path agrees seed-for-seed with the same pure core.
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

/** A historical plan: an optional pinned start year, the plan's own seed and historical mode. */
const historicalPlan = (options?: {
  /** The pinned start year; `null` leaves the plan unpinned. Defaults to 1975. */
  startYear?: number | null;
  lifeExpectancy?: number;
  historicalBacktest?: { mode: 'looping' | 'truncate' };
}): SimulatorInputs => {
  const startYear = options?.startYear === undefined ? 1975 : options.startYear;

  return createPlan({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: options?.lifeExpectancy ?? 90 },
    simulationSettings: {
      simulationSeed: 9521,
      simulationMode: 'historicalReturns',
      // No retirement pin: a reset at retirement can keep a long run inside the vendored data,
      // which would hide the truncate mode this suite needs to observe.
      ...(startYear === null ? {} : { historicalStartYearOverride: startYear }),
      ...(options?.historicalBacktest ? { historicalBacktest: options.historicalBacktest } : {}),
    },
  });
};

const ALL_MODES = [
  'fixedReturns',
  'stochasticReturns',
  'historicalReturns',
  'monteCarloStochasticReturns',
  'monteCarloHistoricalReturns',
] as const;

// ============================================================================
// Itemized deductions reach the engine (P3-P3)
// ============================================================================

/**
 * The deduction settings have to survive the trip from the plan to `TaxProcessor`, and only a run
 * through `simulate()` proves it: every hand-worked unit fixture constructs `DeductionSettings`
 * directly, so a dropped constructor argument would leave them all green.
 */
describe('itemized deductions reach the engine', () => {
  /** A plan whose only income is wages and whose returns are zero, so AGI is exactly the wage. */
  const flatPlan = (overrides: Partial<SimulatorInputs> = {}): SimulatorInputs =>
    createPlan({
      timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 40 },
      accounts: {},
      expenses: {},
      contributionRules: {},
      marketAssumptions: { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 },
      incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 110000, taxes: { incomeType: 'wage', withholding: 0 } }) },
      // Federal-only: this fixture isolates the itemized-deduction wiring, and a California return
      // would add its own bill and put the state tax on the federal SALT line (P3-P8 has its own
      // fixture for that interaction).
      taxSettings: { filingStatus: 'single', stateResidency: 'none' },
      ...overrides,
    });

  it('changes the tax by the hand-worked amount when the plan itemizes', () => {
    // $110,000 of wages, single, no returns and no spending. The first settlement closes a year
    // after the 2026-03-15 start, so it is a 2027 return — which is why the SALT cap is 2027's
    // $40,804 (101% of 2026's $40,400, IRC §164(b)(7)(A)(iii)).
    //
    // Standard deduction path:
    //   taxable = 110,000 − 16,100 = 93,900
    //   tax     = 1,240 + 4,560 + 22% × (93,900 − 50,400) = $15,370.00
    // Itemized path (SALT 50,000 capped to 40,804, mortgage 20,000, charitable 10,000):
    //   itemized = 40,804 + 20,000 + 10,000 = $70,804  > 16,100 → itemized wins
    //   taxable  = 110,000 − 70,804 = 39,196
    //   tax      = 1,240 + 12% × (39,196 − 12,400) = $4,455.52
    //   difference = 15,370.00 − 4,455.52 = $10,914.48
    const baseline = simulate(flatPlan(), { mode: 'fixedReturns', seed: 1, asOf: AS_OF });
    const itemizing = simulate(
      flatPlan({
        taxSettings: {
          filingStatus: 'single',
          // No state return: this fixture isolates the *federal* itemized wiring. The California
          // tax feeding the federal SALT line has its own fixture in `taxes.test.ts`.
          stateResidency: 'none',
          itemizedDeductions: { mortgageInterest: 20000, charitable: 10000, stateAndLocalTaxes: 50000, medicalExpenses: 0 },
        },
      }),
      { mode: 'fixedReturns', seed: 1, asOf: AS_OF }
    );

    const standard = baseline.result.data[1].taxes!;
    const itemized = itemizing.result.data[1].taxes!;

    expect(standard.deduction.type).toBe('standard');
    expect(standard.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(15370);
    expect(standard.totalTaxLiability).toBeCloseTo(15370 + standard.fica.total);

    expect(itemized.deduction.type).toBe('itemized');
    expect(itemized.deduction.saltCap.allowed).toBeCloseTo(40804);
    expect(itemized.deduction.itemized.total).toBeCloseTo(70804);
    expect(itemized.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(4455.52);
    expect(itemized.totalTaxLiability).toBeCloseTo(4455.52 + itemized.fica.total);

    // The delta is the deduction's effect, exactly: same wages, so payroll tax is identical.
    expect(itemized.fica.total).toBeCloseTo(standard.fica.total);
    expect(standard.totalTaxLiability - itemized.totalTaxLiability).toBeCloseTo(10914.48);
  });

  it('keeps itemizing after the first death, when the survivor files single', () => {
    // The second `new TaxProcessor(...)` — the survivor's filing-status swap — must carry the same
    // deduction settings. A partial wiring would silently drop this plan back to the standard
    // deduction for every year after the death, which is the bug this test exists to catch.
    const household: Household = {
      members: [
        { id: 'primary', role: 'primary', lifeExpectancy: 70 },
        { id: 'partner', role: 'partner', lifeExpectancy: 95 },
      ],
    };
    const survivorPlan = createPlan({
      timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 95, household },
      accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 500000 }) },
      expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 45000 }) },
      contributionRules: {},
      incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
      taxSettings: {
        filingStatus: 'single', // the household overrides this to marriedFilingJointly
        stateResidency: 'none',
        itemizedDeductions: { mortgageInterest: 30000, charitable: 20000, stateAndLocalTaxes: 60000, medicalExpenses: 0 },
      },
    });

    const rows = simulate(survivorPlan, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }).result.data;
    const settled = rows.filter((row) => row.taxes !== null);
    const joint = settled.filter((row) => row.taxes!.deduction.standardDeduction === 32200);
    const single = settled.filter((row) => row.taxes!.deduction.standardDeduction === 16100);

    // Both regimes occur, so the swap really happened inside this run.
    expect(joint.length).toBeGreaterThan(0);
    expect(single.length).toBeGreaterThan(0);
    // And the plan itemizes in both: the standard deduction is the one it did *not* take.
    expect(joint.every((row) => row.taxes!.deduction.type === 'itemized')).toBe(true);
    expect(single.every((row) => row.taxes!.deduction.type === 'itemized')).toBe(true);
    // The survivor's itemized lines are still there, not zeroed by the swap.
    expect(single[0].taxes!.deduction.itemized.stateAndLocalTaxes).toBeGreaterThan(0);
  });
});

// ============================================================================
// The existing store/worker path
// ============================================================================

// The single-run path is no longer transcribed here: the store calls `runStoreSingleSimulation`
// (`src/lib/stores/single-run.ts`), so the tests below run the store's own module. The Monte Carlo
// path still has to be emulated, because it is worker orchestration — chunking trials and folding
// partial results through the merge worker — which no pure function can stand in for.

/**
 * Exactly what the store's worker pool runs: trial index ranges of 10, each handed to a worker,
 * and the merge worker folding the pieces back together. Chunks arrive in any order, so the
 * comparison is order-insensitive by construction (the merge sorts and sums).
 */
function storeMonteCarloRun(
  inputs: SimulatorInputs,
  mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns',
  seed: number,
  asOf: string,
  totalTrials: number
): { simulations: Array<[number, SimulationResult]>; summary: MonteCarloRunResult['summary'] } {
  const chunks: Array<{ start: number; size: number }> = [];
  for (let start = 0; start < totalTrials; start += 10) chunks.push({ start, size: Math.min(10, totalTrials - start) });

  const partials = chunks.map((chunk) =>
    runMonteCarloRange(inputs, { mode, baseSeed: seed, asOf, config: { retention: 'full' }, startIndex: chunk.start, count: chunk.size })
  );

  return {
    simulations: partials.flatMap((partial) => partial.simulations),
    summary: mergeMonteCarloSummaries(partials.map((p) => p.summary)),
  };
}

const bySeed = (simulations: Array<[number, SimulationResult]>): Map<number, SimulationResult> =>
  new Map(simulations.map(([seed, result]) => [seed, result]));

const seedsOf = (simulations: Array<[number, SimulationResult]>): number[] => simulations.map(([seed]) => seed);

// ============================================================================
// Determinism
// ============================================================================

describe('simulate determinism', () => {
  it.each(ALL_MODES)('returns deep-equal results for identical arguments (%s)', { timeout: 60_000 }, (mode) => {
    const inputs = createPlan();
    const options: SimulateOptions =
      mode === 'monteCarloStochasticReturns' || mode === 'monteCarloHistoricalReturns'
        ? { mode, seed: 4242, asOf: AS_OF, monteCarlo: { trials: 100 } }
        : { mode, seed: 4242, asOf: AS_OF };

    const first = simulate(inputs, options);
    const second = simulate(createPlan(), options);

    expect(second).toStrictEqual(first);
  });

  it('does not mutate its inputs', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const before = structuredClone(inputs);

    simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF });
    simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 1, asOf: AS_OF, monteCarlo: { trials: 100 } });

    expect(inputs).toStrictEqual(before);
  });
});

// ============================================================================
// Host independence
// ============================================================================

const ORIGINAL_TZ = process.env.TZ;

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

describe('simulate host independence', () => {
  it('returns identical results under three different process timezones', { timeout: 60_000 }, () => {
    const inputs = createPlan();

    const runIn = <T>(timeZone: string, run: () => T) => runInTimezone(timeZone, () => ({ offset: winterOffsetMinutes(), value: run() }));

    const utc = runIn('UTC', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));
    const losAngeles = runIn('America/Los_Angeles', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));
    const kiritimati = runIn('Pacific/Kiritimati', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));

    expect(utc.offset).toBe(0);
    expect(losAngeles.offset).toBe(480);
    expect(kiritimati.offset).toBe(-840);

    expect(losAngeles.value).toStrictEqual(utc.value);
    expect(kiritimati.value).toStrictEqual(utc.value);
  });
});

// ============================================================================
// Extraction, not a change: the store's single-run path is `simulate()`
// ============================================================================

describe('the store single-run path', () => {
  it.each(['fixedReturns', 'stochasticReturns'] as const)('%s: the store helper equals a direct simulate()', (mode) => {
    const inputs = createPlan();

    // The expectation is produced by `simulate()` with the plan's own seed, so this fails if the
    // store's seed rule, clock or input handling drifts away from the engine entry point.
    expect(runStoreSingleSimulation(inputs, mode, { asOf: AS_OF })).toStrictEqual(
      simulate(inputs, { mode, seed: inputs.simulationSettings.simulationSeed, asOf: AS_OF }).result
    );
  });

  it('runs at an explicit seed override instead of the plan seed', () => {
    const inputs = createPlan();
    const stored = runStoreSingleSimulation(inputs, 'stochasticReturns', { seedOverride: 4242, asOf: AS_OF });

    expect(stored).toStrictEqual(simulate(inputs, { mode: 'stochasticReturns', seed: 4242, asOf: AS_OF }).result);
    expect(stored).not.toStrictEqual(
      simulate(inputs, { mode: 'stochasticReturns', seed: inputs.simulationSettings.simulationSeed, asOf: AS_OF }).result
    );
  });

  it('returns null for a plan with no timeline, where simulate() throws', () => {
    const inputs = createPlan({ timeline: null });

    expect(runStoreSingleSimulation(inputs, 'fixedReturns', { asOf: AS_OF })).toBeNull();
    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF })).toThrow(/timeline is required/);
  });

  it('keeps the pinned historical start years when the plan runs its own seed', () => {
    const inputs = historicalPlan();
    const stored = runStoreSingleSimulation(inputs, 'historicalReturns', { asOf: AS_OF });

    expect(stored).toStrictEqual(simulate(inputs, { mode: 'historicalReturns', seed: 9521, asOf: AS_OF }).result);
    expect(stored?.context.historicalRanges?.[0]?.startYear).toBe(1975);
  });

  it('ignores the pins on a per-seed drill-down, matching a plan that never had them', () => {
    const pinned = historicalPlan();
    const unpinned = historicalPlan({ startYear: null });
    const stored = runStoreSingleSimulation(pinned, 'historicalReturns', { seedOverride: 4242, asOf: AS_OF });

    // The expectation is `simulate()` on a plan without pins, so the store's suppression rule is
    // what is under test while the engine wiring stays simulate()'s.
    expect(stored).toStrictEqual(simulate(unpinned, { mode: 'historicalReturns', seed: 4242, asOf: AS_OF }).result);
    expect(stored?.context.historicalRanges?.[0]?.startYear).not.toBe(1975);
  });

  it('runs a truncating plan as truncate, and carries truncatedAtYear to the UI (P2-P4)', () => {
    const plan = historicalPlan({ startYear: 1990, historicalBacktest: { mode: 'truncate' } });
    const looping = historicalPlan({ startYear: 1990, historicalBacktest: { mode: 'looping' } });

    const stored = runStoreSingleSimulation(plan, 'historicalReturns', { asOf: AS_OF });

    // Same result as a direct simulate() with truncate...
    expect(stored).toStrictEqual(simulate(plan, { mode: 'historicalReturns', seed: 9521, asOf: AS_OF }).result);
    // ...and it is the truncating run, not the looping one. Before the store was routed through
    // `simulate()` it built the provider without the mode, so this plan rendered as looping:
    // no disclosure, and the wrong ending balance.
    expect(stored?.context.truncatedAtYear).toBe(getNyuDataRange().endYear);
    expect(stored?.context.historicalWrapped).toBeUndefined();
    expect(stored).not.toStrictEqual(simulate(looping, { mode: 'historicalReturns', seed: 9521, asOf: AS_OF }).result);
  });
});

describe('simulate equals the existing store/worker path', () => {
  it('monteCarloStochasticReturns matches the worker pool seed-for-seed', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, {
      mode: 'monteCarloStochasticReturns',
      seed: 9521,
      asOf: AS_OF,
      monteCarlo: { trials: 100, retention: 'full' },
    });

    const stored = storeMonteCarloRun(inputs, 'monteCarloStochasticReturns', 9521, AS_OF, 100);

    expect(seedsOf(outcome.result.simulations)).toEqual(seedsOf(stored.simulations));
    expect(bySeed(outcome.result.simulations)).toStrictEqual(bySeed(stored.simulations));
    // The chunked worker path and the one-shot run must agree on the aggregates too.
    expect(outcome.result.summary).toStrictEqual(stored.summary);
  });

  it('monteCarloHistoricalReturns matches the worker pool seed-for-seed', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, {
      mode: 'monteCarloHistoricalReturns',
      seed: 9521,
      asOf: AS_OF,
      monteCarlo: { trials: 100, retention: 'full' },
    });

    const stored = storeMonteCarloRun(inputs, 'monteCarloHistoricalReturns', 9521, AS_OF, 100);

    expect(seedsOf(outcome.result.simulations)).toEqual(seedsOf(stored.simulations));
    expect(bySeed(outcome.result.simulations)).toStrictEqual(bySeed(stored.simulations));
    expect(outcome.result.summary).toStrictEqual(stored.summary);
  });

  it('matches the store path for a plan with no incomes, expenses, debts or assets', () => {
    const inputs = createSimulatorInputs({
      timeline: createDefaultTimeline(),
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    expect(simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }).result).toStrictEqual(
      runStoreSingleSimulation(inputs, 'fixedReturns', { seedOverride: 1, asOf: AS_OF })
    );
  });
});

// ============================================================================
// trials
// ============================================================================

describe('simulate trials', () => {
  it('honours an explicit trial count exactly, across chunk boundaries', { timeout: 60_000 }, () => {
    const inputs = createPlan();

    const count = (mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns', trials: number) => {
      const outcome = simulate(inputs, { mode, seed: 7, asOf: AS_OF, monteCarlo: { trials, retention: 'full' } });
      expect(outcome.result.simulations).toHaveLength(trials);
      expect(outcome.result.summary.trials).toBe(trials);
      return outcome.result.summary.successes;
    };

    count('monteCarloStochasticReturns', 100);
    count('monteCarloStochasticReturns', 101);
    count('monteCarloHistoricalReturns', 137);
  });

  it(`defaults to ${DEFAULT_MONTE_CARLO_TRIALS} trials and summary retention when nothing is configured`, { timeout: 60_000 }, () => {
    expect(DEFAULT_MONTE_CARLO_TRIALS).toBe(500);

    // A bare plan keeps this 500-trial assertion cheap; the count is the point here.
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 60 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });
    const outcome = simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF });

    expect(outcome.result.summary.trials).toBe(DEFAULT_MONTE_CARLO_TRIALS);
    expect(outcome.result.simulations).toEqual([]);
    expect(outcome.result.summary.histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(DEFAULT_MONTE_CARLO_TRIALS);
  });

  it('keeps the trials shorthand on summary retention, with full retention now opt-in', () => {
    // The shorthand predates both the range check and retention. It no longer retains runs by
    // itself, so a stray large `--trials` cannot silently keep a gigabyte of results.
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 62 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    const shorthand = simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF, trials: 3 });
    const optedIn = simulate(inputs, {
      mode: 'monteCarloStochasticReturns',
      seed: 7,
      asOf: AS_OF,
      trials: 3,
      monteCarlo: { retention: 'full' },
    });

    expect(shorthand.result.summary.trials).toBe(3);
    expect(shorthand.result.simulations).toEqual([]);
    expect(optedIn.result.simulations).toHaveLength(3);
    // Retention changes what is kept, never the aggregates.
    expect(optedIn.result.summary).toStrictEqual(shorthand.result.summary);
  });

  it('bounds the trials shorthand at the maximum trial count', () => {
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 62 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    expect(() =>
      simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF, trials: MONTE_CARLO_MAX_TRIALS + 1 })
    ).toThrow(/exceeds the 5000-trial maximum/);
  });

  it.each(['fixedReturns', 'stochasticReturns', 'historicalReturns'] as const)(
    'rejects Monte Carlo options for the single-run mode %s',
    (mode) => {
      const inputs = createPlan();

      expect(() => simulate(inputs, { mode, seed: 1, asOf: AS_OF, trials: 100 })).toThrow(/Monte Carlo options are only valid/);
      expect(() => simulate(inputs, { mode, seed: 1, asOf: AS_OF, monteCarlo: { trials: 100 } })).toThrow(
        /Monte Carlo options are only valid/
      );
    }
  );

  it.each([0, -5, 1.5, Number.NaN])('rejects an invalid trial shorthand (%s)', (trials) => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 1, asOf: AS_OF, trials })).toThrow(/trials must be/);
  });
});

// ============================================================================
// Argument validation: `asOf` is required and explicit
// ============================================================================

describe('simulate arguments', () => {
  it('requires a real ISO date for asOf', () => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: '2026-02-30' })).toThrow(/Invalid ISO date/);
    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: '2026-3-15' })).toThrow(/Invalid ISO date/);
  });

  it('requires a positive integer seed', () => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'stochasticReturns', seed: 0, asOf: AS_OF })).toThrow(/seed must be a positive integer/);
    expect(() => simulate(inputs, { mode: 'stochasticReturns', seed: 1.5, asOf: AS_OF })).toThrow(/seed must be a positive integer/);
  });

  it('requires a timeline', () => {
    const inputs = createPlan({ timeline: null });

    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF })).toThrow(/inputs\.timeline is required/);
  });

  it('pins the run to asOf', () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF });

    expect(outcome.result.context.startDate).toBe(AS_OF);
    expect(outcome.result.data[0].date).toBe(AS_OF);
  });
});

// ============================================================================
// Contract 3.1: cumulativeInflationIndex on simulate()'s surface
// ============================================================================

describe('cumulativeInflationIndex (contract 3.1)', () => {
  it('is the same function the engine binds amounts with, not a copy', () => {
    expect(cumulativeInflationIndex).toBe(cumulativeInflationIndexFromTimeBinding);
  });

  it('compounds the plan inflation rate', () => {
    const marketAssumptions = createDefaultMarketAssumptions(); // 3% inflation

    expect(cumulativeInflationIndex(marketAssumptions, 0)).toBe(1);
    expect(cumulativeInflationIndex(marketAssumptions, 1)).toBeCloseTo(1.03, 12);
    expect(cumulativeInflationIndex(marketAssumptions, 10)).toBeCloseTo(Math.pow(1.03, 10), 12);
    expect(cumulativeInflationIndex(marketAssumptions, -1)).toBeCloseTo(1 / 1.03, 12);
  });

  it('agrees with the index the engine used to convert a nominal amount', () => {
    const marketAssumptions = createDefaultMarketAssumptions();
    const startYear = 2028; // two years after AS_OF
    const startMonth = 3;

    // Same amount, same dates; only the basis differs, so the ratio of what the engine reports
    // is exactly the index it scaled the nominal amount with.
    const expense = (amountBasis: 'real' | 'nominal'): ExpenseInputs => ({
      id: 'expense-1',
      name: 'Living Expenses',
      amount: 1000,
      amountBasis,
      frequency: 'yearly',
      disabled: false,
      timeframe: {
        start: { type: 'customDate', year: startYear, month: startMonth },
        end: { type: 'atLifeExpectancy' },
      },
    });

    const runWith = (amountBasis: 'real' | 'nominal') =>
      simulate(createPlan({ expenses: { 'expense-1': expense(amountBasis) } }), { mode: 'fixedReturns', seed: 1, asOf: AS_OF });

    const real = runWith('real');
    const nominal = runWith('nominal');

    const firstActiveIndex = real.result.data.findIndex((point) => (point.expenses?.perExpenseData['expense-1']?.expense ?? 0) > 0);
    expect(firstActiveIndex).toBeGreaterThan(-1);
    expect(real.result.data[firstActiveIndex].date).toBe('2028-03-01');

    const realAmount = real.result.data[firstActiveIndex].expenses!.perExpenseData['expense-1'].expense;
    const nominalAmount = nominal.result.data[firstActiveIndex].expenses!.perExpenseData['expense-1'].expense;

    // ... and that is the same number the module exposes to callers.
    expect(realAmount / nominalAmount).toBeCloseTo(cumulativeInflationIndex(marketAssumptions, 2), 8);
    expect(realAmount / nominalAmount).toBeCloseTo(Math.pow(1.03, 2), 8);
  });
});
