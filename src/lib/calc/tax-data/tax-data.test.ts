import { describe, it, expect } from 'vitest';

import { FEDERAL_2026 } from './years/2026';

/**
 * The 2026 ruleset's tables, read directly (R2).
 *
 * These used to be six one-table modules under `tax-data/`, each a module-level `const` resolved
 * from `getRules(2026)`. `years/2026.ts` announced they would go once the tests asserted against
 * the ruleset; R2 is that point. Keeping them was a trap: a bare constant cannot distinguish an
 * `indexed` table from a statute-`fixed` one, so it silently encodes "no inflation" — and these
 * are assertions about the *nominal* 2026 data, which is exactly what the ruleset holds.
 */
const TABLES = FEDERAL_2026.tables;

const FEDERAL_INCOME_TAX_BRACKETS_SINGLE = TABLES.incomeTaxBrackets.values.single;
const FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY = TABLES.incomeTaxBrackets.values.marriedFilingJointly;
const FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD = TABLES.incomeTaxBrackets.values.headOfHousehold;

const CAPITAL_GAINS_TAX_BRACKETS_SINGLE = TABLES.capitalGainsTaxBrackets.values.single;
const CAPITAL_GAINS_TAX_BRACKETS_MARRIED_FILING_JOINTLY = TABLES.capitalGainsTaxBrackets.values.marriedFilingJointly;
const CAPITAL_GAINS_TAX_BRACKETS_HEAD_OF_HOUSEHOLD = TABLES.capitalGainsTaxBrackets.values.headOfHousehold;

const STANDARD_DEDUCTION_SINGLE = TABLES.standardDeduction.values.single;
const STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY = TABLES.standardDeduction.values.marriedFilingJointly;
const STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD = TABLES.standardDeduction.values.headOfHousehold;

const NIIT_RATE = TABLES.netInvestmentIncomeTax.values.rate;
const NIIT_THRESHOLDS = TABLES.netInvestmentIncomeTax.values.thresholds;

const SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE = TABLES.socialSecurityTaxation.values.tiers.single;
const SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY = TABLES.socialSecurityTaxation.values.tiers.marriedFilingJointly;
const SOCIAL_SECURITY_TAX_THRESHOLDS_HEAD_OF_HOUSEHOLD = TABLES.socialSecurityTaxation.values.tiers.headOfHousehold;

