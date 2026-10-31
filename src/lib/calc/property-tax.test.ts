import { describe, expect, it } from 'vitest';

import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { TEST_TIME_BINDING_CONTEXT } from './__tests__/time-binding-context';
import { createSavingsAccount, createSimulatorInputs } from './__tests__/test-utils';
import { prop13AnnualTax, prop13AssessedValue } from './prop-13';
import { simulate } from './simulate';
import {
  PROPERTY_TAX_EXPENSE_NAME,
  derivePropertyTaxExpenses,
  isProp13Residency,
  propertyTaxAnnualGrowthPercent,
  propertyTaxBaseAmount,
  propertyTaxExpense,
  propertyTaxExpenseId,
} from './property-tax';

/**
 * Property tax as an engine expense (P1-P5), hand-worked.
 *
 * The bill itself belongs to `prop-13.ts`; this module only decides *how much* the engine charges
 * and *how that bill grows* in the engine's real dollars. So every case below is arithmetic that
 * can be redone on paper from the two published rules:
 *
 *   nominal assessed growth = min(nominal market appreciation, 2%), floored at 0 (California)
 *   real growth             = (1 + nominal growth) / (1 + inflation) - 1
 */

const residence = (overrides: Partial<PhysicalAssetInputs> = {}): PhysicalAssetInputs => ({
  id: 'home-1',
  name: 'Primary Residence',
  assetType: 'primaryResidence',
  purchaseDate: { type: 'now' },
  purchasePrice: 500000,
  appreciationRate: 3,
  saleDate: { type: 'atLifeExpectancy' },
  paymentMethod: { type: 'cash' },
  propertyTax: { ratePercent: 1.1 },
  ...overrides,
});

const CA_OPTIONS = { inflationRatePercent: 3, stateResidency: 'CA' as const };
const NOT_CA_OPTIONS = { inflationRatePercent: 3, stateResidency: 'none' as const };

describe('property-tax: which law applies', () => {
  it('applies Prop 13 in California and to a plan that states no residency', () => {
    expect(isProp13Residency('CA')).toBe(true);
    // Absent reads as California, exactly as `taxes.ts` reads the same field (`?? 'CA'`), so a v7
    // plan keeps the rule it was always subject to.
    expect(isProp13Residency(undefined)).toBe(true);
    expect(isProp13Residency('none')).toBe(false);
  });
});

describe('property-tax: the annual growth rate', () => {
  it('caps a California assessment at 2% nominal, deflated by the plan’s inflation', () => {
    // A $500,000 home appreciating 3% *real* with 3% inflation appreciates 6.09% nominal:
    //   nominal = 1.03 × 1.03 − 1 = 6.09%  →  capped at 2%
    //   real    = 1.02 / 1.03 − 1 = −0.970873786…%
    const growth = propertyTaxAnnualGrowthPercent(residence(), CA_OPTIONS);

    expect(((1.03 * 1.03 - 1) * 100).toFixed(2)).toBe('6.09');
    expect(growth).toBeCloseTo(-0.9708737864077666, 12);
  });

  it('does not cap outside California: the bill tracks market value', () => {
    // `stateResidency: 'none'` — the tax is reassessed to market value, so it grows at the plan's
    // own real appreciation with no 2% ceiling and no floor.
    expect(propertyTaxAnnualGrowthPercent(residence({ appreciationRate: 8 }), NOT_CA_OPTIONS)).toBe(8);
    expect(propertyTaxAnnualGrowthPercent(residence({ appreciationRate: -5 }), NOT_CA_OPTIONS)).toBe(-5);
    // The same 8% is capped in California: 1.08 × 1.03 − 1 = 11.24% nominal → 2% → 1.02/1.03 − 1.
    expect(propertyTaxAnnualGrowthPercent(residence({ appreciationRate: 8 }), CA_OPTIONS)).toBeCloseTo((1.02 / 1.03 - 1) * 100, 12);
  });

  it('floors the assessment at the base year, so a falling market does not cut the tax', () => {
    // A home losing 5% a year *real* with 3% inflation falls 2.15% nominal:
    //   nominal = 0.95 × 1.03 − 1 = −2.15%  →  Prop 13's floor holds the assessment at its
    //   base-year value (`prop13AssessedValue` applies it with `Math.max`), so the growth used is
    //   0% nominal, i.e. −2.912621359…% real: the bill shrinks only by inflation.
    const growth = propertyTaxAnnualGrowthPercent(residence({ appreciationRate: -5 }), CA_OPTIONS);

    expect(prop13AssessedValue(500000, 10, { marketAppreciationPercent: -2.15 })).toBe(500000);
    expect(growth).toBeCloseTo((1 / 1.03 - 1) * 100, 12);
    expect(growth).toBeCloseTo(-2.9126213592232997, 12);
  });

  it('rejects a plan whose inflation assumption leaves no real rate to convert to', () => {
    expect(() => propertyTaxAnnualGrowthPercent(residence(), { inflationRatePercent: -100, stateResidency: 'CA' })).toThrow(
      /greater than -100/
    );
    expect(() => propertyTaxAnnualGrowthPercent(residence(), { inflationRatePercent: Number.NaN })).toThrow(/finite/);
  });
});

