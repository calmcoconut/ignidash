/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { basicTemplate } from './templates/basic';

import { milestonesFromConvex, milestonesToConvex } from '../src/lib/utils/data-transformers';
import type { MilestoneInputs } from '../src/lib/schemas/inputs/milestone-form-schema';

const modules = import.meta.glob('./**/*.ts');

const TEST_USER = 'test-user-123';

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: TEST_USER, name: 'Test Plan', ...overrides };
}

const MILESTONE: MilestoneInputs = {
  id: 'net-worth-goal',
  name: 'Net worth goal',
  condition: {
    op: 'and',
    children: [
      { metric: 'netWorth', operator: '>=', value: 1_000_000 },
      { metric: 'account', accountId: 'account-1', operator: '>', value: 100_000 },
    ],
  },
  references: [],
};

/** A plan whose milestones round-trip through the database, both ways. */
describe('plan milestones', () => {
  it('stores a milestone whole and reads it back through the transformers', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Out: the app's list, through the transformer and the mutation's own validator.
    await asUser.mutation(api.milestones.update, { planId, milestones: milestonesToConvex([MILESTONE]) });

    // Back: the query's documents, through the transformer the simulator reads.
    const stored = await asUser.query(api.milestones.get, { planId });
    const back = milestonesFromConvex(stored as Parameters<typeof milestonesFromConvex>[0]);

    expect(back).toStrictEqual([MILESTONE]);

    // And the document really holds it, rather than the query inventing it.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan?.milestones).toStrictEqual([MILESTONE]);
    });
  });

  it('answers an empty list for a plan that has no milestones', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Absent on the document — a plan written before the field existed — and the editor still gets
    // a list to render.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan).not.toHaveProperty('milestones');
    });
    expect(await asUser.query(api.milestones.get, { planId })).toStrictEqual([]);
  });

  it('replaces the whole list, so a removed milestone is gone', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    await asUser.mutation(api.milestones.update, { planId, milestones: milestonesToConvex([MILESTONE]) });
    await asUser.mutation(api.milestones.update, { planId, milestones: [] });

    expect(await asUser.query(api.milestones.get, { planId })).toStrictEqual([]);
  });

  it('is copied by clonePlan, not dropped', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan({ milestones: [MILESTONE] })));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const clonedId = await asUser.mutation(api.plans.clonePlan, { newPlanName: 'Clone', planId });

    await t.run(async (ctx) => {
      const cloned = await ctx.db.get(clonedId);
      expect(cloned?.milestones).toStrictEqual([MILESTONE]);
    });
  });

  /** The stored tree is depth-bounded: a Convex validator cannot be cyclic. */
  it('refuses a condition nested deeper than the stored three levels', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const leaf: MilestoneInputs['condition'] = { metric: 'age', operator: '>=', value: 65 };
    const nest = (depth: number): MilestoneInputs['condition'] => (depth === 0 ? leaf : { op: 'and', children: [nest(depth - 1)] });

    await asUser.mutation(api.milestones.update, { planId, milestones: milestonesToConvex([{ ...MILESTONE, condition: nest(3) }]) });
    await expect(
      asUser.mutation(api.milestones.update, { planId, milestones: milestonesToConvex([{ ...MILESTONE, condition: nest(4) }]) })
    ).rejects.toThrow();
  });
});
