/**
 * Fixture plans for the frozen golden corpus (parity plan P2-P1b).
 *
 * Three plans, each chosen for what it can catch rather than for looking realistic:
 *
 * | fixture | catches |
 * | --- | --- |
 * | `steady-saver` | the ordinary path end to end: accumulation, fixed-age retirement, contributions, a taxable account, `baseContributionRule: 'save'`. Comfortable success, so a *regression in the happy path* shows up as a diff. |
 * | `marginal-retiree` | the failing branch: income below spending, portfolio exhausted mid-plan, long shortfall tail and RMDs from 75. `evaluateSuccess` is false here, so the corpus is not degenerate. |
 * | `time-binding-mixed` | the newer inputs from P1-P1: a mid-plan `customDate` start, an `everyNYears` cadence on an expense, and a `nominal` amount (so `cumulativeInflationIndex` is exercised through `TimeBinding`). A time-binding regression should move these numbers. |
 * | `shortfall-repaid` | the success predicate itself. This run reaches retirement, takes a mid-plan shortfall a later pension surplus repays, and ends well above $0.10. It is the only fixture whose verdict flips under the predicates P2-P2 replaced: `true` if the shortfall term is dropped, `true` if the final phase is required to be retirement (it is), and `false` under the current predicate. |
 *
 * Every plan is parsed with `simulatorSchema` before it is simulated, so the corpus is built
 * from plans an import would accept — not from shapes only the test understands.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';

/** The single clock every snapshot is pinned to, so the bytes cannot depend on the day. */
export const GOLDEN_AS_OF = '2026-03-15';

export type GoldenMode = 'fixedReturns' | 'stochasticReturns' | 'historicalReturns';

export interface GoldenFixture {
  /** Corpus key and the name that appears in failure messages. */
  id: string;
  /** What a diff in this fixture is most likely to mean. */
  catches: string;
  /** Runs this fixture is frozen for, with the seed each one uses. */
  runs: Array<{ mode: GoldenMode; seed: number }>;
  inputs: SimulatorInputs;
}

const marketAssumptions = {
  stockReturn: 9,
  stockYield: 2,
  bondReturn: 4,
  bondYield: 3.5,
  cashReturn: 3,
  inflationRate: 3,
};

const steadySaver: SimulatorInputs = {
  timeline: {
    birthMonth: 6,
    birthYear: 1985,
    lifeExpectancy: 70,
    retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
  },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 110000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 22 },
    },
  },
  accounts: {
    '401k': { id: '401k', name: '401k', type: '401k', balance: 450000, percentBonds: 25 },
    roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 60000, percentBonds: 20 },
    brokerage: { id: 'brokerage', name: 'Brokerage', type: 'taxableBrokerage', balance: 120000, percentBonds: 30 },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living Expenses',
      amount: 55000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: {
    'to-401k': { id: 'to-401k', accountId: '401k', rank: 1, contributionType: 'unlimited' },
    'to-roth': { id: 'to-roth', accountId: 'roth', rank: 2, contributionType: 'unlimited' },
  },
  baseContributionRule: { type: 'save' },
  marketAssumptions,
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  // The historical run pins its start years so it cannot wrap past the vendored data; the plan's
  // other runs ignore these because they select their mode explicitly.
  simulationSettings: {
    simulationSeed: 1,
    simulationMode: 'historicalReturns',
    historicalStartYearOverride: 1990,
    historicalRetirementStartYearOverride: 2000,
  },
};

const marginalRetiree: SimulatorInputs = {
  timeline: {
    birthMonth: 6,
    birthYear: 1965,
    lifeExpectancy: 90,
    retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
  },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 60000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 15 },
    },
  },
  accounts: {
    '401k': { id: '401k', name: '401k', type: '401k', balance: 220000, percentBonds: 40 },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living Expenses',
      amount: 72000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: {},
  baseContributionRule: { type: 'spend' },
  marketAssumptions,
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns' },
};

