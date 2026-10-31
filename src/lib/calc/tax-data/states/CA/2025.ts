/**
 * California ruleset for tax year 2025 — the latest the FTB has published.
 *
 * ## Why the file is 2025 and not 2026
 *
 * The FTB publishes each year's rate schedules with that year's Form 540, in the fall. At the time
 * of writing the FTB's own rates page still says "Calculate your 2025 tax … Tax calculator is for
 * 2025 tax year only", so a 2026 schedule does not exist to copy. The harness resolves a year
 * without a ruleset to the nearest **prior** one, so a 2026 return files under this 2025 ruleset and
 * says so (`getRules(2026, 'CA').year === 2025`). Inventing 2026 amounts by applying an inflation
 * guess would be the one thing the plan forbids, so the file states its year and stops there; the
 * annual-update pipeline (P3-P2) adds 2026 when the FTB publishes it.
 *
 * ## Sources (all read 2026-10-30)
 *
 * - **Brackets**: FTB, "2025 California Tax Rate Schedules" (ftb.ca.gov/forms/2025/
 *   2025-540-tax-rate-schedules.pdf), Schedules X (single/MFS), Y (MFJ/QSS) and Z (HOH). The
 *   schedules are published as "amount over" columns; they are transcribed here as the equivalent
 *   progressive brackets, which the engine walks.
 * - **Standard deduction**: 2025 Form 540, line 18 — $5,706 single/MFS, $11,412 MFJ/HOH/QSS.
 * - **Personal exemption credit**: 2025 Form 540, line 7 ($153 per taxpayer; $475 per dependent) and
 *   the line 32 AGI Limitation Worksheet — limited above $252,203 (single/MFS), $504,411 (MFJ/QSS)
 *   or $378,310 (HOH) by $6 for each $2,500 ($1,250 MFS) or part thereof.
 * - **Itemized deduction limitation**: 2025 Schedule CA (540), Part II, line 29 and its Itemized
 *   Deductions Worksheet — the same AGI thresholds, 6% of the excess, capped at 80% of the
 *   deduction.
 * - **Disallowed itemized lines**: 2025 Schedule CA (540), line 5a — "California does not allow a
 *   deduction for state and local income tax … and State Disability Insurance (SDI) or state and
 *   local general sales tax." Property tax stays deductible, and California does not conform to the
 *   federal SALT cap (same line's note).
 * - **Behavioral Health Services Tax**: 2025 Form 540, line 62 worksheet — 1% of the amount over
 *   $1,000,000 (R&TC §17043; renamed from the Mental Health Services Tax for 2025 and later).
 * - **Medical floor**: Schedule CA (540), line 4 — the 7.5%-of-federal-AGI threshold, which
 *   California conforms to.
 * - **Conformity flags**: the 2025 540 booklet's "Federal Tax Changes Under One Big Beautiful Bill
 *   Act (OBBBA) — In general, California R&TC does not conform to the OBBBA", and the absence of a
 *   §86 equivalent (California excludes Social Security) and of a preferential capital-gains rate
 *   (Schedule X/Y/Z tax all taxable income on one schedule).
 *
 * ## What this ruleset does not model
 *
 * HSA non-conformity (contributions not deductible, earnings taxable, the 2.5% early-distribution
 * penalty) is P3-P5's: it needs the retirement-account pass, and the notes there are in
 * `PLAN-parity.md` §3-P5. Dependents, the blind and senior credits, the renter's credit, the
 * exemption of certain public pensions, municipal-bond interest, and the alternative minimum tax
 * (California has its own, FTB 6251) are all out of scope.
 */

import type { CaliforniaTaxRuleset, ProgressiveBracket } from '../../types';

/** Schedule X — single, and married/RDP filing separately. */
const SINGLE_BRACKETS: ProgressiveBracket[] = [
  { min: 0, max: 11079, rate: 0.01 },
  { min: 11079, max: 26264, rate: 0.02 },
  { min: 26264, max: 41452, rate: 0.04 },
  { min: 41452, max: 57542, rate: 0.06 },
  { min: 57542, max: 72724, rate: 0.08 },
  { min: 72724, max: 371479, rate: 0.093 },
  { min: 371479, max: 445771, rate: 0.103 },
  { min: 445771, max: 742953, rate: 0.113 },
  { min: 742953, max: Infinity, rate: 0.123 },
];

/** Schedule Y — married/RDP filing jointly, and qualifying surviving spouse/RDP. */
const MARRIED_BRACKETS: ProgressiveBracket[] = [
  { min: 0, max: 22158, rate: 0.01 },
  { min: 22158, max: 52528, rate: 0.02 },
  { min: 52528, max: 82904, rate: 0.04 },
  { min: 82904, max: 115084, rate: 0.06 },
  { min: 115084, max: 145448, rate: 0.08 },
  { min: 145448, max: 742958, rate: 0.093 },
  { min: 742958, max: 891542, rate: 0.103 },
  { min: 891542, max: 1485906, rate: 0.113 },
  { min: 1485906, max: Infinity, rate: 0.123 },
];

