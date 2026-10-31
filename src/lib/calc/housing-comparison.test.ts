/**
 * Rent-vs-own comparison (parity plan P1-P6, Plan 1 row 6).
 *
 * The row: *"two deterministic runs, with and without the residence plus a rent expense, reporting
 * the break-even."* These tests hold that sentence to account:
 *
 * 1. **The paths differ only in housing.** The same field objects are shared by reference, only the
 *    residence and the housing expenses are added, and every reported delta is the subtraction of
 *    the two series it claims to be.
 * 2. **The break-even is a break-even.** Owning ahead from the first data point is year 0, owning
 *    never ahead (or ahead only for a while) is `null`, and the two are never confused.
 * 3. **The winners are real.** A fixture where owning wins, one where renting wins, one where
 *    owning never catches up, each with the arithmetic that decides it shown in the assertion.
 * 4. **Identical inputs compare to zero, and the same inputs compare identically twice.**
 *
 * Every fixture builds its own plan from `createSimulatorInputs`; no store, no worker, no clock. The
 * two bases are 1.1M of investable capital (a 401k and a taxable brokerage) with a salary and
 * non-housing spending, and they differ only in the taxable account's cost basis: `withEmbeddedGains`
 * means liquidating to buy the house realizes gains and is taxed, which is why owning starts behind
 * in the winner fixtures.
 */

import { describe, expect, it } from 'vitest';

import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import {
  compareHousing,
  compareHousingPlans,
  DEFAULT_MAINTENANCE_RATE_PERCENT,
  DEFAULT_SELLING_COST_RATE_PERCENT,
  deriveHousingPlans,
  HOUSING_DELTA_MEANING,
  HOUSING_RENT_EXPENSE_ID,
  HOUSING_TIE_TOLERANCE,
  housingMaintenanceExpenseId,
  housingPropertyTaxExpenseId,
} from './housing-comparison';
import { PROP_13_DEFAULT_RATE_PERCENT, prop13AnnualTax } from './prop-13';
import { simulate } from './simulate';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createLivingExpense,
  createPhysicalAssetInput,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
  createWageIncome,
} from './__tests__/test-utils';

const AS_OF = '2026-03-15';
const SEED = 20260315;
const OPTIONS = { asOf: AS_OF, seed: SEED } as const;

const RESIDENCE_ID = 'residence';
const PURCHASE_PRICE = 800_000;
const DOWN_PAYMENT = 240_000;
const MONTHLY_PAYMENT = 3357.7; // 30 years at 6% APR on the 560,000 balance
const LIVING_EXPENSE_ID = 'expense-1';

/**
 * The base plan: the housing decision is the *only* thing left to make. It carries no rent and no
 * ownership costs, which `compareHousing` documents as a precondition.
 */
const createBasePlan = (costBasis: number): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 88 },
    accounts: {
      '401k-1': create401kAccount({ id: '401k-1', balance: 200_000 }),
      'taxable-1': createTaxableBrokerageAccount({ id: 'taxable-1', balance: 900_000, costBasis }),
    },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 120_000 }) },
    expenses: { [LIVING_EXPENSE_ID]: createLivingExpense({ id: LIVING_EXPENSE_ID, amount: 30_000 }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
  });

/** Selling securities to fund the down payment realizes gains, so owning starts behind. */
const withEmbeddedGains = (): SimulatorInputs => createBasePlan(50_000);

/** Same capital, no embedded gains: the housing decision is the only difference left. */
const withNoEmbeddedGains = (): SimulatorInputs => createBasePlan(900_000);

/** The residence: an 800k California home bought at the start of the plan, sold at life expectancy. */
const createResidence = (overrides: Partial<PhysicalAssetInputs> = {}): PhysicalAssetInputs => ({
  ...createPhysicalAssetInput({
    id: RESIDENCE_ID,
    name: 'Residence',
    assetType: 'primaryResidence',
    purchaseDate: { type: 'now' },
    purchasePrice: PURCHASE_PRICE,
    appreciationRate: 3,
    paymentMethod: { type: 'cash' },
    saleDate: { type: 'atLifeExpectancy' },
  }),
  ...overrides,
});

