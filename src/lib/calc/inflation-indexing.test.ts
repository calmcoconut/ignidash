/**
 * What deflating the statute-locked thresholds changes in the engine (parity plan R2).
 *
 * `tax-data/real-dollars.test.ts` pins the mechanism. This file pins the consequence, because the
 * bug was not that a helper was missing — it was that the engine read a nominal threshold as though
 * it kept its purchasing power. Each test therefore asserts an *absolute* figure the return
 * produces, and each one goes red if the accessor is bypassed.
 *
 * The hand-worked case throughout: 3% inflation, a settle 31 years after the 2026 ruleset.
 * `1.03^31 ≈ 2.5001`, so a $25,000 nominal amount is worth about $10,000 today.
 */

import { describe, expect, it } from 'vitest';

import { computeWagePayrollTaxes } from './payroll-taxes';
import { Portfolio } from './portfolio';
import { analyzeTaxYear } from './tax-analytics';
import { getRules } from './tax-data';
import { tableValuesInRealDollars } from './tax-data/real-dollars';
import { CALIFORNIA_2025 } from './tax-data/states/CA/2025';
import type { TableMeta } from './tax-data/types';
import { FEDERAL_2026 } from './tax-data/years/2026';
import { TaxProcessor } from './taxes';
import type { SimulationState } from './simulation-engine';
import { cumulativeInflationIndex } from './time-binding';
import {
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createEmptyPortfolioData,
  createEmptyReturnsData,
} from './__tests__/test-utils';

const RULESET_YEAR = 2026;
const SIM_YEAR = 2057;
const INFLATION_PERCENT = 3;

/** The divisor the engine uses for a fixed 2026 amount settled in 2057 — contract 3.1's index. */
const DEFLATOR = cumulativeInflationIndex({ inflationRate: INFLATION_PERCENT }, SIM_YEAR - RULESET_YEAR);