/** Schedule Z — head of household. */
const HEAD_OF_HOUSEHOLD_BRACKETS: ProgressiveBracket[] = [
  { min: 0, max: 22173, rate: 0.01 },
  { min: 22173, max: 52530, rate: 0.02 },
  { min: 52530, max: 67716, rate: 0.04 },
  { min: 67716, max: 83805, rate: 0.06 },
  { min: 83805, max: 98990, rate: 0.08 },
  { min: 98990, max: 505208, rate: 0.093 },
  { min: 505208, max: 606251, rate: 0.103 },
  { min: 606251, max: 1010417, rate: 0.113 },
  { min: 1010417, max: Infinity, rate: 0.123 },
];

const SCHEDULE_SOURCE =
  'FTB, "2025 California Tax Rate Schedules" (ftb.ca.gov/forms/2025/2025-540-tax-rate-schedules.pdf), Schedules X, Y and Z.';

export const CALIFORNIA_2025: CaliforniaTaxRuleset = {
  jurisdiction: 'CA',
  year: 2025,
  source:
    'FTB 2025 Form 540 and Schedule CA (540) (ftb.ca.gov/forms/2025/), with R&TC §17043 for the Behavioral Health Services Tax; ' +
    'the 2026 schedules are not published yet, so a 2026 return resolves this ruleset by the nearest-prior rule.',
  tables: {
    incomeTaxBrackets: {
      indexing: 'indexed',
      source: SCHEDULE_SOURCE,
      values: {
        single: SINGLE_BRACKETS,
        marriedFilingJointly: MARRIED_BRACKETS,
        headOfHousehold: HEAD_OF_HOUSEHOLD_BRACKETS,
        // Schedule X, literally "Single or married/RDP filing separately". A separate return uses
        // the *same* bracket table as a single filer because the FTB's schedule says so — this is
        // not the single row copied for convenience, and it is the one place California's separate
        // return does not halve anything.
        marriedFilingSeparately: SINGLE_BRACKETS,
      },
    },
    standardDeduction: {
      indexing: 'indexed',
      source: '2025 Form 540, line 18: $5,706 single/MFS, $11,412 MFJ/HOH/QSS.',
      values: {
        single: 5706,
        marriedFilingJointly: 11412,
        headOfHousehold: 11412,
        // Same line 18 amount as a single filer: California does not halve its standard deduction
        // for a separate return, which is why the MFS row equals the single one here.
        marriedFilingSeparately: 5706,
      },
    },
    behavioralHealthServicesTax: {
      indexing: 'fixed',
      // The 1% rate is dimensionless; only the $1,000,000 / $500,000 threshold is money.
      dollarFields: ['threshold'],
      source:
        'R&TC §17043; 2025 Form 540, line 62 worksheet: 1% of the amount over $1,000,000 (the Mental Health Services Tax before ' +
        '2025), and $500,000 on a separate return.',
      values: {
        rate: 0.01,
        threshold: {
          single: 1000000,
          marriedFilingJointly: 1000000,
          headOfHousehold: 1000000,
          // R&TC §17043(a): the threshold is $500,000 "in the case of a separate return".
          marriedFilingSeparately: 500000,
        },
      },
    },
    personalExemptionCredit: {
      indexing: 'indexed',
      source:
        '2025 Form 540, line 7 ($153 per taxpayer, $475 per dependent) and the line 32 AGI Limitation Worksheet: ' +
        'limited above $252,203 / $504,411 / $378,310 by $6 per $2,500 ($1,250 MFS) or part thereof.',
      values: {
        perTaxpayer: 153,
        dependent: 475,
        agiLimit: {
          single: 252203,
          marriedFilingJointly: 504411,
          headOfHousehold: 378310,
          marriedFilingSeparately: 252203,
        },
        // $2,500, or $1,250 on a separate return: half the step means twice as many steps for the
        // same excess AGI, so the credit runs out at the same AGI it would for a single filer.
        reductionStep: {
          single: 2500,
          marriedFilingJointly: 2500,
          headOfHousehold: 2500,
          marriedFilingSeparately: 1250,
        },
        reductionPerStep: 6,
      },
    },
    itemizedDeductionLimit: {
      indexing: 'indexed',
      source:
        '2025 Schedule CA (540), Part II, line 29 and its Itemized Deductions Worksheet: 6% of federal AGI over ' +
        '$252,203 / $504,411 / $378,310 ($252,203 on a separate return), capped at 80% of the deduction.',
      values: {
        agiThreshold: {
          single: 252203,
          marriedFilingJointly: 504411,
          headOfHousehold: 378310,
          marriedFilingSeparately: 252203,
        },
        rate: 0.06,
        maxReductionShare: 0.8,
        // 2025 Schedule CA (540), line 5a: no deduction for state and local income tax, SDI or
        // general sales tax. Property tax is not on this list and stays deductible.
        disallowed: ['stateIncomeTax', 'stateDisabilityInsurance', 'generalSalesTax'],
      },
    },
    conformity: {
      indexing: 'fixed',
      // Conformity flags and the 7.5% medical floor: no amounts, nothing to deflate.
      dollarFields: [],
      source:
        '2025 Form 540 booklet ("Federal Tax Changes Under One Big Beautiful Bill Act (OBBBA) — In general, California R&TC does not ' +
        'conform to the OBBBA"), Schedule CA (540) lines 4 and 5a, and Schedules X/Y/Z (one schedule for all income).',
      values: {
        preferentialCapitalGains: false,
        taxesSocialSecurity: false,
        allowsFederalSeniorDeduction: false,
        allowsStateIncomeTaxDeduction: false,
        medicalExpenseFloor: 0.075,
      },
    },
  },
};
