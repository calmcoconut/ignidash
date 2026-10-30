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
    'NIIT, §86 base amounts and the §121 exclusion are statutory and not indexed for 2026.',
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