/** A retired 60-year-old with an empty portfolio: the same minimal state `taxes.test.ts` uses. */
const createState = (): SimulationState => ({
  time: { date: new Date(2025, 0, 1), age: 60, year: 2025, month: 1 },
  portfolio: new Portfolio([]),
  phase: { name: 'retirement' },
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

const processYear = ({ taxYear, inflationRatePercent }: { taxYear: number; inflationRatePercent: number }) =>
  new TaxProcessor(createState(), 'single', taxYear, undefined, { inflationRatePercent });

describe('statute-locked thresholds are deflated to today’s dollars', () => {
  describe('the guard on the data', () => {
    it('every `fixed` table in every ruleset declares dollarFields, and every path resolves', () => {
      const rulesets = [FEDERAL_2026, CALIFORNIA_2025];

      for (const ruleset of rulesets) {
        const tables = ruleset.tables as unknown as Record<string, TableMeta<unknown>>;
        for (const [name, table] of Object.entries(tables)) {
          if (table.indexing !== 'fixed') continue;

          expect(
            table.dollarFields,
            `${ruleset.jurisdiction} ${ruleset.year} table "${name}" is fixed and must declare dollarFields`
          ).toBeDefined();
          // A typo'd path would throw here rather than silently deflating nothing in production.
          expect(() =>
            tableValuesInRealDollars(table, {
              rulesetYear: ruleset.year,
              simYear: ruleset.year + 1,
              cumulativeInflationIndex: (years) => Math.pow(1.03, years),
            })
          ).not.toThrow();
        }
      }
    });
  });

  describe('the NIIT threshold (§1411, fixed since 2013)', () => {
    it('is $200,000 / 1.03^31 for a single filer 31 years out, to the cent', () => {
      const { niit } = processYear({ taxYear: SIM_YEAR, inflationRatePercent: INFLATION_PERCENT }).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData(),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(niit.threshold).toBeCloseTo(200000 / DEFLATOR, 6);
      // And it is emphatically not the nominal amount.
      expect(niit.threshold).toBeLessThan(100000);
    });

    it('is unchanged in the ruleset year, so the first settlement is unaffected', () => {
      const { niit } = processYear({ taxYear: RULESET_YEAR, inflationRatePercent: INFLATION_PERCENT }).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData(),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      expect(niit.threshold).toBe(200000);
    });
  });

  describe('the §86 base amounts (fixed by statute)', () => {
    /**
     * $20,000 of benefits and $5,000 of other income: provisional income = 15,000.
     *
     * In 2026 that lands below the $25,000 base amount, so nothing is taxable. In 2057 the base is
     * ~$10,000 and the adjusted base ~$13,600, so the same provisional income is in the 85% band.
     * That difference is the bug R2 closes, and it is observable only if the table is deflated.
     */
    const benefits = 20000;
    const otherIncome = 5000;
    const provisionalIncome = otherIncome + benefits * 0.5;

    const taxableIn = (taxYear: number, inflationRatePercent: number): number => {
      const incomes = createEmptyIncomesData();
      incomes.totalSocialSecurityIncome = benefits;
      incomes.totalIncome = benefits + otherIncome;

      return processYear({ taxYear, inflationRatePercent }).process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      ).socialSecurityTaxes.taxableSocialSecurityIncome;
    };

    it('reports nothing taxable in the ruleset year, where provisional income is below $25,000', () => {
      expect(taxableIn(RULESET_YEAR, INFLATION_PERCENT)).toBe(0);
    });

    it('reports the 85%-band amount 31 years out, against the deflated tiers', () => {
      const base = 25000 / DEFLATOR;
      const adjustedBase = 34000 / DEFLATOR;
      // The general three-tier walk: 50% of the band width (capped at 50% of benefits), plus 85% of
      // provisional income above the adjusted base, capped at 85% of the benefits.
      const tierOne = Math.min((adjustedBase - base) * 0.5, benefits * 0.5);
      const expected = Math.min(tierOne + (provisionalIncome - adjustedBase) * 0.85, benefits * 0.85);

      expect(provisionalIncome).toBeGreaterThan(adjustedBase);
      expect(taxableIn(SIM_YEAR, INFLATION_PERCENT)).toBeCloseTo(expected, 6);
      // The pin has teeth: the nominal reading would still report zero here.
      expect(taxableIn(SIM_YEAR, 0)).toBe(0);
    });
  });

  describe('the Additional Medicare threshold (§3101(b)(2), fixed since 2013)', () => {
    it('charges the 0.9% on wages above the deflated threshold 31 years out', () => {
      const wages = 100000;
      const threshold = 200000 / DEFLATOR;

      const late = computeWagePayrollTaxes({
        wages,
        filingStatus: 'single',
        taxYear: SIM_YEAR,
        inflationRatePercent: INFLATION_PERCENT,
      });
      const early = computeWagePayrollTaxes({ wages, filingStatus: 'single', taxYear: RULESET_YEAR });

      expect(late.additionalMedicare).toBeCloseTo((wages - threshold) * 0.009, 6);
      expect(late.additionalMedicare).toBeGreaterThan(0);
      // The same wages, priced by the pre-R2 reading, pay nothing: this is the defect.
      expect(early.additionalMedicare).toBe(0);
    });
  });

  describe('an indexed table is not deflated', () => {
    it('keeps the federal bracket breakpoints where the 2026 ruleset puts them, 31 years out', () => {
      const taxes = processYear({ taxYear: SIM_YEAR, inflationRatePercent: INFLATION_PERCENT }).process(
        createEmptyPortfolioData(),
        createEmptyIncomesData(),
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      const analytics = analyzeTaxYear({
        taxYear: SIM_YEAR,
        filingStatus: 'single',
        taxes,
        earnedIncome: { wages: 0, selfEmployment: 0 },
        inflationRatePercent: INFLATION_PERCENT,
      });

      const secondBracket = analytics.bracketFill.ordinary.brackets[1];
      expect(secondBracket.min).toBe(12400);
      expect(analytics.bracketFill.ordinary.brackets[2].min).toBe(50400);
    });
  });

  describe('the analytics agree with the engine', () => {
    it('measures NIIT headroom against the deflated threshold, not the nominal one', () => {
      const incomes = createEmptyIncomesData();
      incomes.totalIncome = 120000;

      const taxes = processYear({ taxYear: SIM_YEAR, inflationRatePercent: INFLATION_PERCENT }).process(
        createEmptyPortfolioData(),
        incomes,
        createEmptyReturnsData(),
        createEmptyPhysicalAssetsData()
      );

      const analytics = analyzeTaxYear({
        taxYear: SIM_YEAR,
        filingStatus: 'single',
        taxes,
        earnedIncome: { wages: 0, selfEmployment: 0 },
        inflationRatePercent: INFLATION_PERCENT,
      });

      // The engine's own threshold and the analytics' are the same number, and headroom is measured
      // from it — a nominal threshold here would report a large headroom the return does not have.
      expect(analytics.cliffs.niit.threshold).toBe(taxes.niit.threshold);
      expect(analytics.cliffs.niit.headroom).toBeCloseTo(Math.max(0, taxes.niit.threshold - taxes.incomeSources.adjustedGrossIncome), 6);
      expect(analytics.cliffs.additionalMedicare.threshold).toBeCloseTo(200000 / DEFLATOR, 6);
    });
  });

  describe('the California Behavioral Health Services Tax threshold (fixed by statute)', () => {
    it('deflates from the ruleset that states it — 2025 — while leaving the 1% rate alone', () => {
      const rules = getRules(SIM_YEAR, 'CA');
      expect(rules.year).toBe(2025);

      const scaled = tableValuesInRealDollars(rules.tables.behavioralHealthServicesTax, {
        rulesetYear: rules.year,
        simYear: SIM_YEAR,
        cumulativeInflationIndex: (years) => cumulativeInflationIndex({ inflationRate: INFLATION_PERCENT }, years),
      });

      // One more year of erosion than the federal tables: the 2025 amount has been unadjusted since
      // 2025, so a 2057 return reads it deflated by 1.03^32 rather than 1.03^31.
      const californiaDeflator = cumulativeInflationIndex({ inflationRate: INFLATION_PERCENT }, SIM_YEAR - rules.year);

      expect(scaled.rate).toBe(0.01);
      expect(scaled.threshold.single).toBeCloseTo(1000000 / californiaDeflator, 6);
      expect(scaled.threshold.marriedFilingSeparately).toBeCloseTo(500000 / californiaDeflator, 6);
    });
  });
});
