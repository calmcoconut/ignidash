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
  milestonesFromConvex,
  milestonesToConvex,
  seppFromConvex,
  seppToConvex,
  taxSettingsFromConvex,
  taxSettingsToConvex,
  journalFromConvex,
  journalToConvex,
  arrayToRecord,
  recordToArray,
  simulationResultToConvex,
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
import { WITHDRAWAL_STRATEGY_IDS, getWithdrawalStrategy } from '@/lib/calc/withdrawal-strategies';
import { createSimulatorInputs } from '@/lib/calc/__tests__/test-utils';
import { simulate } from '@/lib/calc/simulate';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

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

  it('defaults essential to false, and reads a stored true back', () => {
    // Absent in the document means every expense a withdrawal cap may cut, which is what every
    // expense was before P1-P4.
    expect(expenseFromConvex(createConvexExpense()).essential).toBe(false);
    expect(expenseFromConvex(createConvexExpense({ essential: true })).essential).toBe(true);
  });

  it('stores essential only when it is true, so an untouched expense keeps its document', () => {
    const plain = expenseFromConvex(createConvexExpense());
    const essential = expenseFromConvex(createConvexExpense({ essential: true }));

    const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    expect(stored(expenseToConvex(plain))).not.toHaveProperty('essential');
    expect(stored(expenseToConvex({ ...plain, essential: false }))).not.toHaveProperty('essential');
    expect(stored(expenseToConvex(essential))).toHaveProperty('essential', true);

    // ...and the true survives the trip back through the reader.
    expect(expenseFromConvex(expenseToConvex(essential)).essential).toBe(true);
  });

  it('defaults qualifiedMedical and satisfyFromIra to false, and reads stored true back', () => {
    const plain = createConvexExpense();
    expect(expenseFromConvex(plain).qualifiedMedical).toBe(false);
    expect(expenseFromConvex(plain).satisfyFromIra).toBe(false);

    expect(expenseFromConvex({ ...plain, qualifiedMedical: true }).qualifiedMedical).toBe(true);
    expect(expenseFromConvex({ ...plain, satisfyFromIra: true }).satisfyFromIra).toBe(true);
  });

  it('stores qualifiedMedical and satisfyFromIra only when true', () => {
    const plain = expenseFromConvex(createConvexExpense());
    const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

    expect(stored(expenseToConvex(plain))).not.toHaveProperty('qualifiedMedical');
    expect(stored(expenseToConvex(plain))).not.toHaveProperty('satisfyFromIra');

    expect(stored(expenseToConvex({ ...plain, qualifiedMedical: true }))).toHaveProperty('qualifiedMedical', true);
    expect(stored(expenseToConvex({ ...plain, satisfyFromIra: true }))).toHaveProperty('satisfyFromIra', true);
  });
});

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

  // The P1-P5 fields (loan term, mortgage offset, property tax). Each is optional and its absence
  // is a statement, so both directions must carry the statement and neither may invent a default.
  it('carries the loan term, the offset account and the property tax back from Convex', () => {
    const doc = createConvexPhysicalAsset({
      assetType: 'primaryResidence',
      paymentMethod: {
        type: 'loan',
        downPayment: 80000,
        loanBalance: 320000,
        apr: 6,
        monthlyPayment: 1913.84,
        termMonths: 360,
        offsetAccountId: 'savings-1',
      },
      propertyTax: { ratePercent: 1.1, annualAmount: 5500 },
    });

    const zod = physicalAssetFromConvex(doc);

    expect(zod.paymentMethod).toStrictEqual({
      type: 'loan',
      downPayment: 80000,
      loanBalance: 320000,
      apr: 6,
      monthlyPayment: 1913.84,
      termMonths: 360,
      offsetAccountId: 'savings-1',
    });
    expect(zod.propertyTax).toStrictEqual({ ratePercent: 1.1, annualAmount: 5500 });
  });

  it('keeps the P1-P5 fields absent when the document states none, inventing no default', () => {
    // A v10 document cannot carry them. Absent must stay absent: no term (the payment drives the
    // loan), no offset (interest on the whole principal), no property tax (none charged).
    const zod = physicalAssetFromConvex(
      createConvexPhysicalAsset({
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
      })
    );

    expect(zod.paymentMethod).toStrictEqual({ type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 });
    expect('termMonths' in zod.paymentMethod).toBe(false);
    expect('offsetAccountId' in zod.paymentMethod).toBe(false);
    expect('propertyTax' in zod).toBe(false);
  });

  it('stores the P1-P5 fields to Convex only when they are stated', () => {
    const stated = physicalAssetToConvex({
      id: 'asset-1',
      name: 'Primary Residence',
      assetType: 'primaryResidence',
      purchaseDate: { type: 'now' },
      purchasePrice: 400000,
      appreciationRate: 3,
      saleDate: { type: 'atLifeExpectancy' },
      paymentMethod: {
        type: 'loan',
        downPayment: 80000,
        loanBalance: 320000,
        apr: 6,
        monthlyPayment: 1913.84,
        termMonths: 360,
        offsetAccountId: 'savings-1',
      },
      propertyTax: { annualAmount: 5500 },
    });

    expect(stated.paymentMethod).toStrictEqual({
      type: 'loan',
      downPayment: 80000,
      loanBalance: 320000,
      apr: 6,
      monthlyPayment: 1913.84,
      termMonths: 360,
      offsetAccountId: 'savings-1',
    });
    expect(stated.propertyTax).toStrictEqual({ annualAmount: 5500 });

    const unstated = physicalAssetToConvex({
      id: 'asset-2',
      name: 'Paid Off Home',
      assetType: 'primaryResidence',
      purchaseDate: { type: 'now' },
      purchasePrice: 400000,
      appreciationRate: 3,
      saleDate: { type: 'atLifeExpectancy' },
      paymentMethod: { type: 'cash' },
    });

    expect('propertyTax' in unstated).toBe(false);
    expect(unstated.paymentMethod).toStrictEqual({ type: 'cash' });
  });

  it('round-trips the P1-P5 fields through both transformers', () => {
    const doc = createConvexPhysicalAsset({
      paymentMethod: { type: 'loan', loanBalance: 320000, apr: 6, monthlyPayment: 1913.84, termMonths: 360, offsetAccountId: 'savings-1' },
      propertyTax: { ratePercent: 1.1 },
    });

    const back = physicalAssetToConvex(physicalAssetFromConvex(doc));
    // The whole payment method and the property-tax block come back exactly as they went in.
    expect(back.paymentMethod).toStrictEqual(doc.paymentMethod);
    expect(back.propertyTax).toStrictEqual(doc.propertyTax);
  });
});

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

  it('carries every withdrawal strategy to Convex and back, P1-P4', () => {
    // Both directions matter: a converter that dropped the field would leave the engine reading
    // `undefined` (= `ordered`) while the drawer showed the chosen strategy.
    for (const withdrawalStrategy of WITHDRAWAL_STRATEGY_IDS) {
      const toConvex = simulationSettingsToConvex({ simulationSeed: 9521, simulationMode: 'fixedReturns', withdrawalStrategy });
      expect(toConvex.withdrawalStrategy).toBe(withdrawalStrategy);

      const fromConvex = simulationSettingsFromConvex(toConvex as Doc<'plans'>['simulationSettings']);
      expect(fromConvex.withdrawalStrategy).toBe(withdrawalStrategy);
    }
  });

  it('leaves an absent strategy absent, so every earlier plan keeps ordered numbers', () => {
    const fromConvex = simulationSettingsFromConvex({
      simulationSeed: 9521,
      simulationMode: 'fixedReturns',
    } as Doc<'plans'>['simulationSettings']);

    expect(fromConvex.withdrawalStrategy).toBeUndefined();
    expect(simulationSettingsToConvex(fromConvex)).not.toHaveProperty('withdrawalStrategy');
    expect(getWithdrawalStrategy(fromConvex.withdrawalStrategy).id).toBe('ordered');
  });
});

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

