import type { SimulatorInputs } from '../../../src/lib/schemas/inputs/simulator-schema';

/**
 * Eval set for the tax-optimization skill (§7-A2).
 *
 * Ten hand-specified plans across the shapes the engine can actually compute today, plus the
 * properties every run must satisfy. The plans are `SimulatorInputs` — exactly what the tools in
 * `convex/chat_tools.ts` consume — and `tax-optimization-evals.test.ts` proves each one validates
 * and produces a baseline, so a schema change cannot leave a dead fixture behind.
 *
 * Evals run **on demand** against a real chat (see the README beside this file). Nothing here
 * calls a provider, and no test drives the agent.
 *
 * Deliberately **not** covered:
 * - **MFS.** The engine prices a separate return (P3-P1b), but no fixture in this set uses it yet.
 * - **California state tax.** Federal rules only; CA SDI is a payroll line, not a state return.
 * - **Roth conversions, SEPP, QCDs, pro-rata IRA basis, itemized deductions/SALT, AMT/IRMAA, ACA
 *   credits, Social Security claiming.** The skill may be *asked* about these; the correct
 *   behaviour is to say the lever is not modelled, which is what the refused-patch check looks at.
 */

/** The goal a run is ranked by. F1: the user picks it; the agent never does. */
export type EvalGoal = 'lifetime-taxes' | 'ending-net-worth' | 'success';

export interface TaxOptimizationEval {
  id: string;
  /** What this case exercises, in one line. */
  covers: string;
  /** The goal the operator sets for this run. */
  goal: EvalGoal;
  /** The message the operator sends to open the session. */
  request: string;
  /** Patches a competent agent is likely to try. Descriptive, never prescriptive. */
  levers: Array<{ label: string; planPatch: Record<string, unknown> }>;
  plan: SimulatorInputs;
}

/** The fixed clock every eval uses: deterministic and already in the past, so ages are stable. */
export const EVAL_AS_OF = '2026-01-01';

const basePlan = (overrides: Partial<SimulatorInputs> = {}): SimulatorInputs => ({
  timeline: {
    birthMonth: 1,
    birthYear: 1990,
    lifeExpectancy: 87,
    retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
  },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 87500,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 20 },
      growth: { growthRate: 3 },
      disabled: false,
    },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living expenses',
      amount: 40000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
      growth: { growthRate: 3 },
      disabled: false,
    },
  },
  debts: {},
  physicalAssets: {},
  accounts: {
    traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 250000, percentBonds: 20 },
    roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 60000, percentBonds: 20 },
    taxable: { id: 'taxable', name: 'Brokerage', balance: 120000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 90000 },
  },
  contributionRules: {},
  baseContributionRule: { type: 'save' },
  marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns' },
  ...overrides,
});

const retireAt = (retirementAge: number) => ({ retirementStrategy: { type: 'fixedAge' as const, retirementAge } });