describe('property-tax: the year-0 bill', () => {
  it('derives the bill from the purchase price and the rate', () => {
    // 500,000 × 1.1% = 5,500
    expect(propertyTaxBaseAmount(residence(), TEST_TIME_BINDING_CONTEXT)).toBeCloseTo(5500, 6);
  });

  it('charges nothing for a block with no number in it', () => {
    // What the dialog leaves behind after both inputs are cleared, and what a hand-written
    // `"propertyTax": {}` means: no bill was stated. Not "1.1% of the price".
    expect(propertyTaxBaseAmount(residence({ propertyTax: {} }), TEST_TIME_BINDING_CONTEXT)).toBe(0);
    expect(propertyTaxExpense(residence({ propertyTax: {} }), CA_OPTIONS, TEST_TIME_BINDING_CONTEXT)).toBeUndefined();
  });

  it('prefers a stated annual amount over the rate', () => {
    // The plan knows its own bill: 12,345 a year, and the rate is not consulted.
    const asset = residence({ propertyTax: { annualAmount: 12345, ratePercent: 0.5 } });

    expect(propertyTaxBaseAmount(asset, TEST_TIME_BINDING_CONTEXT)).toBeCloseTo(12345, 6);
  });

  it('scales a nominal bill with the nominal purchase price', () => {
    // A `nominal` asset is expressed in the dollars of its purchase date; eight years out at 3%
    // inflation the real dollars of that year are worth less, so the plan's real bill is
    // 5,500 × 1.03^-8 = 4,341.87. The price is scaled by the same factor, so the ratio is unchanged.
    const context = {
      ...TEST_TIME_BINDING_CONTEXT,
      marketAssumptions: { ...TEST_TIME_BINDING_CONTEXT.marketAssumptions, inflationRate: 3 },
    };
    const asset = residence({ purchaseDate: { type: 'customDate', month: 1, year: 2033 }, amountBasis: 'nominal' });

    expect(propertyTaxBaseAmount(asset, context)).toBeCloseTo(5500 * Math.pow(1.03, -8), 6);
  });
});

