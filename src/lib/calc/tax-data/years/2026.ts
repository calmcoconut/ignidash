/**
 * Federal tax ruleset for tax year 2026.
 *
 * This file is the single home of every federal amount the tax processor uses. Before the
 * ruleset harness existed the six tables below were six separate modules under
 * `tax-data/`, hard-coded to 2026 and imported unqualified by every caller; those modules are
 * now thin aliases onto this ruleset (see each file) and will be removed once the test suite
 * asserts against the ruleset directly.
 *
 * Amounts: IRS 2026 inflation adjustments, including the OBBBA amendments. The NIIT (§1411),
 * Social Security base amounts (§86) and §121 exclusion are statutory and were not adjusted for
 * 2026 — they are marked `indexing: 'fixed'` for exactly that reason.
 */

import type { FederalTaxRuleset } from '../types';

export const FEDERAL_2026: FederalTaxRuleset = {
  jurisdiction: 'federal',
  year: 2026,
  source:
    'IRS 2026 inflation adjustments to the Internal Revenue Code, including the OBBBA amendments; ' +
    'NIIT, §86 base amounts and the §121 exclusion are statutory and not indexed for 2026; ' +
    'the OASDI wage base is the SSA 2026 determination (90 FR 49047, Nov 3 2025).',
  tables: {
    incomeTaxBrackets: {
      indexing: 'indexed',
      source: 'IRC §1(j); IRS 2026 inflation adjustments (including OBBBA amendments).',
      values: {
        single: [
          { min: 0, max: 12400, rate: 0.1 },
          { min: 12400, max: 50400, rate: 0.12 },
          { min: 50400, max: 105700, rate: 0.22 },
          { min: 105700, max: 201775, rate: 0.24 },
          { min: 201775, max: 256225, rate: 0.32 },
          { min: 256225, max: 640600, rate: 0.35 },
          { min: 640600, max: Infinity, rate: 0.37 },
        ],
        marriedFilingJointly: [
          { min: 0, max: 24800, rate: 0.1 },
          { min: 24800, max: 100800, rate: 0.12 },
          { min: 100800, max: 211400, rate: 0.22 },
          { min: 211400, max: 403550, rate: 0.24 },
          { min: 403550, max: 512450, rate: 0.32 },
          { min: 512450, max: 768700, rate: 0.35 },
          { min: 768700, max: Infinity, rate: 0.37 },
        ],
        headOfHousehold: [
          { min: 0, max: 17700, rate: 0.1 },
          { min: 17700, max: 67450, rate: 0.12 },
          { min: 67450, max: 105700, rate: 0.22 },
          { min: 105700, max: 201750, rate: 0.24 },
          { min: 201750, max: 256200, rate: 0.32 },
          { min: 256200, max: 640600, rate: 0.35 },
          { min: 640600, max: Infinity, rate: 0.37 },
        ],
      },
    },
    standardDeduction: {
      indexing: 'indexed',
      source: 'IRC §63(c); IRS 2026 inflation adjustments (including OBBBA amendments).',
      values: {
        single: 16100,
        marriedFilingJointly: 32200,
        headOfHousehold: 24150,
      },
    },
    capitalGainsTaxBrackets: {
      indexing: 'indexed',
      source: 'IRC §1(h); IRS 2026 inflation adjustments (including OBBBA amendments).',
      values: {
        single: [
          { min: 0, max: 49450, rate: 0.0 },
          { min: 49450, max: 545500, rate: 0.15 },
          { min: 545500, max: Infinity, rate: 0.2 },
        ],
        marriedFilingJointly: [
          { min: 0, max: 98900, rate: 0.0 },
          { min: 98900, max: 613700, rate: 0.15 },
          { min: 613700, max: Infinity, rate: 0.2 },
        ],
        headOfHousehold: [
          { min: 0, max: 66200, rate: 0.0 },
          { min: 66200, max: 579600, rate: 0.15 },
          { min: 579600, max: Infinity, rate: 0.2 },
        ],
      },
    },
    netInvestmentIncomeTax: {
      indexing: 'fixed',
      source: 'IRC §1411; 3.8% rate and $200k/$250k base amounts, not indexed since 2013.',
      values: {
        rate: 0.038,
        thresholds: {
          single: 200000,
          marriedFilingJointly: 250000,
          headOfHousehold: 200000,
        },
      },
    },
    // The OASDI contribution and benefit base for 2026 (the "Social Security wage base").
    // Source: SSA, "Cost-of-Living Increase and Other Determinations for 2026", 90 FR 49047
    // (Nov 3, 2025): "The OASDI contribution and benefit base is $184,500 for remuneration paid in
    // 2026 and self-employment income earned in tax years beginning in 2026." Rounded by SSA from
    // $184,548.71 to the nearest $300 under §230(b). It is indexed every year: this row must be
    // re-issued, never copied forward.
    socialSecurityWageBase: {
      indexing: 'indexed',
      source: 'IRC §230(b); SSA 2026 determination, 90 FR 49047 (Nov 3, 2025): $184,500.',
      values: 184500,
    },
    // The combined 6.2% employee OASDI + 1.45% employee Hospital Insurance (Medicare) share is
    // 7.65%, which is what `incomes.ts` used to hard-code. The self-employment shares are double
    // the employee shares (12.4% + 2.9% = 15.3%) because a self-employed earner pays both halves,
    // applied to 92.35% of net SE earnings (IRC §1402(a)(12)); half of the resulting tax is
    // deductible above the line (IRC §164(f)). All of these are statutory, not indexed.
    payrollTaxRates: {
      indexing: 'fixed',
      source:
        'IRC §3101(a) (6.2% OASDI), §3101(b) (1.45% Medicare), §3101(b)(2) (0.9% Additional Medicare), ' +
        '§1401(a)-(b) (12.4% + 2.9% self-employment), §1402(a)(12) (92.35% of net SE earnings) and §164(f) (half of SE tax deductible).',
      values: {
        socialSecurity: 0.062,
        medicare: 0.0145,
        additionalMedicare: 0.009,
        selfEmploymentTaxablePercentage: 0.9235,
        selfEmploymentSocialSecurity: 0.124,
        selfEmploymentMedicare: 0.029,
        selfEmploymentDeduction: 0.5,
      },
    },
    // Alternative minimum tax (IRC §55). Exemption and phase-out threshold from the IRS 2026
    // inflation adjustments: "For tax year 2026, the exemption amount for unmarried individuals is
    // $90,100 and begins to phase out at $500,000 ($140,200 for married couples filing jointly for
    // whom the exemption begins to phase out at $1,000,000)." The 26%/28% rates and the 25%
    // phase-out rate are statutory; the ceiling on the 26% band is the fixed §55(b)(1) $175,000
    // ($87,500 on a separate return), which is *not* indexed.
    alternativeMinimumTax: {
      indexing: 'indexed',
      source:
        'IRC §55(b)(1) (26%/28% rates, $175,000 / $87,500 band ceiling), §55(d)(1) (25% phase-out) and §56(b)(1) ' +
        '(disallowed deductions); IRS 2026 inflation adjustments: $90,100 single / $140,200 MFJ exemption, ' +
        'phasing out at $500,000 / $1,000,000.',
      values: {
        exemption: { single: 90100, marriedFilingJointly: 140200, headOfHousehold: 90100 },
        exemptionPhaseOutThreshold: { single: 500000, marriedFilingJointly: 1000000, headOfHousehold: 500000 },
        exemptionPhaseOutRate: 0.25,
        rateLow: 0.26,
        rateHigh: 0.28,
        rateLowCeiling: { single: 175000, marriedFilingJointly: 175000, headOfHousehold: 175000 },
        // IRC §56(b)(1): the standard deduction, state and local taxes and miscellaneous itemized
        // deductions do not survive into AMTI. Qualified mortgage interest and charitable
        // contributions are allowed and are deliberately absent. Only the standard deduction can be
        // non-zero today, because the engine applies no itemized deductions yet (P3-P3).
        disallowedDeductions: ['standardDeduction', 'stateAndLocalTaxes', 'propertyTaxes', 'miscellaneousItemized'],
      },
    },
    // Medicare IRMAA, Parts B and D (42 U.S.C. §1395r(i)). CMS, "2026 Medicare Parts A & B
    // Premiums and Deductibles" fact sheet (Nov 14, 2025), read 2026-10-30:
    //   Part B standard premium $202.90/month, income-related adjustments $0.00 / $81.20 /
    //   $202.90 / $324.60 / $446.30 / $487.00/month;
    //   Part D income-related adjustments $0.00 / $14.50 / $37.50 / $60.40 / $83.30 / $91.00/month;
    //   MAGI tiers ≤109,000 / ≤137,000 / ≤171,000 / ≤205,000 / <500,000 / ≥500,000 (individual),
    //   doubled for a joint return. The tier is set from the return filed two years earlier.
    medicareIrmaa: {
      indexing: 'indexed',
      source:
        'CMS, "2026 Medicare Parts A & B Premiums and Deductibles" (Nov 14, 2025): Part B adjustments ' +
        '$0.00/$81.20/$202.90/$324.60/$446.30/$487.00 and Part D $0.00/$14.50/$37.50/$60.40/$83.30/$91.00 per month, ' +
        'on MAGI tiers of $109k/$137k/$171k/$205k/$500k (individual), doubled for a joint return.',
      values: {
        standardPartBMonthly: 202.9,
        lookbackYears: 2,
        tiers: {
          single: [
            { min: 0, max: 109000, partBMonthly: 0, partDMonthly: 0 },
            { min: 109000, max: 137000, partBMonthly: 81.2, partDMonthly: 14.5 },
            { min: 137000, max: 171000, partBMonthly: 202.9, partDMonthly: 37.5 },
            { min: 171000, max: 205000, partBMonthly: 324.6, partDMonthly: 60.4 },
            { min: 205000, max: 500000, partBMonthly: 446.3, partDMonthly: 83.3 },
            { min: 500000, max: null, partBMonthly: 487, partDMonthly: 91 },
          ],
          marriedFilingJointly: [
            { min: 0, max: 218000, partBMonthly: 0, partDMonthly: 0 },
            { min: 218000, max: 274000, partBMonthly: 81.2, partDMonthly: 14.5 },
            { min: 274000, max: 342000, partBMonthly: 202.9, partDMonthly: 37.5 },
            { min: 342000, max: 410000, partBMonthly: 324.6, partDMonthly: 60.4 },
            { min: 410000, max: 750000, partBMonthly: 446.3, partDMonthly: 83.3 },
            { min: 750000, max: null, partBMonthly: 487, partDMonthly: 91 },
          ],
          // CMS publishes one "individual" column, which a head of household uses.
          headOfHousehold: [
            { min: 0, max: 109000, partBMonthly: 0, partDMonthly: 0 },
            { min: 109000, max: 137000, partBMonthly: 81.2, partDMonthly: 14.5 },
            { min: 137000, max: 171000, partBMonthly: 202.9, partDMonthly: 37.5 },
            { min: 171000, max: 205000, partBMonthly: 324.6, partDMonthly: 60.4 },
            { min: 205000, max: 500000, partBMonthly: 446.3, partDMonthly: 83.3 },
            { min: 500000, max: null, partBMonthly: 487, partDMonthly: 91 },
          ],
        },
      },
    },
    // Additional Medicare Tax thresholds. Statutory amounts in IRC §3101(b)(2)(A) and
    // §1401(b)(2)(A), fixed since 2013 and deliberately not indexed. The employer withholding
    // threshold is $200,000 regardless of filing status; the liability these thresholds describe
    // is filing-status dependent, and this engine models the liability (there is no Form 8959
    // true-up), so the filing status wins.
    additionalMedicareThreshold: {
      indexing: 'fixed',
      source: 'IRC §3101(b)(2)(A), §1401(b)(2)(A): $200,000 single/HOH, $250,000 MFJ; not indexed since 2013.',
      values: {
        single: 200000,
        marriedFilingJointly: 250000,
        headOfHousehold: 200000,
      },
    },
    socialSecurityTaxation: {
      indexing: 'fixed',
      source: 'IRC §86; base amounts of $25,000/$34,000 (single, HOH) and $32,000/$44,000 (MFJ), fixed by statute.',
      values: {
        single: [
          { min: 0, max: 25000, taxablePercentage: 0 },
          { min: 25000, max: 34000, taxablePercentage: 0.5 },
          { min: 34000, max: Infinity, taxablePercentage: 0.85 },
        ],
        marriedFilingJointly: [
          { min: 0, max: 32000, taxablePercentage: 0 },
          { min: 32000, max: 44000, taxablePercentage: 0.5 },
          { min: 44000, max: Infinity, taxablePercentage: 0.85 },
        ],
        headOfHousehold: [
          { min: 0, max: 25000, taxablePercentage: 0 },
          { min: 25000, max: 34000, taxablePercentage: 0.5 },
          { min: 34000, max: Infinity, taxablePercentage: 0.85 },
        ],
      },
    },
    section121Exclusion: {
      indexing: 'fixed',
      source: 'IRC §121(b); $250,000 single/HOH and $500,000 MFJ, fixed by statute.',
      values: {
        single: 250000,
        marriedFilingJointly: 500000,
        headOfHousehold: 250000,
      },
    },
  },
};