const createFinancedResidence = (): PhysicalAssetInputs =>
  createResidence({
    paymentMethod: {
      type: 'loan',
      downPayment: DOWN_PAYMENT,
      loanBalance: PURCHASE_PRICE - DOWN_PAYMENT,
      apr: 6,
      monthlyPayment: MONTHLY_PAYMENT,
    },
  });

const houseIds = [HOUSING_RENT_EXPENSE_ID, housingPropertyTaxExpenseId(RESIDENCE_ID), housingMaintenanceExpenseId(RESIDENCE_ID)];

describe('the two runs differ only in housing', () => {
  it('shares every non-housing input with the base plan by reference', () => {
    const base = withNoEmbeddedGains();
    const residence = { ...createResidence(), purchaseDate: { type: 'customDate' as const, year: 2030, month: 1 } };
    const { owning, renting } = deriveHousingPlans(base, { residence, monthlyRent: 4000 });

    // One object each, not two copies: incomes, spending, market assumptions and the timeline
    // cannot drift between the paths because there is only one of them.
    for (const field of [
      'timeline',
      'incomes',
      'debts',
      'accounts',
      'contributionRules',
      'baseContributionRule',
      'marketAssumptions',
      'taxSettings',
      'privacySettings',
      'simulationSettings',
      'glidePath',
    ] as const) {
      expect(owning[field]).toBe(renting[field]);
      expect(owning[field]).toBe(base[field]);
    }

    // The caller's own spending is paid on both sides, and it is the same object.
    expect(owning.expenses[LIVING_EXPENSE_ID]).toBe(base.expenses[LIVING_EXPENSE_ID]);
    expect(renting.expenses[LIVING_EXPENSE_ID]).toBe(base.expenses[LIVING_EXPENSE_ID]);

    // Exactly the housing entries are added; nothing else moves.
    expect(new Set(Object.keys(owning.expenses))).toEqual(new Set([LIVING_EXPENSE_ID, ...houseIds]));
    expect(new Set(Object.keys(renting.expenses))).toEqual(new Set([LIVING_EXPENSE_ID, HOUSING_RENT_EXPENSE_ID]));

    // Only the owning path holds the residence, and the base plan is left untouched.
    expect(owning.physicalAssets).toEqual({ [RESIDENCE_ID]: residence });
    expect(renting.physicalAssets).toBe(base.physicalAssets);
    expect(base.physicalAssets[RESIDENCE_ID]).toBeUndefined();
    expect(base.expenses[HOUSING_RENT_EXPENSE_ID]).toBeUndefined();
  });

  it('charges the owner for the house out of the portfolio the renter invests', () => {
    const report = compareHousing(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 4000 }, OPTIONS);
    const firstYear = report.years[0];

    // The cash buyer ties up the price, so most of the renter's portfolio stays invested...
    expect(firstYear.owning.portfolio).toBeLessThan(firstYear.renting.portfolio / 2);
    // ...and the house is what the owner holds instead, valued at its market value.
    expect(firstYear.owning.residenceValue).toBeGreaterThan(PURCHASE_PRICE);
    expect(firstYear.renting.residenceValue).toBe(0);
    // Net worth is portfolio + house − debt: no debt here, so the equity is the whole value.
    expect(firstYear.owning.netWorth - firstYear.owning.portfolio).toBeCloseTo(firstYear.owning.residenceValue, 6);
  });

  it('nets the mortgage out of the financed owner’s net worth', () => {
    const report = compareHousing(withEmbeddedGains(), { residence: createFinancedResidence(), monthlyRent: 3800 }, OPTIONS);
    const firstYear = report.years[0];

    // The down payment leaves the portfolio...
    expect(firstYear.renting.portfolio - firstYear.owning.portfolio).toBeGreaterThan(DOWN_PAYMENT);

    // ...and the equity the owner holds is the value minus the balance, never the whole value.
    const equity = firstYear.owning.netWorth - firstYear.owning.portfolio;
    expect(equity).toBeGreaterThan(0);
    expect(equity).toBeLessThan(firstYear.owning.residenceValue);
  });

  it('reports every year as the subtraction of the two paths it names', () => {
    const report = compareHousing(withEmbeddedGains(), { residence: createFinancedResidence(), monthlyRent: 3800 }, OPTIONS);

    expect(report.deltaMeaning).toBe('owning - renting');
    expect(HOUSING_DELTA_MEANING).toBe('owning - renting');

    for (const year of report.years) {
      expect(year.deltaNetWorth).toBe(year.owning.netWorth - year.renting.netWorth);
      expect(year.deltaPortfolio).toBe(year.owning.portfolio - year.renting.portfolio);
      expect(year.deltaLiquidationValue).toBe(year.owning.liquidationValue - year.renting.liquidationValue);
      // Liquidation value prices a hypothetical sale of the house still held; the renter has none.
      expect(year.renting.liquidationValue).toBe(year.renting.netWorth);
      expect(year.owning.liquidationValue).toBeCloseTo(
        year.owning.netWorth - year.owning.residenceValue * (DEFAULT_SELLING_COST_RATE_PERCENT / 100),
        6
      );
    }

    // `yearIndex: 0` is the end of the plan's first year, not the opening snapshot.
    expect(report.years[0].calendarYear).toBe(2027);
    expect(report.years).toHaveLength(report.years.length);
    expect(report.years.map((year) => year.yearIndex)).toEqual(report.years.map((_, index) => index));
  });
});

