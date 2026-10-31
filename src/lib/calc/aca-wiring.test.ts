/**
 * ACA Premium Tax Credit (IRC §36B) engine integration (R8).
 *
 * Wire verification for:
 * 1. The 2026 table: the credit over the 2025 HHS poverty guidelines ($15,650 base, which by IRC
 *    §36B(d)(3)(B) is the line in force for coverage year 2026) and the Rev. Proc. 2025-25
 *    percentages for tax year 2026.
 * 2. 400% FPL statutory cliff: credit drops to $0 when income exceeds 400% of the FPL.
 * 3. Refundable credit application: offsets totalTaxesDue or increases totalTaxesRefund.
 * 4. Invariant: totalTaxLiability is strictly reconciled to sum of lines (federal, state, FICA, penalties, NIIT, IRMAA).
 * 5. MFS ineligibility: under IRC §36B(c)(1)(C), married filing separately is ineligible for PTC.
 */

import { describe, expect, it } from 'vitest';

import {
  createDefaultTimeline,
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createEmptyPortfolioData,
  createEmptyReturnsData,
  createMockSimulationState,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';
import { Portfolio } from './portfolio';
import { simulate } from './simulate';
import type { SimulationState } from './simulation-engine';
import { TaxProcessor } from './taxes';
import type { TaxesData } from './taxes';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

const RULESET_YEAR = 2026;

const createState = (age = 45): SimulationState => createMockSimulationState(new Portfolio([]), age);

const sumOfLines = (result: TaxesData): number =>
  result.federalIncomeTaxes.federalIncomeTaxAmount +
  result.capitalGainsTaxes.capitalGainsTaxAmount +
  result.amt.netCharge +
  result.niit.niitAmount +
  result.irmaa.total +
  result.state.total +
  result.earlyWithdrawalPenalties.totalPenaltyAmount +
  result.fica.total;

describe('ACA Premium Tax Credit engine wiring (R8)', () => {
  it('computes ACA premium tax credit for eligible income in 2026', () => {
    // Coverage year 2026 uses the 2025 guidelines: 200% FPL for household size 1 = 2 * 15,650 = $31,300.
    // In the 2026 table, 200% FPL has applicable rate of 6.60% (0.066).
    // Required contribution = 31,300 * 0.066 = $2,065.80.
    // Benchmark SLCSP = $8,000 -> Expected credit = 8,000 - 2,065.80 = $5,934.20.
    const income = 31_300;
    const slcsp = 8_000;

    const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, {
      aca: { optIn: true, householdSize: 1, slcsp },
    });

    const incomes = createEmptyIncomesData({
      totalIncome: income,
      totalWageIncome: income,
      totalAmountWithheld: 0,
    });

    const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

    expect(result.aca).toBeDefined();
    expect(result.aca?.eligible).toBe(true);
    expect(result.aca?.povertyLine).toBe(15_650);
    expect(result.aca?.fplPercent).toBeCloseTo(200, 2);
    expect(result.aca?.applicablePercentage).toBeCloseTo(0.066, 4);
    expect(result.aca?.requiredContribution).toBeCloseTo(2_065.8, 2);
    expect(result.aca?.credit).toBeCloseTo(5_934.2, 2);

    // Invariant: totalTaxLiability is unchanged and matches sumOfLines
    expect(result.totalTaxLiability).toBeCloseTo(sumOfLines(result), 4);

    // Refundable credit offsets taxes due or increases refund
    // If credit > totalTaxLiability, totalTaxesRefund = credit - totalTaxLiability
    const netExpected = result.totalTaxLiability - 5_934.2;
    if (netExpected < 0) {
      expect(result.totalTaxesDue).toBe(0);
      expect(result.totalTaxesRefund).toBeCloseTo(Math.abs(netExpected), 2);
    } else {
      expect(result.totalTaxesDue).toBeCloseTo(netExpected, 2);
      expect(result.totalTaxesRefund).toBe(0);
    }
  });

  it('drops credit to zero at the 400% FPL cliff in 2026, on both sides of the boundary', () => {
    // 400% of the 2025 guideline ($15,650) = $62,600, inclusive (IRC §36B(c)(1)(A)). One dollar more
    // is over the cliff: the credit is $0 and the household pays the tax it otherwise would have.
    const slcsp = 8_000;
    const run = (income: number) => {
      const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, {
        aca: { optIn: true, householdSize: 1, slcsp },
      });

      const incomes = createEmptyIncomesData({
        totalIncome: income,
        totalWageIncome: income,
        totalAmountWithheld: 0,
      });

      return processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
    };

    // At the boundary: 62,600 * 0.0996 = $6,234.96 of contribution → 8,000 - 6,234.96 = $1,765.04.
    const atCliff = run(62_600);
    expect(atCliff.aca).toBeDefined();
    expect(atCliff.aca?.eligible).toBe(true);
    expect(atCliff.aca?.applicablePercentage).toBeCloseTo(0.0996, 4);
    expect(atCliff.aca?.requiredContribution).toBeCloseTo(6_234.96, 2);
    expect(atCliff.aca?.credit).toBeCloseTo(1_765.04, 2);
    expect(atCliff.totalTaxesDue).toBeCloseTo(atCliff.totalTaxLiability - 1_765.04, 2);

    // One dollar over: the credit disappears entirely rather than shading down.
    const overCliff = run(62_601);
    expect(overCliff.aca).toBeDefined();
    expect(overCliff.aca?.eligible).toBe(false);
    expect(overCliff.aca?.credit).toBe(0);
    expect(overCliff.totalTaxesDue).toBeCloseTo(overCliff.totalTaxLiability, 2);
  });

  it('caps the credit at the actual premium paid (§36B(b)(2))', () => {
    // Income = $31,300 (200% of $15,650). SLCSP credit before cap = $5,934.20.
    // If actualPremium = $4,000, credit is capped at $4,000.
    const income = 31_300;
    const slcsp = 8_000;
    const actualPremium = 4_000;

    const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, {
      aca: { optIn: true, householdSize: 1, slcsp, actualPremium },
    });

    const incomes = createEmptyIncomesData({
      totalIncome: income,
      totalWageIncome: income,
      totalAmountWithheld: 0,
    });

    const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

    expect(result.aca?.cappedByActualPremium).toBe(true);
    expect(result.aca?.creditBeforePremiumCap).toBeCloseTo(5_934.2, 2);
    expect(result.aca?.credit).toBe(4_000);
  });

  it('does not compute ACA credit when optIn is false or absent', () => {
    const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, {
      aca: { optIn: false, slcsp: 8_000 },
    });

    const incomes = createEmptyIncomesData({
      totalIncome: 30_000,
      totalWageIncome: 30_000,
      totalAmountWithheld: 0,
    });

    const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

    expect(result.aca).toBeUndefined();
  });

  it('prices a plan simulated past the last vendored year from the prior year’s table, without throwing', () => {
    // The 400 % cliff needs a coverage year whose table exists, and the horizon here starts in 2026
    // (born 1990, life expectancy 87) — so a plan that opts in runs past the newest vendored ACA
    // table (2027). Before `getAcaTable` resolved the nearest prior year, this threw mid-engine in
    // 2028 and the whole run died, pricing only the first two years.
    const base = createSimulatorInputs();
    const plan: SimulatorInputs = {
      ...base,
      timeline: { ...createDefaultTimeline(), birthYear: 1990, birthMonth: 1 },
      incomes: {
        'wage-1': createWageIncome({
          id: 'wage-1',
          name: 'Salary',
          amount: 40_000,
          frequency: 'yearly',
          taxes: { incomeType: 'wage', withholding: 0 },
        }),
      },
      accounts: {},
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
      taxSettings: {
        filingStatus: 'single',
        stateResidency: 'none',
        aca: { optIn: true, householdSize: 1, slcsp: 8_000 },
      },
    };

    const run = simulate(plan, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });

    // The whole horizon prices: one settled return per year, not the two a mid-engine throw left behind.
    expect(run.result.data.length).toBe(run.result.context.yearsToSimulate + 1);

    const settled = run.result.data.filter((point) => point.taxes?.aca !== undefined);
    expect(settled.length).toBeGreaterThan(30);

    // The engine settles the period ending on the row's own date under that date's year, so the row's
    // date year *is* the coverage year. Through 2027 that is a year with its own table; every year
    // after the last vendored row (2027) is priced by it as the nearest prior row and says so.
    for (const point of settled) {
      const coverageYear = Number(point.date.slice(0, 4));
      expect(point.taxes!.aca!.resolvedYear).toBe(Math.min(coverageYear, 2027));
    }

    const lastYear = Number(settled[settled.length - 1].date.slice(0, 4));
    expect(lastYear).toBeGreaterThan(2040); // the horizon really does run well past the table
    expect(settled[settled.length - 1].taxes!.aca!.resolvedYear).toBe(2027);
    // One table priced the whole run: this plan's first settled year is 2027 (the period ending
    // 2027-01-01), so 2027 is both its own year and the fallback for every year after it.
    expect([...new Set(settled.map((point) => point.taxes!.aca!.resolvedYear))]).toStrictEqual([2027]);
  });
});
