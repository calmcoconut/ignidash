/**
 * HSA qualified medical withdrawals and California non-conformity (R5).
 *
 * Wire verification for:
 * 1. Qualified medical HSA withdrawals (IRC §223(f)(1)): tax-free federally.
 * 2. Non-qualified HSA withdrawals under 65 (IRC §223(f)(4)): ordinary income + 20% early penalty.
 * 3. Non-qualified HSA withdrawals at age 65 or older: ordinary income, 0% penalty.
 * 4. California non-conformity (R&TC §§ 17024.5, 17215):
 *    - HSA contributions are not deductible in California.
 *    - HSA annual earnings (yield + gains) are taxable in California every year.
 *    - HSA distributions are non-taxable return of California basis (subtracted from CA income).
 *    - California FTB 3805P 2.5% early-distribution penalty on non-HSA retirement accounts before 59.5.
 */

import { describe, expect, it } from 'vitest';

import {
  createAccountData,
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createEmptyPortfolioData,
  createEmptyReturnsData,
  createMockSimulationState,
} from './__tests__/test-utils';
import type { AccountDataWithFlows } from './account';
import { Portfolio } from './portfolio';
import type { PortfolioData } from './portfolio';
import type { SimulationState } from './simulation-engine';
import { TaxProcessor } from './taxes';

const RULESET_YEAR = 2026;

const createState = (age = 40): SimulationState => createMockSimulationState(new Portfolio([]), age);

const accountRow = (row: {
  id: string;
  type: AccountDataWithFlows['type'];
  balance: number;
  withdrawn?: number;
  contributions?: number;
  yieldAmounts?: number;
  realizedGains?: number;
}): AccountDataWithFlows => ({
  ...createAccountData({
    id: row.id,
    name: row.id,
    type: row.type,
    balance: row.balance,
    assetAllocation: { stocks: 0, bonds: 0, cash: 0 },
    ...(row.withdrawn ? { withdrawals: { stocks: row.withdrawn, bonds: 0, cash: 0 } } : {}),
    ...(row.contributions ? { contributions: { stocks: row.contributions, bonds: 0, cash: 0 } } : {}),
    ...(row.realizedGains ? { realizedGains: row.realizedGains } : {}),
  }),
  ...(row.yieldAmounts ? { yieldAmounts: { stocks: row.yieldAmounts, bonds: 0, cash: 0 } } : {}),
});

function portfolioWith(rows: AccountDataWithFlows[]): PortfolioData {
  const empty = createEmptyPortfolioData();

  return {
    ...empty,
    totalValue: rows.reduce((total, row) => total + row.balance, 0),
    perAccountData: Object.fromEntries(rows.map((row) => [row.id, row])),
  };
}

function processYear({
  age = 40,
  taxYear = RULESET_YEAR,
  portfolio,
  qualifiedMedicalExpenses = 0,
  stateResidency = 'none' as 'CA' | 'none',
  earnedIncome = 0,
}: {
  age?: number;
  taxYear?: number;
  portfolio: PortfolioData;
  qualifiedMedicalExpenses?: number;
  stateResidency?: 'CA' | 'none';
  earnedIncome?: number;
}) {
  const taxProcessor = new TaxProcessor(createState(age), 'single', taxYear, undefined, { stateResidency });

  return taxProcessor.process(
    portfolio,
    createEmptyIncomesData({ totalIncome: earnedIncome, totalWageIncome: earnedIncome }),
    createEmptyReturnsData(),
    createEmptyPhysicalAssetsData(),
    undefined,
    qualifiedMedicalExpenses
  );
}