describe('property-tax: the expense row', () => {
  it('states nothing when the asset states no property tax', () => {
    const asset = residence({ propertyTax: undefined });

    expect(propertyTaxExpense(asset, CA_OPTIONS, TEST_TIME_BINDING_CONTEXT)).toBeUndefined();
    expect(derivePropertyTaxExpenses([asset], CA_OPTIONS, TEST_TIME_BINDING_CONTEXT)).toStrictEqual([]);
  });

  it('states nothing when the bill is zero, rather than a row of zero', () => {
    expect(propertyTaxExpense(residence({ propertyTax: { annualAmount: 0 } }), CA_OPTIONS, TEST_TIME_BINDING_CONTEXT)).toBeUndefined();
  });

  it('is a yearly expense over the ownership period, growing at the assessed rate', () => {
    const expense = propertyTaxExpense(residence({ saleDate: { type: 'customAge', age: 80 } }), CA_OPTIONS, TEST_TIME_BINDING_CONTEXT);

    expect(expense).toMatchObject({
      id: 'property-tax:home-1',
      name: 'Property Tax',
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'customAge', age: 80 } },
      growth: { growthRate: -0.9708737864077666 },
    });
    // 500,000 × 1.1% = 5,500 (float noise from the percentage, hence the tolerance).
    expect(expense?.amount).toBeCloseTo(5500, 6);
    expect(expense?.name).toBe(PROPERTY_TAX_EXPENSE_NAME);
    expect(expense?.id).toBe(propertyTaxExpenseId('home-1'));
  });

  it('resets the base when the home is sold and another is bought', () => {
    // Two ownership periods are two schedules: the second home's assessment starts from *its*
    // price, not from the first home's assessment — which is exactly `prop-13.ts`'s rule for a
    // sale and repurchase. So each asset gets its own row and its own base.
    const first = residence({ id: 'home-1', purchasePrice: 500000 });
    const second = residence({ id: 'home-2', purchasePrice: 800000, purchaseDate: { type: 'customDate', month: 6, year: 2040 } });

    const expenses = derivePropertyTaxExpenses([first, second], CA_OPTIONS, TEST_TIME_BINDING_CONTEXT);

    expect(expenses.map((expense) => expense.id)).toStrictEqual(['property-tax:home-1', 'property-tax:home-2']);
    // 500,000 × 1.1% = 5,500 and 800,000 × 1.1% = 8,800: the second starts over.
    expect(expenses[0].amount).toBeCloseTo(5500, 6);
    expect(expenses[1].amount).toBeCloseTo(8800, 6);
    expect(expenses[1].timeframe.start).toStrictEqual({ type: 'customDate', month: 6, year: 2040 });
  });

  it('agrees with prop-13.ts year by year, in the plan’s real dollars', () => {
    const asset = residence();
    const expense = propertyTaxExpense(asset, CA_OPTIONS, TEST_TIME_BINDING_CONTEXT)!;
    const inflation = 1.03;
    const nominalAppreciationPercent = (1.03 * 1.03 - 1) * 100;

    for (const year of [0, 1, 5, 10, 29]) {
      const nominalBill = prop13AnnualTax(
        prop13AssessedValue(asset.purchasePrice, year, { marketAppreciationPercent: nominalAppreciationPercent }),
        1.1
      );
      const realBillFromProp13 = nominalBill / Math.pow(inflation, year);
      const realBillFromExpense = expense.amount * Math.pow(1 + expense.growth!.growthRate! / 100, year);

      // Hand-worked spot checks: 5,500 at year 0, 5,446.60 at year 1, 5,238.14 at year 5.
      if (year === 1) expect(realBillFromProp13).toBeCloseTo(5446.6019, 3);
      if (year === 5) expect(realBillFromProp13).toBeCloseTo(5238.1439, 3);
      expect(realBillFromExpense).toBeCloseTo(realBillFromProp13, 6);
    }
  });
});

// ============================================================================
// Through the engine: the bill is an expense, and residency decides its growth
// ============================================================================

