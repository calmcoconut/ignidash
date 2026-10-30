/**
 * Payroll taxes: FICA, the Additional Medicare Tax, California SDI and self-employment tax.
 *
 * This module is the tax layer's home for payroll maths. Before it existed `incomes.ts` computed
 * `income * 0.0765` inline — a flat 7.65% with no wage base, no Additional Medicare Tax, no
 * self-employment tax and no state payroll line. Every amount here comes from the ruleset for the
 * tax year being settled (`getRules(taxYear)` for the federal tables, `getCaliforniaSdi(taxYear)`
 * for SDI), never from a module-level constant.
 *
 * ## What is computed where
 *
 * - **Wages** are taxed per pay period, because that is how payroll works: the OASDI share stops
 *   at the annual wage base, the Additional Medicare Tax starts at the filing-status threshold,
 *   and SDI applies to every dollar. `PayrollTaxProcessor` holds the year-to-date wages and
 *   returns each month's incremental deduction, so the twelve monthly amounts always add up to
 *   exactly the annual figure `computeWagePayrollTaxes()` returns for the same total.
 * - **Self-employment income** is taxed annually, on the year's net earnings, because the 92.35%
 *   base, the wage-base remainder and the half deduction are all year-level facts.
 *
 * Neither PAYROLL figure is a *liability* the year-end settlement collects: the wage taxes have
 * already been withheld from the paycheque, and the engine credits them against the annual
 * liability (`TaxesData.totalTaxLiability`) instead of withdrawing them a second time. The
 * self-employment tax is the exception — nothing withholds it, so it is settled with the return.
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { getRules, LATEST_TAX_YEAR } from './tax-data';
import { getCaliforniaSdi } from './tax-data/california-sdi';
import type { TaxYear } from './tax-data/types';

/** One year of payroll tax withheld from wages, split by line. */
export interface WagePayrollTaxes {
  /** Employee OASDI share (6.2%), capped at the annual wage base. */
  socialSecurity: number;
  /** Employee Hospital Insurance share (1.45%), uncapped. */
  medicare: number;
  /** Additional Medicare Tax (0.9%) on wages above the filing-status threshold. */
  additionalMedicare: number;
  /** California SDI, uncapped since 2024. A state payroll line, not FICA. */
  stateDisability: number;
  /** Sum of the four lines above. */
  total: number;
}

/** One year of self-employment tax, with the base and the deduction that comes with it. */
export interface SelfEmploymentTaxes {
  /** Net self-employment earnings, i.e. gross receipts less business expenses. */
  netEarnings: number;
  /** The 92.35% base the tax is actually charged on (IRC §1402(a)(12)). */
  taxableEarnings: number;
  /** 12.4%, on the lesser of the base and what is left of the OASDI wage base after wages. */
  socialSecurity: number;
  /** 2.9%, uncapped. */
  medicare: number;
  /** 0.9% on the self-employment share of compensation above the filing-status threshold. */
  additionalMedicare: number;
  /** Sum of the three lines above. */
  total: number;
  /** Half the tax, deductible above the line (IRC §164(f)). Reduces income tax, not SE tax. */
  halfDeduction: number;
}

/** The payroll-tax group of `TaxesData`: FICA + SDI on wages, plus self-employment tax. */
export interface FicaTaxesData {
  wages: WagePayrollTaxes;
  selfEmployment: SelfEmploymentTaxes;
  /** `wages.total + selfEmployment.total`. */
  total: number;
}

/** A zeroed wage-payroll line, for a year with no wages. */
export function zeroWagePayrollTaxes(): WagePayrollTaxes {
  return { socialSecurity: 0, medicare: 0, additionalMedicare: 0, stateDisability: 0, total: 0 };
}

/** A zeroed self-employment-tax line, for a year with no self-employment income. */
export function zeroSelfEmploymentTaxes(): SelfEmploymentTaxes {
  return {
    netEarnings: 0,
    taxableEarnings: 0,
    socialSecurity: 0,
    medicare: 0,
    additionalMedicare: 0,
    total: 0,
    halfDeduction: 0,
  };
}

