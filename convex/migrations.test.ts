/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { basicTemplate } from './templates/basic';

const modules = import.meta.glob('./**/*.ts');

/**
 * `backfillOwnerAndHousehold` through its real wiring (parity plan P1-P2).
 *
 * The row's verify column asks for the migration to be exercised, not just its helper: this
 * runs the internal mutation that `migrations.define` produces — its own pagination, its own
 * `ctx.db.patch`, over a real `plans` table — twice. `household_backfill.test.ts` covers the
 * patch computation in isolation; this covers the framework path around it.
 *
 * A plan is constructed here, never read from a data volume.
 */

/** The stored plan as it looked before P1-P2: no owners, no property regimes, no household. */
function legacyPlanDoc(): Omit<Doc<'plans'>, '_id' | '_creationTime' | 'userId' | 'name'> {
  const { household: _household, ...timeline } = basicTemplate.timeline!;
  const withoutOwnership = <T extends { owner?: unknown; propertyRegime?: unknown }>(entity: T): T => {
    const { owner: _owner, propertyRegime: _regime, ...rest } = entity;
    return rest as T;
  };

  return {
    ...basicTemplate,
    timeline,
    accounts: basicTemplate.accounts.map(withoutOwnership),
    incomes: basicTemplate.incomes.map(withoutOwnership),
    expenses: basicTemplate.expenses.map(withoutOwnership),
    // One debt, so the optional collection is exercised too.
    debts: [
      {
        id: 'debt-1',
        name: 'Mortgage',
        balance: 250000,
        apr: 4.25,
        interestType: 'compound',
        compoundingFrequency: 'monthly',
        startDate: { type: 'now' },
        monthlyPayment: 1500,
        disabled: false,
      },
    ],
    physicalAssets: [],
  };
}

/** One batch of the migration, as the CLI's "For real" args would run it. */
const runBackfill = (t: ReturnType<typeof convexTest>) =>
  t.mutation(internal.migrations.backfillOwnerAndHousehold, { cursor: null, dryRun: false });

describe('backfillOwnerAndHousehold runs over a real table', () => {
  it('tags a legacy plan on the first run and leaves it byte-identical on the second', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) =>
      ctx.db.insert('plans', { ...legacyPlanDoc(), userId: 'user-1', name: 'Legacy', isDefault: true })
    );

    // Nothing is tagged before the migration runs.
    const before = await t.run(async (ctx) => (await ctx.db.get(planId))!);
    expect(before.incomes[0]).not.toHaveProperty('owner');
    expect(before.accounts[0]).not.toHaveProperty('owner');
    expect(before.timeline).not.toHaveProperty('household');

    // First run: the framework visits the document and patches it.
    const first = await runBackfill(t);
    expect(first).toMatchObject({ processed: 1, isDone: true });

    const migrated = await t.run(async (ctx) => (await ctx.db.get(planId))!);
    for (const entity of [migrated.accounts[0], migrated.incomes[0], migrated.expenses[0], migrated.debts![0]]) {
      expect(entity.owner).toBe('primary');
    }
    expect(migrated.timeline!.household).toStrictEqual({ members: [{ id: 'primary', role: 'primary' }] });

    // Second run: the same document is visited again and nothing changes, so the stored
    // record is byte-identical — the property that makes re-running runAll safe.
    const second = await runBackfill(t);
    expect(second).toMatchObject({ processed: 1, isDone: true });

    const afterSecondRun = await t.run(async (ctx) => (await ctx.db.get(planId))!);
    expect(afterSecondRun).toStrictEqual(migrated);
  });

  it('leaves a plan that the user already tagged exactly as it was', async () => {
    const t = convexTest(schema, modules);
    const tagged: Omit<Doc<'plans'>, '_id' | '_creationTime' | 'userId' | 'name'> = {
      ...legacyPlanDoc(),
      timeline: {
        ...legacyPlanDoc().timeline!,
        household: {
          members: [
            { id: 'a', role: 'primary' },
            { id: 'b', role: 'partner' },
          ],
        },
      },
      incomes: [{ ...legacyPlanDoc().incomes[0], owner: 'joint', propertyRegime: 'jointTenancy' }],
    };

    const planId = await t.run(async (ctx) => ctx.db.insert('plans', { ...tagged, userId: 'user-1', name: 'Tagged', isDefault: true }));
    const before = await t.run(async (ctx) => (await ctx.db.get(planId))!);

    await runBackfill(t);

    const after = await t.run(async (ctx) => (await ctx.db.get(planId))!);
    // The two tags that were already set are untouched; the collections that had none are
    // tagged, and the household the user described is kept as a couple.
    expect(after.incomes[0]).toStrictEqual(before.incomes[0]);
    expect(after.timeline!.household).toStrictEqual(before.timeline!.household);
    expect(after.accounts[0].owner).toBe('primary');
    expect(after.debts![0].owner).toBe('primary');
  });
});