describe('property-tax: charged by the engine', () => {
  const planWithTax = (options: {
    stateResidency?: 'CA' | 'none';
    propertyTax?: PhysicalAssetInputs['propertyTax'];
    appreciationRate?: number;
  }): SimulatorInputs =>
    createSimulatorInputs({
      accounts: { 'savings-1': createSavingsAccount({ id: 'savings-1', name: 'Savings', balance: 2000000 }) },
      physicalAssets: {
        'home-1': residence({
          appreciationRate: options.appreciationRate ?? 3,
          // Absent from `options` keeps `residence()`'s own `{ ratePercent: 1.1 }` statement.
          ...(options.propertyTax !== undefined ? { propertyTax: options.propertyTax } : {}),
        }),
      },
      // A savings account funds the bill; no income, so the expense is the only outflow.
      taxSettings: { filingStatus: 'single', ...(options.stateResidency === undefined ? {} : { stateResidency: options.stateResidency }) },
    });

  const run = (plan: SimulatorInputs) => simulate(plan, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 7 }).result;

  /** The derived property-tax row's amount in each annual data point, skipping the opening snapshot. */
  const annualPropertyTax = (plan: SimulatorInputs): number[] =>
    run(plan)
      .data.slice(1)
      .map((point) => point.expenses?.perExpenseData[propertyTaxExpenseId('home-1')]?.expense ?? 0);

  it('charges the California schedule: capped at 2% nominal, in real dollars', () => {
    const amounts = annualPropertyTax(planWithTax({ stateResidency: 'CA' }));

    // The base: 500,000 × 1.1% = 5,500 a year, charged as 1/12 of that each month. `Expense` applies
    // a year's growth when the plan's calendar year rolls over, so one annual bucket holds eleven
    // months at one year's bill and one month at the next — nothing specific to this bill:
    //   (11 × 5,500 + 1 × 5,500 × 1.02/1.03) / 12 = 5,495.5502
    expect(amounts[0]).toBeCloseTo(5495.5502, 3);

    // Year over year the bill grows at exactly Prop 13's real rate, 1.02/1.03 − 1 = −0.9709%: the 2%
    // nominal cap deflated by the plan's 3% inflation. (The home appreciated 3% real = 6.09% nominal,
    // so the cap binds and the real bill falls.)
    const cappedRealGrowth = 1.02 / 1.03;
    expect(amounts[1] / amounts[0]).toBeCloseTo(cappedRealGrowth, 9);
    expect(amounts[4]).toBeCloseTo(amounts[0] * Math.pow(cappedRealGrowth, 4), 6);
  });

  it('charges the market-value schedule outside California, with no cap', () => {
    // `stateResidency: 'none'`: the tax is reassessed to market value, so the bill grows at the
    // plan's own 8% real appreciation — no 2% ceiling, and no inflation deflation either.
    //   (11 × 5,500 + 1 × 5,500 × 1.08) / 12 = 5,536.6667, then × 1.08 a year
    const notCapped = annualPropertyTax(planWithTax({ stateResidency: 'none', appreciationRate: 8 }));

    expect(notCapped[0]).toBeCloseTo(5536.6667, 3);
    expect(notCapped[1] / notCapped[0]).toBeCloseTo(1.08, 9);

    // The same plan in California is capped: 1.08 × 1.03 − 1 = 11.24% nominal → 2% → −0.9709% real.
    const capped = annualPropertyTax(planWithTax({ stateResidency: 'CA', appreciationRate: 8 }));
    expect(capped[1] / capped[0]).toBeCloseTo(1.02 / 1.03, 9);
    expect(capped[1]).toBeLessThan(notCapped[1]);
  });

  it('charges nothing when the residence states no property tax', () => {
    const withTax = planWithTax({ stateResidency: 'CA' });
    const { propertyTax: _stated, ...untaxed } = withTax.physicalAssets['home-1'] as PhysicalAssetInputs;
    const result = run({ ...withTax, physicalAssets: { 'home-1': untaxed } });

    expect(result.data.every((point) => point.expenses?.perExpenseData[propertyTaxExpenseId('home-1')] === undefined)).toBe(true);
    // And the expense total is exactly the plan's own expenses (none) — no hidden row.
    expect(result.data.every((point) => (point.expenses?.totalExpenses ?? 0) === 0)).toBe(true);
  });

  it('refuses a plan that already owns the derived expense id', () => {
    const plan = planWithTax({ stateResidency: 'CA' });
    const clashing: SimulatorInputs = {
      ...plan,
      expenses: {
        ...plan.expenses,
        [propertyTaxExpenseId('home-1')]: {
          id: propertyTaxExpenseId('home-1'),
          name: 'My Own Tax Row',
          amount: 1,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        },
      },
    };

    expect(() => run(clashing)).toThrow(/already uses the derived property-tax id/);
  });
});