const timeBindingMixed: SimulatorInputs = {
  timeline: {
    birthMonth: 3,
    birthYear: 1980,
    lifeExpectancy: 88,
    retirementStrategy: { type: 'fixedAge', retirementAge: 67 },
  },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 95000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 20 },
    },
  },
  accounts: {
    '401k': { id: '401k', name: '401k', type: '401k', balance: 300000, percentBonds: 30 },
    brokerage: { id: 'brokerage', name: 'Brokerage', type: 'taxableBrokerage', balance: 80000, percentBonds: 20 },
  },
  expenses: {
    // Mid-plan start, every third year, expressed in the dollars of 2031 — the three newer
    // inputs from P1-P1 in one row.
    trips: {
      id: 'trips',
      name: 'Big Trip',
      amount: 12000,
      amountBasis: 'nominal',
      frequency: 'yearly',
      timeframe: {
        start: { type: 'customDate', year: 2031, month: 7, everyNYears: 3 },
        end: { type: 'atLifeExpectancy' },
      },
    },
    living: {
      id: 'living',
      name: 'Living Expenses',
      amount: 45000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: { 'to-401k': { id: 'to-401k', accountId: '401k', rank: 1, contributionType: 'unlimited' } },
  baseContributionRule: { type: 'save' },
  marketAssumptions,
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns' },
};

/**
 * Reaches retirement at 67, runs out of money for years 1-11, then a pension from 70 produces the
 * surplus that repays the shortfall; ends with ~$306k. `evaluateSuccess` is false (the shortfall
 * happened), while dropping the shortfall term or requiring only the final phase would say true.
 */
const shortfallRepaid: SimulatorInputs = {
  timeline: {
    birthMonth: 6,
    birthYear: 1960,
    lifeExpectancy: 90,
    retirementStrategy: { type: 'fixedAge', retirementAge: 67 },
  },
  incomes: {
    pension: {
      id: 'pension',
      name: 'Pension',
      amount: 7000,
      frequency: 'monthly',
      timeframe: { start: { type: 'customAge', age: 70 }, end: { type: 'atLifeExpectancy' } },
      taxes: { incomeType: 'pension' },
    },
  },
  accounts: {
    '401k': { id: '401k', name: '401k', type: '401k', balance: 20000, percentBonds: 20 },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living Expenses',
      amount: 50000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: {},
  baseContributionRule: { type: 'save' },
  marketAssumptions,
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns' },
};

/**
 * Parses a fixture exactly as an import would. Throws if a fixture stops being a valid plan, which
 * is the signal to fix the fixture deliberately rather than to regenerate the corpus.
 */
export function validateFixture(inputs: SimulatorInputs): SimulatorInputs {
  return simulatorSchema.parse(inputs);
}

/**
 * The fixture whose three modes feed the multi-simulation readouts. One plan under three return
 * models: the runs are the same length, which the analyzer compares pairwise, and the percentile
 * ordering is then about the return model rather than about a longer horizon.
 */
export const CROSS_RUN_FIXTURE_ID = 'steady-saver';

/**
 * The fixtures the cross-plan percentile snapshot is taken over. Named explicitly so that adding a
 * fixture does not silently move an existing frozen number: the corpus is frozen once, and a new
 * fixture must arrive as an addition, not as a rewrite of the cross-plan distribution.
 */
export const CROSS_PLAN_FIXTURE_IDS = ['steady-saver', 'marginal-retiree', 'time-binding-mixed'] as const;

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    id: 'steady-saver',
    catches: 'the ordinary path: accumulation, fixed-age retirement, contributions, taxable account',
    runs: [
      { mode: 'fixedReturns', seed: 1 },
      { mode: 'stochasticReturns', seed: 1 },
      { mode: 'historicalReturns', seed: 1 },
    ],
    inputs: steadySaver,
  },
  {
    id: 'marginal-retiree',
    catches: 'the failing branch: shortfall, bankruptcy, RMDs; success is false here',
    runs: [{ mode: 'fixedReturns', seed: 1 }],
    inputs: marginalRetiree,
  },
  {
    id: 'time-binding-mixed',
    catches: 'time binding: mid-plan customDate, everyNYears cadence, nominal amount',
    runs: [{ mode: 'fixedReturns', seed: 1 }],
    inputs: timeBindingMixed,
  },
  {
    id: 'shortfall-repaid',
    catches: 'the success predicate: reaches retirement, shortfall later repaid, ends above $0.10',
    runs: [{ mode: 'fixedReturns', seed: 1 }],
    inputs: shortfallRepaid,
  },
];
