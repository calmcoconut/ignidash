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
        // IRC §1(d) sets the separate-return schedule to **one-half the joint amounts**, and the
        // IRS's annual inflation Rev. Proc. (Rev. Proc. 2025-32 for 2026) publishes exactly that
        // column: $12,400 / $50,400 / $105,700 / $201,775 / $256,225 / $384,350, the last being
        // half of the joint $768,700. It is therefore written here as the halving of the row above
        // rather than as a second transcript of the table, so the two can never disagree; the halves
        // reproduce the published MFS column to the dollar ($24,800/2 = 12,400 and so on).
        //
        // Note the shape that falls out: the MFS schedule equals the single one for every band
        // except the 35% band, which a separate return leaves at $384,350 rather than $640,600.
        marriedFilingSeparately: [
          { min: 0, max: 12400, rate: 0.1 },
          { min: 12400, max: 50400, rate: 0.12 },
          { min: 50400, max: 105700, rate: 0.22 },
          { min: 105700, max: 201775, rate: 0.24 },
          { min: 201775, max: 256225, rate: 0.32 },
          { min: 256225, max: 384350, rate: 0.35 },
          { min: 384350, max: Infinity, rate: 0.37 },
        ],
      },
    },
    standardDeduction: {
      indexing: 'indexed',
      source:
        'IRC §63(c)(2)(A) and (c)(2)(B) (the separate-return basic standard deduction is 50 percent of the joint amount); ' +
        'IRS 2026 inflation adjustments (including OBBBA amendments): $16,100 separate, half of the $32,200 joint amount.',
      values: {
        single: 16100,
        marriedFilingJointly: 32200,
        headOfHousehold: 24150,
        // §63(c)(2)(B): 50% of the joint amount, i.e. $16,100 — the same dollars as a single filer.
        marriedFilingSeparately: 16100,
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
        // The 0%/15% breakpoints are the joint amounts halved (IRC §1(h)(1); the MFS column of the
        // 2026 inflation Rev. Proc.): $49,450 and $306,850 — half of $98,900 and $613,700. As with
        // the ordinary schedule, the MFS row matches the single one until the top break.
        marriedFilingSeparately: [
          { min: 0, max: 49450, rate: 0.0 },
          { min: 49450, max: 306850, rate: 0.15 },
          { min: 306850, max: Infinity, rate: 0.2 },
        ],
      },
    },
    netInvestmentIncomeTax: {
      indexing: 'fixed',
      source:
        'IRC §1411; 3.8% rate and $200k/$250k/$125k base amounts, not indexed since 2013. ' +
        '§1411(b)(2) sets the separate-return threshold at $125,000, half of the joint $250,000.',
      values: {
        rate: 0.038,
        thresholds: {
          single: 200000,
          marriedFilingJointly: 250000,
          headOfHousehold: 200000,
          marriedFilingSeparately: 125000,
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
    // whom the exemption begins to phase out at $1,000,000)." The separate-return exemption is
    // $70,100 — half of the joint amount, per §55(d)(1)(C)'s $43,750 halving of the (pre-inflation)
    // $87,500 — and its phase-out threshold is $500,000, the un-doubled §55(d)(4) amount. The
    // 26%/28% rates and the 25% phase-out rate are statutory; the ceiling on the 26% band is the
    // fixed §55(b)(1) $175,000 ($87,500 on a separate return), which is *not* indexed.
    alternativeMinimumTax: {
      indexing: 'indexed',
      source:
        'IRC §55(b)(1) (26%/28% rates, $175,000 / $87,500 band ceiling), §55(d)(1) and (d)(4) (exemption, $43,750 separate-return ' +
        'halving and 25% phase-out) and §56(b)(1) (disallowed deductions); IRS 2026 inflation adjustments: $90,100 single / ' +
        '$140,200 MFJ / $70,100 separate exemption, phasing out at $500,000 / $1,000,000 / $500,000.',
      values: {
        exemption: { single: 90100, marriedFilingJointly: 140200, headOfHousehold: 90100, marriedFilingSeparately: 70100 },
        exemptionPhaseOutThreshold: {
          single: 500000,
          marriedFilingJointly: 1000000,
          headOfHousehold: 500000,
          marriedFilingSeparately: 500000,
        },
        exemptionPhaseOutRate: 0.25,
        rateLow: 0.26,
        rateHigh: 0.28,
        // §55(b)(1)(A)(ii): "($87,500 in the case of a married individual filing a separate return)" —
        // statutory, and never indexed, like the $175,000 it halves.
        rateLowCeiling: { single: 175000, marriedFilingJointly: 175000, headOfHousehold: 175000, marriedFilingSeparately: 87500 },
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
        'on MAGI tiers of $109k/$137k/$171k/$205k/$500k (individual), doubled for a joint return and halved for a separate ' +
        'one (42 U.S.C. §1395r(i)(3)).',
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
          // 42 U.S.C. §1395r(i)(3) reduces the joint-return thresholds by 50 percent for a married
          // individual filing separately, and CMS publishes that column directly: the same five
          // boundaries halved ($109,000 / $137,000 / $171,000 / $205,000 / $375,000) with the same
          // monthly adjustment amounts. Note that the first four therefore coincide with the single
          // column and only the top boundary differs ($375,000 rather than $500,000).
          marriedFilingSeparately: [
            { min: 0, max: 109000, partBMonthly: 0, partDMonthly: 0 },
            { min: 109000, max: 137000, partBMonthly: 81.2, partDMonthly: 14.5 },
            { min: 137000, max: 171000, partBMonthly: 202.9, partDMonthly: 37.5 },
            { min: 171000, max: 205000, partBMonthly: 324.6, partDMonthly: 60.4 },
            { min: 205000, max: 375000, partBMonthly: 446.3, partDMonthly: 83.3 },
            { min: 375000, max: null, partBMonthly: 487, partDMonthly: 91 },
          ],
        },
      },
    },
    // The temporary senior deduction, IRC §151(d)(5)(C), added by P.L. 119-21 §70103: "$6,000 for
    // each qualified individual", reduced by 6% of MAGI over $75,000 ($150,000 joint), for taxable
    // years beginning before January 1, 2029. Fixed by statute, not indexed.
    seniorDeduction: {
      indexing: 'fixed',
      source:
        'IRC §151(d)(5)(C), added by P.L. 119-21 §70103: $6,000 per individual aged 65+, reduced by 6% of MAGI over ' +
        '$75,000 ($150,000 joint, $75,000 separate), taxable years beginning before January 1, 2029; the paragraph denies ' +
        "the deduction where the individual's spouse also claims it, which a pair of separate returns cannot be checked for, " +
        'so a separate return is declared ineligible.',
      values: {
        perIndividual: 6000,
        phaseOutThreshold: { single: 75000, marriedFilingJointly: 150000, headOfHousehold: 75000, marriedFilingSeparately: 75000 },
        phaseOutRate: 0.06,
        lastTaxYear: 2028,
        // See `SeniorDeductionTable.eligible` in types.ts: declared, not a zero amount.
        eligible: { single: true, marriedFilingJointly: true, headOfHousehold: true, marriedFilingSeparately: false },
      },
    },
    // IRC §213(a): medical expenses are deductible only above 7.5% of AGI. A rate, so `fixed`.
    medicalExpenseFloor: {
      indexing: 'fixed',
      source: 'IRC §213(a): the medical-expense deduction is limited to expenses above 7.5% of adjusted gross income.',
      values: 0.075,
    },
    // Additional Medicare Tax thresholds. Statutory amounts in IRC §3101(b)(2)(A) and
    // §1401(b)(2)(A), fixed since 2013 and deliberately not indexed. The employer withholding
    // threshold is $200,000 regardless of filing status; the liability these thresholds describe
    // is filing-status dependent, and this engine models the liability (there is no Form 8959
    // true-up), so the filing status wins.
    additionalMedicareThreshold: {
      indexing: 'fixed',
      source:
        'IRC §3101(b)(2)(A), §1401(b)(2)(A): $200,000 single/HOH, $250,000 MFJ, $125,000 separate (half the joint amount); ' +
        'not indexed since 2013.',
      values: {
        single: 200000,
        marriedFilingJointly: 250000,
        headOfHousehold: 200000,
        marriedFilingSeparately: 125000,
      },
    },
    socialSecurityTaxation: {
      indexing: 'fixed',
      source:
        'IRC §86; base amounts of $25,000/$34,000 (single, HOH) and $32,000/$44,000 (MFJ), fixed by statute; ' +
        '§86(c)(1)(C) and (c)(2)(C) set both the base and the adjusted base amount of a married individual filing a separate ' +
        'return to $0.',
      values: {
        tiers: {
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
          // Base amount $0 and adjusted base amount $0, so the 50% band has no width and the
          // collapsed rule is "85% of provisional income, capped at 85% of the benefits". The single
          // tier states that as a row; `taxableFromFirstDollar` says the walk must use it, because a
          // zero-width second band is not expressible in the general three-tier form.
          marriedFilingSeparately: [{ min: 0, max: Infinity, taxablePercentage: 0.85 }],
        },
        taxableFromFirstDollar: {
          single: false,
          marriedFilingJointly: false,
          headOfHousehold: false,
          marriedFilingSeparately: true,
        },
      },
    },
    section121Exclusion: {
      indexing: 'fixed',
      source:
        'IRC §121(b)(1)-(2); $250,000 generally and $500,000 on a joint return, fixed by statute. A separate return is the ' +
        'general $250,000: §121(b)(1) is the base amount and (b)(2) is what doubles it for a joint return.',
      values: {
        single: 250000,
        marriedFilingJointly: 500000,
        headOfHousehold: 250000,
        marriedFilingSeparately: 250000,
      },
    },
  },
};