describe('Milestone transforms', () => {
  const milestone = {
    id: 'milestone-1',
    name: 'Net worth goal',
    condition: {
      op: 'and' as const,
      children: [
        { metric: 'netWorth' as const, operator: '>=' as const, value: 1_000_000 },
        { metric: 'account' as const, accountId: 'acct-2', operator: '>' as const, value: 100_000 },
      ],
    },
    references: ['milestone-0'],
  };

  it('should carry a milestone back from Convex with the condition untouched', () => {
    const zod = milestonesFromConvex([milestone])!;

    // The stored condition *is* the evaluator's expression: no re-keying, no flattening.
    expect(zod).toStrictEqual([milestone]);
  });

  it('should roundtrip a milestone through both directions', () => {
    const back = milestonesToConvex(milestonesFromConvex([milestone])!);

    expect(back).toStrictEqual([milestone]);
  });

  it('should read an absent field as no milestones, not as an empty list', () => {
    expect(milestonesFromConvex(undefined)).toBeUndefined();
    expect(milestonesFromConvex([])).toStrictEqual([]);
    expect(milestonesToConvex([])).toStrictEqual([]);
  });

  it('should hand the plan`s milestones to the engine through simulatorFromConvex', () => {
    const plan = {
      _id: 'plan-1' as Doc<'plans'>['_id'],
      _creationTime: 0,
      userId: 'user-1',
      name: 'Milestone Plan',
      isDefault: true,
      timeline: null,
      incomes: [],
      accounts: [],
      expenses: [],
      contributionRules: [],
      baseContributionRule: { type: 'save' as const },
      marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
      taxSettings: { filingStatus: 'single' as const },
      privacySettings: { isPrivate: true },
      simulationSettings: { simulationSeed: 0, simulationMode: 'fixedReturns' as const },
      milestones: [milestone],
    } as Doc<'plans'>;

    expect(simulatorFromConvex(plan).milestones).toStrictEqual([milestone]);

    // Absent stays absent: the engine must not be handed an empty list, or "no milestones" would be
    // two different values by the time it reaches the latch.
    const withoutField = { ...plan } as Record<string, unknown>;
    delete withoutField.milestones;
    expect(simulatorFromConvex(withoutField as unknown as Doc<'plans'>).milestones).toBeUndefined();
  });
});

