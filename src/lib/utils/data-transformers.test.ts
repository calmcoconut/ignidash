import { describe, it, expect } from 'vitest';
import {
  accountFromConvex,
  accountToConvex,
  contributionFromConvex,
  contributionToConvex,
  incomeFromConvex,
  incomeToConvex,
  expenseFromConvex,
  expenseToConvex,
  debtFromConvex,
  debtToConvex,
  physicalAssetFromConvex,
  physicalAssetToConvex,
  simulationSettingsFromConvex,
  simulationSettingsToConvex,
  simulatorFromConvex,
  arrayToRecord,
  recordToArray,
} from './data-transformers';
import {
  createConvexAccount,
  createConvexIncome,
  createConvexExpense,
  createConvexDebt,
  createConvexContribution,
  createConvexPhysicalAsset,
} from './__tests__/test-utils';
import type { Doc } from '@/convex/_generated/dataModel';

// ============================================================================
// Account Roundtrips
// ============================================================================

describe('Account transforms', () => {
  it('should roundtrip savings account', () => {
    const doc = createConvexAccount({ type: 'savings' });
    const zod = accountFromConvex(doc);
    const back = accountToConvex(zod);

    expect(back.type).toBe('savings');
    expect(back.id).toBe(doc.id);
    expect(back.balance).toBe(doc.balance);
  });

  it('should roundtrip taxableBrokerage account', () => {
    const doc = createConvexAccount({ type: 'taxableBrokerage', costBasis: 15000 });
    const zod = accountFromConvex(doc);
    const back = accountToConvex(zod);

    expect(back.type).toBe('taxableBrokerage');
    expect(back.percentBonds).toBe(doc.percentBonds);
    expect(back.costBasis).toBe(15000);
  });

  it('should roundtrip roth account types with contributionBasis', () => {
    for (const type of ['roth401k', 'roth403b', 'rothIra'] as const) {
      const doc = createConvexAccount({ type, contributionBasis: 30000 });
      const zod = accountFromConvex(doc);
      const back = accountToConvex(zod);

      expect(back.type).toBe(type);
      expect(back.contributionBasis).toBe(30000);
      expect(back.percentBonds).toBe(doc.percentBonds);
    }
  });

  it('should roundtrip traditional and HSA account types', () => {
    for (const type of ['401k', '403b', 'ira', 'hsa'] as const) {
      const doc = createConvexAccount({ type });
      const zod = accountFromConvex(doc);
      const back = accountToConvex(zod);

      expect(back.type).toBe(type);
      expect(back.percentBonds).toBe(doc.percentBonds);
    }
  });
});

// ============================================================================
// Contribution Roundtrips
// ============================================================================

describe('Contribution transforms', () => {
  it('should roundtrip dollarAmount contribution', () => {
    const doc = createConvexContribution({ amount: { type: 'dollarAmount', dollarAmount: 5000 } });
    const zod = contributionFromConvex(doc);

    expect(zod.contributionType).toBe('dollarAmount');
    if (zod.contributionType === 'dollarAmount') expect(zod.dollarAmount).toBe(5000);

    const back = contributionToConvex(zod);
    expect(back.amount).toEqual({ type: 'dollarAmount', dollarAmount: 5000 });
  });

  it('should roundtrip percentRemaining contribution', () => {
    const doc = createConvexContribution({ amount: { type: 'percentRemaining', percentRemaining: 50 } });
    const zod = contributionFromConvex(doc);

    expect(zod.contributionType).toBe('percentRemaining');
    if (zod.contributionType === 'percentRemaining') expect(zod.percentRemaining).toBe(50);

    const back = contributionToConvex(zod);
    expect(back.amount).toEqual({ type: 'percentRemaining', percentRemaining: 50 });
  });

  it('should roundtrip unlimited contribution', () => {
    const doc = createConvexContribution({ amount: { type: 'unlimited' } });
    const zod = contributionFromConvex(doc);

    expect(zod.contributionType).toBe('unlimited');

    const back = contributionToConvex(zod);
    expect(back.amount).toEqual({ type: 'unlimited' });
  });

  it('should preserve disabled default to false', () => {
    const doc = createConvexContribution({ disabled: undefined });
    const zod = contributionFromConvex(doc);
    expect(zod.disabled).toBe(false);
  });

  it('should preserve employerMatch and enableMegaBackdoorRoth', () => {
    const doc = createConvexContribution({ employerMatch: 3000, enableMegaBackdoorRoth: true });
    const zod = contributionFromConvex(doc);
    expect(zod.employerMatch).toBe(3000);
    expect(zod.enableMegaBackdoorRoth).toBe(true);
  });
});

