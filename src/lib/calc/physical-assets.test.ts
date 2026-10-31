import { describe, it, expect } from 'vitest';

import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';

import { buildAmortizationSchedule, computeLoanPayment, monthlyRealRate } from './amortization-schedule';
import { Debt } from './debts';
import { PhysicalAsset, PhysicalAssets, PhysicalAssetsProcessor } from './physical-assets';
import type { SimulationState } from './simulation-engine';
import { TEST_TIME_BINDING_CONTEXT } from '@/lib/calc/__tests__/time-binding-context';

/**
 * Physical Assets Tests
 *
 * Tests for:
 * - Appreciation (compound growth, depreciation)
 * - Loan payments (amortized, zero APR, interest/principal split)
 * - Inflation adjustment (loan payment deflation, real interest rates)
 * - Sale mechanics (proceeds, capital gains, underwater sales)
 * - Activation/scheduling (timeframe handling)
 * - Collection operations (filtering, aggregation)
 * - Processor operations (process, liquidate, annual data)
 */

// ============================================================================
// Helper Functions
// ============================================================================

// Default to zero inflation for legacy tests to maintain existing behavior
const ZERO_INFLATION = 0;

// Helper for creating debt inputs (for comparison tests)
const createDebtInput = (overrides: {
  id?: string;
  name?: string;
  balance: number;
  apr: number;
  monthlyPayment: number;
  interestType?: 'simple' | 'compound';
}) => ({
  id: overrides.id ?? 'debt-1',
  name: overrides.name ?? 'Debt',
  balance: overrides.balance,
  apr: overrides.apr,
  interestType: overrides.interestType ?? 'simple',
  compoundingFrequency: undefined,
  startDate: { type: 'now' as const },
  monthlyPayment: overrides.monthlyPayment,
  disabled: false,
});

