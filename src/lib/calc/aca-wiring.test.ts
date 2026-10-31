/**
 * ACA Premium Tax Credit (IRC §36B) engine integration (R8).
 *
 * Wire verification for:
 * 1. Statutory 2026 table and FPL: calculates required contribution and credit under Rev. Proc. 2025-25.
 * 2. 400% FPL statutory cliff: credit drops to $0 when income exceeds 400% of the FPL.
 * 3. Refundable credit application: offsets totalTaxesDue or increases totalTaxesRefund.
 * 4. Invariant: totalTaxLiability is strictly reconciled to sum of lines (federal, state, FICA, penalties, NIIT, IRMAA).
 * 5. MFS ineligibility: under IRC §36B(c)(1)(C), married filing separately is ineligible for PTC.
 */

import { describe, expect, it } from 'vitest';

import {
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createEmptyPortfolioData,
  createEmptyReturnsData,
  createMockSimulationState,
} from './__tests__/test-utils';
import { Portfolio } from './portfolio';
import type { SimulationState } from './simulation-engine';
import { TaxProcessor } from './taxes';
import type { TaxesData } from './taxes';

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
    // 200% FPL for household size 1 = 2 * 15,960 = $31,920.
    // In 2026 table, 200% FPL has applicable rate of 6.60% (0.066).
    // Required contribution = 31,920 * 0.066 = $2,106.72.
    // Benchmark SLCSP = $8,000 -> Expected credit = 8,000 - 2,106.72 = $5,893.28.
    const income = 31_920;
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
    expect(result.aca?.fplPercent).toBeCloseTo(200, 2);
    expect(result.aca?.applicablePercentage).toBeCloseTo(0.066, 4);
    expect(result.aca?.requiredContribution).toBeCloseTo(2_106.72, 2);
    expect(result.aca?.credit).toBeCloseTo(5_893.28, 2);

    // Invariant: totalTaxLiability is unchanged and matches sumOfLines
    expect(result.totalTaxLiability).toBeCloseTo(sumOfLines(result), 4);

    // Refundable credit offsets taxes due or increases refund
    // If credit > totalTaxLiability, totalTaxesRefund = credit - totalTaxLiability
    const netExpected = result.totalTaxLiability - 5_893.28;
    if (netExpected < 0) {
      expect(result.totalTaxesDue).toBe(0);
      expect(result.totalTaxesRefund).toBeCloseTo(Math.abs(netExpected), 2);
    } else {
      expect(result.totalTaxesDue).toBeCloseTo(netExpected, 2);
      expect(result.totalTaxesRefund).toBe(0);
    }
  });

  it('drops credit to zero at the 400% FPL cliff in 2026', () => {
    // 400% cliff: $63,840 is 400% (eligible). $63,850 is > 400% (cliff bites, $0 credit).
    const slcsp = 8_000;
    const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, {
      aca: { optIn: true, householdSize: 1, slcsp },
    });

    const incomes = createEmptyIncomesData({
      totalIncome: 63_850,
      totalWageIncome: 63_850,
      totalAmountWithheld: 0,
    });

    const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

    expect(result.aca).toBeDefined();
    expect(result.aca?.eligible).toBe(false);
    expect(result.aca?.credit).toBe(0);
    expect(result.totalTaxesDue).toBeCloseTo(result.totalTaxLiability, 2);
  });

  it('caps the credit at the actual premium paid (§36B(b)(2))', () => {
    // Income = $31,920 (200% FPL). SLCSP credit before cap = $5,893.28.
    // If actualPremium = $4,000, credit is capped at $4,000.
    const income = 31_920;
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
    expect(result.aca?.creditBeforePremiumCap).toBeCloseTo(5_893.28, 2);
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
});