describe('sepp roundtrips', () => {
  const seppSchedule = {
    id: 'sepp-1',
    name: 'SEPP Schedule',
    accountId: 'account-1',
    method: 'fixedAmortization' as const,
    startYear: 2030,
    rate: 0.05,
    annualAmount: 25000,
    stopYear: 2036,
    disabled: false,
  };

  it('should roundtrip SEPP schedules through both directions', () => {
    const from = seppFromConvex([seppSchedule])!;
    expect(from).toStrictEqual([seppSchedule]);
    const back = seppToConvex(from);
    expect(back).toStrictEqual([seppSchedule]);
  });

  it('should preserve absent SEPP schedules', () => {
    expect(seppFromConvex(undefined)).toBeUndefined();
    expect(seppFromConvex([])).toStrictEqual([]);
    expect(seppToConvex([])).toStrictEqual([]);
  });
});

describe('taxSettings ACA roundtrips', () => {
  const acaSettings = {
    optIn: true,
    householdSize: 2,
    slcsp: 12000,
    actualPremium: 10000,
  };

  it('should roundtrip ACA settings through both directions', () => {
    const convexTax = {
      filingStatus: 'marriedFilingJointly' as const,
      aca: acaSettings,
    };
    const from = taxSettingsFromConvex(convexTax);
    expect(from.aca).toStrictEqual(acaSettings);
    const to = taxSettingsToConvex(from);
    expect(to.aca).toStrictEqual(acaSettings);
  });

  it('should preserve absent ACA settings', () => {
    const convexTax = {
      filingStatus: 'single' as const,
    };
    const from = taxSettingsFromConvex(convexTax);
    expect(from.aca).toBeUndefined();
    const to = taxSettingsToConvex(from);
    expect(to.aca).toBeUndefined();
  });

  it('should omit aca when optIn is false', () => {
    const to = taxSettingsToConvex({
      filingStatus: 'single',
      aca: { optIn: false, slcsp: 10000 },
    });
    expect(to.aca).toBeUndefined();
  });
});

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

describe('journal roundtrips (R11)', () => {
  const journalEntries = [
    {
      date: '2026-06',
      balances: { 'account-1': 100000 },
      note: 'Snapshot',
    },
  ];

  it('should roundtrip journal entries through journalFromConvex and journalToConvex', () => {
    const from = journalFromConvex(journalEntries);
    expect(from).toStrictEqual(journalEntries);
    const to = journalToConvex(from!);
    expect(to).toStrictEqual(journalEntries);
  });

  it('should preserve absent journal entries', () => {
    const from = journalFromConvex(undefined);
    expect(from).toBeUndefined();
    expect(journalToConvex([])).toStrictEqual([]);
  });
});

describe('simulation summary for the assistant (R4a)', () => {
  it("carries the year's Roth conversions, so the assistant can quote what a conversion did", () => {
    // A plan with one 25,000 conversion out of a traditional IRA in 2026. The assistant may patch a
    // conversion (`applyPatch` reaches `conversions`), so the flattened summary it reads must show
    // the conversion's effect; before this field it showed only RMDs and withdrawals.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          amount: 25_000,
          year: 2026,
        },
      ],
    };

    const outcome = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    if (outcome.mode !== 'fixedReturns') throw new Error('expected a fixed-returns projection');
    const simulation = outcome.result;
    const summary = simulationResultToConvex(simulation);

    // Summary row 0 is the first settled year (`simulation.data[1]`), and the engine converted 25k.
    const engineConversions = simulation.data[1].portfolio.conversions;
    expect(engineConversions).toBe(25_000);
    expect(summary.simulationResult[0].annualRothConversions).toBe(25_000);

    // A year with no conversion flattens to 0, not to a missing key: absence means "no conversion".
    expect(simulation.data[2].portfolio.conversions).toBeUndefined();
    expect(summary.simulationResult[1].annualRothConversions).toBe(0);
  });
});