describe('Tax Data Validation (2026 IRS values)', () => {
  describe('income tax brackets', () => {
    it('should have correct Single 10% bracket: $0-$12,400', () => {
      expect(FEDERAL_INCOME_TAX_BRACKETS_SINGLE[0]).toEqual({ min: 0, max: 12400, rate: 0.1 });
    });

    it('should have correct MFJ 22% bracket: $100,800-$211,400', () => {
      expect(FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY[2]).toEqual({ min: 100800, max: 211400, rate: 0.22 });
    });

    it('should have correct HOH 10% bracket: $0-$17,700', () => {
      expect(FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD[0]).toEqual({ min: 0, max: 17700, rate: 0.1 });
    });

    it('should have correct HOH 24% bracket: $105,700-$201,750', () => {
      expect(FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD[3]).toEqual({ min: 105700, max: 201750, rate: 0.24 });
    });

    it.each([
      ['single', FEDERAL_INCOME_TAX_BRACKETS_SINGLE],
      ['MFJ', FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should be sorted by min ascending', (_name, brackets) => {
      for (let i = 1; i < brackets.length; i++) {
        expect(brackets[i].min).toBeGreaterThanOrEqual(brackets[i - 1].min);
      }
    });

    it.each([
      ['single', FEDERAL_INCOME_TAX_BRACKETS_SINGLE],
      ['MFJ', FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should have last bracket max as Infinity', (_name, brackets) => {
      expect(brackets[brackets.length - 1].max).toBe(Infinity);
    });

    it.each([
      ['single', FEDERAL_INCOME_TAX_BRACKETS_SINGLE],
      ['MFJ', FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should have 7 brackets', (_name, brackets) => {
      expect(brackets).toHaveLength(7);
    });

    it.each([
      ['single', FEDERAL_INCOME_TAX_BRACKETS_SINGLE],
      ['MFJ', FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should be contiguous (each bracket.max === next bracket.min)', (_name, brackets) => {
      for (let i = 0; i < brackets.length - 1; i++) {
        expect(brackets[i].max).toBe(brackets[i + 1].min);
      }
    });
  });

  describe('capital gains tax brackets', () => {
    it('should have correct Single 0% threshold: $49,450', () => {
      expect(CAPITAL_GAINS_TAX_BRACKETS_SINGLE[0]).toEqual({ min: 0, max: 49450, rate: 0.0 });
    });

    it('should have correct MFJ 0% threshold: $98,900', () => {
      expect(CAPITAL_GAINS_TAX_BRACKETS_MARRIED_FILING_JOINTLY[0]).toEqual({ min: 0, max: 98900, rate: 0.0 });
    });

    it('should have correct HOH 0% threshold: $66,200', () => {
      expect(CAPITAL_GAINS_TAX_BRACKETS_HEAD_OF_HOUSEHOLD[0]).toEqual({ min: 0, max: 66200, rate: 0.0 });
    });

    it.each([
      ['single', CAPITAL_GAINS_TAX_BRACKETS_SINGLE],
      ['MFJ', CAPITAL_GAINS_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', CAPITAL_GAINS_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should have 3 brackets with rates 0%%, 15%%, 20%%', (_name, brackets) => {
      expect(brackets).toHaveLength(3);
      expect(brackets[0].rate).toBe(0.0);
      expect(brackets[1].rate).toBe(0.15);
      expect(brackets[2].rate).toBe(0.2);
    });

    it.each([
      ['single', CAPITAL_GAINS_TAX_BRACKETS_SINGLE],
      ['MFJ', CAPITAL_GAINS_TAX_BRACKETS_MARRIED_FILING_JOINTLY],
      ['HOH', CAPITAL_GAINS_TAX_BRACKETS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s brackets should have last bracket max as Infinity', (_name, brackets) => {
      expect(brackets[brackets.length - 1].max).toBe(Infinity);
    });
  });

  describe('standard deductions', () => {
    it('should have correct values for each filing status', () => {
      expect(STANDARD_DEDUCTION_SINGLE).toBe(16100);
      expect(STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY).toBe(32200);
      expect(STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD).toBe(24150);
    });

    it('MFJ should be exactly 2x single', () => {
      expect(STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY).toBe(STANDARD_DEDUCTION_SINGLE * 2);
    });
  });

  describe('NIIT', () => {
    it('should have 3.8% rate', () => {
      expect(NIIT_RATE).toBe(0.038);
    });

    it('should have correct thresholds per filing status', () => {
      expect(NIIT_THRESHOLDS.single).toBe(200000);
      expect(NIIT_THRESHOLDS.marriedFilingJointly).toBe(250000);
      expect(NIIT_THRESHOLDS.headOfHousehold).toBe(200000);
    });
  });

  describe('Social Security tax tiers', () => {
    it('should have correct Single thresholds: $25k / $34k', () => {
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE[0]).toEqual({ min: 0, max: 25000, taxablePercentage: 0 });
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE[1]).toEqual({ min: 25000, max: 34000, taxablePercentage: 0.5 });
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE[2]).toEqual({ min: 34000, max: Infinity, taxablePercentage: 0.85 });
    });

    it('should have correct MFJ thresholds: $32k / $44k', () => {
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY[0]).toEqual({ min: 0, max: 32000, taxablePercentage: 0 });
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY[1]).toEqual({ min: 32000, max: 44000, taxablePercentage: 0.5 });
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY[2]).toEqual({
        min: 44000,
        max: Infinity,
        taxablePercentage: 0.85,
      });
    });

    it('HOH thresholds should match Single', () => {
      expect(SOCIAL_SECURITY_TAX_THRESHOLDS_HEAD_OF_HOUSEHOLD).toEqual(SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE);
    });

    it.each([
      ['single', SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE],
      ['MFJ', SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY],
      ['HOH', SOCIAL_SECURITY_TAX_THRESHOLDS_HEAD_OF_HOUSEHOLD],
    ] as const)('%s should have 3 tiers (0%%, 50%%, 85%%)', (_name, thresholds) => {
      expect(thresholds).toHaveLength(3);
      expect(thresholds[0].taxablePercentage).toBe(0);
      expect(thresholds[1].taxablePercentage).toBe(0.5);
      expect(thresholds[2].taxablePercentage).toBe(0.85);
    });
  });
});