export const TAX_OPTIMIZATION_EVALS: readonly TaxOptimizationEval[] = [
  {
    id: 'single-baseline',
    covers: 'single filer, one wage, retire at 65: the reference case every delta is read against',
    goal: 'lifetime-taxes',
    request: 'Compare a few tax-optimization variants for my plan, ranked by lifetime taxes and penalties.',
    levers: [
      { label: 'retire at 67', planPatch: { timeline: retireAt(67) } },
      { label: 'retire at 62', planPatch: { timeline: retireAt(62) } },
      { label: 'lower expense target', planPatch: { expenses: { living: { amount: 34000 } } } },
    ],
    plan: basePlan(),
  },
  {
    id: 'single-high-earner',
    covers: 'single filer at a high wage: bracket pressure and a large tax-deferred balance',
    goal: 'lifetime-taxes',
    request: 'Rank variants of my plan by lifetime taxes and penalties. I earn well; tell me what the engine shows.',
    levers: [
      { label: 'retire at 60', planPatch: { timeline: retireAt(60) } },
      { label: 'retire at 67', planPatch: { timeline: retireAt(67) } },
      { label: 'larger tax-deferred balance', planPatch: { accounts: { traditional: { balance: 900000 } } } },
    ],
    plan: basePlan({
      incomes: {
        salary: {
          id: 'salary',
          name: 'Salary',
          amount: 320000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 30 },
          growth: { growthRate: 2 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 620000, percentBonds: 20 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 90000, percentBonds: 20 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 420000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 260000 },
      },
    }),
  },
  {
    id: 'single-early-retiree',
    covers: 'single filer retiring at 45: a taxable bridge and early-withdrawal penalties',
    goal: 'success',
    request: 'Rank early-retirement variants by success. I care about the plan not running out, and I want to see what the penalties cost.',
    levers: [
      { label: 'retire at 45', planPatch: { timeline: retireAt(45) } },
      { label: 'retire at 50', planPatch: { timeline: retireAt(50) } },
      { label: 'larger taxable bridge', planPatch: { accounts: { taxable: { balance: 500000 } } } },
    ],
    plan: basePlan({
      timeline: {
        birthMonth: 1,
        birthYear: 1990,
        lifeExpectancy: 90,
        retirementStrategy: { type: 'fixedAge', retirementAge: 45 },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Living expenses',
          amount: 46000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 310000, percentBonds: 20 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 80000, percentBonds: 20, contributionBasis: 60000 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 380000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 290000 },
      },
    }),
  },
  {
    id: 'single-low-income',
    covers: 'single filer with a modest wage: the 0% long-term capital gains zone',
    goal: 'lifetime-taxes',
    request: 'Rank variants by lifetime taxes. My income is modest and I want to know what the low-bracket years look like.',
    levers: [
      { label: 'retire at 62', planPatch: { timeline: retireAt(62) } },
      { label: 'lower expenses', planPatch: { expenses: { living: { amount: 24000 } } } },
    ],
    plan: basePlan({
      incomes: {
        salary: {
          id: 'salary',
          name: 'Salary',
          amount: 46000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 10 },
          growth: { growthRate: 2 },
          disabled: false,
        },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Living expenses',
          amount: 28000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 120000, percentBonds: 30 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 30000, percentBonds: 30 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 95000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 60000 },
      },
    }),
  },
  {
    id: 'single-roth-heavy',
    covers: 'single filer whose balances are mostly tax-free: withdrawals that do not add taxable income',
    goal: 'ending-net-worth',
    request: 'Rank variants by ending net worth. Most of my savings are already in Roth accounts.',
    levers: [
      { label: 'retire at 60', planPatch: { timeline: retireAt(60) } },
      { label: 'shift bonds higher', planPatch: { accounts: { roth: { percentBonds: 50 }, traditional: { percentBonds: 50 } } } },
    ],
    plan: basePlan({
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 60000, percentBonds: 20 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 520000, percentBonds: 20, contributionBasis: 200000 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 60000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 45000 },
      },
    }),
  },
  {
    id: 'single-tax-deferred-heavy',
    covers: 'single filer with a large tax-deferred balance: required minimum distributions late in life',
    goal: 'lifetime-taxes',
    request: 'Rank variants by lifetime taxes and penalties. Most of my money is in a traditional 401(k).',
    levers: [
      { label: 'retire at 70', planPatch: { timeline: retireAt(70) } },
      { label: 'retire at 62', planPatch: { timeline: retireAt(62) } },
      { label: 'smaller tax-deferred balance', planPatch: { accounts: { traditional: { balance: 600000 } } } },
    ],
    plan: basePlan({
      timeline: {
        birthMonth: 1,
        birthYear: 1990,
        lifeExpectancy: 92,
        retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 1250000, percentBonds: 25 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 40000, percentBonds: 25 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 80000, type: 'taxableBrokerage', percentBonds: 25, costBasis: 55000 },
      },
    }),
  },
  {
    id: 'mfj-dual-income',
    covers: 'married filing jointly with two wages: two earners, joint brackets',
    goal: 'lifetime-taxes',
    request: 'Rank variants of our joint plan by lifetime taxes and penalties. We both work.',
    levers: [
      { label: 'retire at 60', planPatch: { timeline: retireAt(60) } },
      { label: 'retire at 67', planPatch: { timeline: retireAt(67) } },
      { label: 'lower household expenses', planPatch: { expenses: { living: { amount: 64000 } } } },
    ],
    plan: basePlan({
      taxSettings: { filingStatus: 'marriedFilingJointly' },
      incomes: {
        primary: {
          id: 'primary',
          name: 'Primary salary',
          amount: 115000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 20 },
          growth: { growthRate: 3 },
          disabled: false,
        },
        partner: {
          id: 'partner',
          name: 'Partner salary',
          amount: 92000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 20 },
          growth: { growthRate: 2 },
          disabled: false,
        },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Household expenses',
          amount: 78000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 410000, percentBonds: 20 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 120000, percentBonds: 20 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 210000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 150000 },
      },
    }),
  },
  {
    id: 'mfj-single-earner',
    covers: 'married filing jointly with one wage: a non-earning spouse and a wider bracket',
    goal: 'lifetime-taxes',
    request: 'Rank variants of our joint plan by lifetime taxes. Only one of us is earning.',
    levers: [
      { label: 'retire at 65', planPatch: { timeline: retireAt(65) } },
      { label: 'retire at 58', planPatch: { timeline: retireAt(58) } },
    ],
    plan: basePlan({
      taxSettings: { filingStatus: 'marriedFilingJointly' },
      incomes: {
        primary: {
          id: 'primary',
          name: 'Salary',
          amount: 165000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 25 },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Household expenses',
          amount: 70000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
    }),
  },
  {
    id: 'mfj-early-retiree',
    covers: 'married filing jointly retiring at 50: a long pre-59½ window and a taxable bridge',
    goal: 'success',
    request: 'Rank variants by success. We want to stop working around 50 and need to know the plan holds.',
    levers: [
      { label: 'retire at 50', planPatch: { timeline: retireAt(50) } },
      { label: 'retire at 55', planPatch: { timeline: retireAt(55) } },
      { label: 'larger taxable bridge', planPatch: { accounts: { taxable: { balance: 700000 } } } },
    ],
    plan: basePlan({
      taxSettings: { filingStatus: 'marriedFilingJointly' },
      timeline: {
        birthMonth: 1,
        birthYear: 1990,
        lifeExpectancy: 92,
        retirementStrategy: { type: 'fixedAge', retirementAge: 50 },
      },
      incomes: {
        primary: {
          id: 'primary',
          name: 'Primary salary',
          amount: 132000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 22 },
          growth: { growthRate: 3 },
          disabled: false,
        },
        partner: {
          id: 'partner',
          name: 'Partner salary',
          amount: 98000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 22 },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Household expenses',
          amount: 82000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 520000, percentBonds: 20 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 140000, percentBonds: 20, contributionBasis: 90000 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 430000, type: 'taxableBrokerage', percentBonds: 20, costBasis: 300000 },
      },
    }),
  },
  {
    id: 'mfj-high-income',
    covers: 'married filing jointly at a high income: NIIT territory, federal rules only (no CA return)',
    goal: 'lifetime-taxes',
    request: 'Rank variants of our joint plan by lifetime taxes and penalties. We are high earners in California.',
    levers: [
      { label: 'retire at 62', planPatch: { timeline: retireAt(62) } },
      { label: 'retire at 68', planPatch: { timeline: retireAt(68) } },
      { label: 'larger taxable balance', planPatch: { accounts: { taxable: { balance: 900000 } } } },
    ],
    plan: basePlan({
      taxSettings: { filingStatus: 'marriedFilingJointly' },
      incomes: {
        primary: {
          id: 'primary',
          name: 'Primary salary',
          amount: 285000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 30 },
          growth: { growthRate: 2 },
          disabled: false,
        },
        partner: {
          id: 'partner',
          name: 'Partner salary',
          amount: 145000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 30 },
          growth: { growthRate: 2 },
          disabled: false,
        },
      },
      expenses: {
        living: {
          id: 'living',
          name: 'Household expenses',
          amount: 120000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          growth: { growthRate: 3 },
          disabled: false,
        },
      },
      accounts: {
        traditional: { id: 'traditional', name: '401(k)', type: '401k', balance: 760000, percentBonds: 25 },
        roth: { id: 'roth', name: 'Roth IRA', type: 'rothIra', balance: 180000, percentBonds: 25 },
        taxable: { id: 'taxable', name: 'Brokerage', balance: 640000, type: 'taxableBrokerage', percentBonds: 25, costBasis: 380000 },
      },
    }),
  },
];

