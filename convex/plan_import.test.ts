// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { planDataFields } from './validators/plan_data_fields';
import { createPlanWithData } from './plans';
import { basicTemplate } from './templates/basic';
import {
  createPlanEnvelope,
  createPlansEnvelope,
  parseEnvelope,
  prepareImport,
  serializeEnvelope,
  toFinancesExport,
  toPlanExport,
  type ExportEnvelope,
  type PlanExport,
} from '../src/lib/export/plan-envelope';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it
// ships with `vite/client`, and referencing that from here would make `vite` an
// unlisted dependency, so the transform's shape is declared locally instead.
const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('./**/*.ts');

const TEST_USER = 'test-user-123';
const EXPORTED_AT = '2026-10-30T12:00:00.000Z';

const GLIDE_PATH = {
  id: 'glide-path-1',
  endTimePoint: { type: 'customAge' as const, age: 65 },
  targetBondAllocation: 60,
  enabled: true,
};

/**
 * The values `TIME_BINDING_FIELDS` expects to survive an export → import round trip.
 *
 * `everyNYears`/`recurrenceYears` (time-point cadence) and `amountBasis` (real vs nominal)
 * are the fields P1-P1 added. They are stored and exported like any other plan field, so the
 * seed plan below carries one of each and the tests read the values back by path.
 */
const TIME_BINDING_FIXTURES = {
  income: { amountBasis: 'nominal', everyNYears: 5, recurrenceYears: 20 },
  expense: { amountBasis: 'nominal', everyNYears: 2, recurrenceYears: 12 },
  debt: { amountBasis: 'nominal', everyNYears: 10, recurrenceYears: 30 },
  physicalAsset: { amountBasis: 'nominal', everyNYears: 4, recurrenceYears: 8 },
} as const;

const SEED_INCOME: Doc<'plans'>['incomes'][number] = {
  id: 'income-1',
  name: 'Consulting',
  amount: 50000,
  frequency: 'yearly',
  timeframe: {
    start: {
      type: 'customAge',
      age: 45,
      everyNYears: TIME_BINDING_FIXTURES.income.everyNYears,
      recurrenceYears: TIME_BINDING_FIXTURES.income.recurrenceYears,
    },
    end: { type: 'atRetirement' },
  },
  taxes: { incomeType: 'wage', withholding: 20 },
  amountBasis: TIME_BINDING_FIXTURES.income.amountBasis,
  disabled: false,
};

const SEED_EXPENSE: Doc<'plans'>['expenses'][number] = {
  id: 'expense-1',
  name: 'Tuition',
  amount: 30000,
  frequency: 'yearly',
  timeframe: {
    start: {
      type: 'customDate',
      year: 2031,
      month: 9,
      everyNYears: TIME_BINDING_FIXTURES.expense.everyNYears,
      recurrenceYears: TIME_BINDING_FIXTURES.expense.recurrenceYears,
    },
    end: { type: 'atLifeExpectancy' },
  },
  amountBasis: TIME_BINDING_FIXTURES.expense.amountBasis,
  disabled: false,
};

function seedPlan(overrides: Partial<Omit<Doc<'plans'>, '_id' | '_creationTime'>> = {}): Omit<Doc<'plans'>, '_id' | '_creationTime'> {
  return {
    ...basicTemplate,
    userId: TEST_USER,
    name: 'Source Plan',
    glidePath: GLIDE_PATH,
    incomes: [SEED_INCOME],
    expenses: [SEED_EXPENSE],
    accounts: [
      { id: 'acc-1', name: 'Brokerage', balance: 42000, type: 'taxableBrokerage', percentBonds: 20, syncedFinanceId: 'finance-asset-1' },
    ],
    debts: [
      {
        id: 'debt-1',
        name: 'Mortgage',
        balance: 250000,
        apr: 4.25,
        interestType: 'compound',
        compoundingFrequency: 'monthly',
        startDate: {
          type: 'customDate',
          year: 2027,
          month: 4,
          everyNYears: TIME_BINDING_FIXTURES.debt.everyNYears,
          recurrenceYears: TIME_BINDING_FIXTURES.debt.recurrenceYears,
        },
        monthlyPayment: 1500,
        amountBasis: TIME_BINDING_FIXTURES.debt.amountBasis,
        syncedFinanceId: 'liability-1',
      },
    ],
    physicalAssets: [
      {
        id: 'asset-1',
        name: 'Cabin',
        assetType: 'other',
        purchaseDate: {
          type: 'customAge',
          age: 50,
          everyNYears: TIME_BINDING_FIXTURES.physicalAsset.everyNYears,
          recurrenceYears: TIME_BINDING_FIXTURES.physicalAsset.recurrenceYears,
        },
        purchasePrice: 300000,
        appreciationRate: 3,
        amountBasis: TIME_BINDING_FIXTURES.physicalAsset.amountBasis,
        paymentMethod: { type: 'cash' },
      },
    ],
    ...overrides,
  };
}

