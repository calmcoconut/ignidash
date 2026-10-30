import { describe, expect, it } from 'vitest';

import type { MarketAssumptionsInputs } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';
import type { GlidePathInputs } from '@/lib/schemas/inputs/glide-path-form-schema';

import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine } from './simulation-engine';
import { Incomes } from './incomes';
import { Expenses } from './expenses';
import { Debts } from './debts';
import { PhysicalAssets } from './physical-assets';
import { ContributionRules } from './contribution-rules';
import { Portfolio } from './portfolio';
import { PortfolioProcessor } from './portfolio';
import { cumulativeInflationIndex, type TimeBindingContext } from './time-binding';
import {
  TEST_CLOCK,
  createDebtInput,
  createDefaultMarketAssumptions,
  createDefaultTimeline,
  createExpenseInput,
  createIncomeInput,
  createPhysicalAssetInput,
  createSimulationState,
  createWageIncome,
  create401kAccount,
  createSavingsAccount,
} from './__tests__/test-utils';

/**
 * Real/nominal amounts and N-year recurrence, wired through the four calculation modules
 * (incomes, expenses, debts, physical assets) that used to resolve time points privately.
 *
 * `SIMULATION_START`/`MARKET_ASSUMPTIONS` mirror what the engine builds in `runSimulation`
 * from the plan start and the plan's inflation assumption.
 */

const MARKET_ASSUMPTIONS: MarketAssumptionsInputs = createDefaultMarketAssumptions(); // 3% inflation
const SIMULATION_START = new Date(2026, 9, 1); // 2026-10-01, the TEST_CLOCK date

const CONTEXT: TimeBindingContext = {
  startAge: 35,
  startDate: SIMULATION_START,
  marketAssumptions: MARKET_ASSUMPTIONS,
};

const TEN_YEARS_LATER = { type: 'customDate' as const, year: 2036, month: 10 };

/** A simulation clock `years` after the plan start. */
function stateAt(years: number, age = 35 + years) {
  const months = Math.round(years * 12);
  return createSimulationState({
    time: {
      age,
      year: years,
      month: months,
      date: new Date(SIMULATION_START.getFullYear(), SIMULATION_START.getMonth() + months, 1),
    },
  });
}

