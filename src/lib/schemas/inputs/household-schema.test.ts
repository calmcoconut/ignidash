import { describe, expect, it } from 'vitest';

import { simulatorSchema } from './simulator-schema';
import {
  householdSchema,
  isCoupleHousehold,
  ownerOf,
  ownerSchema,
  propertyRegimeOf,
  ownershipForStorage,
  propertyRegimeSchema,
  SINGLE_MEMBER_HOUSEHOLD,
} from './household-schema';

/**
 * Ownership and household (parity plan P1-P2, E1/E2/F10).
 *
 * The point of these tests is the backward-compatible half: a plan written before this module
 * existed carries no `owner`, no `propertyRegime` and no `household`, and every reader must
 * read it as "the plan's owner, alone". The new half is small: three owner values, a regime
 * that only applies to joint property, and a household of one or two members.
 */

/** A plan as stored before P1-P2: no owner, no regime, no household anywhere. */
const LEGACY_PLAN = {
  timeline: { birthMonth: 1, birthYear: 1990, lifeExpectancy: 87, retirementStrategy: { type: 'fixedAge' as const, retirementAge: 65 } },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 100000,
      frequency: 'yearly' as const,
      timeframe: { start: { type: 'now' as const }, end: { type: 'atRetirement' as const } },
      taxes: { incomeType: 'wage' as const, withholding: 20 },
      disabled: false,
    },
  },
  accounts: {
    brokerage: { id: 'brokerage', name: 'Brokerage', balance: 50000, type: 'taxableBrokerage' as const, percentBonds: 20 },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living',
      amount: 40000,
      frequency: 'yearly' as const,
      timeframe: { start: { type: 'now' as const }, end: { type: 'atLifeExpectancy' as const } },
      disabled: false,
    },
  },
  debts: {
    card: {
      id: 'card',
      name: 'Card',
      balance: 5000,
      apr: 20,
      interestType: 'simple' as const,
      startDate: { type: 'now' as const },
      monthlyPayment: 250,
      disabled: false,
    },
  },
  physicalAssets: {
    house: {
      id: 'house',
      name: 'House',
      assetType: 'other' as const,
      purchaseDate: { type: 'now' as const },
      purchasePrice: 400000,
      appreciationRate: 3,
      saleDate: { type: 'atLifeExpectancy' as const },
      paymentMethod: { type: 'cash' as const },
    },
  },
  contributionRules: {},
  baseContributionRule: { type: 'save' as const },
  marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
  taxSettings: { filingStatus: 'single' as const },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 9521, simulationMode: 'fixedReturns' as const },
};

describe('the schema values', () => {
  it('accepts exactly three owners and two property regimes', () => {
    for (const owner of ['primary', 'partner', 'joint'] as const) expect(ownerSchema.parse(owner)).toBe(owner);
    for (const regime of ['community', 'jointTenancy'] as const) expect(propertyRegimeSchema.parse(regime)).toBe(regime);

    expect(ownerSchema.safeParse('spouse').success).toBe(false);
    expect(propertyRegimeSchema.safeParse('separate').success).toBe(false);
  });

  it('describes a household of one or two distinct members', () => {
    expect(householdSchema.safeParse(SINGLE_MEMBER_HOUSEHOLD).success).toBe(true);
    expect(
      householdSchema.safeParse({
        members: [
          { id: 'a', role: 'primary' },
          { id: 'b', role: 'partner' },
        ],
      }).success
    ).toBe(true);

    // No empty household, no two partners, no third member.
    expect(householdSchema.safeParse({ members: [] }).success).toBe(false);
    expect(
      householdSchema.safeParse({
        members: [
          { id: 'a', role: 'partner' },
          { id: 'b', role: 'partner' },
        ],
      }).success
    ).toBe(false);
    expect(
      householdSchema.safeParse({
        members: [
          { id: 'a', role: 'primary' },
          { id: 'b', role: 'partner' },
          { id: 'c', role: 'primary' },
        ],
      }).success
    ).toBe(false);
  });
});