// ============================================================================
// Income Roundtrips
// ============================================================================

describe('Income transforms', () => {
  it('should roundtrip income', () => {
    const doc = createConvexIncome();
    const zod = incomeFromConvex(doc);
    const back = incomeToConvex(zod);

    expect(back.id).toBe(doc.id);
    expect(back.name).toBe(doc.name);
    expect(back.amount).toBe(doc.amount);
    expect(back.taxes.incomeType).toBe(doc.taxes.incomeType);
    expect(back.taxes.withholding).toBe(doc.taxes.withholding);
  });

  it('should default disabled to false', () => {
    const doc = createConvexIncome({ disabled: undefined });
    const zod = incomeFromConvex(doc);
    expect(zod.disabled).toBe(false);
  });
});

// ============================================================================
// Expense Roundtrips
// ============================================================================

describe('Expense transforms', () => {
  it('should roundtrip expense', () => {
    const doc = createConvexExpense();
    const zod = expenseFromConvex(doc);
    const back = expenseToConvex(zod);

    expect(back.id).toBe(doc.id);
    expect(back.amount).toBe(doc.amount);
    expect(back.timeframe).toEqual(doc.timeframe);
  });

  it('should default disabled to false', () => {
    const doc = createConvexExpense({ disabled: undefined });
    const zod = expenseFromConvex(doc);
    expect(zod.disabled).toBe(false);
  });
});

// ============================================================================
// Ownership Roundtrips (P1-P2)
// ============================================================================

describe('ownership survives the round trip', () => {
  // `owner` and `propertyRegime` ride inside each entity, so a converter that forgets them
  // loses the tag silently — the same failure mode as `clonePlan` dropping `glidePath`. The
  // clone guard only reaches the *optional top-level* plan fields (debts, physical assets,
  // glidePath), so accounts, incomes and expenses are covered here, in both directions.
  const OWNED = { owner: 'joint', propertyRegime: 'jointTenancy' } as const;

  it('account: reads an owner off the document and writes it back', () => {
    const doc = { ...createConvexAccount({ type: 'savings' }), ...OWNED };

    const zod = accountFromConvex(doc);
    expect(zod).toMatchObject(OWNED);

    // A converter that dropped the fields would return an account whose reader default
    // (`ownerOf`) silently says `primary` again.
    expect(accountToConvex(zod)).toMatchObject(OWNED);
  });

  it('income: reads an owner off the document and writes it back', () => {
    const doc = { ...createConvexIncome(), ...OWNED };

    const zod = incomeFromConvex(doc);
    expect(zod).toMatchObject(OWNED);

    expect(incomeToConvex(zod)).toMatchObject(OWNED);
  });

  it('expense: reads an owner off the document and writes it back', () => {
    const doc = { ...createConvexExpense(), ...OWNED };

    const zod = expenseFromConvex(doc);
    expect(zod).toMatchObject(OWNED);

    expect(expenseToConvex(zod)).toMatchObject(OWNED);
  });

  it('leaves the fields unset when the stored item has none, so old plans stay old', () => {
    // Unset is what every reader defaults from; a converter that invented `owner: 'primary'`
    // would rewrite plans on their next save. An explicit `undefined` is how the converters
    // carry "not stored" — Convex drops such a key from an optional field, and `ownerOf`
    // treats it as absent.
    for (const entity of [
      accountFromConvex(createConvexAccount({ type: 'savings' })),
      incomeFromConvex(createConvexIncome()),
      expenseFromConvex(createConvexExpense()),
    ]) {
      expect(entity.owner).toBeUndefined();
      expect(entity.propertyRegime).toBeUndefined();
    }

    // Stored form: the key is dropped entirely, so an untouched plan is byte-identical.
    const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    for (const doc of [
      accountToConvex(accountFromConvex(createConvexAccount({ type: 'savings' }))),
      incomeToConvex(incomeFromConvex(createConvexIncome())),
      expenseToConvex(expenseFromConvex(createConvexExpense())),
    ]) {
      expect(stored(doc)).not.toHaveProperty('owner');
      expect(stored(doc)).not.toHaveProperty('propertyRegime');
    }
  });
});