describe('HSA qualified medical withdrawals and California non-conformity (R5)', () => {
  describe('federal qualified medical withdrawals (IRC §223)', () => {
    it('treats HSA withdrawals up to qualified medical expenses as 100% tax-free with zero penalty', () => {
      // $5,000 HSA withdrawal, $5,000 qualified medical expenses, age 40
      const result = processYear({
        age: 40,
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 20000, withdrawn: 5000 })]),
        qualifiedMedicalExpenses: 5000,
      });

      expect(result.incomeSources.taxDeferredWithdrawals).toBe(0);
      expect(result.incomeSources.earlyWithdrawals.hsa).toBe(0);
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
      expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(0);
      expect(result.incomeSources.hsaData?.qualifiedWithdrawals).toBe(5000);
      expect(result.incomeSources.hsaData?.nonQualifiedWithdrawals).toBe(0);
    });

    it('taxes non-qualified HSA withdrawals under 65 as ordinary income and assesses 20% penalty', () => {
      // $5,000 HSA withdrawal, $0 qualified medical expenses, age 40
      const result = processYear({
        age: 40,
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 20000, withdrawn: 5000 })]),
        qualifiedMedicalExpenses: 0,
      });

      expect(result.incomeSources.taxDeferredWithdrawals).toBe(5000);
      expect(result.incomeSources.earlyWithdrawals.hsa).toBe(5000);
      // 20% penalty on $5,000 = $1,000 (IRC §223(f)(4))
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(1000);
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(1000);
      expect(result.incomeSources.hsaData?.qualifiedWithdrawals).toBe(0);
      expect(result.incomeSources.hsaData?.nonQualifiedWithdrawals).toBe(5000);
    });

    it('taxes non-qualified HSA withdrawals at age 65 or older as ordinary income without 20% penalty', () => {
      // $5,000 HSA withdrawal, $0 qualified medical expenses, age 66
      const result = processYear({
        age: 66,
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 20000, withdrawn: 5000 })]),
        qualifiedMedicalExpenses: 0,
      });

      expect(result.incomeSources.taxDeferredWithdrawals).toBe(5000);
      expect(result.incomeSources.earlyWithdrawals.hsa).toBe(0);
      // No penalty after age 65
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
    });

    it('splits partially qualified HSA withdrawals into tax-free and taxable/penalized portions', () => {
      // $10,000 HSA withdrawal, $6,000 qualified medical expenses, age 45
      const result = processYear({
        age: 45,
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 30000, withdrawn: 10000 })]),
        qualifiedMedicalExpenses: 6000,
      });

      expect(result.incomeSources.hsaData?.qualifiedWithdrawals).toBe(6000);
      expect(result.incomeSources.hsaData?.nonQualifiedWithdrawals).toBe(4000);
      expect(result.incomeSources.taxDeferredWithdrawals).toBe(4000);
      expect(result.incomeSources.earlyWithdrawals.hsa).toBe(4000);
      // 20% penalty on $4,000 = $800
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(800);
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(800);
    });
  });

  describe('California non-conformity (R&TC §17024.5, §17215)', () => {
    it('taxes HSA earnings annually in California', () => {
      // HSA has $2,000 yield and $1,000 realized gains = $3,000 HSA earnings
      const result = processYear({
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 50000, yieldAmounts: 2000, realizedGains: 1000 })]),
        stateResidency: 'CA',
        earnedIncome: 50000,
      });

      expect(result.incomeSources.hsaEarnings).toBe(3000);
      // Federal ordinary income does not include HSA yield/gains
      expect(result.incomeSources.taxableInterestIncome).toBe(0);
      expect(result.incomeSources.taxableDividendIncome).toBe(0);
      // California income includes earned income $50,000 + $3,000 HSA earnings = $53,000
      expect(result.state.income).toBe(53000);
    });

    it('does not double-tax HSA distributions in California (return of basis)', () => {
      // $10,000 non-qualified HSA withdrawal:
      // Federal treats as $10,000 ordinary income
      // California excludes it as return of basis (since contributions & earnings were already taxed)
      const result = processYear({
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 20000, withdrawn: 10000 })]),
        stateResidency: 'CA',
        earnedIncome: 60000,
        qualifiedMedicalExpenses: 0,
      });

      expect(result.incomeSources.taxableRetirementDistributions).toBe(10000);
      // California income = earnedIncome $60,000 + retirement $10,000 - nonQualifiedHsa $10,000 = $60,000
      expect(result.state.income).toBe(60000);
    });

    it('denies California deduction for HSA contributions while federal deducts them', () => {
      // $4,000 HSA employee contribution, $50,000 wage income
      const result = processYear({
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 10000, contributions: 4000 })]),
        stateResidency: 'CA',
        earnedIncome: 50000,
      });

      // Federal: $4,000 tax-deductible contribution reduces ordinary income
      expect(result.incomeSources.taxDeductibleContributions).toBe(4000);
      expect(result.incomeSources.adjustedIncomeTaxedAsOrdinary).toBe(46000);

      // California: HSA contribution is not deductible, so California income remains $50,000
      expect(result.state.income).toBe(50000);
    });

    it('assesses California FTB 3805P 2.5% penalty on early non-HSA retirement distributions before 59.5', () => {
      // $20,000 early 401(k) withdrawal at age 45
      const result = processYear({
        age: 45,
        portfolio: portfolioWith([accountRow({ id: 'k401', type: '401k', balance: 80000, withdrawn: 20000 })]),
        stateResidency: 'CA',
      });

      // Federal 10% penalty on $20,000 = $2,000
      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(2000);
      // California 2.5% penalty on $20,000 = $500 (FTB 3805P)
      expect(result.earlyWithdrawalPenalties.californiaPenaltyAmount).toBe(500);
      // Total penalty = $2,000 + $500 = $2,500
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(2500);

      // Reconciles exactly in total tax liability
      expect(result.totalTaxLiability).toBeCloseTo(
        result.federalIncomeTaxes.federalIncomeTaxAmount +
          result.capitalGainsTaxes.capitalGainsTaxAmount +
          result.amt.netCharge +
          result.niit.niitAmount +
          result.irmaa.total +
          result.state.total +
          result.earlyWithdrawalPenalties.totalPenaltyAmount +
          result.fica.total
      );
    });

    it('does not assess FTB 3805P 2.5% penalty on HSA distributions', () => {
      // $10,000 early HSA withdrawal at age 45:
      // Federal 20% penalty = $2,000.
      // California FTB 3805P does not apply to HSAs.
      const result = processYear({
        age: 45,
        portfolio: portfolioWith([accountRow({ id: 'hsa-1', type: 'hsa', balance: 20000, withdrawn: 10000 })]),
        stateResidency: 'CA',
        qualifiedMedicalExpenses: 0,
      });

      expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(2000);
      // No California early penalty on HSA
      expect(result.earlyWithdrawalPenalties.californiaPenaltyAmount).toBeUndefined();
      expect(result.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(2000);
    });
  });
});