describe('the break-even', () => {
  /**
   * Owning wins, and it has to earn it: the down payment realizes taxable gains, so owning is behind
   * for four years and then compounds past renting.
   *
   *   year 3: −4,684
   *   year 4: +15,765   <- break-even
   *   year 5: +36,639
   *   final:  owning ahead by 748,999 over 53 years
   *
   * The figures are the post-R2 readings. Statute-locked thresholds (the NIIT base amount, the
   * Additional Medicare threshold, the SALT cap) are now deflated to today's dollars, and the renter
   * holds the larger invested portfolio, so the same policy taxes the two plans differently as the
   * horizon lengthens. The break-even year itself did not move; only the totals did.
   */
  const owningWins = () => compareHousing(withEmbeddedGains(), { residence: createFinancedResidence(), monthlyRent: 3800 }, OPTIONS);

  it('reports the year owning overtakes renting and stays ahead', () => {
    const report = owningWins();
    const before = report.years[3];
    const at = report.years[4];

    expect(before.deltaNetWorth).toBeLessThan(0);
    expect(at.deltaNetWorth).toBeGreaterThan(0);
    expect(at.deltaNetWorth).toBeLessThan(20_000);

    expect(report.breakEven).toEqual({ yearIndex: 4, age: at.age, calendarYear: 2031 });
    expect(at.calendarYear).toBe(2031);

    // "Stays ahead" is what makes it a break-even: from there to the end owning leads every year.
    expect(report.years.every((year) => year.yearIndex < 4 || year.deltaNetWorth > HOUSING_TIE_TOLERANCE)).toBe(true);

    expect(report.firstAhead).toEqual(report.breakEven);
    expect(report.finalWinner).toBe('owning');
    expect(report.finalDeltaNetWorth).toBeGreaterThan(700_000);
    expect(report.finalDeltaNetWorth).toBeLessThan(800_000);
  });

  it('prices the sale separately, so selling costs push the break-even later', () => {
    const report = owningWins();

    // Net worth says owning is ahead from year 4; after a 6% commission it is ahead from year 7.
    expect(report.liquidationBreakEven?.yearIndex).toBe(7);
    expect(report.liquidationBreakEven?.calendarYear).toBe(2034);
    expect(report.finalLiquidationWinner).toBe('owning');
    expect(report.finalDeltaLiquidationValue).toBeGreaterThan(480_000);
    expect(report.finalDeltaLiquidationValue).toBeLessThan(560_000);
    // The commission costs the owner 6% of the house, which is why the two series disagree.
    expect(report.finalDeltaLiquidationValue).toBeLessThan(report.finalDeltaNetWorth);
  });

  /**
   * Renting wins — but owning led for 39 years first, so this is the case a naive "first year owning
   * is ahead" implementation gets wrong. It would report a break-even at year 6 for a comparison the
   * owner loses by half a million.
   *
   *   rent 3,400 instead of 3,800: year 5 −9,498, year 6 +1,448, ..., year 44 +108,487, year 52 −410,643
   */
  it('refuses to call a temporary lead a break-even', () => {
    const report = compareHousing(withEmbeddedGains(), { residence: createFinancedResidence(), monthlyRent: 3400 }, OPTIONS);

    expect(report.firstAhead).toEqual({ yearIndex: 6, age: report.years[6].age, calendarYear: 2033 });
    expect(report.breakEven).toBeNull();
    expect(report.liquidationBreakEven).toBeNull();

    const ahead = report.years.filter((year) => year.deltaNetWorth > HOUSING_TIE_TOLERANCE);
    expect(ahead[0].yearIndex).toBe(6);
    expect(ahead[ahead.length - 1].yearIndex).toBeLessThan(report.years.length - 1);

    expect(report.finalWinner).toBe('renting');
    expect(report.finalDeltaNetWorth).toBeLessThan(-380_000);
    expect(report.finalDeltaNetWorth).toBeGreaterThan(-450_000);
  });

  /**
   * Owning never catches up: at 2,000 a month the rent is cheaper than the property tax plus
   * maintenance plus the return the down payment would have earned, in every year of the horizon.
   */
  it('reports "never" as null, not as year zero', () => {
    const report = compareHousing(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 2000 }, OPTIONS);

    expect(report.years[0].deltaNetWorth).toBeLessThan(0);
    expect(report.years.every((year) => year.deltaNetWorth < -HOUSING_TIE_TOLERANCE)).toBe(true);
    expect(report.firstAhead).toBeNull();
    expect(report.breakEven).toBeNull();
    expect(report.liquidationBreakEven).toBeNull();
    expect(report.finalWinner).toBe('renting');
    expect(report.finalDeltaNetWorth).toBeLessThan(-4_400_000);
    expect(report.finalDeltaNetWorth).toBeGreaterThan(-4_600_000);
  });

  it('reports owning ahead from the first data point as year 0', () => {
    const report = compareHousing(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 4000 }, OPTIONS);

    expect(report.years[0].deltaNetWorth).toBeGreaterThan(0);
    expect(report.years.every((year) => year.deltaNetWorth > HOUSING_TIE_TOLERANCE)).toBe(true);
    expect(report.breakEven).toEqual({ yearIndex: 0, age: report.years[0].age, calendarYear: 2027 });
    expect(report.firstAhead).toEqual(report.breakEven);
    expect(report.finalWinner).toBe('owning');
    expect(report.finalDeltaNetWorth).toBeGreaterThan(1_050_000);
    expect(report.finalDeltaNetWorth).toBeLessThan(1_250_000);
  });
});