// ============================================================================
// Debt Roundtrips
// ============================================================================

describe('Debt transforms', () => {
  it('should roundtrip debt', () => {
    const doc = createConvexDebt();
    const zod = debtFromConvex(doc);
    const back = debtToConvex(zod);

    expect(back.id).toBe(doc.id);
    expect(back.balance).toBe(doc.balance);
    expect(back.apr).toBe(doc.apr);
    expect(back.interestType).toBe(doc.interestType);
    expect(back.monthlyPayment).toBe(doc.monthlyPayment);
  });

  it('should default disabled to false', () => {
    const doc = createConvexDebt({ disabled: undefined });
    const zod = debtFromConvex(doc);
    expect(zod.disabled).toBe(false);
  });
});

// ============================================================================
// Physical Asset Roundtrips
// ============================================================================

describe('Physical asset transforms', () => {
  it('should default assetType to other when missing', () => {
    const doc = createConvexPhysicalAsset({ assetType: undefined });
    const zod = physicalAssetFromConvex(doc);
    expect(zod.assetType).toBe('other');
  });

  it('should preserve explicit assetType', () => {
    const doc = createConvexPhysicalAsset({ assetType: 'primaryResidence' });
    const zod = physicalAssetFromConvex(doc);
    expect(zod.assetType).toBe('primaryResidence');
  });

  it('should default saleDate to atLifeExpectancy when missing', () => {
    const doc = createConvexPhysicalAsset({ saleDate: undefined });
    const zod = physicalAssetFromConvex(doc);
    expect(zod.saleDate).toEqual({ type: 'atLifeExpectancy' });
  });

  it('should preserve explicit saleDate', () => {
    const doc = createConvexPhysicalAsset({ saleDate: { type: 'customAge', age: 65 } });
    const zod = physicalAssetFromConvex(doc);
    expect(zod.saleDate).toEqual({ type: 'customAge', age: 65 });
  });

  it('should roundtrip physical asset', () => {
    const doc = createConvexPhysicalAsset({ assetType: 'primaryResidence', saleDate: { type: 'atRetirement' } });
    const zod = physicalAssetFromConvex(doc);
    const back = physicalAssetToConvex(zod);

    expect(back.id).toBe(doc.id);
    expect(back.assetType).toBe('primaryResidence');
    expect(back.purchasePrice).toBe(doc.purchasePrice);
    expect(back.saleDate).toEqual({ type: 'atRetirement' });
  });
});

// ============================================================================
// Simulation Settings (clock injection, parity plan P2-P0)
// ============================================================================

describe('simulationSettingsFromConvex / simulationSettingsToConvex', () => {
  it('carries a pinned asOfDate to Convex instead of dropping it', () => {
    const convexSettings = simulationSettingsToConvex({
      simulationSeed: 9521,
      simulationMode: 'fixedReturns',
      asOfDate: '2026-03-15',
    });

    expect(convexSettings).toEqual({ simulationSeed: 9521, simulationMode: 'fixedReturns', asOfDate: '2026-03-15' });
  });

  it('carries a pinned asOfDate back from Convex', () => {
    const zodSettings = simulationSettingsFromConvex({
      simulationSeed: 9521,
      simulationMode: 'fixedReturns',
      asOfDate: '2026-03-15',
    } as Doc<'plans'>['simulationSettings']);

    expect(zodSettings.asOfDate).toBe('2026-03-15');
  });

  it('round-trips settings without asOfDate unchanged', () => {
    const zodSettings = simulationSettingsFromConvex({
      simulationSeed: 9521,
      simulationMode: 'fixedReturns',
    } as Doc<'plans'>['simulationSettings']);

    expect(zodSettings).toEqual({ simulationSeed: 9521, simulationMode: 'fixedReturns' });
    expect(simulationSettingsToConvex(zodSettings)).toEqual({ simulationSeed: 9521, simulationMode: 'fixedReturns' });
  });
});