const createSimulationState = (overrides: Partial<SimulationState> = {}): SimulationState => ({
  time: {
    age: 35,
    year: 2024,
    month: 1,
    date: new Date(2024, 0, 1),
    ...overrides.time,
  },
  phase: overrides.phase !== undefined ? overrides.phase : { name: 'accumulation' },
  portfolio: {} as SimulationState['portfolio'],
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

const createPhysicalAssetInput = (overrides: Partial<PhysicalAssetInputs> = {}): PhysicalAssetInputs => ({
  id: overrides.id ?? 'asset-1',
  name: overrides.name ?? 'Primary Residence',
  assetType: overrides.assetType ?? 'other',
  purchaseDate: overrides.purchaseDate ?? { type: 'now' },
  purchasePrice: overrides.purchasePrice ?? 400000,
  marketValue: overrides.marketValue,
  appreciationRate: overrides.appreciationRate ?? 3,
  saleDate: overrides.saleDate ?? { type: 'atLifeExpectancy' },
  paymentMethod: overrides.paymentMethod ?? { type: 'cash' },
});

const createFinancedAssetInput = (overrides: Partial<PhysicalAssetInputs> = {}): PhysicalAssetInputs => {
  const paymentMethodOverrides = overrides.paymentMethod?.type === 'loan' ? overrides.paymentMethod : undefined;
  const downPayment = paymentMethodOverrides?.downPayment ?? 80000;
  const loanBalance = paymentMethodOverrides?.loanBalance ?? 320000;
  const apr = paymentMethodOverrides?.apr ?? 6;
  // Default monthly payment calculated from standard amortization formula for 30yr @ 6% on $320k
  const monthlyPayment = paymentMethodOverrides?.monthlyPayment ?? 1918.56;

  return {
    id: overrides.id ?? 'asset-1',
    name: overrides.name ?? 'Primary Residence',
    assetType: overrides.assetType ?? 'other',
    purchaseDate: overrides.purchaseDate ?? { type: 'now' },
    purchasePrice: overrides.purchasePrice ?? 400000,
    marketValue: overrides.marketValue,
    appreciationRate: overrides.appreciationRate ?? 3,
    saleDate: overrides.saleDate ?? { type: 'atLifeExpectancy' },
    paymentMethod: {
      type: 'loan',
      downPayment,
      loanBalance,
      apr,
      monthlyPayment,
      // P1-P5 fields are carried only when stated: absent means the stored payment drives the
      // loan and there is no offset account, exactly as before.
      ...(paymentMethodOverrides?.termMonths !== undefined ? { termMonths: paymentMethodOverrides.termMonths } : {}),
      ...(paymentMethodOverrides?.offsetAccountId !== undefined ? { offsetAccountId: paymentMethodOverrides.offsetAccountId } : {}),
    },
  };
};

// ============================================================================
// PhysicalAsset Class Tests
// ============================================================================

describe('PhysicalAsset Class', () => {
  describe('Appreciation Tests', () => {
    it('applies monthly appreciation (compound growth)', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
          appreciationRate: 3, // 3% annual
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Formula: monthlyRate = (1 + annualRate)^(1/12) - 1
      const expectedMonthlyRate = Math.pow(1 + 0.03, 1 / 12) - 1;
      const expectedAppreciation = 400000 * expectedMonthlyRate;

      const { monthlyAppreciation } = asset.applyMonthlyAppreciation();

      expect(monthlyAppreciation).toBeCloseTo(expectedAppreciation);
      expect(asset.getMarketValue()).toBeCloseTo(400000 + expectedAppreciation);
    });

    it('compounds appreciation over multiple months', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
          appreciationRate: 3,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply 12 months of appreciation
      for (let i = 0; i < 12; i++) {
        asset.applyMonthlyAppreciation();
      }

      // After 12 months at 3% annual, should be approximately 400000 * 1.03
      expect(asset.getMarketValue()).toBeCloseTo(400000 * 1.03, 0);
    });

    it('handles zero appreciation rate', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 300000,
          appreciationRate: 0,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { monthlyAppreciation } = asset.applyMonthlyAppreciation();

      expect(monthlyAppreciation).toBe(0);
      expect(asset.getMarketValue()).toBe(300000);
    });

    it('handles negative appreciation (depreciation)', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 50000, // Car
          appreciationRate: -15, // 15% depreciation
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const expectedMonthlyRate = Math.pow(1 - 0.15, 1 / 12) - 1;
      const expectedDepreciation = 50000 * expectedMonthlyRate;

      const { monthlyAppreciation } = asset.applyMonthlyAppreciation();

      expect(monthlyAppreciation).toBeCloseTo(expectedDepreciation);
      expect(monthlyAppreciation).toBeLessThan(0);
      expect(asset.getMarketValue()).toBeLessThan(50000);
    });

    it('sold asset throws on applyMonthlyAppreciation', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
          appreciationRate: 3,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      asset.sell();

      expect(() => asset.applyMonthlyAppreciation()).toThrow('Asset is not owned');
      expect(asset.getMarketValue()).toBe(0);
    });
  });

  describe('Loan Payment Tests', () => {
    it('returns the configured monthly payment', () => {
      // Formula: P * r * (1+r)^n / ((1+r)^n - 1)
      const monthlyRate = 0.06 / 12;
      const numPayments = 360;
      const configuredPayment =
        (320000 * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: configuredPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { monthlyPaymentDue } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);

      expect(monthlyPaymentDue).toBeCloseTo(configuredPayment, 2);
    });

    it('handles zero APR loan', () => {
      // Zero APR: payment = loanBalance / termMonths (configured by user)
      const expectedPayment = 24000 / 48;

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 30000,
          paymentMethod: { type: 'loan', downPayment: 6000, loanBalance: 24000, apr: 0, monthlyPayment: expectedPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { monthlyPaymentDue } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);

      expect(monthlyPaymentDue).toBeCloseTo(expectedPayment);
    });

    it('applies payment (interest vs principal split)', () => {
      const loanBalance = 320000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const numPayments = 360;
      const monthlyPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const initialBalance = asset.getLoanBalance();
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      const principal = monthlyPaymentDue - interest;

      asset.applyLoanPayment(monthlyPaymentDue, interest);

      expect(asset.getLoanBalance()).toBeCloseTo(initialBalance - principal);
    });

    it('final payment handles payoff', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 10000,
          paymentMethod: {
            type: 'loan',
            downPayment: 0,
            loanBalance: 10000,
            apr: 0,
            monthlyPayment: 1000, // 10000 / 10 payments
          },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply 10 payments to pay off the loan
      for (let i = 0; i < 10; i++) {
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
      }

      expect(asset.getLoanBalance()).toBe(0);
      expect(asset.getMonthlyPaymentInfo(ZERO_INFLATION)).toEqual({ monthlyPaymentDue: 0, interest: 0 });
    });

    it('no payment for cash purchase', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
          paymentMethod: undefined, // Cash purchase
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getMonthlyPaymentInfo(ZERO_INFLATION)).toEqual({ monthlyPaymentDue: 0, interest: 0 });
      expect(asset.getLoanBalance()).toBe(0);
    });
  });

  describe('Sale Tests', () => {
    it('sale proceeds = market value - loan balance', () => {
      const loanBalance = 320000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const numPayments = 360;
      const monthlyPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply some appreciation
      for (let i = 0; i < 24; i++) {
        asset.applyMonthlyAppreciation();
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
      }

      const marketValueBeforeSale = asset.getMarketValue();
      const loanBalanceBeforeSale = asset.getLoanBalance();

      const { saleProceeds } = asset.sell();

      expect(saleProceeds).toBeCloseTo(marketValueBeforeSale - loanBalanceBeforeSale);
    });

    it('capital gain = market value - cost basis', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 300000,
          appreciationRate: 5,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply 60 months (5 years) of appreciation
      for (let i = 0; i < 60; i++) {
        asset.applyMonthlyAppreciation();
      }

      const marketValueBeforeSale = asset.getMarketValue();
      const { realizedGains } = asset.sell();

      // Cost basis is original purchase price
      expect(realizedGains).toBeCloseTo(marketValueBeforeSale - 300000);
    });

    it('handles underwater sale (loan > value)', () => {
      const loanBalance = 380000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const numPayments = 360;
      const monthlyPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          appreciationRate: -20, // Major depreciation
          paymentMethod: {
            type: 'loan',
            downPayment: 20000,
            loanBalance, // High LTV
            apr,
            monthlyPayment,
          },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply depreciation (no loan payments to keep it underwater)
      for (let i = 0; i < 12; i++) {
        asset.applyMonthlyAppreciation();
      }

      const marketValueBeforeSale = asset.getMarketValue();
      const loanBalanceBeforeSale = asset.getLoanBalance();
      const { saleProceeds, realizedGains } = asset.sell();

      // Proceeds can be negative when underwater (seller owes money)
      expect(saleProceeds).toBe(marketValueBeforeSale - loanBalanceBeforeSale);
      expect(saleProceeds).toBeLessThan(0);
      // Capital gain will be negative (loss)
      expect(realizedGains).toBeLessThan(0);
    });

    it('already sold throws error', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // First sale
      asset.sell();

      // Second sale attempt throws
      expect(() => asset.sell()).toThrow('Asset is not owned');
    });
  });

  describe('Ownership Status Tests', () => {
    it('now - owned immediately', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('customAge - pending until purchased', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before age 40 - pending
      let simState = createSimulationState({ time: { age: 39, year: 2028, month: 1, date: new Date(2028, 0, 1) } });
      expect(asset.getOwnershipStatus()).toBe('pending');

      // At age 40 - still pending until purchased
      simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      expect(asset.getOwnershipStatus()).toBe('pending');
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(true);

      // After purchasing, asset becomes owned
      asset.purchase();
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('customDate - pending until purchased', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customDate', year: 2025, month: 6 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before June 2025 - pending
      let simState = createSimulationState({ time: { age: 36, year: 2025, month: 5, date: new Date(2025, 4, 1) } });
      expect(asset.getOwnershipStatus()).toBe('pending');
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(false);

      // At June 2025 - still pending until purchased
      simState = createSimulationState({ time: { age: 36, year: 2025, month: 6, date: new Date(2025, 5, 1) } });
      expect(asset.getOwnershipStatus()).toBe('pending');
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(true);

      // After purchasing, asset becomes owned
      asset.purchase();
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('atRetirement - pending until purchased', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'atRetirement' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Pre-retirement - pending
      let simState = createSimulationState({ phase: { name: 'accumulation' } });
      expect(asset.getOwnershipStatus()).toBe('pending');
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(false);

      // In retirement - still pending until purchased
      simState = createSimulationState({ phase: { name: 'retirement' } });
      expect(asset.getOwnershipStatus()).toBe('pending');
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(true);

      // After purchasing, asset becomes owned
      asset.purchase();
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('sold asset has sold status', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      asset.sell();

      expect(asset.getOwnershipStatus()).toBe('sold');
    });
  });

  describe('Scheduled Sale Tests (shouldSellThisPeriod)', () => {
    it('no saleDate - never scheduled', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          saleDate: undefined,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState({ time: { age: 90, year: 2079, month: 1, date: new Date(2079, 0, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(false);
    });

    it('customAge - scheduled at age', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          saleDate: { type: 'customAge', age: 65 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before age 65
      let simState = createSimulationState({ time: { age: 64, year: 2053, month: 12, date: new Date(2053, 11, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(false);

      // At age 65
      simState = createSimulationState({ time: { age: 65, year: 2054, month: 1, date: new Date(2054, 0, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(true);
    });

    it('customDate - scheduled at date', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          saleDate: { type: 'customDate', year: 2030, month: 12 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before December 2030
      let simState = createSimulationState({ time: { age: 41, year: 2030, month: 11, date: new Date(2030, 10, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(false);

      // At December 2030
      simState = createSimulationState({ time: { age: 41, year: 2030, month: 12, date: new Date(2030, 11, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(true);
    });

    it('already sold - not scheduled', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          saleDate: { type: 'customAge', age: 65 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      asset.sell();

      const simState = createSimulationState({ time: { age: 65, year: 2054, month: 1, date: new Date(2054, 0, 1) } });
      expect(asset.shouldSellThisPeriod(simState)).toBe(false);
    });
  });

  describe('Equity Calculation', () => {
    it('equity = market value - loan balance for financed asset', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Initial equity should be market value - loan balance
      expect(asset.getEquity()).toBeCloseTo(80000, 0);
    });

    it('equity = market value for cash purchase', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchasePrice: 400000,
          paymentMethod: undefined,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getEquity()).toBe(400000);
    });

    it('equity cannot be negative', () => {
      const loanBalance = 95000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const numPayments = 360;
      const monthlyPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          appreciationRate: -50, // Extreme depreciation
          paymentMethod: { type: 'loan', downPayment: 5000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Apply heavy depreciation
      for (let i = 0; i < 12; i++) {
        asset.applyMonthlyAppreciation();
      }

      // Equity should be floored at 0
      expect(asset.getEquity()).toBeGreaterThanOrEqual(0);
    });
  });
});

// ============================================================================
// getMarketValue/getLoanBalance/getEquity Return 0 Before Asset Is Owned
// ============================================================================

describe('getMarketValue/getLoanBalance/getEquity return 0 before asset is owned', () => {
  it('PhysicalAsset.getMarketValue() returns 0 for pending asset', () => {
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchaseDate: { type: 'customAge', age: 40 },
        purchasePrice: 400000,
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Before purchase(), market value should be 0
    expect(asset.getOwnershipStatus()).toBe('pending');
    expect(asset.getMarketValue()).toBe(0);

    // After purchase(), market value should be actual value
    asset.purchase();
    expect(asset.getOwnershipStatus()).toBe('owned');
    expect(asset.getMarketValue()).toBe(400000);
  });

  it('PhysicalAsset.getLoanBalance() returns 0 for pending financed asset', () => {
    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchaseDate: { type: 'customAge', age: 40 },
        purchasePrice: 400000,
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Before purchase(), loan balance should be 0
    expect(asset.getOwnershipStatus()).toBe('pending');
    expect(asset.getLoanBalance()).toBe(0);

    // After purchase(), loan balance should be actual balance
    asset.purchase();
    expect(asset.getOwnershipStatus()).toBe('owned');
    expect(asset.getLoanBalance()).toBe(320000);
  });

  it('PhysicalAsset.getEquity() returns 0 for pending asset', () => {
    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchaseDate: { type: 'customAge', age: 40 },
        purchasePrice: 400000,
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Before purchase(), equity should be 0
    expect(asset.getOwnershipStatus()).toBe('pending');
    expect(asset.getEquity()).toBe(0);

    // After purchase(), equity should be market value - loan balance
    asset.purchase();
    expect(asset.getOwnershipStatus()).toBe('owned');
    expect(asset.getEquity()).toBeCloseTo(80000, 0);
  });

  it('PhysicalAssets.getTotalMarketValue() excludes pending assets', () => {
    const assets = new PhysicalAssets(
      [
        createPhysicalAssetInput({
          id: 'owned',
          name: 'Owned Home',
          purchaseDate: { type: 'now' },
          purchasePrice: 400000,
        }),
        createPhysicalAssetInput({
          id: 'pending',
          name: 'Future Home',
          purchaseDate: { type: 'customAge', age: 50 },
          purchasePrice: 600000,
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    // Only the owned asset should be counted
    expect(assets.getTotalMarketValue()).toBe(400000);
  });

  it('PhysicalAssets.getTotalLoanBalance() excludes pending financed assets', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'owned',
          name: 'Owned Home',
          purchaseDate: { type: 'now' },
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
        createFinancedAssetInput({
          id: 'pending',
          name: 'Future Home',
          purchaseDate: { type: 'customAge', age: 50 },
          purchasePrice: 600000,
          paymentMethod: { type: 'loan', downPayment: 120000, loanBalance: 480000, apr: 6, monthlyPayment: 2878.0 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    // Only the owned asset's loan should be counted
    expect(assets.getTotalLoanBalance()).toBe(320000);
  });

  it('PhysicalAssets.getTotalEquity() excludes pending assets', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'owned',
          name: 'Owned Home',
          purchaseDate: { type: 'now' },
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
        createPhysicalAssetInput({
          id: 'pending-cash',
          name: 'Future Cash Purchase',
          purchaseDate: { type: 'customAge', age: 50 },
          purchasePrice: 200000,
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    // Only the owned asset's equity should be counted (400000 - 320000 = 80000)
    expect(assets.getTotalEquity()).toBeCloseTo(80000, 0);
  });

  it('getMarketValue/getLoanBalance/getEquity return actual values after purchase via getAssetsToPurchaseThisPeriod', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'future',
          name: 'Future Home',
          purchaseDate: { type: 'customAge', age: 40 },
          purchasePrice: 500000,
          paymentMethod: { type: 'loan', downPayment: 100000, loanBalance: 400000, apr: 6, monthlyPayment: 2398.2 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    // Before purchase, all totals should be 0
    expect(assets.getTotalMarketValue()).toBe(0);
    expect(assets.getTotalLoanBalance()).toBe(0);
    expect(assets.getTotalEquity()).toBe(0);

    // Process at age 40 when asset is scheduled for purchase
    const simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
    const assetsToPurchase = assets.getAssetsToPurchaseThisPeriod(simState);

    // Purchase the assets
    for (const asset of assetsToPurchase) {
      asset.purchase();
    }

    // Now totals should reflect the purchased asset
    expect(assets.getTotalMarketValue()).toBe(500000);
    expect(assets.getTotalLoanBalance()).toBe(400000);
    expect(assets.getTotalEquity()).toBeCloseTo(100000, 0);
  });
});

// ============================================================================
// PhysicalAssets Collection Tests
// ============================================================================

describe('PhysicalAssets Collection', () => {
  it('getOwnedAssets returns only currently owned assets', () => {
    const assets = new PhysicalAssets(
      [
        createPhysicalAssetInput({
          id: 'current',
          name: 'Current Home',
          purchaseDate: { type: 'now' },
        }),
        createPhysicalAssetInput({
          id: 'future',
          name: 'Future Home',
          purchaseDate: { type: 'customAge', age: 50 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const ownedAssets = assets.getOwnedAssets();

    expect(ownedAssets.length).toBe(1);
    expect(ownedAssets[0].getName()).toBe('Current Home');
  });

  it('getAssetsToSellThisPeriod returns only assets scheduled for sale', () => {
    const assets = new PhysicalAssets(
      [
        createPhysicalAssetInput({
          id: 'sell-now',
          name: 'Sell Now',
          saleDate: { type: 'customAge', age: 35 },
        }),
        createPhysicalAssetInput({
          id: 'keep',
          name: 'Keep Forever',
          saleDate: undefined,
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState({ time: { age: 35, year: 2024, month: 1, date: new Date(2024, 0, 1) } });
    const assetsToSell = assets.getAssetsToSellThisPeriod(simState);

    expect(assetsToSell.length).toBe(1);
    expect(assetsToSell[0].getName()).toBe('Sell Now');
  });

  it('aggregates total value/loan/equity', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house1',
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
        createPhysicalAssetInput({
          id: 'car',
          purchasePrice: 50000,
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    expect(assets.getTotalMarketValue()).toBe(450000);
    expect(assets.getTotalLoanBalance()).toBe(320000);
    expect(assets.getTotalEquity()).toBeCloseTo(130000, 0);
  });
});

// ============================================================================
// PhysicalAssetsProcessor Tests
// ============================================================================

describe('PhysicalAssetsProcessor', () => {
  it('process() applies appreciation and loan payments', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house',
          purchasePrice: 400000,
          appreciationRate: 3,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    const result = processor.process(ZERO_INFLATION);

    expect(result.totalAppreciation).toBeGreaterThan(0);
    expect(result.totalLoanPayment).toBeGreaterThan(0);
    expect(result.perAssetData['house']).toBeDefined();
  });

  it('process() handles scheduled sales', () => {
    const assets = new PhysicalAssets(
      [
        createPhysicalAssetInput({
          id: 'selling',
          name: 'Selling House',
          purchasePrice: 500000,
          appreciationRate: 0, // No appreciation for predictable test
          saleDate: { type: 'customAge', age: 35 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState({ time: { age: 35, year: 2024, month: 1, date: new Date(2024, 0, 1) } });
    const processor = new PhysicalAssetsProcessor(simState, assets);

    const result = processor.process(ZERO_INFLATION);

    expect(result.totalSaleProceeds).toBe(500000);
    expect(result.totalRealizedGains).toBe(0); // No appreciation
    expect(result.perAssetData['selling'].isSold).toBe(true);
  });

  it('unpaidInterest and principalPaid are capped at 0, debtPaydown is raw', () => {
    // NEW SEMANTICS:
    // - principalPaid = max(0, payment - interest) - capped, for display
    // - unpaidInterest = max(0, interest - payment) - capped, for display
    // - debtPaydown = payment - interest - raw, for net worth tracking

    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'normal-loan',
          purchasePrice: 200000,
          paymentMethod: {
            type: 'loan',
            downPayment: 100000,
            loanBalance: 100000,
            apr: 6, // interest = 100000 * 0.06 / 12 = 500
            monthlyPayment: 1000, // payment > interest
          },
        }),
        createFinancedAssetInput({
          id: 'underwater-loan',
          purchasePrice: 200000,
          paymentMethod: {
            type: 'loan',
            downPayment: 100000,
            loanBalance: 100000,
            apr: 100, // interest = 100000 * 1.00 / 12 = 8333.33
            monthlyPayment: 100, // payment < interest
          },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    const result = processor.process(ZERO_INFLATION);

    // Verify individual calculations
    const normalLoan = result.perAssetData['normal-loan'];
    const underwaterLoan = result.perAssetData['underwater-loan'];

    // Normal loan: payment > interest
    // principalPaid = max(0, 1000 - 500) = 500
    // unpaidInterest = max(0, 500 - 1000) = 0
    // debtPaydown = 1000 - 500 = 500
    expect(normalLoan.principalPaid).toBeCloseTo(500, 0);
    expect(normalLoan.unpaidInterest).toBe(0);
    expect(normalLoan.debtPaydown).toBeCloseTo(500, 0);

    // Underwater loan: payment < interest
    // principalPaid = max(0, 100 - 8333.33) = 0
    // unpaidInterest = max(0, 8333.33 - 100) = 8233.33
    // debtPaydown = 100 - 8333.33 = -8233.33
    expect(underwaterLoan.principalPaid).toBe(0);
    expect(underwaterLoan.unpaidInterest).toBeCloseTo(8233.33, 0);
    expect(underwaterLoan.debtPaydown).toBeCloseTo(-8233.33, 0);

    // Total unpaid interest = sum of capped values = 0 + 8233.33 = 8233.33
    expect(result.totalUnpaidInterest).toBeCloseTo(8233.33, 0);

    // Total principalPaid = sum of capped values = 500 + 0 = 500
    expect(result.totalPrincipalPaid).toBeCloseTo(500, 0);

    // Total debtPaydown = sum of raw values = 500 + (-8233.33) = -7733.33
    expect(result.totalDebtPaydown).toBeCloseTo(-7733.33, 0);
  });

  it('debtPaydown tracks raw balance changes for net worth calculations', () => {
    // debtPaydown is used for net worth tracking and should equal payment - interest
    // This allows correct aggregation across multiple loans for the net worth change formula
    //
    // With multiple loans where one has payment < interest:
    // - Loan 1: payment = 1000, interest = 500 → debtPaydown = 500
    // - Loan 2: payment = 100, interest = 8333.33 → debtPaydown = -8233.33
    //
    // Total debtPaydown = 500 + (-8233.33) = -7733.33

    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'normal-loan',
          purchasePrice: 200000,
          paymentMethod: {
            type: 'loan',
            downPayment: 100000,
            loanBalance: 100000,
            apr: 6, // interest = 100000 * 0.06 / 12 = 500
            monthlyPayment: 1000, // payment > interest
          },
        }),
        createFinancedAssetInput({
          id: 'underwater-loan',
          purchasePrice: 200000,
          paymentMethod: {
            type: 'loan',
            downPayment: 100000,
            loanBalance: 100000,
            apr: 100, // interest = 100000 * 1.00 / 12 = 8333.33
            monthlyPayment: 100, // payment < interest
          },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    const result = processor.process(ZERO_INFLATION);

    // Verify individual calculations
    const normalLoan = result.perAssetData['normal-loan'];
    const underwaterLoan = result.perAssetData['underwater-loan'];

    expect(normalLoan.interest).toBeCloseTo(500, 0);
    expect(normalLoan.debtPaydown).toBeCloseTo(500, 0);

    expect(underwaterLoan.interest).toBeCloseTo(8333.33, 0);
    // Raw value: 100 - 8333.33 = -8233.33
    expect(underwaterLoan.debtPaydown).toBeCloseTo(-8233.33, 0);

    // Total debtPaydown = sum of raw values
    // 500 + (-8233.33) = -7733.33
    expect(result.totalDebtPaydown).toBeCloseTo(-7733.33, 0);

    // Verify the relationship: debtPaydown = payment - interest (raw sum)
    expect(result.totalDebtPaydown).toBeCloseTo(result.totalLoanPayment - result.totalInterest, 0);
  });

  it('getAnnualData aggregates monthly data', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house',
          purchasePrice: 400000,
          appreciationRate: 3,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    // Process 12 months
    for (let i = 0; i < 12; i++) {
      processor.process(ZERO_INFLATION);
    }

    const annualData = processor.getAnnualData();

    // Annual appreciation should be approximately 3% of starting value
    expect(annualData.totalAppreciation).toBeCloseTo(400000 * 0.03, -2);
    // Should have 12 months of loan payments
    expect(annualData.totalLoanPayment).toBeGreaterThan(0);
  });

  it('getAnnualData uses last month snapshot fields, not summed across months', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house',
          purchasePrice: 400000,
          appreciationRate: 0, // Zero appreciation for predictable values
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 0, monthlyPayment: 1000 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    // Process 3 months — loan balance goes 320k -> 319k -> 318k -> 317k
    for (let i = 0; i < 3; i++) {
      processor.process(ZERO_INFLATION);
    }

    const annualData = processor.getAnnualData();

    // Snapshot fields should be last month's values, not summed
    expect(annualData.totalMarketValue).toBe(400000);
    expect(annualData.totalLoanBalance).toBe(317000);
    expect(annualData.totalEquity).toBe(400000 - 317000);
  });

  it('getAnnualData uses last month per-asset snapshot fields, not summed', () => {
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house',
          purchasePrice: 400000,
          appreciationRate: 0,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 0, monthlyPayment: 1000 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    for (let i = 0; i < 3; i++) {
      processor.process(ZERO_INFLATION);
    }

    const annualData = processor.getAnnualData();
    const assetData = annualData.perAssetData['house'];

    // Per-asset snapshot fields should be last month's values
    expect(assetData.marketValue).toBe(400000);
    expect(assetData.loanBalance).toBe(317000);
    expect(assetData.equity).toBe(400000 - 317000);
    expect(assetData.isSold).toBe(false);
  });

  it('resetMonthlyData clears accumulated data', () => {
    const assets = new PhysicalAssets(
      [
        createPhysicalAssetInput({
          id: 'house',
          purchasePrice: 400000,
          appreciationRate: 3,
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new PhysicalAssetsProcessor(simState, assets);

    // Process some months
    processor.process(ZERO_INFLATION);
    processor.process(ZERO_INFLATION);
    processor.process(ZERO_INFLATION);

    let annualData = processor.getAnnualData();
    expect(annualData.totalAppreciation).toBeGreaterThan(0);

    // Reset
    processor.resetMonthlyData();

    annualData = processor.getAnnualData();
    expect(annualData.totalAppreciation).toBe(0);
  });
});

// ============================================================================
// Purchase Expense Tracking Tests
// ============================================================================

describe('Purchase Expense Tracking', () => {
  describe('Ownership Status', () => {
    it('constructor sets owned status for purchaseDate.type === now', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('constructor sets pending status for future purchase dates', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('pending');
    });

    it('constructor sets pending status for atRetirement purchase', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'atRetirement' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('pending');
    });

    it('sell() transitions owned to sold', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('owned');
      asset.sell();
      expect(asset.getOwnershipStatus()).toBe('sold');
    });
  });

  describe('PhysicalAsset purchase methods', () => {
    it('purchase() returns full purchase price for cash purchase', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
          purchasePrice: 400000,
          paymentMethod: undefined,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      expect(asset.getOwnershipStatus()).toBe('pending');
      const { purchaseOutlay } = asset.purchase();

      expect(purchaseOutlay).toBe(400000);
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('purchase() returns down payment for financed purchase', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { purchaseOutlay } = asset.purchase();

      expect(purchaseOutlay).toBe(80000);
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('purchase() returns 0 for zero down payment (100% financed)', () => {
      const loanBalance = 400000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const numPayments = 360;
      const monthlyPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { purchaseOutlay } = asset.purchase();

      expect(purchaseOutlay).toBe(0);
      expect(asset.getOwnershipStatus()).toBe('owned');
    });

    it('purchase() throws for already owned asset', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
          purchasePrice: 400000,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Already owned from constructor
      expect(asset.getOwnershipStatus()).toBe('owned');
      expect(() => asset.purchase()).toThrow('Asset is not pending');
    });

    it('purchase() throws on second call', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
          purchasePrice: 400000,
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { purchaseOutlay } = asset.purchase();
      expect(purchaseOutlay).toBe(400000);

      // Second purchase throws
      expect(() => asset.purchase()).toThrow('Asset is not pending');
    });

    it('shouldPurchaseThisPeriod returns true for pending asset at purchase date', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const simStateBefore = createSimulationState({ time: { age: 39, year: 2028, month: 1, date: new Date(2028, 0, 1) } });
      expect(asset.shouldPurchaseThisPeriod(simStateBefore)).toBe(false);

      const simStateAt = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      expect(asset.shouldPurchaseThisPeriod(simStateAt)).toBe(true);

      // After purchase, should return false
      asset.purchase();
      expect(asset.shouldPurchaseThisPeriod(simStateAt)).toBe(false);
    });

    it('shouldPurchaseThisPeriod returns false for already owned asset', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'now' },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState();
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(false);
    });

    it('shouldPurchaseThisPeriod returns false for sold asset', () => {
      const asset = new PhysicalAsset(
        createPhysicalAssetInput({
          purchaseDate: { type: 'customAge', age: 40 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Purchase then sell
      asset.purchase();
      asset.sell();

      const simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      expect(asset.shouldPurchaseThisPeriod(simState)).toBe(false);
    });
  });

  describe('PhysicalAssetsProcessor purchase expense tracking', () => {
    it('assets already active at sim start have no purchase expense', () => {
      const assets = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'existing-house',
            name: 'Existing House',
            purchaseDate: { type: 'now' }, // Already owned
            purchasePrice: 400000,
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState();
      const processor = new PhysicalAssetsProcessor(simState, assets);

      const result = processor.process(ZERO_INFLATION);

      expect(result.totalPurchaseOutlay).toBe(0);
      expect(result.perAssetData['existing-house'].purchaseOutlay).toBe(0);
    });

    it('future cash purchase charges full purchase price when date arrives', () => {
      const assets = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'future-house',
            name: 'Future House',
            purchaseDate: { type: 'customAge', age: 40 },
            purchasePrice: 500000,
            paymentMethod: undefined, // Cash purchase
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      // Before purchase age
      const simStateBefore = createSimulationState({ time: { age: 39, year: 2028, month: 1, date: new Date(2028, 0, 1) } });
      const processorBefore = new PhysicalAssetsProcessor(simStateBefore, assets);
      const resultBefore = processorBefore.process(ZERO_INFLATION);
      expect(resultBefore.totalPurchaseOutlay).toBe(0);

      // At purchase age - need new processor since assets state changed
      const assets2 = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'future-house',
            name: 'Future House',
            purchaseDate: { type: 'customAge', age: 40 },
            purchasePrice: 500000,
            paymentMethod: undefined,
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const simStateAt = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      const processorAt = new PhysicalAssetsProcessor(simStateAt, assets2);
      const resultAt = processorAt.process(ZERO_INFLATION);

      expect(resultAt.totalPurchaseOutlay).toBe(500000);
      expect(resultAt.perAssetData['future-house'].purchaseOutlay).toBe(500000);
    });

    it('future financed purchase charges only down payment when date arrives', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            id: 'future-house',
            name: 'Future House',
            purchaseDate: { type: 'customAge', age: 40 },
            purchasePrice: 400000,
            paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      const processor = new PhysicalAssetsProcessor(simState, assets);
      const result = processor.process(ZERO_INFLATION);

      expect(result.totalPurchaseOutlay).toBe(80000);
      expect(result.perAssetData['future-house'].purchaseOutlay).toBe(80000);
    });

    it('purchase expense is charged only once, not every month', () => {
      const assets = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'future-house',
            name: 'Future House',
            purchaseDate: { type: 'customAge', age: 40 },
            purchasePrice: 500000,
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      const processor = new PhysicalAssetsProcessor(simState, assets);

      // First month - should have purchase expense
      const result1 = processor.process(ZERO_INFLATION);
      expect(result1.totalPurchaseOutlay).toBe(500000);

      // Advance to next month
      simState.time.month = 2;
      simState.time.date = new Date(2029, 1, 1);

      // Second month - no purchase expense
      const result2 = processor.process(ZERO_INFLATION);
      expect(result2.totalPurchaseOutlay).toBe(0);

      // Annual data should show total purchase expense
      const annualData = processor.getAnnualData();
      expect(annualData.totalPurchaseOutlay).toBe(500000);
    });

    it('atRetirement purchase charges expense when retirement starts', () => {
      const assets = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'retirement-home',
            name: 'Retirement Home',
            purchaseDate: { type: 'atRetirement' },
            purchasePrice: 300000,
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      // Pre-retirement
      const simStateAccum = createSimulationState({ phase: { name: 'accumulation' } });
      const processorAccum = new PhysicalAssetsProcessor(simStateAccum, assets);
      const resultAccum = processorAccum.process(ZERO_INFLATION);
      expect(resultAccum.totalPurchaseOutlay).toBe(0);

      // At retirement - new assets instance
      const assets2 = new PhysicalAssets(
        [
          createPhysicalAssetInput({
            id: 'retirement-home',
            name: 'Retirement Home',
            purchaseDate: { type: 'atRetirement' },
            purchasePrice: 300000,
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const simStateRetire = createSimulationState({ phase: { name: 'retirement' } });
      const processorRetire = new PhysicalAssetsProcessor(simStateRetire, assets2);
      const resultRetire = processorRetire.process(ZERO_INFLATION);

      expect(resultRetire.totalPurchaseOutlay).toBe(300000);
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

// ============================================================================
// Full Amortization Tests
// ============================================================================

describe('Full Amortization Tests', () => {
  it('should pay off loan exactly at term end with correct total interest', () => {
    const loanBalance = 320000;
    const apr = 6;
    const termMonths = 360;
    const monthlyRate = apr / 100 / 12;

    // Calculate expected monthly payment using standard amortization formula
    const expectedMonthlyPayment =
      (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);

    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 400000,
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance, apr, monthlyPayment: expectedMonthlyPayment },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Apply all payments
    let totalPayments = 0;
    for (let i = 0; i < termMonths; i++) {
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      if (monthlyPaymentDue === 0) break;

      asset.applyLoanPayment(monthlyPaymentDue, interest);
      totalPayments += monthlyPaymentDue;
    }

    // Loan should be paid off exactly
    expect(asset.getLoanBalance()).toBeCloseTo(0, 2);
    expect(asset.getMonthlyPaymentInfo(ZERO_INFLATION)).toEqual({ monthlyPaymentDue: 0, interest: 0 });

    // Total payments should match expected (principal + total interest)
    // Total interest for 30-year mortgage at 6% on $320k is roughly $370k
    const expectedTotalPayments = expectedMonthlyPayment * termMonths;
    expect(totalPayments).toBeCloseTo(expectedTotalPayments, 0);

    // Verify total interest paid
    const totalInterest = totalPayments - loanBalance;
    expect(totalInterest).toBeGreaterThan(0);
    expect(totalInterest).toBeCloseTo(expectedTotalPayments - loanBalance, 0);
  });

  it('should pay off zero APR loan with exact payments', () => {
    const loanBalance = 24000;
    const termMonths = 48;
    const expectedPayment = loanBalance / termMonths;

    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 30000,
        paymentMethod: { type: 'loan', downPayment: 6000, loanBalance, apr: 0, monthlyPayment: expectedPayment },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Apply all payments
    let totalPayments = 0;
    for (let i = 0; i < termMonths; i++) {
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      expect(monthlyPaymentDue).toBeCloseTo(expectedPayment, 2);

      asset.applyLoanPayment(monthlyPaymentDue, interest);
      totalPayments += monthlyPaymentDue;
    }

    // Loan should be paid off exactly with zero interest
    expect(asset.getLoanBalance()).toBe(0);
    expect(totalPayments).toBeCloseTo(loanBalance, 2);
  });

  it('should correctly track principal vs interest split over loan life', () => {
    const loanBalance = 100000;
    const apr = 5;
    const termMonths = 120; // 10 year loan
    const monthlyRate = apr / 100 / 12;

    // Calculate monthly payment using standard amortization formula
    const monthlyPayment =
      (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);

    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 125000,
        paymentMethod: { type: 'loan', downPayment: 25000, loanBalance, apr, monthlyPayment },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    let totalPrincipal = 0;
    let totalInterest = 0;

    for (let i = 0; i < termMonths; i++) {
      const balanceBefore = asset.getLoanBalance();
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      if (monthlyPaymentDue === 0) break;

      const interestThisMonth = balanceBefore * monthlyRate;
      const principalThisMonth = monthlyPaymentDue - interestThisMonth;

      totalInterest += interestThisMonth;
      totalPrincipal += principalThisMonth;

      asset.applyLoanPayment(monthlyPaymentDue, interest);
    }

    // Total principal should equal original loan balance
    expect(totalPrincipal).toBeCloseTo(loanBalance, 0);

    // Total interest should be positive for a loan with APR > 0
    expect(totalInterest).toBeGreaterThan(0);

    // Loan should be paid off
    expect(asset.getLoanBalance()).toBeCloseTo(0, 2);
  });
});

// ============================================================================
// Capital Loss Scenario Tests
// ============================================================================

describe('Capital Loss Scenarios', () => {
  it('should calculate negative capital gain on depreciated asset sale', () => {
    const purchasePrice = 50000;
    const depreciationRate = -20; // 20% annual depreciation

    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchasePrice,
        appreciationRate: depreciationRate,
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Apply 24 months of depreciation
    for (let i = 0; i < 24; i++) {
      asset.applyMonthlyAppreciation();
    }

    const marketValueBeforeSale = asset.getMarketValue();
    const { realizedGains, saleProceeds } = asset.sell();

    // Asset should have depreciated: 50000 * (0.8)^2 = 32000
    expect(marketValueBeforeSale).toBeCloseTo(purchasePrice * Math.pow(1 - 0.2, 2), -1);

    // Capital gain should be negative (a loss)
    expect(realizedGains).toBeLessThan(0);
    expect(realizedGains).toBeCloseTo(marketValueBeforeSale - purchasePrice, 0);

    // Sale proceeds should equal market value (no loan)
    expect(saleProceeds).toBeCloseTo(marketValueBeforeSale, 0);
  });

  it('should calculate capital loss on financed depreciated asset', () => {
    const purchasePrice = 40000;
    const downPayment = 8000;
    const loanBalance = 32000;
    const apr = 4;
    const monthlyRate = apr / 100 / 12;
    const termMonths = 60;
    const monthlyPayment =
      (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);

    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice,
        appreciationRate: -15, // 15% annual depreciation (like a car)
        paymentMethod: { type: 'loan', downPayment, loanBalance, apr, monthlyPayment },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Apply 12 months of depreciation and payments
    for (let i = 0; i < 12; i++) {
      asset.applyMonthlyAppreciation();
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
    }

    const marketValueBeforeSale = asset.getMarketValue();
    const loanBalanceBeforeSale = asset.getLoanBalance();
    const { realizedGains, saleProceeds } = asset.sell();

    // Market value after 1 year: 40000 * 0.85 = 34000
    expect(marketValueBeforeSale).toBeCloseTo(purchasePrice * Math.pow(1 - 0.15, 1), -2);

    // Capital gain should be negative (loss)
    expect(realizedGains).toBeLessThan(0);
    expect(realizedGains).toBeCloseTo(marketValueBeforeSale - purchasePrice, 0);

    // Sale proceeds = market value - remaining loan
    expect(saleProceeds).toBeCloseTo(marketValueBeforeSale - loanBalanceBeforeSale, 0);
  });

  it('should handle zero capital gain when sold at purchase price', () => {
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchasePrice: 300000,
        appreciationRate: 0, // No change in value
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const { realizedGains, saleProceeds } = asset.sell();

    expect(realizedGains).toBe(0);
    expect(saleProceeds).toBe(300000);
  });

  it('should track capital loss correctly with marketValueAtPurchase', () => {
    // Asset was purchased for $200k, now worth $180k (already depreciated)
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchasePrice: 200000, // Original cost basis
        marketValue: 180000, // Current value (already lost value)
        appreciationRate: 0,
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const { realizedGains, saleProceeds } = asset.sell();

    // Capital gain uses cost basis, not current market value
    expect(realizedGains).toBe(180000 - 200000); // -$20,000 loss
    expect(saleProceeds).toBe(180000);
  });
});

describe('Edge Cases', () => {
  it('asset purchased in future is pending and has no market value', () => {
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchaseDate: { type: 'customDate', year: 2030, month: 1 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    expect(asset.getOwnershipStatus()).toBe('pending');
    expect(asset.getMarketValue()).toBe(0); // Pending assets don't contribute to net worth
  });

  it('marketValueAtPurchase != purchasePrice (pre-existing asset)', () => {
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchasePrice: 300000, // Original cost basis
        marketValue: 450000, // Current value (appreciated)
        appreciationRate: 3,
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Market value should be the current value, not purchase price
    expect(asset.getMarketValue()).toBe(450000);

    // But capital gain on sale uses original cost basis
    const { realizedGains } = asset.sell();
    expect(realizedGains).toBe(150000); // 450000 - 300000
  });

  it('deprecating asset becomes underwater', () => {
    const loanBalance = 27000;
    const apr = 5;
    const monthlyRate = apr / 100 / 12;
    const termMonths = 60;
    const monthlyPayment =
      (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);

    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 30000, // Car
        appreciationRate: -25, // 25% annual depreciation
        paymentMethod: { type: 'loan', downPayment: 3000, loanBalance, apr, monthlyPayment },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Apply 24 months of depreciation
    for (let i = 0; i < 24; i++) {
      asset.applyMonthlyAppreciation();
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
    }

    // Asset should be underwater (loan > value)
    const marketValue = asset.getMarketValue();
    const currentLoanBalance = asset.getLoanBalance();

    // Market value after 2 years: 30000 * (0.75)^2 = 16875
    expect(marketValue).toBeLessThan(currentLoanBalance);

    // Equity should be 0 (floored)
    expect(asset.getEquity()).toBe(0);
  });

  it('atLifeExpectancy purchase date stays pending', () => {
    const asset = new PhysicalAsset(
      createPhysicalAssetInput({
        purchaseDate: { type: 'atLifeExpectancy' },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Should stay pending (atLifeExpectancy returns false for shouldPurchaseThisPeriod)
    const simState = createSimulationState({ time: { age: 100, year: 2089, month: 1, date: new Date(2089, 0, 1) } });
    expect(asset.getOwnershipStatus()).toBe('pending');
    expect(asset.shouldPurchaseThisPeriod(simState)).toBe(false);
  });

  it('very small loan balance is paid off cleanly', () => {
    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 10000,
        paymentMethod: {
          type: 'loan',
          downPayment: 0,
          loanBalance: 10000,
          apr: 0,
          monthlyPayment: 1000, // 10000 / 10 payments
        },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Pay off the loan
    for (let i = 0; i < 15; i++) {
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(ZERO_INFLATION);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
    }

    // Balance should be exactly 0, not negative
    expect(asset.getLoanBalance()).toBe(0);
    expect(asset.getMonthlyPaymentInfo(ZERO_INFLATION)).toEqual({ monthlyPaymentDue: 0, interest: 0 });
  });
});

// ============================================================================
// Inflation Adjustment Tests
// ============================================================================

describe('Inflation Adjustment', () => {
  describe('Loan Payoff Timing Equivalence', () => {
    it('should pay off loan in same number of months as nominal calculation', () => {
      // Setup: $320K loan, 6% nominal APR, standard 30-year mortgage payment
      const loanBalance = 320000;
      const apr = 6;
      const monthlyRate = apr / 100 / 12;
      const termMonths = 360;
      const nominalPayment =
        (loanBalance * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);

      const annualInflation = 0.03;
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;

      // Calculate nominal payoff months (standard loan amortization)
      let nomBalance = loanBalance;
      let nomMonths = 0;
      while (nomBalance > 0 && nomMonths < 400) {
        const interest = nomBalance * monthlyRate;
        nomBalance = nomBalance + interest - Math.min(nominalPayment, nomBalance + interest);
        nomMonths++;
      }

      // Calculate real payoff months using inflation-adjusted approach
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: { type: 'loan', downPayment: 80000, loanBalance, apr, monthlyPayment: nominalPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      let realMonths = 0;
      while (!asset.isPaidOff() && realMonths < 400) {
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
        realMonths++;
      }

      // Should pay off in same number of months (within 1 month tolerance for rounding)
      expect(realMonths).toBeCloseTo(nomMonths, 0);
    });
  });

  describe('Payment Deflation', () => {
    it('should deflate loan payments by cumulative inflation', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance: 100000, apr: 0, monthlyPayment: 1000 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const monthlyInflation = 0.0025; // ~3% annual

      // After 12 months of inflation
      for (let i = 0; i < 12; i++) {
        asset.applyMonthlyInflation(monthlyInflation);
      }

      const { monthlyPaymentDue } = asset.getMonthlyPaymentInfo(monthlyInflation);

      // Payment should be ~$970 (deflated by ~3%)
      const expectedPayment = 1000 / Math.pow(1 + monthlyInflation, 12);
      expect(monthlyPaymentDue).toBeCloseTo(expectedPayment, 1);
    });
  });

  describe('Real Interest Rate Calculation', () => {
    it('should correctly convert nominal to real interest rate', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance: 10000, apr: 7, monthlyPayment: 500 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // 3% annual inflation = ~0.247% monthly inflation
      const annualInflation = 0.03;
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;

      // Get payment info which uses real interest rate internally
      const balanceBefore = asset.getLoanBalance();
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
      const balanceAfter = asset.getLoanBalance();

      // Real monthly rate = (1 + 0.07/12) / (1 + monthlyInflation) - 1
      const nominalMonthlyRate = 0.07 / 12;
      const realMonthlyRate = (1 + nominalMonthlyRate) / (1 + monthlyInflation) - 1;
      const expectedInterest = balanceBefore * realMonthlyRate;
      const expectedPrincipal = monthlyPaymentDue - expectedInterest;

      expect(balanceAfter).toBeCloseTo(balanceBefore - expectedPrincipal, 2);
    });

    it('should correctly handle negative real interest rates', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance: 10000, apr: 7, monthlyPayment: 0 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // 10% annual inflation > 7% nominal APR = negative real rate
      const annualInflation = 0.1;
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;

      const balanceBefore = asset.getLoanBalance();
      // Apply zero payment to see interest effect only
      const { interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
      asset.applyLoanPayment(0, interest);
      const balanceAfter = asset.getLoanBalance();

      // Real rate should be negative, so balance should decrease (debt erodes)
      const nominalMonthlyRate = 0.07 / 12;
      const realMonthlyRate = (1 + nominalMonthlyRate) / (1 + monthlyInflation) - 1;

      expect(realMonthlyRate).toBeLessThan(0);
      // With negative real rate and zero payment, unpaid interest should decrease balance
      expect(balanceAfter).toBeLessThan(balanceBefore);
    });
  });

  describe('Processor Integration', () => {
    it('future-dated asset first payment is at full nominal value through processor', () => {
      const nominalPayment = 2000;
      const purchaseAge = 36;
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            id: 'house',
            purchasePrice: 400000,
            purchaseDate: { type: 'customAge', age: purchaseAge },
            paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: nominalPayment },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      const monthlyInflation = Math.pow(1.08, 1 / 12) - 1; // 8% annual
      const simState = createSimulationState();
      const processor = new PhysicalAssetsProcessor(simState, assets);

      // Process months before purchase — no payments should occur
      for (let month = 0; month < 12; month++) {
        const result = processor.process(monthlyInflation);
        expect(result.totalLoanPayment).toBe(0);
        simState.time.age += 1 / 12;
      }

      // Purchase month — first payment should be at full nominal value
      const purchaseResult = processor.process(monthlyInflation);
      expect(purchaseResult.totalLoanPayment).toBeCloseTo(nominalPayment, 0);

      // Next month — payment should be deflated
      simState.time.age += 1 / 12;
      const nextResult = processor.process(monthlyInflation);
      expect(nextResult.totalLoanPayment).toBeLessThan(nominalPayment);
    });

    it('should apply inflation through processor', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            id: 'house',
            purchasePrice: 400000,
            paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 2000 },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState();
      const processor = new PhysicalAssetsProcessor(simState, assets);

      const monthlyInflation = Math.pow(1.03, 1 / 12) - 1; // ~3% annual

      // Process first month
      const result1 = processor.process(monthlyInflation);

      // Process second month - payment should be slightly lower due to deflation
      const result2 = processor.process(monthlyInflation);

      // First payment at full nominal, second deflated (inflation applied after payment)
      expect(result1.totalLoanPayment).toBeCloseTo(2000, 0);
      expect(result2.totalLoanPayment).toBeLessThan(result1.totalLoanPayment);
    });
  });

  describe('Physical Asset Loan vs Standalone Debt Consistency', () => {
    it('should produce same results as equivalent standalone debt', () => {
      const loanBalance = 100000;
      const apr = 6;
      const monthlyPayment = 600;
      const monthlyInflation = Math.pow(1.03, 1 / 12) - 1; // ~3% annual

      // Create physical asset loan
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 125000,
          paymentMethod: { type: 'loan', downPayment: 25000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Create equivalent standalone debt
      const debt = new Debt(
        createDebtInput({
          balance: loanBalance,
          apr,
          monthlyPayment,
          interestType: 'simple',
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Process 12 months for both
      for (let i = 0; i < 12; i++) {
        // Physical asset
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue: assetPayment, interest: assetInterest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(assetPayment, assetInterest);

        // Standalone debt
        debt.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue: debtPayment, interest: debtInterest } = debt.getMonthlyPaymentInfo(monthlyInflation);
        debt.applyPayment(debtPayment, debtInterest);
      }

      // Both should have same remaining balance
      expect(asset.getLoanBalance()).toBeCloseTo(debt.getBalance(), 1);
    });

    it('should produce identical results over 60 months with varying parameters', () => {
      const loanBalance = 500_000;
      const apr = 6;
      const monthlyPayment = 3_000;
      const monthlyInflation = Math.pow(1.03, 1 / 12) - 1;

      // Create physical asset with loan
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 600_000,
          paymentMethod: { type: 'loan', downPayment: 100_000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Create equivalent standalone debt
      const debt = new Debt(
        createDebtInput({
          balance: loanBalance,
          apr,
          monthlyPayment,
          interestType: 'simple',
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Run 60 months for both
      for (let i = 0; i < 60; i++) {
        // Physical asset
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue: assetPayment, interest: assetInterest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(assetPayment, assetInterest);

        // Standalone debt
        debt.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue: debtPayment, interest: debtInterest } = debt.getMonthlyPaymentInfo(monthlyInflation);
        debt.applyPayment(debtPayment, debtInterest);
      }

      // Balances should match
      expect(asset.getLoanBalance()).toBeCloseTo(debt.getBalance(), 0);
    });
  });

  describe('Real Balance with Interest-Only Payments (Physical Asset Loan)', () => {
    it('should significantly reduce real loan balance when inflation doubles over loan life (APR = inflation)', () => {
      // Same test as Debt class: when nominal APR equals inflation, real interest rate ≈ 0
      // After 10 years of ~7.177% inflation, prices roughly double
      // Starting with $1M loan, interest-only payments in nominal terms
      // means real balance should be close to half the original

      const loanBalance = 1_000_000;
      const annualInflation = 0.07177;
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;
      const apr = annualInflation * 100; // APR matches inflation rate
      // Nominal interest-only payment = balance * (APR / 12)
      const monthlyPayment = loanBalance * (annualInflation / 12);

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 1_250_000,
          paymentMethod: { type: 'loan', downPayment: 250_000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Run 120 months (10 years)
      for (let i = 0; i < 120; i++) {
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
      }

      // Real balance should be approximately half of initial
      // (small drift due to monthly compounding vs annual rate approximation)
      expect(asset.getLoanBalance()).toBeLessThan(550_000);
      expect(asset.getLoanBalance()).toBeGreaterThan(450_000);
    });
  });

  describe('Zero Payment with Equal Rates (Physical Asset Loan)', () => {
    it('should maintain roughly constant real loan balance with zero payments when APR = inflation', () => {
      // When APR equals inflation and no payments are made:
      // - Real interest rate ≈ 0% (Fisher equation)
      // - No payments means no principal reduction
      // - Real balance stays approximately constant
      // Note: small drift occurs due to monthly compounding vs annual rate approximation

      const loanBalance = 1_000_000;
      const annualInflation = 0.05;
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;
      const apr = annualInflation * 100; // APR matches inflation

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 1_250_000,
          paymentMethod: { type: 'loan', downPayment: 250_000, loanBalance, apr, monthlyPayment: 0 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Run 120 months
      for (let i = 0; i < 120; i++) {
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
      }

      // Real balance should stay approximately at $1M (within ~2% after 10 years)
      // Small drift due to APR being simple interest (annual/12) vs inflation being compound
      expect(asset.getLoanBalance()).toBeGreaterThan(loanBalance * 0.98);
      expect(asset.getLoanBalance()).toBeLessThan(loanBalance * 1.02);
    });
  });

  describe('Loan Erosion with High Inflation (Physical Asset Loan)', () => {
    it('should erode loan when inflation exceeds APR', () => {
      const loanBalance = 1_000_000;
      const apr = 5; // 5% nominal
      const annualInflation = 0.1; // 10% inflation
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 1_250_000,
          paymentMethod: { type: 'loan', downPayment: 250_000, loanBalance, apr, monthlyPayment: 0 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Run 120 months
      for (let i = 0; i < 120; i++) {
        asset.applyMonthlyInflation(monthlyInflation);
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
        asset.applyLoanPayment(monthlyPaymentDue, interest);
      }

      // Real rate ≈ (1.05/1.10) - 1 ≈ -4.5% annually
      // After 10 years: balance should be significantly less
      expect(asset.getLoanBalance()).toBeLessThan(700_000);
      expect(asset.getLoanBalance()).toBeGreaterThan(500_000);
    });
  });

  describe('Extreme Inflation Edge Cases (Physical Asset Loan)', () => {
    it('should handle very high inflation (50% annual) without errors', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance: 10000, apr: 5, monthlyPayment: 100 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const annualInflation = 0.5; // 50%
      const monthlyInflation = Math.pow(1 + annualInflation, 1 / 12) - 1;

      // Should not throw
      asset.applyMonthlyInflation(monthlyInflation);
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
      asset.applyLoanPayment(monthlyPaymentDue, interest);

      // With 50% inflation > 5% APR, real rate is deeply negative
      // Loan balance should decrease even with small payment
      expect(asset.getLoanBalance()).toBeLessThan(10000);
    });

    it('should handle zero inflation without division issues', () => {
      const loanBalance = 10000;
      const apr = 7;

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: { type: 'loan', downPayment: 0, loanBalance, apr, monthlyPayment: 500 },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // With zero inflation, real rate = nominal rate
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(0);
      asset.applyLoanPayment(monthlyPaymentDue, interest);

      // Expected: interest = 10000 * (0.07 / 12) ≈ 58.33
      // Principal = 500 - 58.33 = 441.67
      // New balance = 10000 - 441.67 = 9558.33
      const expectedInterest = loanBalance * (apr / 100 / 12);
      const expectedNewBalance = loanBalance - (500 - expectedInterest);

      expect(asset.getLoanBalance()).toBeCloseTo(expectedNewBalance, 2);
    });

    describe('Real Rate Mathematical Bounds', () => {
      it('should have real rate > -100% even with extreme inflation', () => {
        // APR = 0% (minimum allowed)
        // Inflation = 10,000% annual (extreme hyperinflation)
        const asset = new PhysicalAsset(
          createFinancedAssetInput({
            purchasePrice: 200_000,
            paymentMethod: { type: 'loan', downPayment: 100_000, loanBalance: 100_000, apr: 0, monthlyPayment: 1000 },
          }),
          TEST_TIME_BINDING_CONTEXT
        );

        const extremeAnnualInflation = 100; // 10,000%
        const monthlyInflation = Math.pow(1 + extremeAnnualInflation, 1 / 12) - 1;

        const { interest } = asset.getMonthlyPaymentInfo(monthlyInflation);

        // Real rate = (1 + 0) / (1 + monthlyInflation) - 1
        // With 10,000% annual inflation, monthly ≈ 46.8%
        // Real rate ≈ 1/1.468 - 1 ≈ -31.9%
        // Interest should be negative but |interest| < principal
        expect(interest).toBeLessThan(0);
        expect(Math.abs(interest)).toBeLessThan(100_000); // |interest| < balance
      });
    });

    describe('Monthly Payment Due Non-Negativity', () => {
      it('should always have non-negative monthlyPaymentDue even with extreme inflation', () => {
        const asset = new PhysicalAsset(
          createFinancedAssetInput({
            purchasePrice: 200,
            paymentMethod: {
              type: 'loan',
              downPayment: 100,
              loanBalance: 100,
              apr: 0, // Worst case for negative interest
              monthlyPayment: 1000,
            },
          }),
          TEST_TIME_BINDING_CONTEXT
        );

        // Even with 10,000% annual inflation
        const extremeAnnualInflation = 100;
        const monthlyInflation = Math.pow(1 + extremeAnnualInflation, 1 / 12) - 1;

        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);

        // Interest is negative
        expect(interest).toBeLessThan(0);
        // But balance + interest > 0, so monthlyPaymentDue >= 0
        expect(monthlyPaymentDue).toBeGreaterThanOrEqual(0);
        // Specifically: monthlyPaymentDue = balance + interest (since that's less than monthlyPayment)
        expect(monthlyPaymentDue).toBeCloseTo(100 + interest, 2);
      });

      it('should maintain non-negative loan payments through multiple months of extreme inflation', () => {
        const asset = new PhysicalAsset(
          createFinancedAssetInput({
            purchasePrice: 20_000,
            paymentMethod: {
              type: 'loan',
              downPayment: 10_000,
              loanBalance: 10_000,
              apr: 5, // 5% APR
              monthlyPayment: 500,
            },
          }),
          TEST_TIME_BINDING_CONTEXT
        );

        const extremeAnnualInflation = 10; // 1,000% annual
        const monthlyInflation = Math.pow(1 + extremeAnnualInflation, 1 / 12) - 1;

        // Run for 60 months
        for (let i = 0; i < 60 && !asset.isPaidOff(); i++) {
          asset.applyMonthlyInflation(monthlyInflation);
          const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);

          // Every single month, payment should be non-negative
          expect(monthlyPaymentDue).toBeGreaterThanOrEqual(0);

          asset.applyLoanPayment(monthlyPaymentDue, interest);
        }

        // Loan should be paid off
        expect(asset.isPaidOff()).toBe(true);
      });
    });

    describe('Balance Plus Interest Invariant', () => {
      it('should always have balance + interest > 0 for physical asset loans', () => {
        // This invariant holds because:
        // interest = principal * realRate
        // realRate > -1 (proven above)
        // So |interest| < principal <= balance
        // Therefore balance + interest > 0

        const testCases = [
          { apr: 0, inflation: 0.5 }, // 50% annual
          { apr: 0, inflation: 1 }, // 100% annual
          { apr: 0, inflation: 10 }, // 1,000% annual
          { apr: 0, inflation: 100 }, // 10,000% annual
          { apr: 40, inflation: 100 }, // Max APR, extreme inflation
        ];

        for (const { apr, inflation } of testCases) {
          const asset = new PhysicalAsset(
            createFinancedAssetInput({
              purchasePrice: 2000,
              paymentMethod: {
                type: 'loan',
                downPayment: 1000,
                loanBalance: 1000,
                apr,
                monthlyPayment: 100,
              },
            }),
            TEST_TIME_BINDING_CONTEXT
          );

          const monthlyInflation = Math.pow(1 + inflation, 1 / 12) - 1;
          const { interest } = asset.getMonthlyPaymentInfo(monthlyInflation);

          expect(asset.getLoanBalance() + interest).toBeGreaterThan(0);
        }
      });
    });
  });
});

// ============================================================================
// Negative Interest Reporting (High Inflation Fix)
// ============================================================================

describe('Negative Interest Reporting (High Inflation Fix)', () => {
  const HIGH_INFLATION_MONTHLY = Math.pow(1.1, 1 / 12) - 1;

  describe('getMonthlyPaymentInfo', () => {
    it('should NOT cap monthlyPaymentDue at 0 - allows raw value for accurate tracking', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 100000,
          paymentMethod: {
            type: 'loan',
            loanBalance: 100, // Small balance
            apr: 3, // Low APR
            monthlyPayment: 500, // Larger than balance + interest
            downPayment: 0,
          },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(HIGH_INFLATION_MONTHLY);

      // Interest is negative (inflation > APR)
      expect(interest).toBeLessThan(0);

      // Payment = min(500, balance + interest) = balance + interest
      // Without Math.max(0, ...), the raw value flows through
      expect(monthlyPaymentDue).toBeCloseTo(100 + interest, 2);

      // Payment is less than original balance because of negative interest adjustment
      expect(monthlyPaymentDue).toBeLessThan(100);
    });

    it('should return raw interest for internal balance calculations', () => {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 400000,
          paymentMethod: {
            type: 'loan',
            loanBalance: 320000,
            apr: 5, // 5% APR < 10% inflation
            monthlyPayment: 1918,
            downPayment: 80000,
          },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const { interest } = asset.getMonthlyPaymentInfo(HIGH_INFLATION_MONTHLY);

      // Raw interest should be negative for internal calculations
      expect(interest).toBeLessThan(0);
    });
  });

  describe('PhysicalAssetsProcessor.process - Raw Values for Net Worth Tracking', () => {
    it('should pass through raw totalInterest (can be negative)', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            paymentMethod: {
              type: 'loan',
              loanBalance: 320000,
              apr: 5,
              monthlyPayment: 1918,
              downPayment: 80000,
            },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const state = createSimulationState();
      const processor = new PhysicalAssetsProcessor(state, assets);

      const result = processor.process(HIGH_INFLATION_MONTHLY);

      // Raw interest should be negative when inflation > APR
      expect(result.totalInterest).toBeLessThan(0);
      expect(result.perAssetData['asset-1'].interest).toBeLessThan(0);
    });

    it('should still erode loan balance with raw reporting', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            paymentMethod: {
              type: 'loan',
              loanBalance: 100000,
              apr: 5,
              monthlyPayment: 0, // No payment
              downPayment: 0,
            },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const state = createSimulationState();
      const processor = new PhysicalAssetsProcessor(state, assets);

      const result = processor.process(HIGH_INFLATION_MONTHLY);

      // Balance should erode (internal works)
      expect(result.totalLoanBalance).toBeLessThan(100000);

      // Raw interest is negative (reflects balance erosion economically)
      expect(result.totalInterest).toBeLessThan(0);
    });

    it('should pass through raw totalLoanPayment (equals balance + interest when that is less than monthlyPayment)', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            paymentMethod: {
              type: 'loan',
              loanBalance: 100, // Small balance
              apr: 3,
              monthlyPayment: 500, // Larger than balance + interest
              downPayment: 0,
            },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const state = createSimulationState();
      const processor = new PhysicalAssetsProcessor(state, assets);

      const result = processor.process(HIGH_INFLATION_MONTHLY);

      // With negative interest, balance + interest < balance
      // Payment = min(500, balance + interest) = balance + interest
      const expectedPayment = 100 + result.totalInterest;
      expect(result.totalLoanPayment).toBeCloseTo(expectedPayment, 2);

      // Interest is negative (inflation > APR)
      expect(result.totalInterest).toBeLessThan(0);

      // Payment is less than original balance because of negative interest adjustment
      expect(result.totalLoanPayment).toBeLessThan(100);
    });

    it('should calculate principalPaid as payment minus raw interest', () => {
      const assets = new PhysicalAssets(
        [
          createFinancedAssetInput({
            paymentMethod: {
              type: 'loan',
              loanBalance: 100000,
              apr: 5,
              monthlyPayment: 1000,
              downPayment: 0,
            },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      );
      const state = createSimulationState();
      const processor = new PhysicalAssetsProcessor(state, assets);

      const result = processor.process(HIGH_INFLATION_MONTHLY);

      // With negative raw interest, principalPaid = payment - interest > payment
      // This correctly reflects that more principal is "paid" due to balance erosion
      expect(result.totalPrincipalPaid).toBeGreaterThan(result.totalLoanPayment);
      expect(result.totalPrincipalPaid).toBeCloseTo(result.totalLoanPayment - result.totalInterest, 2);
    });
  });

  describe('Loan Payoff Timing with Inflation', () => {
    const loanBalance = 400000;
    const apr = 6;
    const monthlyPayment = 2400;
    const MAX_MONTHS = 600;
    const PENDING_MONTHS = 60;

    function countMonthsToPayoff(monthlyInflationRate: number, pendingMonths: number = 0): number {
      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 500000,
          appreciationRate: 0,
          purchaseDate: pendingMonths > 0 ? { type: 'customAge', age: 35 + pendingMonths / 12 } : { type: 'now' },
          paymentMethod: { type: 'loan', downPayment: 100000, loanBalance, apr, monthlyPayment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      let paymentMonths = 0;
      for (let month = 0; month < MAX_MONTHS; month++) {
        // Simulate purchase at the right month
        if (month === pendingMonths && pendingMonths > 0) {
          asset.purchase();
        }

        if (asset.getOwnershipStatus() === 'owned' && !asset.isPaidOff()) {
          asset.applyMonthlyAppreciation();
          const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflationRate);
          asset.applyLoanPayment(monthlyPaymentDue, interest);
          asset.applyMonthlyInflation(monthlyInflationRate);
          paymentMonths++;
          if (asset.isPaidOff()) return paymentMonths;
        }
      }
      return MAX_MONTHS;
    }

    it('future-dated purchase with 8% inflation pays off in same months as owned-now', () => {
      const monthlyInflation = Math.pow(1.08, 1 / 12) - 1;
      const monthsNow = countMonthsToPayoff(monthlyInflation, 0);
      const monthsFuture = countMonthsToPayoff(monthlyInflation, PENDING_MONTHS);
      // Without the fix, the future case would never pay off (600 months).
      expect(monthsFuture).toBeLessThan(MAX_MONTHS);
      expect(monthsNow).toBe(monthsFuture);
    });

    it('future-dated purchase with 3% inflation pays off in same months as owned-now', () => {
      const monthlyInflation = Math.pow(1.03, 1 / 12) - 1;
      const monthsNow = countMonthsToPayoff(monthlyInflation, 0);
      const monthsFuture = countMonthsToPayoff(monthlyInflation, PENDING_MONTHS);
      expect(monthsFuture).toBeLessThan(MAX_MONTHS);
      expect(monthsNow).toBe(monthsFuture);
    });
  });

  describe('Debt vs PhysicalAsset Loan Parity', () => {
    it('simple-interest debt and physical asset loan pay off in the same number of months', () => {
      const balance = 400000;
      const aprPercent = 6;
      const payment = 2400;
      const monthlyInflation = Math.pow(1.03, 1 / 12) - 1;
      const MAX = 600;

      const asset = new PhysicalAsset(
        createFinancedAssetInput({
          purchasePrice: 500000,
          appreciationRate: 0,
          paymentMethod: { type: 'loan', downPayment: 100000, loanBalance: balance, apr: aprPercent, monthlyPayment: payment },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const debt = new Debt(
        createDebtInput({
          balance,
          apr: aprPercent,
          monthlyPayment: payment,
          interestType: 'simple',
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      let assetMonths = MAX;
      let debtMonths = MAX;

      for (let month = 0; month < MAX; month++) {
        if (!asset.isPaidOff()) {
          asset.applyMonthlyAppreciation();
          const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflation);
          asset.applyLoanPayment(monthlyPaymentDue, interest);
          asset.applyMonthlyInflation(monthlyInflation);
          if (asset.isPaidOff() && assetMonths === MAX) assetMonths = month + 1;
        }

        if (!debt.isPaidOff()) {
          const { monthlyPaymentDue, interest } = debt.getMonthlyPaymentInfo(monthlyInflation);
          debt.applyPayment(monthlyPaymentDue, interest);
          debt.applyMonthlyInflation(monthlyInflation);
          if (debt.isPaidOff() && debtMonths === MAX) debtMonths = month + 1;
        }
      }

      expect(assetMonths).toBe(debtMonths);
    });
  });
});

// ============================================================================
// Loan term (P1-P5): the amortisation schedule drives the payment
// ============================================================================

describe('Loan term (paymentMethod.termMonths)', () => {
  const monthlyInflation = (annualPercent: number) => Math.pow(1 + annualPercent / 100, 1 / 12) - 1;

  /** Runs the engine's loan loop for `months` payments and reports what it saw. */
  function runLoan(asset: PhysicalAsset, monthlyRate: number, months: number) {
    let interestTotal = 0;
    let payments = 0;
    for (let month = 0; month < months && !asset.isPaidOff(); month++) {
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyRate);
      interestTotal += interest;
      payments += monthlyPaymentDue;
      asset.applyLoanPayment(monthlyPaymentDue, interest);
      asset.applyMonthlyInflation(monthlyRate);
    }

    return { interestTotal, payments, balance: asset.getLoanBalance() };
  }

  const financedWithTerm = (termMonths: number | undefined, monthlyPayment = 1918.56) =>
    new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 400000,
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment, termMonths },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

  it('clears a 30-year loan in exactly 360 months at 3% inflation', () => {
    // The engine deflates the payment every month, so the term payment is NOT the textbook nominal
    // 1,918.56: `computeLoanPayment` solves the deflated recurrence instead, giving 1,913.8416.
    const monthlyRate = monthlyInflation(3);
    const asset = financedWithTerm(360);

    const after359 = runLoan(asset, monthlyRate, 359);
    // 359 months leave a real balance: the loan is not cleared a month early.
    expect(after359.balance).toBeCloseTo(788.43, 2);
    expect(after359.balance).toBeGreaterThan(1);

    const asset2 = financedWithTerm(360);
    const after360 = runLoan(asset2, monthlyRate, 360);
    expect(after360.balance).toBe(0);

    // The derived payment is the schedule's first-month payment, to the cent.
    const fresh = financedWithTerm(360);
    expect(fresh.getMonthlyPaymentInfo(monthlyRate).monthlyPaymentDue).toBeCloseTo(
      computeLoanPayment({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 3 }),
      6
    );
    expect(computeLoanPayment({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 3 })).toBeCloseTo(
      1913.8416,
      3
    );

    // Interest over the term is the schedule's interest (within the schedule's own $1 tolerance),
    // and the last payment is the remaining balance plus that month's interest — no balloon.
    const schedule = buildAmortizationSchedule({
      principal: 320000,
      annualRatePercent: 6,
      termMonths: 360,
      annualInflationPercent: 3,
    });
    expect(Math.abs(after360.interestTotal - schedule.totalInterest)).toBeLessThan(1);
    expect(after360.payments).toBeCloseTo(schedule.totalPaid, 6);
  });

  it('keeps today’s behaviour when no term is stated: the stored payment drives the loan', () => {
    // No `termMonths`: the engine applies the stored 1,918.56 and deflates it, which clears this
    // loan two months early (358) — the pre-P1-P5 result, pinned here so the absence cannot drift.
    expect(runLoan(financedWithTerm(undefined), monthlyInflation(3), 1200).balance).toBe(0);
    const nominalPayment = financedWithTerm(undefined);
    let months = 0;
    for (; months < 1200 && !nominalPayment.isPaidOff(); months++) {
      const { monthlyPaymentDue, interest } = nominalPayment.getMonthlyPaymentInfo(monthlyInflation(3));
      nominalPayment.applyLoanPayment(monthlyPaymentDue, interest);
      nominalPayment.applyMonthlyInflation(monthlyInflation(3));
    }

    expect(months).toBe(358);
    expect(financedWithTerm(360).getTermMonths()).toBe(360);
    expect(financedWithTerm(undefined).getTermMonths()).toBeUndefined();
  });

  it('clears a zero-rate term in exactly its months when the real rate is negative', () => {
    // 12,000 over 24 months at 0% APR with 3% inflation: the engine's real rate is negative, so the
    // schedule's payment is 498.7699 (a little under 12,000 / 24) and both classes still clear the
    // loan in 24 months, not 23. The schedule's own row count is the reference.
    const monthlyRate = monthlyInflation(3);
    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 20000,
        paymentMethod: { type: 'loan', downPayment: 8000, loanBalance: 12000, apr: 0, monthlyPayment: 1, termMonths: 24 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    expect(asset.getMonthlyPaymentInfo(monthlyRate).monthlyPaymentDue).toBeCloseTo(498.7699, 4);

    const after23 = runLoan(asset, monthlyRate, 23);
    expect(after23.balance).toBeGreaterThan(0);

    const asset2 = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 20000,
        paymentMethod: { type: 'loan', downPayment: 8000, loanBalance: 12000, apr: 0, monthlyPayment: 1, termMonths: 24 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );
    // A cent of float residue is not a payment: the loan is cleared (the schedule writes the same
    // residue off with its own `ONE_CENT` floor).
    expect(runLoan(asset2, monthlyRate, 24).balance).toBeLessThan(0.01);
  });

  it('solves a zero-rate term as principal over months', () => {
    // 12,000 over 24 months at 0% with no inflation: 500.00 a month, no interest.
    const asset = new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 20000,
        paymentMethod: { type: 'loan', downPayment: 8000, loanBalance: 12000, apr: 0, monthlyPayment: 1, termMonths: 24 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = runLoan(asset, 0, 24);
    expect(result.payments).toBeCloseTo(12000, 6);
    expect(result.interestTotal).toBe(0);
    expect(result.balance).toBe(0);
  });
});

// ============================================================================
// Mortgage offset account (P1-P5)
// ============================================================================

describe('Mortgage offset account (paymentMethod.offsetAccountId)', () => {
  const monthlyInflation = (annualPercent: number) => Math.pow(1 + annualPercent / 100, 1 / 12) - 1;

  const financedWithOffset = (offsetAccountId: string | undefined) =>
    new PhysicalAsset(
      createFinancedAssetInput({
        purchasePrice: 400000,
        paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56, offsetAccountId },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

  it('reduces interest by the offset balance times the real rate', () => {
    // 320,000 at 6.00% APR with 3% inflation charges the Fisher-deflated rate
    //   i = 1.005 / 1.03^(1/12) − 1 = 0.0025275
    // so the month's interest is:
    //   no offset:        320,000 × 0.0025275 = 808.7989
    //   with 100,000:     220,000 × 0.0025275 = 556.0492
    //   difference:       100,000 × 0.0025275 = 252.7497  (the offset's whole balance)
    const monthlyRate = monthlyInflation(3);
    const without = financedWithOffset(undefined).getMonthlyPaymentInfo(monthlyRate);
    const withOffset = financedWithOffset('savings-1').getMonthlyPaymentInfo(monthlyRate, 100000);

    expect(without.interest).toBeCloseTo(808.7989, 3);
    expect(withOffset.interest).toBeCloseTo(556.0492, 3);
    expect(without.interest - withOffset.interest).toBeCloseTo(100000 * monthlyRealRate(6, 3), 6);
    expect(without.interest - withOffset.interest).toBeCloseTo(252.7497, 3);

    // The payment is untouched: an offset shortens the loan, it does not change what is due.
    expect(withOffset.monthlyPaymentDue).toBe(without.monthlyPaymentDue);
    expect(financedWithOffset('savings-1').getOffsetAccountId()).toBe('savings-1');
  });

  it('never charges negative interest when the offset exceeds the loan', () => {
    const monthlyRate = monthlyInflation(3);
    const capped = financedWithOffset('savings-1').getMonthlyPaymentInfo(monthlyRate, 500000);

    expect(capped.interest).toBe(0);
    // 320,000 of the 500,000 offsets the loan; the surplus is not credited to the borrower.
    expect(capped.monthlyPaymentDue).toBeCloseTo(1918.56, 6);
  });

  it('pays the loan off early by the interest it saves', () => {
    // Same loan and same payment, one year, with and without a 100,000 offset. Each month's
    // interest is lower by 100,000 × i, so the principal falls by that much more — and because the
    // offset loan's balance is lower, the next month saves slightly more. With i = 0.0025275 and
    // Δ_n = the balance gap after n months:
    //   Δ_n = Δ_(n−1) × (1 + i) + O × i,  Δ_0 = 0
    //   Δ_12 = O × ((1 + i)^12 − 1) = 100,000 × 0.030755157 = 3,075.5157
    // Total payments are identical in both runs, so the interest saved IS that balance gap.
    const monthlyRate = monthlyInflation(3);
    const run = (offsetBalance: number) => {
      const asset = financedWithOffset('savings-1');
      let interestTotal = 0;
      for (let month = 0; month < 12; month++) {
        const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyRate, offsetBalance);
        interestTotal += interest;
        asset.applyLoanPayment(monthlyPaymentDue, interest);
        asset.applyMonthlyInflation(monthlyRate);
      }

      return { interestTotal, balance: asset.getLoanBalance() };
    };

    const without = run(0);
    const withOffset = run(100000);

    const expectedGap = 100000 * (Math.pow(1 + monthlyRealRate(6, 3), 12) - 1);
    expect(expectedGap).toBeCloseTo(3075.5157, 3);
    expect(without.interestTotal - withOffset.interestTotal).toBeCloseTo(expectedGap, 6);
    expect(without.balance - withOffset.balance).toBeCloseTo(expectedGap, 6);
  });

  it('charges the whole principal when no offset account is named', () => {
    expect(financedWithOffset(undefined).getOffsetAccountId()).toBeUndefined();
    expect(financedWithOffset(undefined).getMonthlyPaymentInfo(monthlyInflation(3), 0).interest).toBeCloseTo(808.7989, 3);
  });

  it('is routed from the named account by the processor', () => {
    // The processor asks the caller for the named account's balance; the plan never passes the
    // number, so an id that names nothing behaves like no offset (the portfolio answers 0).
    const assets = new PhysicalAssets(
      [
        createFinancedAssetInput({
          id: 'house',
          purchasePrice: 400000,
          paymentMethod: {
            type: 'loan',
            downPayment: 80000,
            loanBalance: 320000,
            apr: 6,
            monthlyPayment: 1918.56,
            offsetAccountId: 'savings-1',
          },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );
    const processor = new PhysicalAssetsProcessor(createSimulationState(), assets);

    const seen: string[] = [];
    const data = processor.process(monthlyInflation(3), (accountId) => {
      seen.push(accountId);
      return 0;
    });

    // The named account was consulted, and the portfolio answered 0 (no such account here), so the
    // interest is the whole-principal interest — an id that names nothing is not an error.
    expect(seen).toStrictEqual(['savings-1']);
    expect(data.perAssetData['house'].interest).toBeCloseTo(808.7989, 3);
  });
});
