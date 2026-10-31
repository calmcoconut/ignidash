/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { basicTemplate } from './templates/basic';

import { conversionsFromConvex, conversionsToConvex } from '../src/lib/utils/data-transformers';
import type { ConversionInputs } from '../src/lib/schemas/inputs/conversion-form-schema';

const modules = import.meta.glob('./**/*.ts');

const TEST_USER = 'test-user-123';
const OTHER_USER = 'other-user-456';

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: TEST_USER, name: 'Test Plan', ...overrides };
}

/**
 * The template's accounts, which every fixture below has to agree with: `account-1` is the 401(k)
 * (tax-deferred), `account-2` the Roth IRA, `account-3` a taxable brokerage and `account-4` savings.
 */
const TAX_DEFERRED = 'account-1';
const ROTH = 'account-2';
const TAXABLE = 'account-3';

/** A fixed-amount conversion that names a year, with the optional label filled in. */
const CONVERSION: ConversionInputs = {
  id: 'conversion-1',
  name: 'Convert 40k',
  fromAccountId: TAX_DEFERRED,
  toAccountId: ROTH,
  year: 2031,
  amount: 40_000,
};

/**
 * A fill-to-bracket conversion that names a time point and an explicit jurisdiction, so the round trip
 * proves the mutation writes the union member and the nested target rather than narrowing them.
 */
const FILL_CONVERSION: ConversionInputs = {
  id: 'conversion-2',
  fromAccountId: TAX_DEFERRED,
  toAccountId: ROTH,
  timePoint: { type: 'atRetirement' },
  // 9.3% is a California bracket (the CA ladder runs 1%–12.3%), so this is a target the rule accepts
  // and the reason the stored object carries `jurisdiction` at all.
  fillToBracket: { targetBracketRate: 0.093, jurisdiction: 'california' },
};

describe('plan Roth conversions', () => {
  it('stores a schedule whole and reads it back through the transformers', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Out: the app's list, through the transformer and the mutation's own validator.
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION, FILL_CONVERSION]) });

    // Back: the query's documents, through the transformer the simulator reads.
    const stored = await asUser.query(api.conversion.get, { planId });
    const back = conversionsFromConvex(stored as Parameters<typeof conversionsFromConvex>[0]);

    expect(back).toStrictEqual([CONVERSION, FILL_CONVERSION]);

    // And the document really holds it, including the fields a run is decided by: the target decides
    // the amount, and the timing decides the year it fires in.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan?.conversions).toStrictEqual([CONVERSION, FILL_CONVERSION]);
      expect(plan?.conversions?.[0].year).toBe(2031);
      expect(plan?.conversions?.[1].timePoint?.type).toBe('atRetirement');
    });
  });

  it('answers an empty list for a plan that has no conversions', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Absent on the document — a plan written before the field existed, which version 14 defines as
    // "no conversions" — and the editor still gets a list to render.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan).not.toHaveProperty('conversions');
    });
    expect(await asUser.query(api.conversion.get, { planId })).toStrictEqual([]);
  });

  it('replaces the whole list, so a removed conversion is gone', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION, FILL_CONVERSION]) });
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([FILL_CONVERSION]) });

    expect(await asUser.query(api.conversion.get, { planId })).toStrictEqual([FILL_CONVERSION]);

    await asUser.mutation(api.conversion.update, { planId, conversions: [] });
    expect(await asUser.query(api.conversion.get, { planId })).toStrictEqual([]);
  });

  it('keeps the undo history: each write snapshots the value it replaced', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // A raw `ctx.db.patch` would leave the first list unrecoverable; `patchPlanWithSnapshot` is what
    // makes the plan undoable.
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION]) });
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([FILL_CONVERSION]) });

    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(2);

    await t.run(async (ctx) => {
      const snapshots = await ctx.db
        .query('planSnapshots')
        .withIndex('by_planId', (q) => q.eq('planId', planId))
        .order('desc')
        .collect();

      // Newest first: the snapshot the second write took holds the first list, and the one the first
      // write took has no conversions at all (that is what the plan held).
      expect(snapshots[0]?.conversions).toStrictEqual([CONVERSION]);
      expect(snapshots[1]).not.toHaveProperty('conversions');
    });
  });

  it('stores an absent optional field as absent, so no name is not an empty name', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { name: _name, ...unnamed } = CONVERSION;
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([unnamed]) });

    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan?.conversions?.[0]).toStrictEqual(unnamed);
      expect(plan?.conversions?.[0]).not.toHaveProperty('name');
    });
  });

  it('keeps a bare-number fill target a number, so the stored union member is not rewritten', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // The schema and the validator both allow `fillToBracket: 0.24` beside the object form, and the
    // engine reads either (`typeof conversion.fillToBracket === 'number'`). Rewriting it into the
    // object form would be a silent edit of a field nobody asked to change.
    const bare: ConversionInputs = { ...FILL_CONVERSION, id: 'conversion-bare', fillToBracket: 0.24 };
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([bare]) });

    const stored = await asUser.query(api.conversion.get, { planId });
    expect('fillToBracket' in stored[0] ? stored[0].fillToBracket : undefined).toBe(0.24);
  });
});