export interface EvalCheck {
  id: string;
  /** What the reviewer confirms in the transcript. */
  property: string;
}

/**
 * The properties every eval run must satisfy. They are the skill's hard rules and its stance,
 * turned into something a reviewer can check by reading one transcript.
 */
export const TAX_OPTIMIZATION_EVAL_CHECKS: readonly EvalCheck[] = [
  {
    id: 'grounded-numbers',
    property:
      'Every figure in the answer appears in a tool result from the same turn; nothing is estimated, recalled or derived by arithmetic.',
  },
  {
    id: 'goal-first',
    property: 'The answer names the goal it ranks by (the one set in the eval) and orders the variants by it.',
  },
  {
    id: 'refused-patches',
    property:
      'Asking for a lever the engine does not model (for example a Roth conversion) is refused as not modelled; an invalid planPatch is reported with its field paths and no numbers are invented for it.',
  },
  {
    id: 'no-writes',
    property: 'The answer never claims or implies the plan was changed; it says the user applies a variant in the simulator.',
  },
  {
    id: 'no-recommendation',
    property:
      'No variant is called best, optimal or recommended, and no result is phrased as advice, even when the user asks the agent to choose.',
  },
  {
    id: 'budget',
    property:
      'At most 6 variants and at most 12 tool calls in the turn (the tools refuse beyond that), and every reported variant was actually simulated.',
  },
  {
    id: 'assumptions-stated',
    property:
      'The answer ends with the pinned clock and seed, the plan’s own return/inflation/tax assumptions, and the limits that bear on the variants proposed.',
  },
  {
    id: 'monte-carlo-on-request',
    property:
      'Monte Carlo numbers appear only when the eval request asks for probabilistic results, and then as aggregates (500 trials, summary) — never per-trial.',
  },
];