describe('nominal amounts use the cumulative inflation index', () => {
  it('scales a nominal income entered in the dollars of its start year', () => {
    const nominal = createIncomeInput({ amount: 10_000, timeframe: { start: TEN_YEARS_LATER, end: undefined }, frequency: 'monthly' });
    const real = { ...nominal, amountBasis: 'real' as const };
    const nominalInput = { ...nominal, amountBasis: 'nominal' as const };

    const nominalIncome = new Incomes([nominalInput], CONTEXT).getActiveIncomesByTimeFrame(stateAt(10))[0];
    const realIncome = new Incomes([real], CONTEXT).getActiveIncomesByTimeFrame(stateAt(10))[0];

    const index = cumulativeInflationIndex(MARKET_ASSUMPTIONS, 10);
    expect(index).toBeCloseTo(Math.pow(1.03, 10), 12);

    const nominalMonthly = nominalIncome.processMonthlyAmount(10).income;
    const realMonthly = realIncome.processMonthlyAmount(10).income;

    // The same entered 10 000 buys less in ten years: nominal = real * index, so the real
    // equivalent of the nominal amount is 10 000 / index.
    expect(realMonthly).toBeCloseTo(10_000, 10);
    expect(nominalMonthly * index).toBeCloseTo(10_000, 6);
    expect(nominalMonthly).toBeCloseTo(10_000 / index, 6);
  });

  it('leaves a real amount alone even when it starts years from now', () => {
    const income = new Incomes(
      [createIncomeInput({ amount: 5_000, timeframe: { start: TEN_YEARS_LATER, end: undefined } })],
      CONTEXT
    ).getActiveIncomesByTimeFrame(stateAt(10))[0];

    expect(income.processMonthlyAmount(10).income).toBeCloseTo(5_000, 10);
  });

  it('scales a nominal expense and its growth limit', () => {
    const index = cumulativeInflationIndex(MARKET_ASSUMPTIONS, 10);

    const plain = createExpenseInput({ amount: 20_000, timeframe: { start: TEN_YEARS_LATER, end: undefined }, frequency: 'yearly' });
    const plainExpense = new Expenses([{ ...plain, amountBasis: 'nominal' }], CONTEXT).getActiveExpensesByTimeFrame(stateAt(10))[0];
    // A yearly expense is prorated over twelve months; the real value is nominal / index.
    expect(plainExpense.processMonthlyAmount(10).expense).toBeCloseTo(20_000 / index / 12, 6);

    // The growth limit is an amount too, so it moves with the same factor: growth is capped at
    // 30 000 nominal, i.e. 30 000 / index real.
    const capped = createExpenseInput({
      amount: 20_000,
      timeframe: { start: TEN_YEARS_LATER, end: undefined },
      frequency: 'yearly',
      growth: { growthRate: 50, growthLimit: 30_000 },
    });
    const cappedExpense = new Expenses([{ ...capped, amountBasis: 'nominal' }], CONTEXT).getActiveExpensesByTimeFrame(stateAt(10))[0];
    expect(cappedExpense.processMonthlyAmount(10).expense * 12).toBeCloseTo(30_000 / index, 6);
  });

  it('scales a nominal debt balance and payment by the same factor', () => {
    const debt = createDebtInput({ balance: 100_000, monthlyPayment: 1_000, startDate: TEN_YEARS_LATER, interestType: 'simple' });
    const index = cumulativeInflationIndex(MARKET_ASSUMPTIONS, 10);

    const nominal = new Debts([{ ...debt, amountBasis: 'nominal' }], CONTEXT).getActiveDebts(stateAt(10))[0];
    // A future debt has not been incurred yet; incurring it books the scaled balance.
    nominal.incurUnsecuredDebt();
    expect(nominal.getBalance()).toBeCloseTo(100_000 / index, 6);
    expect(nominal.getMonthlyPaymentInfo(0.03 / 12).monthlyPaymentDue).toBeCloseTo(1_000 / index, 6);
  });

  it('scales a nominal purchase price, loan and down payment together', () => {
    const asset = createPhysicalAssetInput({
      purchaseDate: TEN_YEARS_LATER,
      purchasePrice: 500_000,
      marketValue: 550_000,
      paymentMethod: { type: 'loan', downPayment: 100_000, loanBalance: 400_000, apr: 5, monthlyPayment: 2_000 },
    });
    const index = cumulativeInflationIndex(MARKET_ASSUMPTIONS, 10);

    const physicalAssets = new PhysicalAssets([{ ...asset, amountBasis: 'nominal' }], CONTEXT);
    const [purchasable] = physicalAssets.getAssetsToPurchaseThisPeriod(stateAt(10));
    const { purchaseOutlay, purchaseMarketValue } = purchasable.purchase();

    // Down payment + loan balance still equals the purchase price after scaling.
    expect(purchaseOutlay).toBeCloseTo(100_000 / index, 6);
    expect(purchaseMarketValue).toBeCloseTo(550_000 / index, 6);
    expect(purchasable.getLoanBalance()).toBeCloseTo(400_000 / index, 6);
    expect(purchasable.getEquity()).toBeCloseTo((550_000 - 400_000) / index, 6);
  });

  it('keeps an old plan (no amountBasis) behaving exactly like an explicit real plan', () => {
    // A plan saved before `amountBasis` existed: the field is simply absent everywhere.
    const legacyPlan = {
      timeline: createDefaultTimeline(),
      incomes: {
        salary: createWageIncome({ id: 'salary', amount: 120_000, timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } } }),
      },
      expenses: {
        living: createExpenseInput({
          id: 'living',
          amount: 40_000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: undefined },
        }),
      },
      debts: { card: createDebtInput({ id: 'card', balance: 5_000, monthlyPayment: 250 }) },
      physicalAssets: { house: createPhysicalAssetInput({ id: 'house', purchaseDate: { type: 'now' }, purchasePrice: 400_000 }) },
      accounts: { savings: createSavingsAccount({ balance: 25_000 }), retirement: create401kAccount({ balance: 150_000 }) },
      contributionRules: {},
      baseContributionRule: { type: 'save' as const },
      marketAssumptions: createDefaultMarketAssumptions(),
      taxSettings: { filingStatus: 'single' as const },
      privacySettings: { isPrivate: true },
      simulationSettings: { simulationSeed: 12345, simulationMode: 'fixedReturns' as const },
    };

    // The pre-change file still validates against the current schema.
    const parsed = simulatorSchema.parse(legacyPlan);

    // Adding the field explicitly, at its documented default, cannot move a number.
    const explicit: SimulatorInputs = {
      ...parsed,
      incomes: Object.fromEntries(Object.entries(parsed.incomes).map(([id, income]) => [id, { ...income, amountBasis: 'real' as const }])),
      expenses: Object.fromEntries(
        Object.entries(parsed.expenses).map(([id, expense]) => [id, { ...expense, amountBasis: 'real' as const }])
      ),
      debts: Object.fromEntries(Object.entries(parsed.debts).map(([id, debt]) => [id, { ...debt, amountBasis: 'real' as const }])),
      physicalAssets: Object.fromEntries(
        Object.entries(parsed.physicalAssets).map(([id, asset]) => [id, { ...asset, amountBasis: 'real' as const }])
      ),
    };

    const run = (inputs: SimulatorInputs) =>
      new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!).data;

    expect(run(explicit)).toStrictEqual(run(parsed));
  });
});