function wagePayrollTaxesFromCumulativeWages(wages: number, filingStatus: FilingStatus, taxYear: TaxYear): WagePayrollTaxes {
  const { socialSecurityWageBase, payrollTaxRates, additionalMedicareThreshold } = getRules(taxYear).tables;
  const rates = payrollTaxRates.values;

  // OASDI stops at the wage base; Medicare does not; SDI has had no cap since 2024.
  const socialSecurity = Math.min(wages, socialSecurityWageBase.values) * rates.socialSecurity;
  const medicare = wages * rates.medicare;
  const additionalMedicare = Math.max(0, wages - additionalMedicareThreshold.values[filingStatus]) * rates.additionalMedicare;

  const sdi = getCaliforniaSdi(taxYear).values;
  const sdiBase = sdi.wageCap === null ? wages : Math.min(wages, sdi.wageCap);
  const stateDisability = sdiBase * sdi.rate;

  return {
    socialSecurity,
    medicare,
    additionalMedicare,
    stateDisability,
    total: socialSecurity + medicare + additionalMedicare + stateDisability,
  };
}

function subtractWagePayrollTaxes(after: WagePayrollTaxes, before: WagePayrollTaxes): WagePayrollTaxes {
  return {
    socialSecurity: after.socialSecurity - before.socialSecurity,
    medicare: after.medicare - before.medicare,
    additionalMedicare: after.additionalMedicare - before.additionalMedicare,
    stateDisability: after.stateDisability - before.stateDisability,
    total: after.total - before.total,
  };
}

/**
 * Payroll tax on a whole year of wages, as a function of the total.
 *
 * Hand check (2026, single, $200,000 of wages):
 *   OASDI   = min(200,000, 184,500) × 6.2%              = $11,439.00
 *   Medicare= 200,000 × 1.45%                           = $2,900.00
 *   Addl.   = (200,000 − 200,000) × 0.9%                = $0.00
 *   SDI     = 200,000 × 1.3%                            = $2,600.00
 *   total                                               = $16,939.00
 */
export function computeWagePayrollTaxes({
  wages,
  filingStatus,
  taxYear,
}: {
  wages: number;
  filingStatus: FilingStatus;
  taxYear: TaxYear;
}): WagePayrollTaxes {
  return wagePayrollTaxesFromCumulativeWages(Math.max(0, wages), filingStatus, taxYear);
}

/**
 * California SDI on a year of wages. Exposed separately because it is a state payroll line and
 * P3-P8's residency flag will decide whether it applies at all.
 *
 * Hand check (2026): $110,000 × 1.3% = $1,430.00, with no cap — a $500,000 wage pays $6,500.00.
 */
export function computeCaliforniaSdi({ wages, taxYear }: { wages: number; taxYear: TaxYear }): number {
  const { rate, wageCap } = getCaliforniaSdi(taxYear).values;
  const base = wageCap === null ? wages : Math.min(wages, wageCap);
  return Math.max(0, base) * rate;
}

/**
 * Self-employment tax for a year (Schedule SE, short form).
 *
 * Hand check (2026, single, $100,000 of net self-employment earnings, no wages):
 *   base            = 100,000 × 92.35%                  = $92,350.00
 *   Social Security = 92,350 × 12.4% (below the 184,500 wage base) = $11,451.40
 *   Medicare        = 92,350 × 2.9%                     = $2,678.15
 *   Additional      = compensation 92,350 is below $200,000                  = $0.00
 *   total           = $14,129.55, of which half ($7,064.775) is deductible above the line.
 *
 * The Social Security base is shared with wages: with $180,000 of wages and $50,000 of net SE
 * earnings, only $4,500 of the base is left, so the SE OASDI share is 4,500 × 12.4% = $558.00.
 */
