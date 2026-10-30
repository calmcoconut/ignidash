import { describe, it, expect } from 'vitest';

import { Portfolio } from './portfolio';
import { TaxProcessor } from './taxes';
import { getRules, LATEST_TAX_YEAR } from './tax-data';
import type { FederalTaxRuleset, SocialSecurityTaxThreshold } from './tax-data/types';
import type { SimulationState } from './simulation-engine';
import {
  createEmptyPortfolioData,
  createEmptyIncomesData,
  createEmptyReturnsData,
  createEmptyPhysicalAssetsData,
} from './__tests__/test-utils';

const createMockSimulationState = (age: number): SimulationState => ({
  time: { date: new Date(2026, 0, 1), age, year: 2026, month: 1 },
  portfolio: new Portfolio([]),
  phase: { name: 'retirement' },
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

/** $20,000 of benefits plus $23,000 of other income → provisional income of $33,000 (single). */
const SOCIAL_SECURITY_BENEFITS = 20000;
const OTHER_INCOME = 23000;

const createIncomes = () =>
  createEmptyIncomesData({
    totalIncome: OTHER_INCOME + SOCIAL_SECURITY_BENEFITS,
    totalSocialSecurityIncome: SOCIAL_SECURITY_BENEFITS,
  });

const process = (processor: TaxProcessor) =>
  processor.process(createEmptyPortfolioData(), createIncomes(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());

/** A copy of the 2026 ruleset whose §86 tiers all use `taxablePercentage`. */
function withSocialSecurityPercentage(taxablePercentage: number): FederalTaxRuleset {
  const base = getRules(2026);
  const tiers = (values: SocialSecurityTaxThreshold[]) => values.map((tier) => ({ ...tier, taxablePercentage }));

  return {
    ...base,
    tables: {
      ...base.tables,
      socialSecurityTaxation: {
        ...base.tables.socialSecurityTaxation,
        values: {
          single: tiers(base.tables.socialSecurityTaxation.values.single),
          marriedFilingJointly: tiers(base.tables.socialSecurityTaxation.values.marriedFilingJointly),
          headOfHousehold: tiers(base.tables.socialSecurityTaxation.values.headOfHousehold),
        },
      },
    },
  };
}

describe('TaxProcessor — tax year and ruleset', () => {
  it('settles the year it is given', () => {
    const processor = new TaxProcessor(createMockSimulationState(65), 'single', 2026);
    const taxes = process(processor);

    // Provisional income 33,000 lands in the single 50% tier: min((33,000 - 25,000) × 50%, 20,000 × 50%).
    expect(taxes.socialSecurityTaxes.provisionalIncome).toBe(33000);
    expect(taxes.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(4000);
    expect(taxes.socialSecurityTaxes.maxTaxablePercentage).toBe(0.5);
  });

  it('resolves a later year to the nearest prior ruleset', () => {
    const processor = new TaxProcessor(createMockSimulationState(65), 'single', 2051);

    expect(process(processor).federalIncomeTaxes.federalIncomeTaxAmount).toBe(
      process(new TaxProcessor(createMockSimulationState(65), 'single', 2026)).federalIncomeTaxes.federalIncomeTaxAmount
    );
  });

  it('throws for a year with no ruleset at or before it', () => {
    expect(() => new TaxProcessor(createMockSimulationState(65), 'single', 2025)).toThrow(
      /No federal tax ruleset for 2025 or any earlier year/
    );
  });

  it('re-resolves the ruleset when the year advances', () => {
    const processor = new TaxProcessor(createMockSimulationState(65), 'single', 2026);
    const firstYear = process(processor);

    processor.setTaxYear(LATEST_TAX_YEAR + 5);
    expect(process(processor).federalIncomeTaxes.federalIncomeTaxAmount).toBe(firstYear.federalIncomeTaxes.federalIncomeTaxAmount);

    expect(() => processor.setTaxYear(2025)).toThrow(/No federal tax ruleset for 2025/);
  });

  it('reads the §86 tier percentages from the dataset instead of hard-coded values', () => {
    const state = createMockSimulationState(65);

    const currentLaw = process(new TaxProcessor(state, 'single', 2026));
    const atEightyFive = process(new TaxProcessor(state, 'single', 2026, withSocialSecurityPercentage(0.85)));
    const fullyExempt = process(new TaxProcessor(state, 'single', 2026, withSocialSecurityPercentage(0)));

    // Worked example (single, $20,000 benefits, $33,000 provisional income):
    //   50% tier:  min((33,000 − 25,000) × 0.50, 20,000 × 0.50) = min(4,000, 10,000) = $4,000 taxable
    //   85% tier:  min((33,000 − 25,000) × 0.85, 20,000 × 0.85) = min(6,800, 17,000) = $6,800 taxable
    //   exempt:    $0 taxable
    expect(currentLaw.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(4000);
    expect(atEightyFive.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(6800);
    expect(fullyExempt.socialSecurityTaxes.taxableSocialSecurityIncome).toBe(0);

    expect(atEightyFive.socialSecurityTaxes.maxTaxablePercentage).toBe(0.85);
    expect(atEightyFive.incomeSources.taxableSocialSecurityIncome).toBe(6800);
    expect(atEightyFive.federalIncomeTaxes.federalIncomeTaxAmount).toBeGreaterThan(currentLaw.federalIncomeTaxes.federalIncomeTaxAmount);
  });

  it('reads the standard deduction from the ruleset instead of a module-level constant', () => {
    const base = getRules(2026);
    const noDeduction: FederalTaxRuleset = {
      ...base,
      tables: {
        ...base.tables,
        standardDeduction: { ...base.tables.standardDeduction, values: { ...base.tables.standardDeduction.values, single: 0 } },
      },
    };

    const taxes = process(new TaxProcessor(createMockSimulationState(65), 'single', 2026, noDeduction));

    // 23,000 other income + 4,000 taxable benefits = 27,000, undeducted.
    expect(taxes.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(27000);
    expect(taxes.deductions.standardDeduction).toBe(0);
  });
});
