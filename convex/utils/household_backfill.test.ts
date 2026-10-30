// @vitest-environment edge-runtime
import { describe, expect, it } from 'vitest';

import { SINGLE_MEMBER_HOUSEHOLD as SCHEMA_SINGLE_MEMBER_HOUSEHOLD } from '../../src/lib/schemas/inputs/household-schema';

import { backfillPatch, SINGLE_MEMBER_HOUSEHOLD } from './household_backfill';

/**
 * The `backfillOwnerAndHousehold` migration (parity plan P1-P2).
 *
 * Tested as a pure function over constructed documents — no data volume, no Convex runtime —
 * because that is exactly what the migration body is: `migrations.define({ table: 'plans',
 * migrateOne: (ctx, plan) => backfillPatch(plan) })`. What matters is that it is additive
 * (never overwrites a tag a user set) and idempotent (the second run writes nothing).
 */

/** A plan as stored before P1-P2: no owner, no regime, no household. */
function legacyPlan() {
  return {
    timeline: {
      birthMonth: 1,
      birthYear: 1990,
      lifeExpectancy: 87,
      retirementStrategy: { type: 'fixedAge' as const, retirementAge: 65 },
    },
    accounts: [{ id: 'acc-1', name: 'Brokerage', balance: 50000, type: 'taxableBrokerage' as const, percentBonds: 20 }],
    incomes: [
      {
        id: 'inc-1',
        name: 'Salary',
        amount: 100000,
        frequency: 'yearly' as const,
        timeframe: { start: { type: 'now' as const }, end: { type: 'atRetirement' as const } },
        taxes: { incomeType: 'wage' as const, withholding: 20 },
        disabled: false,
      },
    ],
    expenses: [
      {
        id: 'exp-1',
        name: 'Living',
        amount: 40000,
        frequency: 'yearly' as const,
        timeframe: { start: { type: 'now' as const }, end: { type: 'atLifeExpectancy' as const } },
        disabled: false,
      },
    ],
    debts: [
      {
        id: 'debt-1',
        name: 'Mortgage',
        balance: 250000,
        apr: 4.25,
        interestType: 'compound' as const,
        compoundingFrequency: 'monthly' as const,
        startDate: { type: 'now' as const },
        monthlyPayment: 1500,
        disabled: false,
      },
    ],
    physicalAssets: [
      {
        id: 'asset-1',
        name: 'Cabin',
        assetType: 'other' as const,
        purchaseDate: { type: 'now' as const },
        purchasePrice: 300000,
        appreciationRate: 3,
        saleDate: { type: 'atLifeExpectancy' as const },
        paymentMethod: { type: 'cash' as const },
      },
    ],
  };
}

/** The migration hands `backfillPatch` a whole plan document; the cast supplies the document id. */
const asPlan = (plan: ReturnType<typeof legacyPlan>) => plan as unknown as Parameters<typeof backfillPatch>[0];
/** Applying a patch the way `ctx.db.patch` does, for the second-run comparison. */
const applyPatch = (plan: ReturnType<typeof legacyPlan>, patch: NonNullable<ReturnType<typeof backfillPatch>>) =>
  ({ ...plan, ...patch }) as ReturnType<typeof legacyPlan>;

describe('the household this migration writes', () => {
  it('is the same literal the app reads, so the two copies cannot drift', () => {
    // The duplication is deliberate — Convex functions may only import from `convex/`, so the
    // migration cannot import `src/lib/schemas/inputs/household-schema.ts`. This test is what
    // keeps the copies equal: the app's `isCoupleHousehold`, the timeline drawer's default and
    // the migration's backfill must all describe the same single member.
    expect(SINGLE_MEMBER_HOUSEHOLD).toStrictEqual(SCHEMA_SINGLE_MEMBER_HOUSEHOLD);
  });
});

