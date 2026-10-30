import { describe, it, expect } from 'vitest';

import { TaxProcessor } from './taxes';
import { getRules } from './tax-data';
import { irmaaTierFor } from './tax-data/medicare-irmaa';
import type { FederalTaxRuleset } from './tax-data/types';
import { Portfolio } from './portfolio';
import { computeWagePayrollTaxes } from './payroll-taxes';
import {
  STANDARD_DEDUCTION_SINGLE,
  STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY,
  STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD,
} from './tax-data/standard-deduction';
import { NIIT_RATE, NIIT_THRESHOLDS } from './tax-data/niit-thresholds';
import { SECTION_121_EXCLUSION } from './tax-data/section-121-exclusion';
import {
  createEmptyPortfolioData,
  createEmptyIncomesData,
  createEmptyReturnsData,
  createEmptyPhysicalAssetsData,
} from './__tests__/test-utils';
import type { SimulationState } from './simulation-engine';
import type { PhysicalAssetData } from './physical-assets';

/** Itemized-deduction settings for a test, with the four lines defaulted to zero. */
function deductionSettings(overrides?: {
  mortgageInterest?: number;
  charitable?: number;
  stateAndLocalTaxes?: number;
  medicalExpenses?: number;
  spouseQualifiesForSeniorDeduction?: boolean;
}) {
  const entered =
    overrides === undefined ? undefined : { mortgageInterest: 0, charitable: 0, stateAndLocalTaxes: 0, medicalExpenses: 0, ...overrides };

  return {
    itemizedDeductions: entered,
    spouseQualifiesForSeniorDeduction: overrides?.spouseQualifiesForSeniorDeduction,
  };
}

/**
 * A mock state at `age`.
 *
 * The bracket and capital-gains tests below use 60, not 65, on purpose: from 2026 a filer aged 65 or
 * over also gets the §151(d)(5)(C) senior deduction, which would shift the taxable income every one
 * of those assertions is written against. The senior deduction has its own fixtures in
 * "itemized deductions and the deduction choice".
 */