function seedFinances(): Omit<Doc<'finances'>, '_id' | '_creationTime'> {
  return {
    userId: TEST_USER,
    assets: [{ id: 'finance-asset-1', name: 'Brokerage', value: 42000, type: 'taxableBrokerage', updatedAt: 1_700_000_000_000 }],
    liabilities: [{ id: 'liability-1', name: 'Mortgage', balance: 250000, type: 'mortgage', updatedAt: 1_700_000_000_000 }],
  };
}

/** Parses the file and plans the import exactly as the Settings page does. */
function planImport(envelope: ExportEnvelope, existingPlans: Doc<'plans'>[], existingFinances: Doc<'finances'> | null) {
  const parsed = parseEnvelope(serializeEnvelope(envelope));
  if (!parsed.ok) throw new Error(`the export did not parse: ${JSON.stringify(parsed.issues)}`);

  const prepared = prepareImport(
    parsed.envelope,
    { plans: existingPlans, finances: toFinancesExport(existingFinances) },
    { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
  );
  if (!prepared.ok) throw new Error(`the import was refused: ${JSON.stringify(prepared.issues)}`);

  return { envelope: parsed.envelope, prepared };
}

describe('export → import through the real mutations', () => {
  it('restores the plan, its glide path and the finances without losing a field', async () => {
    const t = convexTest(schema, modules);
    const [sourcePlan, sourceFinances, existingPlans] = await t.run(async (ctx) => {
      const planId = await ctx.db.insert('plans', seedPlan());
      await ctx.db.insert('finances', seedFinances());
      const plans = await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .collect();
      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      return [await ctx.db.get(planId), finances, plans] as const;
    });

    const envelope = createPlanEnvelope({ plan: sourcePlan!, finances: toFinancesExport(sourceFinances!), exportedAt: EXPORTED_AT });
    const expectedPlan: PlanExport = toPlanExport(sourcePlan!);

    const { prepared } = planImport(envelope, existingPlans, sourceFinances!);

    const asUser = t.withIdentity({ subject: TEST_USER });
    await asUser.mutation(api.finances.replaceAllFinances, {
      assets: prepared.finances!.assets,
      liabilities: prepared.finances!.liabilities,
      confirmReplace: true,
    });
    for (const plan of prepared.plans) {
      const { name, isDefault: _isDefault, ...planData } = plan;
      await asUser.mutation(api.plans.createPlanWithData, { ...planData, newPlanName: name, isDefault: false });
    }

    await t.run(async (ctx) => {
      const plans = await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .collect();
      const importedDoc = plans.find((plan) => plan._id !== sourcePlan!._id);
      expect(importedDoc).toBeDefined();

      // The whole plan payload survives: every validator field, not just glidePath.
      expect(toPlanExport(importedDoc!)).toStrictEqual(expectedPlan);
      expect(importedDoc!.glidePath).toStrictEqual(GLIDE_PATH);

      // ...including the time-binding fields by value, not merely "the call succeeded".
      expect(importedDoc!.incomes[0].amountBasis).toBe(TIME_BINDING_FIXTURES.income.amountBasis);
      expect(importedDoc!.incomes[0].timeframe.start).toEqual({
        type: 'customAge',
        age: 45,
        everyNYears: TIME_BINDING_FIXTURES.income.everyNYears,
        recurrenceYears: TIME_BINDING_FIXTURES.income.recurrenceYears,
      });
      expect(importedDoc!.expenses[0].amountBasis).toBe(TIME_BINDING_FIXTURES.expense.amountBasis);
      expect(importedDoc!.expenses[0].timeframe.start.everyNYears).toBe(TIME_BINDING_FIXTURES.expense.everyNYears);
      expect(importedDoc!.expenses[0].timeframe.start.recurrenceYears).toBe(TIME_BINDING_FIXTURES.expense.recurrenceYears);
      expect(importedDoc!.debts![0].amountBasis).toBe(TIME_BINDING_FIXTURES.debt.amountBasis);
      expect(importedDoc!.debts![0].startDate.everyNYears).toBe(TIME_BINDING_FIXTURES.debt.everyNYears);
      expect(importedDoc!.debts![0].startDate.recurrenceYears).toBe(TIME_BINDING_FIXTURES.debt.recurrenceYears);
      expect(importedDoc!.physicalAssets![0].amountBasis).toBe(TIME_BINDING_FIXTURES.physicalAsset.amountBasis);
      expect(importedDoc!.physicalAssets![0].purchaseDate.everyNYears).toBe(TIME_BINDING_FIXTURES.physicalAsset.everyNYears);
      expect(importedDoc!.accounts[0].syncedFinanceId).toBe('finance-asset-1');
      expect(importedDoc!.debts![0].syncedFinanceId).toBe('liability-1');

      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      expect(toFinancesExport(finances)).toStrictEqual(toFinancesExport(sourceFinances!));
    });
  });

  it('restores a bulk backup into an empty account', async () => {
    const t = convexTest(schema, modules);
    const [plans, finances] = await t.run(async (ctx) => {
      const first = await ctx.db.insert('plans', seedPlan({ name: 'Plan A' }));
      const second = await ctx.db.insert('plans', seedPlan({ name: 'Plan B', isDefault: false, glidePath: undefined }));
      await ctx.db.insert('finances', seedFinances());
      return [
        [await ctx.db.get(first), await ctx.db.get(second)] as Doc<'plans'>[],
        await ctx.db
          .query('finances')
          .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
          .first(),
      ] as const;
    });

    const envelope = createPlansEnvelope({ plans, finances: toFinancesExport(finances!), exportedAt: EXPORTED_AT });
    const expectedPlans = plans.map(toPlanExport).sort((a, b) => (a.name < b.name ? -1 : 1));

    // Empty the account so the import is the only source of plans and finances.
    await t.run(async (ctx) => {
      for (const plan of await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .collect()) {
        await ctx.db.delete(plan._id);
      }
      const existing = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      if (existing) await ctx.db.delete(existing._id);
    });

    const { prepared } = planImport(envelope, [], null);

    const asUser = t.withIdentity({ subject: TEST_USER });
    await asUser.mutation(api.finances.replaceAllFinances, {
      assets: prepared.finances!.assets,
      liabilities: prepared.finances!.liabilities,
      confirmReplace: true,
    });
    for (const plan of prepared.plans) {
      const { name, isDefault: _isDefault, ...planData } = plan;
      await asUser.mutation(api.plans.createPlanWithData, { ...planData, newPlanName: name, isDefault: false });
    }

    await t.run(async (ctx) => {
      const restored = await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .collect();
      expect(restored.map(toPlanExport).sort((a, b) => (a.name < b.name ? -1 : 1))).toStrictEqual(expectedPlans);

      const financesNow = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      expect(toFinancesExport(financesNow)).toStrictEqual(toFinancesExport(finances!));
    });
  });

  it('declares every plan data field as a createPlanWithData argument', () => {
    // Convex validates a function's arguments from its own `args` validator, and
    // `createPlanWithData` lists each plan field by hand. `convex-test` does not validate
    // arguments at all, so a payload field that is stored and exported but missing from that
    // list would round-trip here and be rejected by the production backend. Compare the two
    // lists directly instead.
    const { exportArgs } = createPlanWithData as unknown as { exportArgs: () => string };
    const argsJson = JSON.parse(exportArgs()) as { type: string; value: Record<string, unknown> };
    const declared = Object.keys(argsJson.value)
      .filter((name) => name !== 'newPlanName')
      .sort();

    // `isDefault` is a document field rather than plan data, but it is an argument too.
    expect(declared).toEqual([...Object.keys(planDataFields), 'isDefault'].sort());
    // The fields this change added are covered by that comparison, but name them so a future
    // rename shows up as a failure here rather than as a silently dropped field.
    expect(Object.keys(planDataFields)).toEqual(expect.arrayContaining(['incomes', 'expenses', 'debts', 'physicalAssets']));
  });

  it('imports a plan exported before the time-binding fields existed', async () => {
    // A plan stored before P1-P1: no `amountBasis` anywhere and no `everyNYears`/
    // `recurrenceYears` on any time point. `basicTemplate` is exactly such a plan.
    const t = convexTest(schema, modules);
    const sourcePlan = await t.run(async (ctx) => {
      const planId = await ctx.db.insert('plans', { ...basicTemplate, userId: TEST_USER, name: 'Legacy Plan' });
      return await ctx.db.get(planId);
    });

    const envelope = createPlanEnvelope({ plan: sourcePlan!, finances: null, exportedAt: EXPORTED_AT });
    const { prepared } = planImport(envelope, [], null);

    const asUser = t.withIdentity({ subject: TEST_USER });
    for (const plan of prepared.plans) {
      const { name, isDefault: _isDefault, ...planData } = plan;
      await asUser.mutation(api.plans.createPlanWithData, { ...planData, newPlanName: name, isDefault: false });
    }

    await t.run(async (ctx) => {
      const plans = await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .collect();
      const importedDoc = plans.find((plan) => plan._id !== sourcePlan!._id);
      expect(importedDoc).toBeDefined();

      expect(toPlanExport(importedDoc!)).toStrictEqual(toPlanExport(sourcePlan!));
      // Absent in the file, absent after import: readers apply the 'real' default, so an old
      // plan keeps simulating exactly as it did.
      expect(importedDoc!.incomes[0].amountBasis).toBeUndefined();
      expect(importedDoc!.incomes[0].timeframe.start.everyNYears).toBeUndefined();
      expect(importedDoc!.debts).toEqual([]);
    });
  });
});