export function computeSelfEmploymentTaxes({
  netEarnings,
  wages,
  filingStatus,
  taxYear,
}: {
  netEarnings: number;
  wages: number;
  filingStatus: FilingStatus;
  taxYear: TaxYear;
}): SelfEmploymentTaxes {
  const { socialSecurityWageBase, payrollTaxRates, additionalMedicareThreshold } = getRules(taxYear).tables;
  const rates = payrollTaxRates.values;

  const earnings = Math.max(0, netEarnings);
  if (earnings === 0) return zeroSelfEmploymentTaxes();

  const taxableEarnings = earnings * rates.selfEmploymentTaxablePercentage;
  const remainingWageBase = Math.max(0, socialSecurityWageBase.values - Math.max(0, wages));

  const socialSecurity = Math.min(taxableEarnings, remainingWageBase) * rates.selfEmploymentSocialSecurity;
  const medicare = taxableEarnings * rates.selfEmploymentMedicare;

  // The 0.9% threshold applies to wages and self-employment compensation together. Wages are
  // withheld first (the payroll processor charges them month by month), so the SE line carries
  // whatever part of the excess the wages did not already cover.
  const threshold = additionalMedicareThreshold.values[filingStatus];
  const wageExcess = Math.max(0, Math.max(0, wages) - threshold);
  const totalExcess = Math.max(0, Math.max(0, wages) + taxableEarnings - threshold);
  const additionalMedicare = Math.max(0, totalExcess - wageExcess) * rates.additionalMedicare;

  const total = socialSecurity + medicare + additionalMedicare;

  return {
    netEarnings: earnings,
    taxableEarnings,
    socialSecurity,
    medicare,
    additionalMedicare,
    total,
    halfDeduction: total * rates.selfEmploymentDeduction,
  };
}

/**
 * Year-to-date payroll withholding for wages.
 *
 * Each month's deduction is the difference between the cumulative tax on the year's wages so far
 * and the cumulative tax at the end of the previous month. That is exactly how payroll works at a
 * wage-base or threshold boundary (a December bonus can be taxed at 0% OASDI because January's
 * paycheques already filled the base), and it makes the annual total independent of how the year's
 * wages are spread across months.
 *
 * ## Which year it withholds under
 *
 * The engine drives this processor with the **settlement year of the period being accumulated**, not
 * the year the run starts in, and calls `startNewYear` with the next period's settlement year. A
 * settlement therefore prices its payroll and its income tax from the same year's tables: the two
 * cannot disagree, which they did before the alignment fix (the first settlement withheld 2026's
 * SDI rate while its income tax already resolved 2027's).
 */
export class PayrollTaxProcessor {
  private taxYear: TaxYear;
  private filingStatus: FilingStatus;
  private yearToDateWages = 0;
  private yearToDateTaxes = zeroWagePayrollTaxes();
  private annualData = zeroWagePayrollTaxes();

  constructor(taxYear: TaxYear = LATEST_TAX_YEAR, filingStatus: FilingStatus = 'single') {
    this.taxYear = taxYear;
    this.filingStatus = filingStatus;
  }

  /**
   * Points the processor at a new tax year and resets the year-to-date wage base. The engine passes
   * the *next* settlement period's year, so the period that follows withholds under the same year
   * it will be settled under.
   */
  startNewYear(taxYear: TaxYear): void {
    this.taxYear = taxYear;
    this.yearToDateWages = 0;
    this.yearToDateTaxes = zeroWagePayrollTaxes();
    this.annualData = zeroWagePayrollTaxes();
  }

  /** The tax year currently being withheld under. */
  getTaxYear(): TaxYear {
    return this.taxYear;
  }

  /** Total wages seen so far this year; the form 941 picture. */
  getYearToDateWages(): number {
    return this.yearToDateWages;
  }

  /**
   * Withholds payroll tax on one pay period's wages and accumulates the year.
   *
   * @returns this period's deduction, split by line.
   */
  processMonthlyWages(wages: number): WagePayrollTaxes {
    const periodWages = Math.max(0, wages);
    if (periodWages === 0) return zeroWagePayrollTaxes();

    this.yearToDateWages += periodWages;
    const cumulative = wagePayrollTaxesFromCumulativeWages(this.yearToDateWages, this.filingStatus, this.taxYear);
    const periodTaxes = subtractWagePayrollTaxes(cumulative, this.yearToDateTaxes);
    this.yearToDateTaxes = cumulative;

    this.annualData = {
      socialSecurity: this.annualData.socialSecurity + periodTaxes.socialSecurity,
      medicare: this.annualData.medicare + periodTaxes.medicare,
      additionalMedicare: this.annualData.additionalMedicare + periodTaxes.additionalMedicare,
      stateDisability: this.annualData.stateDisability + periodTaxes.stateDisability,
      total: this.annualData.total + periodTaxes.total,
    };

    return periodTaxes;
  }

  /** Payroll tax withheld so far this year, split by line. */
  getAnnualData(): WagePayrollTaxes {
    return { ...this.annualData };
  }
}