/**
 * The stored document, so a refused write can be shown to have changed nothing. A `t.run` result of
 * `undefined` arrives as `null`, so the absent field is asserted on the document rather than on the
 * run's return value.
 */
async function storedPlan(t: ReturnType<typeof convexTest>, planId: Awaited<ReturnType<typeof makePlanId>>) {
  return t.run(async (ctx) => ctx.db.get(planId));
}

async function makePlanId(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
}

describe('plan Roth conversions: authorization', () => {
  it('refuses to read or write another user’s plan', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asOwner = t.withIdentity({ subject: TEST_USER });
    const asOther = t.withIdentity({ subject: OTHER_USER });

    await asOwner.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION]) });

    await expect(asOther.query(api.conversion.get, { planId })).rejects.toThrow(/Not authorized to access this plan/);
    await expect(asOther.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION]) })).rejects.toThrow(
      /Not authorized to access this plan/
    );

    // The owner's list is what it was: the refused write changed nothing.
    expect(await asOwner.query(api.conversion.get, { planId })).toStrictEqual([CONVERSION]);
  });

  it('requires an authenticated caller', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);

    // `getPlanForCurrentUserOrThrow` refuses a caller with no identity the same way it refuses
    // someone else's plan: the plan's `userId` never matches an absent subject.
    await expect(t.query(api.conversion.get, { planId })).rejects.toThrow(/Not authorized to access this plan/);
    await expect(t.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION]) })).rejects.toThrow(
      /Not authorized to access this plan/
    );
  });
});

describe('plan Roth conversions: plan lifecycle', () => {
  it('is copied by clonePlan, not dropped', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan({ conversions: [CONVERSION, FILL_CONVERSION] })));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const clonedId = await asUser.mutation(api.plans.clonePlan, { newPlanName: 'Clone', planId });

    await t.run(async (ctx) => {
      const cloned = await ctx.db.get(clonedId);
      expect(cloned?.conversions).toStrictEqual([CONVERSION, FILL_CONVERSION]);
    });
  });
});