describe('the readers default for a plan that predates ownership', () => {
  it('reads a missing owner as primary', () => {
    expect(ownerOf({})).toBe('primary');
    expect(ownerOf({ owner: undefined })).toBe('primary');
    expect(ownerOf({ owner: 'partner' })).toBe('partner');
    expect(ownerOf({ owner: 'joint' })).toBe('joint');
  });

  it('gives a regime only to joint property, community by default', () => {
    expect(propertyRegimeOf({})).toBeUndefined();
    expect(propertyRegimeOf({ owner: 'primary' })).toBeUndefined();
    expect(propertyRegimeOf({ owner: 'partner' })).toBeUndefined();
    // California: joint means community unless tagged otherwise (E2).
    expect(propertyRegimeOf({ owner: 'joint' })).toBe('community');
    expect(propertyRegimeOf({ owner: 'joint', propertyRegime: 'community' })).toBe('community');
    expect(propertyRegimeOf({ owner: 'joint', propertyRegime: 'jointTenancy' })).toBe('jointTenancy');
    // A regime left on an item that is no longer joint is ignored, not honoured.
    expect(propertyRegimeOf({ owner: 'primary', propertyRegime: 'jointTenancy' })).toBeUndefined();
  });

  it('treats a missing household as one person and a two-member household as a couple', () => {
    expect(isCoupleHousehold(undefined)).toBe(false);
    expect(isCoupleHousehold(SINGLE_MEMBER_HOUSEHOLD)).toBe(false);
    expect(
      isCoupleHousehold({
        members: [
          { id: 'a', role: 'primary' },
          { id: 'b', role: 'partner' },
        ],
      })
    ).toBe(true);
  });
});

describe('an old plan loads unchanged', () => {
  it('parses without owner, propertyRegime or household, and every entity reads as primary', () => {
    const parsed = simulatorSchema.parse(LEGACY_PLAN);

    expect(parsed.timeline?.household).toBeUndefined();
    expect(isCoupleHousehold(parsed.timeline?.household)).toBe(false);

    for (const entity of [
      ...Object.values(parsed.incomes),
      ...Object.values(parsed.accounts),
      ...Object.values(parsed.expenses),
      ...Object.values(parsed.debts),
      ...Object.values(parsed.physicalAssets),
    ]) {
      expect(entity).not.toHaveProperty('owner');
      expect(ownerOf(entity)).toBe('primary');
      expect(propertyRegimeOf(entity)).toBeUndefined();
    }
  });

  it('accepts the new fields where they are meaningful', () => {
    const parsed = simulatorSchema.parse({
      ...LEGACY_PLAN,
      timeline: {
        ...LEGACY_PLAN.timeline,
        household: {
          members: [
            { id: 'a', role: 'primary' },
            { id: 'b', role: 'partner' },
          ],
        },
      },
      incomes: { salary: { ...LEGACY_PLAN.incomes.salary, owner: 'partner' } },
      physicalAssets: { house: { ...LEGACY_PLAN.physicalAssets.house, owner: 'joint', propertyRegime: 'jointTenancy' } },
    });

    expect(isCoupleHousehold(parsed.timeline?.household)).toBe(true);
    expect(ownerOf(parsed.incomes.salary)).toBe('partner');
    expect(propertyRegimeOf(parsed.physicalAssets.house)).toBe('jointTenancy');
  });

  it('rejects an owner outside the enum rather than coercing it', () => {
    expect(
      simulatorSchema.safeParse({ ...LEGACY_PLAN, incomes: { salary: { ...LEGACY_PLAN.incomes.salary, owner: 'spouse' } } }).success
    ).toBe(false);
  });
});

describe('ownershipForStorage', () => {
  it('writes the owner explicitly and keeps a regime only for joint property', () => {
    expect(ownershipForStorage({ id: 'x' })).toEqual({ id: 'x', owner: 'primary', propertyRegime: undefined });
    expect(ownershipForStorage({ id: 'x', owner: 'partner' })).toEqual({ id: 'x', owner: 'partner', propertyRegime: undefined });
    // Joint with nothing stored: California's community-property default becomes explicit.
    expect(ownershipForStorage({ id: 'x', owner: 'joint' })).toEqual({ id: 'x', owner: 'joint', propertyRegime: 'community' });
    expect(ownershipForStorage({ id: 'x', owner: 'joint', propertyRegime: 'jointTenancy' })).toEqual({
      id: 'x',
      owner: 'joint',
      propertyRegime: 'jointTenancy',
    });
    // Switching an item back to a single owner drops the stale regime.
    expect(ownershipForStorage({ id: 'x', owner: 'primary', propertyRegime: 'community' })).toEqual({
      id: 'x',
      owner: 'primary',
      propertyRegime: undefined,
    });
  });
});