describe('backfillOwnerAndHousehold', () => {
  it('tags every entity of a plan that has no ownership at all', () => {
    const patch = backfillPatch(asPlan(legacyPlan()));

    expect(patch).toBeDefined();
    if (!patch) return;

    // Primary for each collection, so the stored data says what the readers assumed.
    expect(patch.accounts?.map((entity) => entity.owner)).toEqual(['primary']);
    expect(patch.incomes?.map((entity) => entity.owner)).toEqual(['primary']);
    expect(patch.expenses?.map((entity) => entity.owner)).toEqual(['primary']);
    expect(patch.debts?.map((entity) => entity.owner)).toEqual(['primary']);
    expect(patch.physicalAssets?.map((entity) => entity.owner)).toEqual(['primary']);

    // The plan becomes one explicit member (E1).
    expect(patch.timeline?.household).toEqual(SINGLE_MEMBER_HOUSEHOLD);

    // A `primary` item carries no property regime.
    expect(patch.incomes?.[0]).not.toHaveProperty('propertyRegime');
  });

  it('adds the community-property default to a joint item that has no regime (E2)', () => {
    const plan = legacyPlan();
    const joint = { ...plan, physicalAssets: [{ ...plan.physicalAssets[0], owner: 'joint' as const }] };

    const patch = backfillPatch(asPlan(joint));
    expect(patch?.physicalAssets?.[0]).toMatchObject({ owner: 'joint', propertyRegime: 'community' });
  });

  it('never overwrites an owner, a regime or a household the user already set', () => {
    const plan = legacyPlan();
    const tagged = {
      ...plan,
      timeline: {
        ...plan.timeline,
        household: {
          members: [
            { id: 'a', role: 'primary' as const },
            { id: 'b', role: 'partner' as const },
          ],
        },
      },
      accounts: [{ ...plan.accounts[0], owner: 'partner' as const }],
      incomes: [{ ...plan.incomes[0], owner: 'joint' as const, propertyRegime: 'jointTenancy' as const }],
      expenses: [{ ...plan.expenses[0], owner: 'primary' as const }],
      // Debts and assets already tagged too, so nothing at all is left to write.
      debts: [{ ...plan.debts[0], owner: 'partner' as const }],
      physicalAssets: [{ ...plan.physicalAssets[0], owner: 'joint' as const, propertyRegime: 'community' as const }],
    };

    // Every field is already present: the migration writes nothing.
    expect(backfillPatch(asPlan(tagged))).toBeUndefined();
  });

  it('is idempotent: a second run leaves the documents byte-identical', () => {
    const plan = legacyPlan();
    const first = backfillPatch(asPlan(plan));

    expect(first).toBeDefined();
    if (!first) return;

    const migrated = applyPatch(plan, first);

    // Second run: nothing to do, so nothing is written.
    expect(backfillPatch(asPlan(migrated))).toBeUndefined();

    // And the documents are unchanged, not merely unreported: a would-be second patch, if one
    // were ever produced, would have to equal the first.
    expect(migrated).toStrictEqual({ ...plan, ...first });
  });

  it('leaves a plan with no debts or assets alone in those collections, and needs no write at all when everything is tagged', () => {
    const plan = legacyPlan();
    const { debts: _debts, physicalAssets: _physicalAssets, ...withoutOptional } = plan;
    const patch = backfillPatch(asPlan(withoutOptional as typeof plan));

    expect(patch?.debts).toBeUndefined();
    expect(patch?.physicalAssets).toBeUndefined();
    expect(patch?.accounts?.map((entity) => entity.owner)).toEqual(['primary']);
  });

  it('records no household on a plan with no timeline', () => {
    const plan = legacyPlan();
    // `timeline: null` is a valid stored plan (`v.union(timelineValidator, v.null())`), which
    // the fixture type above does not model.
    const withoutTimeline = { ...plan, timeline: null } as unknown as ReturnType<typeof legacyPlan>;
    const patch = backfillPatch(asPlan(withoutTimeline));

    expect(patch?.timeline).toBeUndefined();
    expect(patch?.incomes?.map((entity) => entity.owner)).toEqual(['primary']);
  });
});