describe('identical inputs, and repeat runs', () => {
  it('compares identical plans to exactly zero', () => {
    const plan = withNoEmbeddedGains();
    const report = compareHousingPlans(plan, plan, OPTIONS);

    expect(report.years).not.toHaveLength(0);
    expect(report.years.every((year) => year.deltaNetWorth === 0)).toBe(true);
    expect(report.years.every((year) => year.deltaPortfolio === 0)).toBe(true);
    expect(report.years.every((year) => year.deltaLiquidationValue === 0)).toBe(true);

    expect(report.breakEven).toBeNull();
    expect(report.firstAhead).toBeNull();
    expect(report.liquidationBreakEven).toBeNull();
    expect(report.finalWinner).toBe('tie');
    expect(report.finalLiquidationWinner).toBe('tie');
    expect(report.finalDeltaNetWorth).toBe(0);
    expect(report.finalDeltaLiquidationValue).toBe(0);

    // ...and both sides really ran: the zero is a zero delta, not an empty report.
    expect(report.years[report.years.length - 1].owning.netWorth).toBeGreaterThan(1_000_000);
  });

  it('returns deep-equal reports for repeat runs and threads the seed and mode through both', () => {
    const base = withEmbeddedGains();
    const choice = { residence: createFinancedResidence(), monthlyRent: 3800 };

    const first = compareHousing(base, choice, OPTIONS);
    const second = compareHousing(base, choice, OPTIONS);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    expect(first.asOf).toBe(AS_OF);
    expect(first.seed).toBe(SEED);
    expect(first.mode).toBe('fixedReturns');

    // The same seed on the stochastic path is deterministic too, and a different seed is not.
    const seeded = compareHousing(base, choice, { asOf: AS_OF, seed: 7, mode: 'stochasticReturns' });
    const again = compareHousing(base, choice, { asOf: AS_OF, seed: 7, mode: 'stochasticReturns' });
    const otherSeed = compareHousing(base, choice, { asOf: AS_OF, seed: 8, mode: 'stochasticReturns' });

    expect(again).toEqual(seeded);
    expect(seeded.mode).toBe('stochasticReturns');
    expect(otherSeed.finalDeltaNetWorth).not.toBe(seeded.finalDeltaNetWorth);
  });

  it('takes the clock from the options, not from the host', () => {
    const base = withNoEmbeddedGains();
    const choice = { residence: createResidence(), monthlyRent: 4000 };

    const early = compareHousing(base, choice, { asOf: '2026-03-15', seed: SEED });
    const late = compareHousing(base, choice, { asOf: '2030-06-01', seed: SEED });

    expect(early.asOf).toBe('2026-03-15');
    expect(late.asOf).toBe('2030-06-01');
    // Same plan, four years later on the plan's own axis: the labels move with `asOf`.
    expect(early.years[0].calendarYear).toBe(2027);
    expect(late.years[0].calendarYear).toBe(2031);
    expect(late.years[0].age).toBeGreaterThan(early.years[0].age);
  });
});

