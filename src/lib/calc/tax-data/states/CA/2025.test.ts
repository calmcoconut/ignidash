/**
 * The California ruleset (P3-P8), pinned to the FTB publications it was transcribed from.
 *
 * Every expected value here is a number printed on the 2025 Form 540, Schedule CA (540) or the
 * 2025 Tax Rate Schedules — see the file header of `2025.ts` for the citations. The test's job is to
 * catch a transcription slip and to pin the *fallback*: 2025 is the latest year the FTB has
 * published, so a 2026 (or later) return resolves it and reports 2025 back.
 */

import { describe, it, expect } from 'vitest';

import { getRules } from '../../index';
import { CALIFORNIA_2025 } from './2025';

describe('the California 2025 ruleset', () => {
  it('is filed as CA 2025, and a later year resolves it by the nearest-prior rule', () => {
    expect(CALIFORNIA_2025.jurisdiction).toBe('CA');
    expect(CALIFORNIA_2025.year).toBe(2025);

    // The FTB's rates page still says "Calculate your 2025 tax" — there is no 2026 schedule yet, so
    // a 2026 return must use this one and say so rather than inventing indexed amounts.
    expect(getRules(2026, 'CA').year).toBe(2025);
    expect(getRules(2030, 'CA').year).toBe(2025);
    expect(() => getRules(2024, 'CA')).toThrow(/No CA tax ruleset for 2024/);
  });

  it('carries every filing status California supports, including the separate return', () => {
    // Schedule X is "Single or married/RDP filing separately", so the fourth status shares the
    // single schedule rather than getting one of its own.
    const tables = CALIFORNIA_2025.tables;
    for (const status of ['single', 'marriedFilingJointly', 'headOfHousehold', 'marriedFilingSeparately'] as const) {
      expect(tables.incomeTaxBrackets.values[status].length).toBeGreaterThan(0);
      expect(tables.standardDeduction.values[status]).toBeGreaterThan(0);
    }

    expect(tables.incomeTaxBrackets.values.marriedFilingSeparately).toBe(tables.incomeTaxBrackets.values.single);
  });

  it('transcribes Schedule X, Y and Z exactly at their bracket boundaries', () => {
    // The FTB prints each schedule as "amount over → tax at that amount + rate × excess". The
    // bracket boundaries below are those printed amounts; a transposed digit fails here.
    const single = CALIFORNIA_2025.tables.incomeTaxBrackets.values.single;
    expect(single.map((bracket) => bracket.min)).toEqual([0, 11079, 26264, 41452, 57542, 72724, 371479, 445771, 742953]);
    expect(single.map((bracket) => bracket.rate)).toEqual([0.01, 0.02, 0.04, 0.06, 0.08, 0.093, 0.103, 0.113, 0.123]);
    expect(single.at(-1)?.max).toBe(Infinity);

    const married = CALIFORNIA_2025.tables.incomeTaxBrackets.values.marriedFilingJointly;
    expect(married.map((bracket) => bracket.min)).toEqual([0, 22158, 52528, 82904, 115084, 145448, 742958, 891542, 1485906]);

    const headOfHousehold = CALIFORNIA_2025.tables.incomeTaxBrackets.values.headOfHousehold;
    expect(headOfHousehold.map((bracket) => bracket.min)).toEqual([0, 22173, 52530, 67716, 83805, 98990, 505208, 606251, 1010417]);
  });

  it('carries the 2025 standard deduction and personal exemption credit', () => {
    // 2025 Form 540, line 18: $5,706 single/MFS, $11,412 MFJ/HOH/QSS.
    expect(CALIFORNIA_2025.tables.standardDeduction.values).toEqual({
      single: 5706,
      marriedFilingJointly: 11412,
      headOfHousehold: 11412,
      marriedFilingSeparately: 5706,
    });
    // 2025 Form 540, line 7 and the line 32 AGI Limitation Worksheet. The step is $1,250 on a
    // separate return, which is what makes the credit run out at the same AGI as a single filer's.
    expect(CALIFORNIA_2025.tables.personalExemptionCredit.values).toMatchObject({
      perTaxpayer: 153,
      dependent: 475,
      agiLimit: { single: 252203, marriedFilingJointly: 504411, headOfHousehold: 378310, marriedFilingSeparately: 252203 },
      reductionStep: { single: 2500, marriedFilingJointly: 2500, headOfHousehold: 2500, marriedFilingSeparately: 1250 },
      reductionPerStep: 6,
    });
  });

  it('carries the itemized-deduction limitation and the lines California disallows', () => {
    // 2025 Schedule CA (540), Part II, line 29: same AGI thresholds, 6%, capped at 80%.
    expect(CALIFORNIA_2025.tables.itemizedDeductionLimit.values).toMatchObject({
      agiThreshold: { single: 252203, marriedFilingJointly: 504411, headOfHousehold: 378310, marriedFilingSeparately: 252203 },
      rate: 0.06,
      maxReductionShare: 0.8,
    });
    // Line 5a: no deduction for state and local income tax, SDI or general sales tax. Property tax
    // is deliberately absent from the list.
    expect(CALIFORNIA_2025.tables.itemizedDeductionLimit.values.disallowed).toEqual([
      'stateIncomeTax',
      'stateDisabilityInsurance',
      'generalSalesTax',
    ]);
  });

  it('carries the Behavioral Health Services Tax at 1% over $1,000,000 for every status, and $500,000 on a separate return', () => {
    // 2025 Form 540, line 62 worksheet: 1% of the amount over $1,000,000 (R&TC §17043), and
    // §17043(a) halves the threshold for a separate return.
    expect(CALIFORNIA_2025.tables.behavioralHealthServicesTax.values.rate).toBe(0.01);
    expect(CALIFORNIA_2025.tables.behavioralHealthServicesTax.values.threshold).toEqual({
      single: 1000000,
      marriedFilingJointly: 1000000,
      headOfHousehold: 1000000,
      marriedFilingSeparately: 500000,
    });
    expect(CALIFORNIA_2025.tables.behavioralHealthServicesTax.indexing).toBe('fixed');
  });

  it('declares the conformity flags as flags, not prose', () => {
    expect(CALIFORNIA_2025.tables.conformity.values).toEqual({
      preferentialCapitalGains: false,
      taxesSocialSecurity: false,
      allowsFederalSeniorDeduction: false,
      allowsStateIncomeTaxDeduction: false,
      medicalExpenseFloor: 0.075,
    });
  });

  it('marks the indexed tables indexed and the statutory ones fixed', () => {
    // Brackets, standard deduction and the credit/limitation thresholds are re-issued every year.
    expect(CALIFORNIA_2025.tables.incomeTaxBrackets.indexing).toBe('indexed');
    expect(CALIFORNIA_2025.tables.standardDeduction.indexing).toBe('indexed');
    expect(CALIFORNIA_2025.tables.personalExemptionCredit.indexing).toBe('indexed');
    expect(CALIFORNIA_2025.tables.itemizedDeductionLimit.indexing).toBe('indexed');
    // The 1% surcharge and the conformity flags are statutory.
    expect(CALIFORNIA_2025.tables.behavioralHealthServicesTax.indexing).toBe('fixed');
    expect(CALIFORNIA_2025.tables.conformity.indexing).toBe('fixed');
  });
});