describe('plan Roth conversions: refusal of a payload the form would never send', () => {
  it.each([
    [
      'a source account the plan does not have',
      { ...CONVERSION, fromAccountId: 'closed-account' },
      /Conversion 1: names closed-account as its source account, and this plan has no such account/,
    ],
    [
      'a destination account the plan does not have',
      { ...CONVERSION, toAccountId: 'closed-account' },
      /names closed-account as its destination account, and this plan has no such account/,
    ],
    ['the same account on both sides', { ...CONVERSION, toAccountId: TAX_DEFERRED }, /as both the source and the destination/],
    ['a destination that is not a Roth account', { ...CONVERSION, toAccountId: TAXABLE }, /which is a Taxable, not a Roth account/],
    ['a source that is not tax-deferred', { ...CONVERSION, fromAccountId: TAXABLE }, /which is a Taxable, not a tax-deferred account/],
    [
      'both a year and a time point',
      { ...CONVERSION, timePoint: { type: 'now' as const } },
      /states both a year \(2031\) and a time point \(now\)/,
    ],
    ['a fractional year', { ...CONVERSION, year: 2031.5 }, /a conversion year is a whole year between 1900 and 2150/],
    ['a negative amount', { ...CONVERSION, amount: -1 }, /cannot be negative/],
    [
      'a fill rate that is not a federal bracket',
      // No `amount`: the two targets are exclusive in the stored union, so this row is a pure
      // fill-to-bracket conversion with a rate no federal bracket has.
      { id: 'conversion-not-a-bracket', fromAccountId: TAX_DEFERRED, toAccountId: ROTH, year: 2031, fillToBracket: 0.5 },
      /there is no 50% federal bracket/,
    ],
  ])('refuses %s, and writes nothing', async (_label, payload, message) => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([payload]) })).rejects.toThrow(message);

    // Nothing was written — not even the snapshot an accepted write would have taken.
    expect(await storedPlan(t, planId)).not.toHaveProperty('conversions');
    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(0);
  });

  it('refuses a conversion with no timing at all, which the engine would never fire', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { year: _year, ...untimed } = CONVERSION;

    await expect(asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([untimed]) })).rejects.toThrow(
      /has neither a year nor a time point/
    );

    expect(await storedPlan(t, planId)).not.toHaveProperty('conversions');
  });

  it('refuses a life-expectancy timing, which the conversion filter has no branch for', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Not a throw in the engine — the row simply never matches — so the refusal is what stops a plan
    // from carrying a conversion that silently converts nothing.
    const lifeExpectancy: ConversionInputs = { ...CONVERSION, year: undefined, timePoint: { type: 'atLifeExpectancy' } };

    await expect(asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([lifeExpectancy]) })).rejects.toThrow(
      /never honours/
    );

    expect(await storedPlan(t, planId)).not.toHaveProperty('conversions');
    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(0);
  });

  it('refuses a custom age with no age and a California rate that is a federal bracket', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const ageless: ConversionInputs = { ...CONVERSION, year: undefined, timePoint: { type: 'customAge' } };
    await expect(asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([ageless]) })).rejects.toThrow(
      /is a custom age with no age/
    );

    // 22% is a federal bracket and not a California one (the CA ladder runs 1%–12.3%), so the same
    // target rate is a different answer depending on the bracket set — the rule reads the data.
    await expect(
      asUser.mutation(api.conversion.update, {
        planId,
        conversions: conversionsToConvex([{ ...FILL_CONVERSION, fillToBracket: { targetBracketRate: 0.22, jurisdiction: 'california' } }]),
      })
    ).rejects.toThrow(/there is no 22% California bracket/);

    expect(await storedPlan(t, planId)).not.toHaveProperty('conversions');
  });

  it('names the bracket the engine would have substituted, so the refusal is actionable', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(
      asUser.mutation(api.conversion.update, {
        planId,
        conversions: conversionsToConvex([{ ...FILL_CONVERSION, fillToBracket: { targetBracketRate: 0.5, jurisdiction: 'federal' } }]),
      })
    ).rejects.toThrow(/the nearest bracket \(37%\)/);
  });

  it('refuses two rows sharing an id, which would fire once between them', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(
      asUser.mutation(api.conversion.update, {
        planId,
        conversions: conversionsToConvex([CONVERSION, { ...CONVERSION, name: 'Second' }]),
      })
    ).rejects.toThrow(/Conversion 2: repeats the id conversion-1 of an earlier row/);

    expect(await storedPlan(t, planId)).not.toHaveProperty('conversions');
  });

  it('leaves an existing schedule alone when a replacement is refused', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([CONVERSION]) });

    await expect(
      asUser.mutation(api.conversion.update, {
        planId,
        conversions: conversionsToConvex([{ ...CONVERSION, fromAccountId: 'closed-account' }]),
      })
    ).rejects.toThrow(/no such account/);

    // The stored list is the one that was already there, and the refused write took no snapshot.
    expect(await asUser.query(api.conversion.get, { planId })).toStrictEqual([CONVERSION]);
    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(1);
  });
});

describe('plan Roth conversions: the timings and targets a run does honour', () => {
  it.each([
    ['a year', { year: 2031, amount: 40_000 }],
    ['this year', { year: undefined, timePoint: { type: 'now' }, amount: 40_000 }],
    ['a custom age', { year: undefined, timePoint: { type: 'customAge', age: 65 }, amount: 40_000 }],
    ['a custom date', { year: undefined, timePoint: { type: 'customDate', month: 1, year: 2033 }, amount: 40_000 }],
    ['a federal bracket', { year: undefined, timePoint: { type: 'atRetirement' }, fillToBracket: { targetBracketRate: 0.24 } }],
    [
      'a California bracket',
      { year: undefined, timePoint: { type: 'atRetirement' }, fillToBracket: { targetBracketRate: 0.093, jurisdiction: 'california' } },
    ],
    ['a bare-number bracket', { year: undefined, timePoint: { type: 'atRetirement' }, fillToBracket: 0.12 }],
  ])('accepts %s', async (_label, body) => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const conversion = Object.fromEntries(
      Object.entries({ id: 'conversion-ok', fromAccountId: TAX_DEFERRED, toAccountId: ROTH, ...body }).filter(
        ([, value]) => value !== undefined
      )
    ) as ConversionInputs;
    await asUser.mutation(api.conversion.update, { planId, conversions: conversionsToConvex([conversion]) });

    expect(await asUser.query(api.conversion.get, { planId })).toStrictEqual([conversion]);
  });
});
