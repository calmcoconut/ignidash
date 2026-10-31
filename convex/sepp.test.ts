/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { basicTemplate } from './templates/basic';

import { seppFromConvex, seppToConvex } from '../src/lib/utils/data-transformers';
import type { SeppScheduleInputs } from '../src/lib/schemas/inputs/sepp-form-schema';
import { seppRateCapForStartYear } from '../src/lib/schemas/inputs/sepp-form-schema';

const modules = import.meta.glob('./**/*.ts');

const TEST_USER = 'test-user-123';

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: TEST_USER, name: 'Test Plan', ...overrides };
}

/**
 * A schedule that exercises every optional field, so the round trip proves the mutation writes them
 * rather than silently narrowing to the required four.
 */
const SCHEDULE: SeppScheduleInputs = {
  id: 'sepp-1',
  name: 'IRA 72(t)',
  accountId: basicTemplate.accounts[0].id,
  method: 'fixedAmortization',
  // 2026, not 2027: a fixed method is priced from the Notice 2022-6 rates, whose vendored months
  // stop at 2026-11, so `seppRateWindowProblem` refuses a 2027 start (asserted below).
  startYear: 2026,
  rate: 0.05,
  annualAmount: 25_000,
  stopYear: 2032,
  disabled: false,
};

describe('plan SEPP schedules', () => {
  it('stores a schedule whole and reads it back through the transformers', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Out: the app's list, through the transformer and the mutation's own validator.
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) });

    // Back: the query's documents, through the transformer the simulator reads.
    const stored = await asUser.query(api.sepp.get, { planId });
    const back = seppFromConvex(stored as Parameters<typeof seppFromConvex>[0]);

    expect(back).toStrictEqual([SCHEDULE]);

    // And the document really holds it — including the fields a run is decided by: `stopYear` ends
    // the series (and triggers the §72(t)(4) recapture test), so a mutation that dropped it would
    // pay forever.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan?.sepp).toStrictEqual([SCHEDULE]);
      expect(plan?.sepp?.[0].stopYear).toBe(2032);
    });
  });

  it('answers an empty list for a plan that has no SEPP schedules', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    // Absent on the document — a plan written before the field existed — and the editor still gets
    // a list to render.
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan).not.toHaveProperty('sepp');
    });
    expect(await asUser.query(api.sepp.get, { planId })).toStrictEqual([]);
  });

  it('replaces the whole list, so a removed schedule is gone', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) });
    await asUser.mutation(api.sepp.update, { planId, sepp: [] });

    expect(await asUser.query(api.sepp.get, { planId })).toStrictEqual([]);
  });

  it('keeps the undo history: each write snapshots the value it replaced', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const replacement: SeppScheduleInputs = { ...SCHEDULE, id: 'sepp-2', method: 'rmd', rate: undefined, startYear: 2028 };

    // A raw `ctx.db.patch` would leave the first schedule unrecoverable; `patchPlanWithSnapshot`
    // is what makes the plan undoable.
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) });
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([replacement]) });

    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(2);

    await t.run(async (ctx) => {
      const snapshots = await ctx.db
        .query('planSnapshots')
        .withIndex('by_planId', (q) => q.eq('planId', planId))
        .order('desc')
        .collect();

      // Newest first: the snapshot the second write took holds the first schedule, and the one the
      // first write took has no schedules at all (that is what the plan held).
      expect(snapshots[0]?.sepp).toStrictEqual([SCHEDULE]);
      expect(snapshots[1]).not.toHaveProperty('sepp');
    });
  });

  it('stores an absent optional field as absent, so "no stop year" is not year zero', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan()));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { stopYear: _stopYear, rate: _rate, annualAmount: _annualAmount, ...openEnded } = SCHEDULE;
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([openEnded]) });

    await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      expect(plan?.sepp?.[0]).toStrictEqual(openEnded);
      expect(plan?.sepp?.[0]).not.toHaveProperty('stopYear');
    });
  });
});

const OTHER_USER = 'other-user-456';

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

describe('plan SEPP schedules: authorization', () => {
  it('refuses to read or write another user’s plan', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asOwner = t.withIdentity({ subject: TEST_USER });
    const asOther = t.withIdentity({ subject: OTHER_USER });

    await asOwner.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) });

    await expect(asOther.query(api.sepp.get, { planId })).rejects.toThrow(/Not authorized to access this plan/);
    await expect(asOther.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) })).rejects.toThrow(
      /Not authorized to access this plan/
    );

    // The owner's list is what it was: the refused write changed nothing.
    expect(await asOwner.query(api.sepp.get, { planId })).toStrictEqual([SCHEDULE]);
  });

  it('requires an authenticated caller', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);

    // `getPlanForCurrentUserOrThrow` refuses a caller with no identity the same way it refuses
    // someone else's plan: the plan's `userId` never matches an absent subject.
    await expect(t.query(api.sepp.get, { planId })).rejects.toThrow(/Not authorized to access this plan/);
    await expect(t.mutation(api.sepp.update, { planId, sepp: seppToConvex([SCHEDULE]) })).rejects.toThrow(
      /Not authorized to access this plan/
    );
  });
});

