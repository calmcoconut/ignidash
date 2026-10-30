import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import {
  TEST_CLOCK,
  create401kAccount,
  createContributionRule,
  createDebtInput,
  createDefaultTimeline,
  createExpenseInput,
  createLivingExpense,
  createPhysicalAssetInput,
  createSavingsAccount,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * Ownership and household are metadata, not inputs to the model (parity plan P1-P2).
 *
 * P1-P3 is what starts reading `owner` (per-owner RMD age, survivor rules, per-owner totals).
 * Until then the only acceptable effect of this item on a simulation is **none**: a plan that
 * carries `owner`, `propertyRegime` and a two-member `household` must produce the same numbers,
 * to the last cent, as the same plan with those fields absent. That is also what makes the
 * frozen golden corpus safe across the migration — no golden can move, because nothing reads
 * the new fields.
 */

/** A complete plan with no ownership anywhere: the shape every stored plan had before P1-P2. */
function legacyPlan(): SimulatorInputs {
  return {
    timeline: createDefaultTimeline(),
    incomes: {
      salary: createWageIncome({ id: 'salary', amount: 120000, timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } } }),
    },
    expenses: {
      living: createLivingExpense({
        id: 'living',
        amount: 45000,
        timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
      }),
      extra: createExpenseInput({ id: 'extra', amount: 6000, frequency: 'yearly', timeframe: { start: { type: 'now' }, end: undefined } }),
    },
    debts: { card: createDebtInput({ id: 'card', balance: 12000, monthlyPayment: 400 }) },
    physicalAssets: { house: createPhysicalAssetInput({ id: 'house', purchasePrice: 450000, purchaseDate: { type: 'now' } }) },
    accounts: {
      savings: createSavingsAccount({ balance: 40000 }),
      retirement: create401kAccount({ balance: 220000 }),
    },
    contributionRules: {
      match: createContributionRule({ id: 'match', accountId: '401k-1', contributionType: 'dollarAmount', dollarAmount: 12000 }),
    },
    baseContributionRule: { type: 'save' },
    marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
    taxSettings: { filingStatus: 'marriedFilingJointly' },
    privacySettings: { isPrivate: true },
    simulationSettings: { simulationSeed: 9521, simulationMode: 'fixedReturns' },
  };
}

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

describe('a plan with no ownership simulates exactly as it did', () => {
  it('adds no new fields to a legacy plan when read through the schema', () => {
    const plan = legacyPlan();

    expect(plan.timeline?.household).toBeUndefined();
    for (const entity of [
      ...Object.values(plan.incomes),
      ...Object.values(plan.accounts),
      ...Object.values(plan.expenses),
      ...Object.values(plan.debts),
      ...Object.values(plan.physicalAssets),
    ]) {
      expect(entity).not.toHaveProperty('owner');
      expect(entity).not.toHaveProperty('propertyRegime');
    }
  });

  it('produces byte-identical results with and without owner, regime and household', () => {
    const plain = legacyPlan();

    // The same plan, fully tagged: a couple, with a mix of primary / partner / joint items and
    // both property regimes. If the engine read any of it, the numbers would move here.
    const tagged: SimulatorInputs = {
      ...plain,
      timeline: {
        ...plain.timeline!,
        household: {
          members: [
            { id: 'primary', role: 'primary' },
            { id: 'partner', role: 'partner' },
          ],
        },
      },
      incomes: { salary: { ...plain.incomes.salary, owner: 'partner' } },
      expenses: {
        living: { ...plain.expenses.living, owner: 'joint', propertyRegime: 'community' },
        extra: { ...plain.expenses.extra, owner: 'primary' },
      },
      debts: { card: { ...plain.debts.card, owner: 'joint', propertyRegime: 'jointTenancy' } },
      physicalAssets: { house: { ...plain.physicalAssets.house, owner: 'joint', propertyRegime: 'community' } },
      accounts: {
        savings: { ...plain.accounts.savings, owner: 'partner' },
        retirement: { ...plain.accounts.retirement, owner: 'joint', propertyRegime: 'community' },
      },
    };

    expect(run(tagged)).toStrictEqual(run(plain));
  });

  it('leaves the plan untouched by the run itself', () => {
    // The engine copies what it needs; a shared object with an owner on it must not be mutated
    // into a different shape by a simulation (P1-P3 will read these fields later).
    const tagged = legacyPlan();
    tagged.incomes.salary = { ...tagged.incomes.salary, owner: 'partner' };
    const before = structuredClone(tagged);

    run(tagged);

    expect(tagged).toStrictEqual(before);
  });
});