// ============================================================================
// Simulator reads
// ============================================================================

describe('simulatorFromConvex', () => {
  it('should roundtrip a plan with multiple entities', () => {
    const plan = {
      _id: 'plan-1' as Doc<'plans'>['_id'],
      _creationTime: 0,
      userId: 'user-1',
      name: 'Test Plan',
      isDefault: true,
      timeline: {
        lifeExpectancy: 87,
        birthMonth: 6,
        birthYear: 1990,
        retirementStrategy: { type: 'fixedAge' as const, retirementAge: 65 },
      },
      incomes: [createConvexIncome({ id: 'inc-1' }), createConvexIncome({ id: 'inc-2', name: 'Side Hustle', amount: 20000 })],
      accounts: [createConvexAccount({ id: 'acct-1', type: 'savings' }), createConvexAccount({ id: 'acct-2', type: '401k' })],
      glidePath: undefined,
      expenses: [createConvexExpense({ id: 'exp-1' })],
      debts: [createConvexDebt({ id: 'debt-1' })],
      physicalAssets: [createConvexPhysicalAsset({ id: 'asset-1', assetType: 'primaryResidence', saleDate: { type: 'atRetirement' } })],
      contributionRules: [createConvexContribution({ id: 'contrib-1' })],
      baseContributionRule: { type: 'save' as const },
      marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
      taxSettings: { filingStatus: 'single' as const },
      privacySettings: { isPrivate: true },
      simulationSettings: { simulationSeed: 12345, simulationMode: 'fixedReturns' as const },
    } as Doc<'plans'>;

    const simulator = simulatorFromConvex(plan);

    // Verify arrays became id-keyed records
    expect(Object.keys(simulator.incomes)).toEqual(['inc-1', 'inc-2']);
    expect(Object.keys(simulator.accounts)).toEqual(['acct-1', 'acct-2']);
    expect(Object.keys(simulator.expenses)).toEqual(['exp-1']);
    expect(Object.keys(simulator.debts)).toEqual(['debt-1']);
    expect(Object.keys(simulator.physicalAssets)).toEqual(['asset-1']);
    expect(Object.keys(simulator.contributionRules)).toEqual(['contrib-1']);

    // Values survive the transform: the records keep what the document stored.
    expect(simulator.taxSettings.filingStatus).toBe('single');
    expect(simulator.marketAssumptions.stockReturn).toBe(9);
  });

  it('should handle empty optional arrays', () => {
    const plan = {
      _id: 'plan-1' as Doc<'plans'>['_id'],
      _creationTime: 0,
      userId: 'user-1',
      name: 'Empty Plan',
      isDefault: true,
      timeline: null,
      incomes: [],
      accounts: [],
      glidePath: undefined,
      expenses: [],
      debts: undefined,
      physicalAssets: undefined,
      contributionRules: [],
      baseContributionRule: { type: 'spend' as const },
      marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
      taxSettings: { filingStatus: 'marriedFilingJointly' as const },
      privacySettings: { isPrivate: false },
      simulationSettings: { simulationSeed: 0, simulationMode: 'fixedReturns' as const },
    } as Doc<'plans'>;

    const simulator = simulatorFromConvex(plan);
    expect(simulator.timeline).toBeNull();
    expect(Object.keys(simulator.incomes)).toHaveLength(0);
    expect(Object.keys(simulator.debts)).toHaveLength(0);
    expect(Object.keys(simulator.physicalAssets)).toHaveLength(0);
  });
});

// ============================================================================
// Helpers
// ============================================================================

describe('arrayToRecord / recordToArray', () => {
  it('should convert array to id-keyed record', () => {
    const arr = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ];
    const rec = arrayToRecord(arr);
    expect(rec['a']).toEqual({ id: 'a', value: 1 });
    expect(rec['b']).toEqual({ id: 'b', value: 2 });
  });

  it('should convert record to array', () => {
    const rec = { a: { id: 'a', value: 1 }, b: { id: 'b', value: 2 } };
    const arr = recordToArray(rec);
    expect(arr).toHaveLength(2);
    expect(arr).toContainEqual({ id: 'a', value: 1 });
  });
});