describe('plan SEPP schedules: plan lifecycle', () => {
  it('is copied by clonePlan, not dropped', async () => {
    const t = convexTest(schema, modules);
    const planId = await t.run(async (ctx) => ctx.db.insert('plans', makePlan({ sepp: [SCHEDULE] })));
    const asUser = t.withIdentity({ subject: TEST_USER });

    const clonedId = await asUser.mutation(api.plans.clonePlan, { newPlanName: 'Clone', planId });

    await t.run(async (ctx) => {
      const cloned = await ctx.db.get(clonedId);
      expect(cloned?.sepp).toStrictEqual([SCHEDULE]);
    });
  });
});

describe('plan SEPP schedules: refusal of a payload the form would never send', () => {
  it.each([
    ['a fractional start year', { startYear: 2027.5 }, /whole start year/],
    ['a start year outside the schema range', { startYear: 2201 }, /must be between 1900 and 2200/],
    ['a rate above 100%', { rate: 1.5 }, /rate is a decimal between 0 and 1/],
    ['a negative annual amount', { annualAmount: -1 }, /annual amount cannot be negative/],
    ['a fractional stop year', { stopYear: 2032.5 }, /stop year must be a whole year/],
  ])('refuses %s', async (_label, override, message) => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, ...override }]) })).rejects.toThrow(message);

    // Nothing was written — not even the snapshot an accepted write would have taken.
    expect(await storedPlan(t, planId)).not.toHaveProperty('sepp');
    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(0);
  });

  it('refuses a fixed-method start year the vendored rates cannot price, and says which years they cover', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    // The engine prices a fixed method from `${startYear}-01` and throws when either of the two
    // months before it is not vendored; the tables stop at 2026-11, so 2027 has no rate.
    await expect(asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, startYear: 2027 }]) })).rejects.toThrow(
      /Fixed amortization can only start in 2022–2026: .*2027 has no rate to price from/
    );

    expect(await storedPlan(t, planId)).not.toHaveProperty('sepp');

    // The RMD method reads no rate, so the same year is a legitimate schedule. The rate is dropped
    // rather than stored as `undefined` — a present-but-undefined key is not the same document as a
    // missing one, which is why the editor drops it for an RMD row too.
    const { rate: _rate, ...rmdSchedule } = { ...SCHEDULE, method: 'rmd' as const, startYear: 2027 };
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([rmdSchedule]) });
    expect(await asUser.query(api.sepp.get, { planId })).toStrictEqual([rmdSchedule]);
  });

  it('refuses a fixed-method rate above the Notice 2022-6 cap, and writes nothing', async () => {
    const t = convexTest(schema, modules);
    const planId = await makePlanId(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    // 2024's window reads 2023-12 (4.82 %) and 2023-11 (4.69 %), so the cap is 120 % of 4.82 % =
    // 5.784 %. `seppAnnualAmountFromTables` throws on anything above it from inside the run, which
    // happens during render — the same unsurvivable place an unpriceable start year throws from.
    await expect(
      asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, startYear: 2024, rate: 0.06 }]) })
    ).rejects.toThrow(/A rate of 6% is above the Notice 2022-6 maximum for a 2024 start \(5\.78%\): .*the 2023-12 rate is 4\.82%/);

    expect(await storedPlan(t, planId)).not.toHaveProperty('sepp');
    // Nothing was written — not even the snapshot an accepted write would have taken.
    expect(await asUser.query(api.plan_snapshots.getCountOfSnapshots, { planId })).toBe(0);

    // The boundary: the engine's own cap is accepted, and so is 5.5 % — above the statute's 5 % floor
    // but below 2024's higher cap, which is what shows the cap is read from the data.
    const cap = seppRateCapForStartYear(2024)?.maximumRate ?? Number.NaN;
    expect(cap).toBeGreaterThan(0.05);
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, startYear: 2024, rate: cap }]) });
    expect(await asUser.query(api.sepp.get, { planId })).toStrictEqual([{ ...SCHEDULE, startYear: 2024, rate: cap }]);

    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, startYear: 2024, rate: 0.055 }]) });
    expect((await asUser.query(api.sepp.get, { planId }))[0].rate).toBe(0.055);

    // 2026's window is under the 5 % floor, so its cap is exactly 5 %: the same 5.5 % is refused
    // there, and the refusal leaves the stored schedule alone.
    await expect(
      asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([{ ...SCHEDULE, startYear: 2026, rate: 0.055 }]) })
    ).rejects.toThrow(/A rate of 5\.5% is above the Notice 2022-6 maximum for a 2026 start \(5\.00%\)/);
    expect((await asUser.query(api.sepp.get, { planId }))[0]).toMatchObject({ startYear: 2024, rate: 0.055 });

    // An RMD row is never refused for a rate the method does not read: the editor drops such a rate,
    // but a payload that carries one is not invalid plan data, and refusing it would be a rule the
    // engine does not have.
    const rmdWithStrayRate: SeppScheduleInputs = { ...SCHEDULE, method: 'rmd', startYear: 2026, rate: 0.5 };
    await asUser.mutation(api.sepp.update, { planId, sepp: seppToConvex([rmdWithStrayRate]) });
    expect(await asUser.query(api.sepp.get, { planId })).toStrictEqual([rmdWithStrayRate]);
  });
});