const createMockSimulationState = (age: number): SimulationState => ({
  time: { date: new Date(2025, 0, 1), age, year: 2025, month: 1 },
  portfolio: new Portfolio([]),
  phase: { name: 'retirement' },
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

// ============================================================================
// Income Tax Bracket Tests
// ============================================================================

describe('TaxProcessor', () => {
  describe('income tax brackets', () => {
    describe('single filing status', () => {
      it('should apply 10% bracket for income up to $12,400', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        // Income of 28,500 - standard deduction of 16,100 = 12,400 taxable
        incomes.totalIncome = 28500;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(12400);
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(1240, 2); // 12,400 * 10%
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.1);
      });

      it('should apply 12% bracket for income between $12,400 and $50,400', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        // Income of 66,500 - standard deduction of 16,100 = 50,400 taxable
        incomes.totalIncome = 66500;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(50400);
        // 12,400 * 10% + (50,400 - 12,400) * 12% = 1,240 + 4,560 = 5,800
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(5800, 2);
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.12);
      });

      it('should calculate progressive tax across multiple brackets', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        // Income of 115,000 - standard deduction of 16,100 = 98,900 taxable
        incomes.totalIncome = 115000;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(98900);
        // 12,400 * 10% + (50,400 - 12,400) * 12% + (98,900 - 50,400) * 22%
        // = 1,240 + 4,560 + 10,670 = 16,470
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(16470, 2);
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.22);
      });
    });

    describe('married filing jointly', () => {
      it('should use married filing jointly brackets', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const incomes = createEmptyIncomesData();
        // Income of 57,000 - standard deduction of 32,200 = 24,800 taxable
        incomes.totalIncome = 57000;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(24800);
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(2480, 2); // 24,800 * 10%
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.1);
      });
    });

    describe('head of household', () => {
      it('should use head of household brackets', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'headOfHousehold');
        const incomes = createEmptyIncomesData();
        // Income of 41,850 - standard deduction of 24,150 = 17,700 taxable
        incomes.totalIncome = 41850;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(17700);
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(1770, 2); // 17,700 * 10%
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.1);
      });
    });

    describe('standard deduction', () => {
      it('should apply standard deduction before calculating taxes', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        incomes.totalIncome = 50000;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // 50,000 - 16,100 standard deduction = 33,900 taxable
        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(33900);
        expect(result.deductions.standardDeduction).toBe(STANDARD_DEDUCTION_SINGLE);
      });

      it('should use correct standard deduction for each filing status', () => {
        const singleProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
        const marriedProcessor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const hohProcessor = new TaxProcessor(createMockSimulationState(60), 'headOfHousehold');
        const incomes = createEmptyIncomesData();
        incomes.totalIncome = 100000;

        const singleResult = singleProcessor.process(
          createEmptyPortfolioData(),
          incomes,
          createEmptyReturnsData(),
          createEmptyPhysicalAssetsData()
        );
        const marriedResult = marriedProcessor.process(
          createEmptyPortfolioData(),
          incomes,
          createEmptyReturnsData(),
          createEmptyPhysicalAssetsData()
        );
        const hohResult = hohProcessor.process(
          createEmptyPortfolioData(),
          incomes,
          createEmptyReturnsData(),
          createEmptyPhysicalAssetsData()
        );

        expect(singleResult.deductions.standardDeduction).toBe(STANDARD_DEDUCTION_SINGLE);
        expect(marriedResult.deductions.standardDeduction).toBe(STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY);
        expect(hohResult.deductions.standardDeduction).toBe(STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD);
      });

      it('should apply standard deduction to ordinary income first, then capital gains', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        incomes.totalIncome = 10000; // Only 10k ordinary income
        const portfolioData = createEmptyPortfolioData();
        portfolioData.realizedGains = 20000; // 20k capital gains

        const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // Standard deduction of 16.1k: 10k applied to ordinary, 6.1k to cap gains
        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(0);
        expect(result.capitalGainsTaxes.taxableIncomeTaxedAsCapitalGains).toBe(13900);
      });
    });
  });

  // ============================================================================
  // Capital Gains Tax Tests
  // ============================================================================

  describe('capital gains tax', () => {
    it('should apply 0% rate for gains within 0% bracket', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      const portfolioData = createEmptyPortfolioData();
      // No ordinary income, 33,125 gains - 16,100 std deduction = 17,025 taxable
      portfolioData.realizedGains = 33125;

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.capitalGainsTaxes.taxableIncomeTaxedAsCapitalGains).toBe(17025);
      expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBe(0);
    });

    it('should apply 15% rate for gains in 15% bracket', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      const portfolioData = createEmptyPortfolioData();
      // No ordinary income, 100,000 gains - 16,100 std deduction = 83,900 taxable
      portfolioData.realizedGains = 100000;

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // 49,450 at 0% + (83,900 - 49,450) at 15% = 0 + 5,167.50 = 5,167.50
      expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBeCloseTo(5167.5, 2);
      expect(result.capitalGainsTaxes.topMarginalCapitalGainsTaxRate).toBe(0.15);
    });

    it('should fill brackets with ordinary income first', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      // 65,550 ordinary - 16,100 std deduction = 49,450 taxable (fills 0% cap gains bracket)
      incomes.totalIncome = 65550;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 10000; // All taxed at 15%

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Capital gains start at 49,450 threshold, so 10k at 15%
      expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBeCloseTo(1500, 2);
    });

    it('should include dividend income in capital gains', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      const portfolioData = createEmptyPortfolioData();
      const returnsData = createEmptyReturnsData();
      returnsData.yieldAmounts.taxable.stocks = 5000; // Dividends

      const result = processor.process(portfolioData, incomes, returnsData, createEmptyPhysicalAssetsData());

      // Dividends are taxed as capital gains
      expect(result.incomeSources.taxableDividendIncome).toBe(5000);
    });
  });

  // ============================================================================
  // NIIT (Net Investment Income Tax) Tests
  // ============================================================================

  describe('NIIT (Net Investment Income Tax)', () => {
    it('should not apply NIIT when AGI is below threshold', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 50000;

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // AGI of 150k is below single threshold of 200k
      expect(result.niit.niitAmount).toBe(0);
    });

    it('should apply 3.8% NIIT on income above threshold', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 150000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 100000;

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // AGI of 250k, threshold 200k, excess of 50k
      // Net investment income = 100k gains
      // NIIT applies to lesser of (NII, excess AGI) = 50k
      expect(result.niit.incomeSubjectToNiit).toBe(50000);
      expect(result.niit.niitAmount).toBeCloseTo(50000 * NIIT_RATE, 2);
    });

    it('should use correct NIIT threshold for married filing jointly', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 200000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 100000;

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // AGI of 300k, threshold 250k for MFJ, excess of 50k
      expect(result.niit.threshold).toBe(NIIT_THRESHOLDS.marriedFilingJointly);
      expect(result.niit.incomeSubjectToNiit).toBe(50000);
    });

    it('should include dividends and interest in net investment income', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 250000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 20000;
      const returnsData = createEmptyReturnsData();
      returnsData.yieldAmounts.taxable.stocks = 10000; // Dividends
      returnsData.yieldAmounts.taxable.bonds = 5000; // Interest
      returnsData.yieldAmounts.cashSavings.cash = 3000; // Cash interest

      const result = processor.process(portfolioData, incomes, returnsData, createEmptyPhysicalAssetsData());

      // NII = 20k gains + 10k dividends + 5k bond interest + 3k cash = 38k
      expect(result.niit.netInvestmentIncome).toBe(38000);
    });
  });

  // ============================================================================
  // Social Security Taxation Tests
  // ============================================================================

  describe('Social Security taxation', () => {
    it('should not tax Social Security when provisional income is below first threshold', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalSocialSecurityIncome = 20000;
      // Provisional income = 0 + (20,000 * 0.5) = 10,000, below 25k threshold

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(0);
      expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0);
    });

    it('should tax up to 50% when provisional income is in middle tier', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalSocialSecurityIncome = 30000;
      incomes.totalIncome = 30000; // Includes SS income
      // With no other income, we need to add some earned income
      // Earned income: 30k - 30k SS = 0
      // Provisional = 0 + 15k (half of SS) = 15k, still below threshold

      // Let's add some other income
      const incomes2 = createEmptyIncomesData();
      incomes2.totalSocialSecurityIncome = 20000;
      incomes2.totalIncome = 40000; // 20k SS + 20k earned
      // Provisional = 20k earned + 10k (half SS) = 30k, in 50% tier (25k-34k)

      const result = processor.process(createEmptyPortfolioData(), incomes2, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
      // Taxable = min((30k - 25k) * 0.5, 20k * 0.5) = min(2.5k, 10k) = 2.5k
      expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBeCloseTo(2500, 2);
    });

    it('should tax up to 85% when provisional income is above upper threshold', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalSocialSecurityIncome = 30000;
      incomes.totalIncome = 80000; // 30k SS + 50k earned
      // Provisional = 50k earned + 15k (half SS) = 65k, well above 34k threshold

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.85);
      // Max taxable = 30k * 0.85 = 25.5k
      expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBeCloseTo(25500, 2);
    });

    it('should use married filing jointly thresholds', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
      const incomes = createEmptyIncomesData();
      incomes.totalSocialSecurityIncome = 30000;
      incomes.totalIncome = 50000; // 30k SS + 20k earned
      // Provisional = 20k + 15k = 35k, in 50% tier for MFJ (32k-44k)

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
    });

    describe('threshold boundary conditions', () => {
      it('single filer: should not tax SS at exactly $25,000 provisional income (Tier 1 boundary)', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        // To get provisional income of exactly $25,000:
        // Provisional = other income + (SS * 0.5)
        // If SS = 20000, other income = 25000 - 10000 = 15000
        incomes.totalSocialSecurityIncome = 20000;
        incomes.totalIncome = 35000; // 20k SS + 15k earned
        // Provisional = 15k + 10k = 25k (exactly at threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // At exactly 25k, we're at the boundary - no SS should be taxable yet
        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0);
        expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(0);
      });

      it('single filer: should tax at 50% just above $25,000 provisional income', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        incomes.totalSocialSecurityIncome = 20000;
        incomes.totalIncome = 35001; // 20k SS + 15001 earned
        // Provisional = 15001 + 10000 = 25001 (just above threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
        // Taxable = (25001 - 25000) * 0.5 = 0.5
        expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBeCloseTo(0.5, 2);
      });

      it('single filer: should tax at 50% at exactly $34,000 provisional income (Tier 2 boundary)', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        // To get provisional income of exactly $34,000:
        // If SS = 20000, other income = 34000 - 10000 = 24000
        incomes.totalSocialSecurityIncome = 20000;
        incomes.totalIncome = 44000; // 20k SS + 24k earned
        // Provisional = 24k + 10k = 34k (exactly at upper threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // At exactly 34k, still in 50% tier
        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
        // Taxable = (34000 - 25000) * 0.5 = 4500
        expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBeCloseTo(4500, 2);
      });

      it('single filer: should tax at 85% just above $34,000 provisional income', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'single');
        const incomes = createEmptyIncomesData();
        incomes.totalSocialSecurityIncome = 20000;
        incomes.totalIncome = 44001; // 20k SS + 24001 earned
        // Provisional = 24001 + 10000 = 34001 (just above upper threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.85);
      });

      it('MFJ: should not tax SS at exactly $32,000 provisional income (Tier 1 boundary)', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const incomes = createEmptyIncomesData();
        // To get provisional income of exactly $32,000:
        // If SS = 24000, other income = 32000 - 12000 = 20000
        incomes.totalSocialSecurityIncome = 24000;
        incomes.totalIncome = 44000; // 24k SS + 20k earned
        // Provisional = 20k + 12k = 32k (exactly at threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0);
        expect(result.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(0);
      });

      it('MFJ: should tax at 50% just above $32,000 provisional income', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const incomes = createEmptyIncomesData();
        incomes.totalSocialSecurityIncome = 24000;
        incomes.totalIncome = 44001; // 24k SS + 20001 earned
        // Provisional = 20001 + 12000 = 32001 (just above threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
      });

      it('MFJ: should tax at 50% at exactly $44,000 provisional income (Tier 2 boundary)', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const incomes = createEmptyIncomesData();
        // To get provisional income of exactly $44,000:
        // If SS = 24000, other income = 44000 - 12000 = 32000
        incomes.totalSocialSecurityIncome = 24000;
        incomes.totalIncome = 56000; // 24k SS + 32k earned
        // Provisional = 32k + 12k = 44k (exactly at upper threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // At exactly 44k, still in 50% tier
        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
      });

      it('MFJ: should tax at 85% just above $44,000 provisional income', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
        const incomes = createEmptyIncomesData();
        incomes.totalSocialSecurityIncome = 24000;
        incomes.totalIncome = 56001; // 24k SS + 32001 earned
        // Provisional = 32001 + 12000 = 44001 (just above upper threshold)

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.socialSecurityTaxes.maxTaxablePercentage).toBe(0.85);
      });
    });
  });

  // ============================================================================
  // Early Withdrawal Penalty Tests
  // ============================================================================

  describe('early withdrawal penalties', () => {
    it('should apply 10% penalty on 401k/IRA withdrawals before age 59.5', () => {
      const processor = new TaxProcessor(createMockSimulationState(50), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        '401k-1': {
          id: '401k-1',
          name: '401k',
          type: '401k',
          balance: 100000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 0, bonds: 0, cash: 0 },
          employerMatch: 0,
          withdrawals: { stocks: 8000, bonds: 2000, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // 10k withdrawal * 10% = 1k penalty
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(1000);
    });

    it('should not apply penalty on 401k/IRA withdrawals at age 59.5+', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        '401k-1': {
          id: '401k-1',
          name: '401k',
          type: '401k',
          balance: 100000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 0, bonds: 0, cash: 0 },
          employerMatch: 0,
          withdrawals: { stocks: 8000, bonds: 2000, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
    });

    it('should apply 20% penalty on HSA withdrawals before age 65', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        'hsa-1': {
          id: 'hsa-1',
          name: 'HSA',
          type: 'hsa',
          balance: 50000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 0, bonds: 0, cash: 0 },
          employerMatch: 0,
          withdrawals: { stocks: 4000, bonds: 1000, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // 5k withdrawal * 20% = 1k penalty
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(1000);
    });

    it('should apply 10% penalty on Roth earnings (not contributions) before 59.5', () => {
      const processor = new TaxProcessor(createMockSimulationState(50), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 50000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 0, bonds: 0, cash: 0 },
          employerMatch: 0,
          withdrawals: { stocks: 8000, bonds: 2000, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 3000, // Only earnings get penalized
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Only 3k earnings * 10% = 300 penalty (contributions are not penalized)
      expect(result.earlyWithdrawalPenalties.taxFreePenaltyAmount).toBe(300);
    });
  });

  // ============================================================================
  // Capital Loss Carryover Tests
  // ============================================================================

  describe('capital loss carryover', () => {
    it('should limit capital loss deduction to $3,000 per year', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = -10000; // 10k loss

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.federalIncomeTaxes.capitalLossDeduction).toBe(3000);
    });

    it('should carry over losses to subsequent years', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;

      // Year 1: 10k loss, deduct 3k, carry over 7k
      portfolioData.realizedGains = -10000;
      const result1 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result1.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 2: No new gains/losses, deduct 3k from carryover, 4k remaining
      portfolioData.realizedGains = 0;
      const result2 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result2.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 3: No new gains/losses, deduct 3k from carryover, 1k remaining
      const result3 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result3.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 4: No new gains/losses, deduct remaining 1k
      const result4 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result4.federalIncomeTaxes.capitalLossDeduction).toBe(1000);
    });

    it('should offset gains with losses before applying carryover', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;

      // Year 1: 10k loss
      portfolioData.realizedGains = -10000;
      processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Year 2: 5k gain, should offset with 5k carryover, leaving 2k carryover
      // Then deduct remaining from ordinary income (but there's only 2k left)
      portfolioData.realizedGains = 5000;
      const result2 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      // Carryover was 7k after year 1
      // 5k gain offsets 5k of carryover, leaving 2k
      // 2k loss deduction from carryover
      expect(result2.incomeSources.realizedGains).toBe(0);
      expect(result2.federalIncomeTaxes.capitalLossDeduction).toBe(2000);
    });

    it('should preserve carryover across iterative convergence using snapshot/restore', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;

      // Year 1: 10k loss - simulate iterative convergence by calling process() multiple times
      portfolioData.realizedGains = -10000;

      // Save snapshot before first calculation
      processor.saveCarryoverSnapshot();

      const result1a = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result1a.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Simulate convergence iterations - restore and process again
      processor.restoreCarryoverSnapshot();
      const result1b = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result1b.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      processor.restoreCarryoverSnapshot();
      const result1c = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      expect(result1c.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 2: No new losses - should still have 7k carryover available
      portfolioData.realizedGains = 0;
      processor.saveCarryoverSnapshot();
      const result2 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Should deduct another 3k from the 7k carryover
      expect(result2.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 3: No new losses - should still have 4k carryover available
      processor.saveCarryoverSnapshot();
      const result3 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result3.federalIncomeTaxes.capitalLossDeduction).toBe(3000);

      // Year 4: No new losses - should have 1k carryover remaining
      processor.saveCarryoverSnapshot();
      const result4 = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result4.federalIncomeTaxes.capitalLossDeduction).toBe(1000);
    });
  });

  // ============================================================================
  // Tax-Deductible Contributions Tests
  // ============================================================================

  describe('tax-deductible contributions', () => {
    it('should reduce taxable income by 401k contributions', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        '401k-1': {
          id: '401k-1',
          name: '401k',
          type: '401k',
          balance: 100000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 16000, bonds: 4000, cash: 0 }, // 20k total
          employerMatch: 5000, // Employer match not deductible
          withdrawals: { stocks: 0, bonds: 0, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // 20k contributions - 5k employer match = 15k deductible
      expect(result.adjustments.taxDeductibleContributions).toBe(15000);
      // 100k - 15k deduction - 16,100 std deduction = 68,900 taxable
      expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(68900);
    });

    it('should include IRA and HSA contributions as deductible', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        'ira-1': {
          id: 'ira-1',
          name: 'IRA',
          type: 'ira',
          balance: 50000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 5600, bonds: 1400, cash: 0 }, // 7k IRA
          employerMatch: 0,
          withdrawals: { stocks: 0, bonds: 0, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
        'hsa-1': {
          id: 'hsa-1',
          name: 'HSA',
          type: 'hsa',
          balance: 20000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 3200, bonds: 800, cash: 0 }, // 4k HSA
          employerMatch: 0,
          withdrawals: { stocks: 0, bonds: 0, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // 7k IRA + 4k HSA = 11k deductible
      expect(result.adjustments.taxDeductibleContributions).toBe(11000);
    });

    it('should NOT include Roth contributions as deductible', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      const portfolioData = createEmptyPortfolioData();
      portfolioData.perAccountData = {
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 50000,
          cumulativeContributions: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeEmployerMatch: 0,
          cumulativeWithdrawals: { stocks: 0, bonds: 0, cash: 0 },
          cumulativeRealizedGains: 0,
          cumulativeEarningsWithdrawn: 0,
          cumulativeRmds: 0,
          assetAllocation: { stocks: 0.8, bonds: 0.2, cash: 0 },
          contributions: { stocks: 5600, bonds: 1400, cash: 0 }, // 7k
          employerMatch: 0,
          withdrawals: { stocks: 0, bonds: 0, cash: 0 },
          realizedGains: 0,
          earningsWithdrawn: 0,
          rmds: 0,
        },
      };

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Roth contributions are not deductible
      expect(result.adjustments.taxDeductibleContributions).toBe(0);
    });
  });

  // ============================================================================
  // Tax Refund / Due Calculations
  // ============================================================================

  describe('tax refund and due calculations', () => {
    it('should calculate refund when withholding exceeds tax liability', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;
      incomes.totalAmountWithheld = 10000; // Over-withheld

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      // Tax on 33,900 taxable: 12,400 * 10% + 21,500 * 12% = 1,240 + 2,580 = 3,820
      expect(result.totalTaxesRefund).toBeGreaterThan(0);
      expect(result.totalTaxesDue).toBe(0);
    });

    it('should calculate amount due when tax liability exceeds withholding', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      incomes.totalAmountWithheld = 5000; // Under-withheld

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.totalTaxesDue).toBeGreaterThan(0);
      expect(result.totalTaxesRefund).toBe(0);
    });
  });

  // ============================================================================
  // Section 121 Primary Residence Exclusion Tests
  // ============================================================================

  describe('Section 121 primary residence exclusion', () => {
    const createPhysicalAssetData = (overrides: Partial<PhysicalAssetData> & { id: string }): PhysicalAssetData => ({
      name: overrides.name ?? 'Asset',
      assetType: overrides.assetType ?? 'primaryResidence',
      marketValue: overrides.marketValue ?? 0,
      loanBalance: overrides.loanBalance ?? 0,
      equity: overrides.equity ?? 0,
      paymentType: overrides.paymentType ?? 'cash',
      appreciation: overrides.appreciation ?? 0,
      loanPayment: overrides.loanPayment ?? 0,
      purchaseOutlay: overrides.purchaseOutlay ?? 0,
      purchaseMarketValue: overrides.purchaseMarketValue ?? 0,
      saleProceeds: overrides.saleProceeds ?? 0,
      saleMarketValue: overrides.saleMarketValue ?? 0,
      realizedGains: overrides.realizedGains ?? 0,
      interest: overrides.interest ?? 0,
      principalPaid: overrides.principalPaid ?? 0,
      unpaidInterest: overrides.unpaidInterest ?? 0,
      debtPaydown: overrides.debtPaydown ?? 0,
      securedDebtIncurred: overrides.securedDebtIncurred ?? 0,
      debtPayoff: overrides.debtPayoff ?? 0,
      isSold: overrides.isSold ?? false,
      ...overrides,
    });

    it('should exclude primary residence gain under cap (single)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(200000);
      expect(result.incomeSources.realizedGains).toBe(0);
    });

    it('should not exclude gains from non-primary-residence assets', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          other1: createPhysicalAssetData({ id: 'other1', assetType: 'other', realizedGains: 200000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(0);
    });

    it('should result in lower taxable gains for primary residence vs non-primary residence', () => {
      const primaryProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const primaryData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });
      const primaryResult = primaryProcessor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData(),
        createEmptyReturnsData(),
        primaryData
      );

      const otherProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const otherData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          other1: createPhysicalAssetData({ id: 'other1', assetType: 'other', realizedGains: 200000 }),
        },
      });
      const otherResult = otherProcessor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), otherData);

      expect(primaryResult.incomeSources.realizedGains).toBeLessThan(otherResult.incomeSources.realizedGains);
    });

    it('should cap exclusion at single filing status limit ($250k)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 400000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 400000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(SECTION_121_EXCLUSION.single);
    });

    it('should use $500k cap for married filing jointly', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 600000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 600000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(SECTION_121_EXCLUSION.marriedFilingJointly);
    });

    it('should use $250k cap for head of household', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'headOfHousehold');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 300000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 300000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(SECTION_121_EXCLUSION.headOfHousehold);
    });

    it('should not exclude negative gains (losses)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: -50000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: -50000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(0);
    });

    it('should apply exclusion per-home for multiple primary residences (each under cap)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 400000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
          home2: createPhysicalAssetData({ id: 'home2', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      // Each home gets its own $250k cap: min(200k, 250k) + min(200k, 250k) = 400k
      expect(result.adjustments.section121Exclusion).toBe(400000);
      expect(result.incomeSources.realizedGains).toBe(0);
    });

    it('should apply per-home cap independently for multiple homes exceeding cap', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 600000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 300000 }),
          home2: createPhysicalAssetData({ id: 'home2', assetType: 'primaryResidence', realizedGains: 300000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      // Each home capped at $250k: min(300k, 250k) + min(300k, 250k) = 500k
      expect(result.adjustments.section121Exclusion).toBe(500000);
    });

    it('should not exclude gains for unsold asset with zero realized gains', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 0,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 0 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(0);
    });

    it('should exclude primary residence gains but not portfolio gains', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 50000;
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });

      const result = processor.process(portfolioData, createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(200000);
      expect(result.incomeSources.realizedGains).toBe(50000);
    });

    it('should exclude primary residence gain but not other physical asset gain in same year', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 300000, // 200k primary + 100k other
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
          shed1: createPhysicalAssetData({ id: 'shed1', assetType: 'other', realizedGains: 100000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      // Only the primary residence gain is excluded
      expect(result.adjustments.section121Exclusion).toBe(200000);
      // The other asset's 100k gain flows through as taxable
      expect(result.incomeSources.realizedGains).toBe(100000);
    });

    it('should fully exclude gain exactly at single cap boundary ($250k)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 250000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 250000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(250000);
      expect(result.incomeSources.realizedGains).toBe(0);
    });

    it('should fully exclude gain exactly at MFJ cap boundary ($500k)', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly');
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 500000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 500000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), createEmptyIncomesData(), createEmptyReturnsData(), physicalAssetsData);

      expect(result.adjustments.section121Exclusion).toBe(500000);
      expect(result.incomeSources.realizedGains).toBe(0);
    });

    it('should reduce capital gains tax amount via Section 121 exclusion', () => {
      // With exclusion: primary residence gain excluded, no capital gains tax
      const withExclusionProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000; // Enough to fill 0% cap gains bracket
      const primaryData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });
      const withExclusionResult = withExclusionProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        primaryData
      );

      // Without exclusion: same gain as non-primary, full capital gains tax
      const withoutExclusionProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const otherData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          other1: createPhysicalAssetData({ id: 'other1', assetType: 'other', realizedGains: 200000 }),
        },
      });
      const withoutExclusionResult = withoutExclusionProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        otherData
      );

      // End-to-end: the exclusion should actually reduce the capital gains tax bill
      expect(withExclusionResult.capitalGainsTaxes.capitalGainsTaxAmount).toBe(0);
      expect(withoutExclusionResult.capitalGainsTaxes.capitalGainsTaxAmount).toBeGreaterThan(0);
    });

    it('should reduce NIIT via Section 121 exclusion for high-income filer', () => {
      // With exclusion: primary residence gain excluded, lower NII and NIIT
      const withExclusionProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 200000; // At NIIT threshold
      const primaryData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });
      const withExclusionResult = withExclusionProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        primaryData
      );

      // Without exclusion: same gain as non-primary, higher NII
      const withoutExclusionProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const otherData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          other1: createPhysicalAssetData({ id: 'other1', assetType: 'other', realizedGains: 200000 }),
        },
      });
      const withoutExclusionResult = withoutExclusionProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        otherData
      );

      // Exclusion should reduce net investment income and NIIT
      expect(withExclusionResult.niit.netInvestmentIncome).toBeLessThan(withoutExclusionResult.niit.netInvestmentIncome);
      expect(withExclusionResult.niit.niitAmount).toBeLessThan(withoutExclusionResult.niit.niitAmount);
    });

    it('should not affect ordinary income tax via Section 121 exclusion', () => {
      const withExclusionProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 100000;
      const primaryData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });
      const withExclusionResult = withExclusionProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        primaryData
      );

      const noGainsProcessor = new TaxProcessor(createMockSimulationState(60), 'single');
      const noGainsResult = noGainsProcessor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      // Ordinary income tax should be identical regardless of excluded home sale gains
      expect(withExclusionResult.federalIncomeTaxes.federalIncomeTaxAmount).toBe(noGainsResult.federalIncomeTaxes.federalIncomeTaxAmount);
      expect(withExclusionResult.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(
        noGainsResult.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary
      );
    });

    it('should exclude gain on one primary residence while loss on another flows through', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 150000, // 200k gain + (-50k loss)
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
          home2: createPhysicalAssetData({ id: 'home2', assetType: 'primaryResidence', realizedGains: -50000 }),
        },
      });

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), physicalAssetsData);

      // Only the positive gain home gets exclusion (200k excluded)
      // Loss home is ignored by exclusion filter (realizedGains > 0)
      // physicalAssetRealizedGains = 150k - 200k = -50k
      // This -50k flows into the capital loss carryover system
      expect(result.adjustments.section121Exclusion).toBe(200000);
      expect(result.incomeSources.realizedGains).toBe(0);
      expect(result.federalIncomeTaxes.capitalLossDeduction).toBe(3000);
    });

    it('should interact correctly with capital loss carryover', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single');
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 50000;

      // Year 1: Portfolio loss of $10k creates carryover
      const portfolioDataYear1 = createEmptyPortfolioData();
      portfolioDataYear1.realizedGains = -10000;
      processor.process(portfolioDataYear1, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      // After year 1: carryover = -(10000 - 3000) = -7000

      // Year 2: Primary residence sold with $200k gain + no portfolio gains
      const portfolioDataYear2 = createEmptyPortfolioData();
      const physicalAssetsData = createEmptyPhysicalAssetsData({
        totalRealizedGains: 200000,
        perAssetData: {
          home1: createPhysicalAssetData({ id: 'home1', assetType: 'primaryResidence', realizedGains: 200000 }),
        },
      });

      const result2 = processor.process(portfolioDataYear2, incomes, createEmptyReturnsData(), physicalAssetsData);

      // Section 121 excludes 200k, physical asset realized gains = 0
      // Portfolio gains = 0 + physical asset realized gains (0) + carryover (-7k) = -7k
      // Capital loss deduction of 3k, remaining carryover of 4k
      expect(result2.adjustments.section121Exclusion).toBe(200000);
      expect(result2.incomeSources.realizedGains).toBe(0);
      expect(result2.federalIncomeTaxes.capitalLossDeduction).toBe(3000);
    });
  });

  // ============================================================================
  // Parametrized Tests Across Filing Statuses
  // ============================================================================

  describe('bracket boundary interactions across filing statuses', () => {
    const filingStatuses = [
      { status: 'single' as const, deduction: STANDARD_DEDUCTION_SINGLE, firstBracketMax: 12400, secondBracketMax: 50400 },
      {
        status: 'marriedFilingJointly' as const,
        deduction: STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY,
        firstBracketMax: 24800,
        secondBracketMax: 100800,
      },
      {
        status: 'headOfHousehold' as const,
        deduction: STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD,
        firstBracketMax: 17700,
        secondBracketMax: 67450,
      },
    ];

    describe.each(filingStatuses)('$status filing status', ({ status, deduction, firstBracketMax, secondBracketMax }) => {
      it('should correctly split tax across the 10%/12% bracket boundary', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), status);
        const incomes = createEmptyIncomesData();
        // Set income so taxable = secondBracketMax (crosses into 12% bracket)
        incomes.totalIncome = secondBracketMax + deduction;

        const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(secondBracketMax);

        // Tax = firstBracketMax * 10% + (secondBracketMax - firstBracketMax) * 12%
        const expectedTax = firstBracketMax * 0.1 + (secondBracketMax - firstBracketMax) * 0.12;
        expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(expectedTax, 2);
        expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.12);
      });
    });
  });

  describe('capital gains bracket stacking across filing statuses', () => {
    const filingStatuses = [
      { status: 'single' as const, deduction: STANDARD_DEDUCTION_SINGLE, cgZeroMax: 49450 },
      { status: 'marriedFilingJointly' as const, deduction: STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY, cgZeroMax: 98900 },
      { status: 'headOfHousehold' as const, deduction: STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD, cgZeroMax: 66200 },
    ];

    describe.each(filingStatuses)('$status filing status', ({ status, deduction, cgZeroMax }) => {
      it('should stack capital gains on top of ordinary income for bracket determination', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), status);
        const incomes = createEmptyIncomesData();
        // Ordinary income fills up to the 0% CG threshold
        incomes.totalIncome = cgZeroMax + deduction;

        const portfolioData = createEmptyPortfolioData();
        // $10,000 in realized gains sits entirely in the 15% CG bracket
        portfolioData.realizedGains = 10000;

        const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // All gains should be taxed at 15% since ordinary income fills the 0% bracket
        expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBeCloseTo(10000 * 0.15, 2);
        expect(result.capitalGainsTaxes.topMarginalCapitalGainsTaxRate).toBe(0.15);
      });

      it('should tax gains at 0% when total income is below the 0% CG threshold', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), status);
        const incomes = createEmptyIncomesData();
        // Low ordinary income: only $10,000 after deduction
        incomes.totalIncome = 10000 + deduction;

        const portfolioData = createEmptyPortfolioData();
        // Small gains that stay within 0% bracket
        const gainsAmount = Math.min(5000, cgZeroMax - 10000);
        portfolioData.realizedGains = gainsAmount;

        const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // All gains should be in the 0% bracket
        expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBe(0);
      });
    });
  });

  describe('NIIT threshold interaction across filing statuses', () => {
    const filingStatuses = [
      { status: 'single' as const, deduction: STANDARD_DEDUCTION_SINGLE, threshold: NIIT_THRESHOLDS.single },
      {
        status: 'marriedFilingJointly' as const,
        deduction: STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY,
        threshold: NIIT_THRESHOLDS.marriedFilingJointly,
      },
      {
        status: 'headOfHousehold' as const,
        deduction: STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD,
        threshold: NIIT_THRESHOLDS.headOfHousehold,
      },
    ];

    describe.each(filingStatuses)('$status filing status (threshold=$threshold)', ({ status, deduction, threshold }) => {
      it('should not apply NIIT when AGI is below threshold', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), status);
        const incomes = createEmptyIncomesData();
        // Income slightly below threshold (after adjustments, AGI will be below)
        incomes.totalIncome = threshold - 10000;

        const portfolioData = createEmptyPortfolioData();
        portfolioData.realizedGains = 5000;

        const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        expect(result.niit.niitAmount).toBe(0);
      });

      it('should apply NIIT on investment income when AGI exceeds threshold', () => {
        const processor = new TaxProcessor(createMockSimulationState(60), status);
        const incomes = createEmptyIncomesData();
        // Income well above threshold
        incomes.totalIncome = threshold + 50000;

        const portfolioData = createEmptyPortfolioData();
        portfolioData.realizedGains = 20000;

        const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

        // NIIT = min(NII, MAGI - threshold) * 3.8%
        expect(result.niit.niitAmount).toBeGreaterThan(0);
        expect(result.niit.threshold).toBe(threshold);
      });
    });
  });

  /**
   * P3-P4's single reconciliation invariant. Every tax line is added in exactly one place in
   * `TaxProcessor.process()`, and this asserts that the total is that sum — no line omitted, no
   * line counted twice (the old double-counting hazard R10 describes).
   */
  /**
   * AMT and IRMAA (P3-P7a), hand-worked against the 2026 ruleset.
   *
   * The AMT is a parallel system, so the only representation that keeps one reconciled total is a
   * top-up: `amt.topUp = max(0, tentativeMinimumTax − regularIncomeTax)`, charged as `amt.netCharge`
   * beside the regular tax, with `amt.applied` saying which one the year paid.
   */
  describe('alternative minimum tax', () => {
    /** 2026 single, hand-worked from the bracket table: 12,400 / 38,000 / 55,300 / 28,200. */
    const regularTaxOn133900 = 1240 + 4560 + 12166 + 28200 * 0.24; // = 24,734

    it('is shadowed when the regular tax wins, and charges nothing', () => {
      // $150,000 of wages, single, 2026:
      //   regular taxable income = 150,000 − 16,100 = $133,900
      //   regular tax            = 1,240 + 4,560 + 12,166 + 28,200 × 24% = $24,734
      //   AMTI = 133,900 + 16,100 (the standard deduction is disallowed, §56(b)(1)) = $150,000
      //   exemption = $90,100 (below the $500,000 phase-out start)
      //   AMT base = 59,900, below the $175,000 ceiling → 59,900 × 26% = $15,574
      //   topUp = max(0, 15,574 − 24,734) = $0 → `applied: 'regular'`
      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026);
      const incomes = createEmptyIncomesData({ totalIncome: 150000, totalWageIncome: 150000 });

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(regularTaxOn133900).toBeCloseTo(24734);
      expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(regularTaxOn133900);

      expect(result.amt.regularIncomeTax).toBeCloseTo(24734);
      expect(result.amt.amtIncome).toBeCloseTo(150000);
      expect(result.amt.addbacks).toBeCloseTo(16100);
      expect(result.amt.exemption).toBeCloseTo(90100);
      expect(result.amt.tentativeMinimumTax).toBeCloseTo(15574);
      expect(result.amt.topUp).toBe(0);
      expect(result.amt.applied).toBe('regular');
      expect(result.amt.netCharge).toBe(0);
      expect(result.amt.creditCarryforward).toBe(0);
      // The total is the regular tax; the AMT contributed exactly zero.
      expect(result.totalTaxLiability).toBeCloseTo(24734 + result.fica.total);
    });

    it('applies as a top-up, and carries the excess forward as a credit', () => {
      // A ruleset whose exemption is $50,000 instead of $90,100: today's law cannot make the AMT
      // bite without preference items, and the engine has no itemized deductions yet (P3-P3), so the
      // exemption is overridden to exercise the top-up path. The arithmetic is the overridden
      // table's, not a claim about 2026 law:
      //   AMTI 150,000 − 50,000 = 100,000 × 26% = $26,000
      //   regular tax $24,734 → topUp = $1,266, applied 'amt', carried forward $1,266
      const base = getRules(2026);
      const lowExemption: FederalTaxRuleset = {
        ...base,
        tables: {
          ...base.tables,
          alternativeMinimumTax: {
            ...base.tables.alternativeMinimumTax,
            values: {
              ...base.tables.alternativeMinimumTax.values,
              exemption: { single: 50000, marriedFilingJointly: 100000, headOfHousehold: 50000 },
            },
          },
        },
      };

      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026, lowExemption);
      const highYear = processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 150000, totalWageIncome: 150000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(highYear.amt.exemption).toBeCloseTo(50000);
      expect(highYear.amt.tentativeMinimumTax).toBeCloseTo(26000);
      expect(highYear.amt.topUp).toBeCloseTo(1266);
      expect(highYear.amt.applied).toBe('amt');
      expect(highYear.amt.netCharge).toBeCloseTo(1266);
      expect(highYear.amt.creditCarryforward).toBeCloseTo(1266);
      expect(highYear.totalTaxLiability).toBeCloseTo(24734 + 1266 + highYear.fica.total);

      // The next year earns $80,000 with the same overridden table (the processor keeps it, since
      // this fixture does not advance the year):
      //   regular taxable income = 80,000 − 16,100 = 63,900
      //   regular tax = 1,240 + 4,560 + (63,900 − 50,400) × 22% = $8,770
      //   AMT base    = 80,000 − 50,000 = 30,000 × 26% = $7,800 → the regular tax wins
      //   credit = min(1,266 carryforward, 8,770 − 7,800 = 970) = $970 → net charge −$970
      const lowYear = processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 80000, totalWageIncome: 80000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(lowYear.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(8770);
      expect(lowYear.amt.tentativeMinimumTax).toBeCloseTo(7800);
      expect(lowYear.amt.topUp).toBe(0);
      expect(lowYear.amt.applied).toBe('regular');
      expect(lowYear.amt.creditApplied).toBeCloseTo(970);
      expect(lowYear.amt.netCharge).toBeCloseTo(-970);
      expect(lowYear.amt.creditCarryforward).toBeCloseTo(296);
      expect(lowYear.totalTaxLiability).toBeCloseTo(8770 - 970 + lowYear.fica.total);
    });

    it('phases the exemption out at 25 cents per dollar of AMTI', () => {
      // $600,000 of wages, single, 2026:
      //   AMTI = 600,000; exemption = 90,100 − 25% × (600,000 − 500,000) = $65,100 (partial)
      const partial = new TaxProcessor(createMockSimulationState(40), 'single', 2026).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 600000, totalWageIncome: 600000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(partial.amt.exemption).toBeCloseTo(65100);
      // base 534,900 → 175,000 × 26% + 359,900 × 28% = 45,500 + 100,772 = $146,272
      expect(partial.amt.ordinaryTax).toBeCloseTo(146272);
      // The regular tax on 583,900 still wins at this income.
      expect(partial.amt.applied).toBe('regular');

      // $1,000,000 of wages: exemption = 90,100 − 25% × 500,000 = $0 (fully phased out).
      //   base 1,000,000 → 175,000 × 26% + 825,000 × 28% = 45,500 + 231,000 = $276,500
      const gone = new TaxProcessor(createMockSimulationState(40), 'single', 2026).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 1000000, totalWageIncome: 1000000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(gone.amt.exemption).toBe(0);
      expect(gone.amt.ordinaryTax).toBeCloseTo(276500);
      // Regular tax on 983,900 = 58,448 + 384,375 × 35% + 343,300 × 37% = $320,000.25
      expect(gone.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(320000.25);
      expect(gone.amt.applied).toBe('regular');
      expect(gone.amt.topUp).toBe(0);
    });

    it('taxes the gain slice of the AMT base at the capital-gains rates', () => {
      // 2026 single, $200,000 of ordinary income and $100,000 of realized gains, with a ruleset
      // whose exemption is $50,000 so the AMT path is priced (see the note above):
      //   AMTI = 300,000; base = 250,000; gains in base = 100,000, ordinary = 150,000
      //   ordinary AMT = 150,000 × 26% = $39,000
      //   gains: stacked on 150,000 → all inside the 15% band (49,450–545,500) = $15,000
      //   tentative minimum tax = $54,000
      const base = getRules(2026);
      const lowExemption: FederalTaxRuleset = {
        ...base,
        tables: {
          ...base.tables,
          alternativeMinimumTax: {
            ...base.tables.alternativeMinimumTax,
            values: {
              ...base.tables.alternativeMinimumTax.values,
              exemption: { single: 50000, marriedFilingJointly: 100000, headOfHousehold: 50000 },
            },
          },
        },
      };
      const portfolio = createEmptyPortfolioData();
      portfolio.realizedGains = 100000;

      const result = new TaxProcessor(createMockSimulationState(40), 'single', 2026, lowExemption).process(
        portfolio,
        createEmptyIncomesData({ totalIncome: 200000, totalWageIncome: 200000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(result.capitalGainsTaxes.taxableIncomeTaxedAsCapitalGains).toBeCloseTo(100000);
      expect(result.amt.ordinaryTax).toBeCloseTo(39000);
      expect(result.amt.capitalGainsTax).toBeCloseTo(15000);
      expect(result.amt.tentativeMinimumTax).toBeCloseTo(54000);
    });
  });

  /**
   * Itemized deductions, the SALT cap, the senior deduction and the standard-vs-itemized choice
   * (P3-P3). All hand-worked on the 2026 ruleset; the SALT cap's own schedule is tested separately
   * in `tax-data/salt-cap.test.ts`.
   */
  describe('itemized deductions and the deduction choice', () => {
    const single = (age: number, totalIncome: number, settings?: Parameters<typeof deductionSettings>[0], taxYear = 2026) =>
      new TaxProcessor(createMockSimulationState(age), 'single', taxYear, undefined, deductionSettings(settings));

    const run = (processor: TaxProcessor, totalIncome: number) =>
      processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome, totalWageIncome: 0 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

    it('takes the standard deduction when the itemized total is smaller, and says so', () => {
      // AGI 100,000, itemized: SALT 5,000 + mortgage interest 2,000 = $7,000 < the $16,100 standard.
      const result = run(single(40, 100000, { stateAndLocalTaxes: 5000, mortgageInterest: 2000 }), 100000);

      expect(result.deduction.type).toBe('standard');
      expect(result.deduction.itemized.total).toBeCloseTo(7000);
      expect(result.deduction.standardDeduction).toBeCloseTo(16100);
      expect(result.deduction.seniorDeduction).toBe(0);
      expect(result.deduction.total).toBeCloseTo(16100);
      // The itemized lines are still reported — the return computed them and chose not to take them.
      expect(result.deductions).toMatchObject({ standardDeduction: 16100, seniorDeduction: 0 });
      expect(result.deductions).not.toHaveProperty('stateAndLocalTaxes');
      expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBeCloseTo(83900);
    });

    it('takes the itemized deduction when it is larger, capping SALT and flooring medical', () => {
      // AGI 200,000, single, 2026:
      //   SALT    min(50,000, 40,400 cap)                   = $40,400
      //   medical 30,000 − 7.5% × 200,000 = 30,000 − 15,000 = $15,000
      //   mortgage interest                                 = $20,000
      //   charitable                                        = $10,000
      //   itemized total                                    = $85,400  > $16,100 standard
      //   taxable ordinary = 200,000 − 85,400               = $114,600
      //   regular tax = 1,240 + 4,560 + 12,166 + 8,900 × 24% = $20,102
      const result = run(
        single(40, 200000, { stateAndLocalTaxes: 50000, mortgageInterest: 20000, charitable: 10000, medicalExpenses: 30000 }),
        200000
      );

      expect(result.deduction.type).toBe('itemized');
      expect(result.deduction.itemized).toMatchObject({
        stateAndLocalTaxes: 40400,
        medicalExpenses: 15000,
        mortgageInterest: 20000,
        charitable: 10000,
      });
      expect(result.deduction.itemized.total).toBeCloseTo(85400);
      expect(result.deduction.saltCap).toMatchObject({ entered: 50000, allowed: 40400, phaseDown: 9600, resolvedYear: 2026 });
      expect(result.deduction.total).toBeCloseTo(85400);
      expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBeCloseTo(114600);
      expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(20102);
      // The record names the lines taken, which is what the AMT addback reads.
      expect(result.deductions).toMatchObject({ stateAndLocalTaxes: 40400, mortgageInterest: 20000, charitable: 10000 });
      expect(result.deductions).not.toHaveProperty('standardDeduction');
    });

    it('phases the SALT cap down above the MAGI threshold and never below the floor', () => {
      // AGI 600,000: 40,400 − 30% × (600,000 − 505,000) = 40,400 − 28,500 = $11,900 of SALT.
      const phased = run(single(40, 600000, { stateAndLocalTaxes: 60000, mortgageInterest: 20000 }), 600000);
      expect(phased.deduction.saltCap.allowed).toBeCloseTo(11900);
      expect(phased.deduction.saltCap.phaseDown).toBeCloseTo(48100);
      expect(phased.deduction.type).toBe('itemized'); // 11,900 + 20,000 = 31,900 > 16,100

      // AGI 700,000: the phase-down would go negative, so the $10,000 floor applies.
      const floored = run(single(40, 700000, { stateAndLocalTaxes: 60000, mortgageInterest: 20000 }), 700000);
      expect(floored.deduction.saltCap.allowed).toBe(10000);
    });

    it('adds the senior deduction on top, phased out by 6% of MAGI, and sunsets after 2028', () => {
      // Age 67, AGI 80,000: 6,000 − 6% × (80,000 − 75,000) = $5,700, on top of the $16,100 standard.
      const senior = run(single(67, 80000), 80000);
      expect(senior.deduction.seniorDeduction).toBeCloseTo(5700);
      expect(senior.deduction.total).toBeCloseTo(16100 + 5700);
      expect(senior.deduction.type).toBe('standard');
      expect(senior.deductions.seniorDeduction).toBeCloseTo(5700);

      // The same plan at 64 gets nothing: the deduction needs age 65 by the end of the year.
      expect(run(single(64, 80000), 80000).deduction.seniorDeduction).toBe(0);

      // A 2029 return gets nothing either: the statute ends the deduction after 2028, and the
      // table's `lastTaxYear` is what says so rather than the ruleset's fallback.
      expect(run(single(67, 80000, undefined, 2029), 80000).deduction.seniorDeduction).toBe(0);
    });

    it('counts a qualifying spouse only when the plan says so, and phases the joint amount once', () => {
      // MFJ, age 67, AGI 200,000: 2 × 6,000 − 6% × (200,000 − 150,000) = 12,000 − 3,000 = $9,000.
      const withSpouse = new TaxProcessor(createMockSimulationState(67), 'marriedFilingJointly', 2026, undefined, {
        spouseQualifiesForSeniorDeduction: true,
      }).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 200000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(withSpouse.deduction.seniorDeduction).toBeCloseTo(9000);

      // Without the flag the spouse is under 65: 6,000 − 3,000 = $3,000.
      const withoutSpouse = new TaxProcessor(createMockSimulationState(67), 'marriedFilingJointly', 2026).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 200000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );
      expect(withoutSpouse.deduction.seniorDeduction).toBeCloseTo(3000);
    });
  });

  describe('the AMT and itemized preferences', () => {
    const withItemized = (totalIncome: number, settings: Parameters<typeof deductionSettings>[0], exemption?: number) => {
      const base = getRules(2026);
      const ruleset: FederalTaxRuleset =
        exemption === undefined
          ? base
          : {
              ...base,
              tables: {
                ...base.tables,
                alternativeMinimumTax: {
                  ...base.tables.alternativeMinimumTax,
                  values: {
                    ...base.tables.alternativeMinimumTax.values,
                    exemption: { single: exemption, marriedFilingJointly: exemption * 2, headOfHousehold: exemption },
                  },
                },
              },
            };

      return new TaxProcessor(createMockSimulationState(40), 'single', 2026, ruleset, deductionSettings(settings)).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );
    };

    it('adds the itemized SALT back into AMTI, with no itemized-specific code', () => {
      // AGI 200,000, itemized total $85,400 of which $40,400 is SALT (§56(b)(1) disallows it):
      //   AMTI = 114,600 (taxable) + 40,400 (addback) = $155,000
      //   AMT base = 155,000 − 90,100 = 64,900 × 26% = $16,874
      //   regular tax $20,102 wins → applied 'regular', no charge
      const result = withItemized(200000, {
        stateAndLocalTaxes: 50000,
        mortgageInterest: 20000,
        charitable: 10000,
        medicalExpenses: 30000,
      });

      expect(result.deduction.type).toBe('itemized');
      expect(result.amt.addbacks).toBeCloseTo(40400);
      expect(result.amt.amtIncome).toBeCloseTo(155000);
      expect(result.amt.tentativeMinimumTax).toBeCloseTo(16874);
      expect(result.amt.topUp).toBe(0);
      expect(result.amt.applied).toBe('regular');
    });

    it('cannot beat the regular tax at 2026 parameters, even with the largest SALT addback', () => {
      // The closest realistic case: AGI 250,000 with nothing but the capped SALT deducted.
      //   taxable 209,600 → regular = 1,240 + 4,560 + 12,166 + 23,058 + 2,504 = $43,528
      //   AMTI 250,000 − 90,100 = 159,900 × 26% = $41,574 → the regular tax wins by $1,954
      const closest = withItemized(250000, { stateAndLocalTaxes: 40400 });
      expect(closest.deduction.type).toBe('itemized');
      expect(closest.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(43528);
      expect(closest.amt.tentativeMinimumTax).toBeCloseTo(41574);
      expect(closest.amt.applied).toBe('regular');

      // At a high income the SALT phase-down has done its work: $40,400 of entered SALT is capped
      // to $10,000 (the floor), which is *below* the $16,100 standard deduction, so the return takes
      // the standard deduction again and the AMT addback is that standard deduction instead.
      //   taxable 983,900 → regular $320,000.25; AMTI 1,000,000 (exemption phased to 0) → $276,500.
      const high = withItemized(1000000, { stateAndLocalTaxes: 40400 });
      expect(high.deduction.type).toBe('standard');
      expect(high.amt.addbacks).toBeCloseTo(16100);
      expect(high.amt.exemption).toBe(0);
      expect(high.amt.tentativeMinimumTax).toBeCloseTo(276500);
      expect(high.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(320000.25);
      expect(high.amt.applied).toBe('regular');

      // Adding mortgage interest keeps this filer itemizing at the same income, and the regular tax
      // still wins: taxable 970,000 → $314,857.25; AMTI 980,000 → $270,900.
      const itemizing = withItemized(1000000, { stateAndLocalTaxes: 60000, mortgageInterest: 20000 });
      expect(itemizing.deduction.type).toBe('itemized');
      expect(itemizing.deduction.saltCap.allowed).toBe(10000);
      expect(itemizing.amt.addbacks).toBeCloseTo(10000);
      expect(itemizing.amt.tentativeMinimumTax).toBeCloseTo(270900);
      expect(itemizing.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(314857.25);
      expect(itemizing.amt.applied).toBe('regular');
    });

    it('charges the AMT through the itemized addback when the exemption is below current law', () => {
      // Same year, a $50,000 exemption instead of $90,100: the SALT addback is what puts the AMT
      // over the regular tax.
      //   AMT base = 155,000 − 50,000 = 105,000 × 26% = $27,300
      //   regular tax $20,102 → topUp = $7,198, and it lands in totalTaxLiability.
      const result = withItemized(
        200000,
        { stateAndLocalTaxes: 50000, mortgageInterest: 20000, charitable: 10000, medicalExpenses: 30000 },
        50000
      );

      expect(result.amt.addbacks).toBeCloseTo(40400);
      expect(result.amt.tentativeMinimumTax).toBeCloseTo(27300);
      expect(result.amt.topUp).toBeCloseTo(7198);
      expect(result.amt.applied).toBe('amt');
      expect(result.amt.netCharge).toBeCloseTo(7198);
      expect(result.totalTaxLiability).toBeCloseTo(20102 + 7198 + result.fica.total);
      // The reconciliation invariant still holds with the charge in it.
      expect(result.totalTaxLiability).toBeCloseTo(
        result.federalIncomeTaxes.federalIncomeTaxAmount +
          result.capitalGainsTaxes.capitalGainsTaxAmount +
          result.amt.netCharge +
          result.niit.niitAmount +
          result.irmaa.total +
          result.earlyWithdrawalPenalties.totalPenaltyAmount +
          result.fica.total
      );
    });
  });

  describe('Medicare IRMAA', () => {
    /**
     * 2026 CMS table, single: tiers at >$109,000 / >$137,000 / … with Part B adjustments of
     * $0 / $81.20 / $202.90 and Part D of $0 / $14.50 / $37.50 a month. The premium is charged on
     * the return of the year itself, from the MAGI of two years earlier.
     */
    const year = (totalIncome: number) => createEmptyIncomesData({ totalIncome, totalWageIncome: totalIncome });

    it('charges nothing until two years of MAGI exist, then bills the lookback tier', () => {
      const processor = new TaxProcessor(createMockSimulationState(60), 'single', 2026);
      const run = (taxYear: number, totalIncome: number) => {
        processor.setTaxYear(taxYear);
        return processor.process(createEmptyPortfolioData(), year(totalIncome), createEmptyReturnsData(), createEmptyPhysicalAssetsData());
      };

      // 2026: MAGI 108,000 — no 2024 return to look at.
      const y2026 = run(2026, 108000);
      expect(y2026.irmaa.total).toBe(0);
      expect(y2026.irmaa.basisMagi).toBeNull();
      expect(y2026.irmaa.basisTaxYear).toBe(2024);

      // 2027: MAGI 110,000 — no 2025 return either.
      const y2027 = run(2027, 110000);
      expect(y2027.irmaa.total).toBe(0);

      // 2028: billed on 2026's MAGI of 108,000, which is inside tier 0 → still nothing.
      const y2028 = run(2028, 140000);
      expect(y2028.irmaa.basisMagi).toBeCloseTo(108000);
      expect(y2028.irmaa.tier).toBe(0);
      expect(y2028.irmaa.total).toBe(0);

      // 2029: billed on 2027's MAGI of 110,000 → tier 1: (81.20 + 14.50) × 12 = $1,148.40.
      const y2029 = run(2029, 90000);
      expect(y2029.irmaa.basisMagi).toBeCloseTo(110000);
      expect(y2029.irmaa.basisTaxYear).toBe(2027);
      expect(y2029.irmaa.tier).toBe(1);
      expect(y2029.irmaa.partBMonthly).toBeCloseTo(81.2);
      expect(y2029.irmaa.partDMonthly).toBeCloseTo(14.5);
      expect(y2029.irmaa.total).toBeCloseTo(1148.4);
      // …and it is inside the reconciled total, not beside it.
      expect(y2029.totalTaxLiability).toBeCloseTo(
        y2029.federalIncomeTaxes.federalIncomeTaxAmount +
          y2029.capitalGainsTaxes.capitalGainsTaxAmount +
          y2029.amt.netCharge +
          y2029.niit.niitAmount +
          y2029.irmaa.total +
          y2029.earlyWithdrawalPenalties.totalPenaltyAmount +
          y2029.fica.total
      );

      // 2030: billed on 2028's MAGI of 140,000 → the next tier: (202.90 + 37.50) × 12 = $2,884.80.
      const y2030 = run(2030, 90000);
      expect(y2030.irmaa.tier).toBe(2);
      expect(y2030.irmaa.total).toBeCloseTo(2884.8);
    });

    it('resolves the tier boundary the way CMS writes it, including the inclusive top tier', () => {
      // The published table reads "greater than X and less than or equal to Y", and the top tier
      // "greater than or equal to $500,000" — so the last threshold is inclusive where the rest are
      // exclusive. Hand check: 109,000 → 0; 109,001 → 1; 205,001 → 4; 499,999 → 4; 500,000 → 5.
      const tiers = getRules(2026).tables.medicareIrmaa.values.tiers.single;

      expect(irmaaTierFor(0, tiers)).toBe(0);
      expect(irmaaTierFor(109000, tiers)).toBe(0);
      expect(irmaaTierFor(109001, tiers)).toBe(1);
      expect(irmaaTierFor(137000, tiers)).toBe(1);
      expect(irmaaTierFor(137001, tiers)).toBe(2);
      expect(irmaaTierFor(205001, tiers)).toBe(4);
      expect(irmaaTierFor(499999, tiers)).toBe(4);
      expect(irmaaTierFor(500000, tiers)).toBe(5);
      expect(irmaaTierFor(1000000, tiers)).toBe(5);
    });

    it('uses the joint thresholds for a joint return', () => {
      // MFJ: the first tier starts above $218,000, so $200,000 is still the standard premium.
      const processor = new TaxProcessor(createMockSimulationState(60), 'marriedFilingJointly', 2026);
      processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 200000 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );
      processor.setTaxYear(2027);
      processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 0 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );
      processor.setTaxYear(2028);
      const billed = processor.process(
        createEmptyPortfolioData(),
        createEmptyIncomesData({ totalIncome: 0 }),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(billed.irmaa.basisMagi).toBeCloseTo(200000);
      expect(billed.irmaa.tier).toBe(0);
      expect(billed.irmaa.total).toBe(0);
    });
  });

  describe('totalTaxLiability reconciliation', () => {
    const sumOfLines = (result: ReturnType<TaxProcessor['process']>) =>
      result.federalIncomeTaxes.federalIncomeTaxAmount +
      result.capitalGainsTaxes.capitalGainsTaxAmount +
      result.amt.netCharge +
      result.niit.niitAmount +
      result.irmaa.total +
      result.earlyWithdrawalPenalties.totalPenaltyAmount +
      result.fica.total;

    it('equals the sum of federal income, capital gains, NIIT, penalties and FICA lines', () => {
      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026);

      const portfolioData = createEmptyPortfolioData();
      portfolioData.realizedGains = 30000;

      const incomes = createEmptyIncomesData({
        totalIncome: 220000,
        totalWageIncome: 220000,
        totalAmountWithheld: 30000,
      });
      const wagePayroll = computeWagePayrollTaxes({ wages: 220000, filingStatus: 'single', taxYear: 2026 });

      const result = processor.process(portfolioData, incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData(), wagePayroll);

      expect(result.totalTaxLiability).toBeCloseTo(sumOfLines(result));
      expect(result.totalTaxLiability).toBeGreaterThan(0);
      // A line that is present but zero still belongs to the sum, so the identity is not vacuous.
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
      expect(result.niit.niitAmount).toBeGreaterThan(0);
    });

    it('equals the sum of its own sub-lines', () => {
      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026);
      const incomes = createEmptyIncomesData({
        totalIncome: 120000,
        totalWageIncome: 120000,
        totalSelfEmploymentIncome: 50000,
      });
      const wagePayroll = computeWagePayrollTaxes({ wages: 120000, filingStatus: 'single', taxYear: 2026 });

      const result = processor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData(),
        wagePayroll
      );

      const { wages, selfEmployment } = result.fica;
      expect(wages.total).toBeCloseTo(wages.socialSecurity + wages.medicare + wages.additionalMedicare + wages.stateDisability);
      expect(selfEmployment.total).toBeCloseTo(selfEmployment.socialSecurity + selfEmployment.medicare + selfEmployment.additionalMedicare);
      expect(result.fica.total).toBeCloseTo(wages.total + selfEmployment.total);
    });

    it('does not collect payroll tax that was already withheld from the paycheque', () => {
      // $120,000 of wages, single, 2026, with no income-tax withholding:
      //   payroll withheld = OASDI 7,440.00 + Medicare 1,740.00 + SDI 1,560.00 = $10,740.00
      // Nothing is left for the annual settlement to collect *for payroll*: the year-end bill is
      // the income tax alone (AGI 120,000 − 16,100 standard deduction = 103,900 taxable).
      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026);
      const incomes = createEmptyIncomesData({
        totalIncome: 120000,
        totalWageIncome: 120000,
        totalAmountWithheld: 0,
      });
      const wagePayroll = computeWagePayrollTaxes({ wages: 120000, filingStatus: 'single', taxYear: 2026 });

      const result = processor.process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData(),
        wagePayroll
      );

      expect(result.fica.wages.total).toBeCloseTo(10740);
      expect(result.fica.wages.socialSecurity).toBeCloseTo(7440);
      expect(result.fica.wages.medicare).toBeCloseTo(1740);
      expect(result.fica.wages.stateDisability).toBeCloseTo(1560);
      expect(result.totalTaxesDue).toBeCloseTo(result.federalIncomeTaxes.federalIncomeTaxAmount);
      expect(result.totalTaxLiability).toBeCloseTo(result.federalIncomeTaxes.federalIncomeTaxAmount + 10740);
    });

    it('settles the self-employment tax with the return and deducts half of it above the line', () => {
      // $100,000 of net self-employment earnings, single, 2026, no wages and no withholding:
      //   SE base         = 100,000 × 92.35%  = $92,350.00
      //   SE tax          = 92,350 × 15.3%    = $14,129.55   (OASDI 11,451.40 + Medicare 2,678.15)
      //   half deduction  = $7,064.775
      //   AGI             = 100,000 − 7,064.775 = $92,935.225
      // Nothing withheld the SE tax, so the whole liability is due at year end.
      const processor = new TaxProcessor(createMockSimulationState(40), 'single', 2026);
      const incomes = createEmptyIncomesData({
        totalIncome: 100000,
        totalWageIncome: 0,
        totalSelfEmploymentIncome: 100000,
        totalAmountWithheld: 0,
      });

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.fica.selfEmployment.taxableEarnings).toBeCloseTo(92350);
      expect(result.fica.selfEmployment.total).toBeCloseTo(14129.55);
      expect(result.fica.selfEmployment.halfDeduction).toBeCloseTo(7064.775);
      expect(result.fica.wages.total).toBe(0);
      expect(result.fica.total).toBeCloseTo(14129.55);

      expect(result.adjustments.selfEmploymentTaxDeduction).toBeCloseTo(7064.775);
      expect(result.incomeSources.adjustedIncomeTaxedAsOrdinary).toBeCloseTo(92935.225);
      expect(result.totalTaxLiability).toBeCloseTo(sumOfLines(result));
      expect(result.totalTaxesDue).toBeCloseTo(result.totalTaxLiability);
    });

    it('adds exactly one payroll line to a year with no wages and no self-employment income', () => {
      // A retiree year: no payroll tax at all, so the invariant collapses to the old total.
      const processor = new TaxProcessor(createMockSimulationState(60), 'single', 2026);
      const incomes = createEmptyIncomesData({ totalIncome: 0 });

      const result = processor.process(createEmptyPortfolioData(), incomes, createEmptyReturnsData(), createEmptyPhysicalAssetsData());

      expect(result.fica).toStrictEqual({
        wages: { socialSecurity: 0, medicare: 0, additionalMedicare: 0, stateDisability: 0, total: 0 },
        selfEmployment: {
          netEarnings: 0,
          taxableEarnings: 0,
          socialSecurity: 0,
          medicare: 0,
          additionalMedicare: 0,
          total: 0,
          halfDeduction: 0,
        },
        total: 0,
      });
      expect(result.totalTaxLiability).toBeCloseTo(sumOfLines(result));
      expect(result.totalTaxesDue).toBe(0);
    });
  });
});