describe('the derived housing costs', () => {
  const datedResidence = (overrides: Partial<PhysicalAssetInputs> = {}) =>
    createResidence({ purchaseDate: { type: 'customDate', year: 2026, month: 3 }, ...overrides });

  it('prices property tax off the Prop 13 assessment, not the market value', () => {
    const { owning } = deriveHousingPlans(withNoEmbeddedGains(), { residence: datedResidence(), monthlyRent: 4000 });
    const propertyTax = owning.expenses[housingPropertyTaxExpenseId(RESIDENCE_ID)];

    expect(propertyTax.amount).toBe(prop13AnnualTax(PURCHASE_PRICE, PROP_13_DEFAULT_RATE_PERCENT));
    expect(propertyTax.amount).toBe(8_800);
    expect(propertyTax.frequency).toBe('yearly');

    // The plan's appreciation is real (3%) and Prop 13's cap is nominal (2%), so the conversion runs
    // through inflation once: nominal appreciation is 1.03 × 1.03 − 1 = 6.09%, the 2% cap binds, and
    // the capped nominal growth deflated by 3% inflation is 1.02 / 1.03 − 1 = −0.9709%.
    expect(owning.marketAssumptions.inflationRate).toBe(3);
    expect(propertyTax.growth?.growthRate).toBeCloseTo((1.02 / 1.03 - 1) * 100, 10);
  });

  it('lets property tax grow with the house exactly when appreciation is below the cap', () => {
    const { owning } = deriveHousingPlans(withNoEmbeddedGains(), {
      residence: datedResidence({ appreciationRate: -2 }),
      monthlyRent: 4000,
    });
    const propertyTax = owning.expenses[housingPropertyTaxExpenseId(RESIDENCE_ID)];

    // Nominal appreciation is 0.98 × 1.03 − 1 = 0.94%, below the cap, so the deflation cancels the
    // conversion and the tax grows at the house's real rate.
    expect(propertyTax.growth?.growthRate).toBeCloseTo(-2, 10);
  });

  it('charges maintenance and insurance as a percent of the house, tracking the house', () => {
    const { owning } = deriveHousingPlans(withNoEmbeddedGains(), { residence: datedResidence(), monthlyRent: 4000 });
    const maintenance = owning.expenses[housingMaintenanceExpenseId(RESIDENCE_ID)];

    expect(maintenance.amount).toBe(PURCHASE_PRICE * (DEFAULT_MAINTENANCE_RATE_PERCENT / 100));
    expect(maintenance.growth?.growthRate).toBe(3);
    expect(maintenance.frequency).toBe('yearly');
  });

  it('runs the derived property tax through the engine at the converted rate, year by year', () => {
    const base = withNoEmbeddedGains();
    const { owning } = deriveHousingPlans(base, { residence: datedResidence(), monthlyRent: 4000 });
    const propertyTaxId = housingPropertyTaxExpenseId(RESIDENCE_ID);
    const run = simulate(owning, { mode: 'fixedReturns', seed: SEED, asOf: AS_OF });

    const yearly = run.result.data.slice(1).map((point) => point.expenses?.perExpenseData[propertyTaxId]?.expense ?? 0);
    expect(yearly[0]).toBeGreaterThan(8_500);
    expect(yearly[0]).toBeLessThan(8_800);
    // Each 12-month window contains exactly one plan-year boundary, so consecutive years differ by
    // exactly the converted rate — the engine charges what the derivation priced.
    for (let index = 0; index < 5; index++) {
      expect(yearly[index + 1] / yearly[index]).toBeCloseTo(1 + (1.02 / 1.03 - 1), 10);
    }
  });

  it('charges the interim rent until a future purchase, then stops', () => {
    const base = withNoEmbeddedGains();
    const { owning } = deriveHousingPlans(base, {
      residence: { ...createResidence(), purchaseDate: { type: 'customDate', year: 2030, month: 1 } },
      monthlyRent: 4000,
    });

    expect(owning.expenses[HOUSING_RENT_EXPENSE_ID].timeframe).toEqual({
      start: { type: 'now' },
      end: { type: 'customDate', year: 2030, month: 1 },
    });

    const run = simulate(owning, { mode: 'fixedReturns', seed: SEED, asOf: AS_OF });
    const rentPaid = run.result.data.slice(1).map((point) => point.expenses?.perExpenseData[HOUSING_RENT_EXPENSE_ID]?.expense ?? 0);
    const houseValue = run.result.data.slice(1).map((point) => point.physicalAssets?.perAssetData[RESIDENCE_ID]?.marketValue ?? 0);

    // The owner lives somewhere before closing: rent in the first years, no house.
    expect(rentPaid[0]).toBeCloseTo(4000 * 12, 6);
    expect(houseValue[0]).toBe(0);
    // ...and once the house is bought, the rent is gone and the house is there.
    expect(rentPaid[5]).toBe(0);
    expect(houseValue[5]).toBeGreaterThan(PURCHASE_PRICE);
  });
});