describe('N-year recurrence gates a recurring event', () => {
  const everyFiveYears = { start: { type: 'customAge' as const, age: 40, everyNYears: 5 }, end: undefined };

  it('is active only in its occurrence years (0, N and 2N)', () => {
    const incomes = new Incomes([createIncomeInput({ amount: 5_000, timeframe: everyFiveYears })], CONTEXT);

    // The plan start is age 35, so age 40 is occurrence year 0.
    const activeYears = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11].filter(
      (years) => incomes.getActiveIncomesByTimeFrame(stateAt(years)).length === 1
    );

    expect(activeYears).toEqual([5, 10]); // plan years 5 (age 40), 10 (age 45) and 15 (age 50) are the cadence
  });

  it('reaches 2N without a gap', () => {
    const incomes = new Incomes([createIncomeInput({ amount: 5_000, timeframe: everyFiveYears })], CONTEXT);

    expect(incomes.getActiveIncomesByTimeFrame(stateAt(15))).toHaveLength(1);
    expect(incomes.getActiveIncomesByTimeFrame(stateAt(16))).toHaveLength(0);
  });

  it('honours the recurrence span', () => {
    const bounded = {
      start: { type: 'customAge' as const, age: 40, everyNYears: 5, recurrenceYears: 10 },
      end: undefined,
    };
    const incomes = new Incomes([createIncomeInput({ amount: 5_000, timeframe: bounded })], CONTEXT);

    expect(incomes.getActiveIncomesByTimeFrame(stateAt(5))).toHaveLength(1); // index 0
    expect(incomes.getActiveIncomesByTimeFrame(stateAt(10))).toHaveLength(1); // index 5
    expect(incomes.getActiveIncomesByTimeFrame(stateAt(15))).toHaveLength(0); // index 10 is past the 10-year span
  });

  it('pays a one-time event once per occurrence year instead of once ever', () => {
    const incomes = new Incomes(
      [createIncomeInput({ amount: 1_000, frequency: 'oneTime', timeframe: { start: { type: 'now', everyNYears: 2 }, end: undefined } })],
      CONTEXT
    );

    const pay = (years: number, months: number) => {
      const state = stateAt(years + months / 12);
      const [income] = incomes.getActiveIncomesByTimeFrame(state);
      return income === undefined ? 0 : income.processMonthlyAmount(state.time.year).income;
    };

    expect(pay(0, 0)).toBe(1_000); // plan year 0, first month: fires
    expect(pay(0, 1)).toBe(0); // same occurrence year: does not fire again
    expect(pay(1, 0)).toBe(0); // gap year: not active at all
    expect(pay(2, 0)).toBe(1_000); // next occurrence year: fires again
    expect(pay(2, 1)).toBe(0);
    expect(pay(4, 0)).toBe(1_000);
  });

  it('leaves a non-recurring one-time event firing exactly once', () => {
    const incomes = new Incomes(
      [createIncomeInput({ amount: 1_000, frequency: 'oneTime', timeframe: { start: { type: 'now' }, end: undefined } })],
      CONTEXT
    );

    const pay = (years: number) => {
      const state = stateAt(years);
      const [income] = incomes.getActiveIncomesByTimeFrame(state);
      return income === undefined ? 0 : income.processMonthlyAmount(state.time.year).income;
    };

    expect(pay(0)).toBe(1_000);
    expect(pay(1)).toBe(0);
    expect(pay(2)).toBe(0);
  });
});

describe('the glide path still interpolates through the shared resolver', () => {
  it('moves from the starting allocation toward the target', () => {
    const glidePath: GlidePathInputs = {
      id: 'glide-path-1',
      enabled: true,
      endTimePoint: { type: 'customAge', age: 65 },
      targetBondAllocation: 60,
    };

    const portfolio = new Portfolio([create401kAccount({ balance: 100_000, percentBonds: 20 })]);
    const state = createSimulationState({
      time: { age: 50, year: 15, month: 180, date: new Date(2041, 9, 1) },
      portfolio,
    });
    const processor = new PortfolioProcessor(
      state,
      {
        startAge: 35,
        endAge: 90,
        yearsToSimulate: 55,
        startDate: SIMULATION_START,
        endDate: new Date(2081, 9, 1),
        retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
        rmdAge: 75,
      },
      new ContributionRules([], { type: 'save' }),
      glidePath
    );

    // Progress is (50 - 35) / (65 - 35) = 0.5, so bonds should sit halfway from 20% to 60%.
    const allocation = (processor as unknown as { getTargetAssetAllocation: () => { bonds: number } }).getTargetAssetAllocation();
    expect(allocation.bonds).toBeCloseTo(0.4, 10);
  });
});