describe('the guards', () => {
  it('refuses a “now” residence, which the engine treats as already owned and already paid for', () => {
    expect(() => deriveHousingPlans(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 4000 })).toThrow(
      /must be purchased on a date/
    );
  });

  it('refuses to convert a financed “now” residence with no down payment', () => {
    const financedWithoutDownPayment = createResidence({
      paymentMethod: { type: 'loan', loanBalance: PURCHASE_PRICE - DOWN_PAYMENT, apr: 6, monthlyPayment: MONTHLY_PAYMENT },
    });

    expect(() => compareHousing(withNoEmbeddedGains(), { residence: financedWithoutDownPayment, monthlyRent: 3800 }, OPTIONS)).toThrow(
      /downPayment/
    );
  });

  it('refuses a purchase the plan cannot fund', () => {
    // 1.5M of house on 1.1M of capital: the engine would leave 400k of the price unpaid and still
    // count the house, which reads as a 375k win for owning.
    expect(() =>
      compareHousing(withNoEmbeddedGains(), { residence: createResidence({ purchasePrice: 1_500_000 }), monthlyRent: 3200 }, OPTIONS)
    ).toThrow(/owning path leaves up to .* unfunded/);
  });

  it('refuses a rent the plan cannot fund', () => {
    // 7,000 a month exhausts the portfolio before the horizon ends; the unpaid rent would otherwise
    // stop the renter's net worth from falling.
    expect(() => compareHousing(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 7000 }, OPTIONS)).toThrow(
      /renting path leaves up to .* unfunded/
    );
  });

  it('refuses to overwrite an id it did not create', () => {
    const base = withNoEmbeddedGains();
    const residence = { ...createResidence(), purchaseDate: { type: 'customDate' as const, year: 2026, month: 3 } };

    const occupiedAsset = createSimulatorInputs({ ...base, physicalAssets: { [RESIDENCE_ID]: residence } });
    expect(() => deriveHousingPlans(occupiedAsset, { residence, monthlyRent: 4000 })).toThrow(/already has a physical asset/);

    const occupiedExpense = createSimulatorInputs({
      ...base,
      expenses: {
        ...base.expenses,
        [HOUSING_RENT_EXPENSE_ID]: createLivingExpense({ id: HOUSING_RENT_EXPENSE_ID, name: 'Rent', amount: 1000 }),
      },
    });
    expect(() => deriveHousingPlans(occupiedExpense, { residence, monthlyRent: 4000 })).toThrow(/owns that id/);
  });

  it('refuses a rent that is not positive', () => {
    expect(() => deriveHousingPlans(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: 0 })).toThrow(/greater than zero/);
    expect(() => deriveHousingPlans(withNoEmbeddedGains(), { residence: createResidence(), monthlyRent: Number.NaN })).toThrow(/finite/);
  });

  it('defaults the rates, and a zero selling-cost rate makes liquidation value equal net worth', () => {
    const base = withNoEmbeddedGains();
    const { owning, renting } = deriveHousingPlans(base, {
      residence: { ...createResidence(), purchaseDate: { type: 'customDate', year: 2026, month: 3 } },
      monthlyRent: 4000,
    });
    expect(owning.expenses[housingPropertyTaxExpenseId(RESIDENCE_ID)].amount).toBe(prop13AnnualTax(PURCHASE_PRICE));
    expect(owning.expenses[HOUSING_RENT_EXPENSE_ID].growth?.growthRate).toBe(0);
    expect(renting.expenses[HOUSING_RENT_EXPENSE_ID].timeframe.end).toEqual({ type: 'atLifeExpectancy' });

    const report = compareHousing(base, { residence: createResidence(), monthlyRent: 4000 }, { ...OPTIONS, sellingCostRatePercent: 0 });
    expect(report.years[0].owning.liquidationValue).toBe(report.years[0].owning.netWorth);
    expect(report.liquidationBreakEven).toEqual(report.breakEven);
  });
});
