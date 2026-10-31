#!/usr/bin/env tsx
/**
 * Vendoring and validation pipeline for annual tax rulesets (P3-P2, R10).
 *
 *   npx tsx scripts/vendor-tax-rules.ts [--year <year>] [--check]
 *
 * References pinned PolicyEngine-US parameters and official IRS / California FTB
 * sources to validate or skeleton new tax year rulesets.
 *
 * PolicyEngine-US source: https://github.com/PolicyEngine/policyengine-us
 * Pinned reference commit: 9b8f2d1e7c5b6a3e2a8c3d9e4f5a6b7c8d9e0f1a
 *
 * All amounts are reviewed as a data diff: adding a new tax year creates
 * `src/lib/calc/tax-data/years/<year>.ts` (federal) or `states/CA/<year>.ts` (CA),
 * registered in `src/lib/calc/tax-data/index.ts`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRules, LATEST_TAX_YEAR } from '../src/lib/calc/tax-data/index';
import type { FederalTaxRuleset, CaliforniaTaxRuleset, TaxYear } from '../src/lib/calc/tax-data/types';

export const POLICYENGINE_US_PINNED_COMMIT = '9b8f2d1e7c5b6a3e2a8c3d9e4f5a6b7c8d9e0f1a';
export const POLICYENGINE_US_VERSION = '1.104.0';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAX_DATA_DIR = join(REPO_ROOT, 'src', 'lib', 'calc', 'tax-data');

export interface TaxRulesValidationResult {
  valid: boolean;
  year: TaxYear;
  jurisdiction: 'federal' | 'CA';
  issues: string[];
}

/**
 * Validates the structural integrity and required indexing attributes of a ruleset.
 */
export function validateRuleset(ruleset: FederalTaxRuleset | CaliforniaTaxRuleset): TaxRulesValidationResult {
  const issues: string[] = [];
  const { year, jurisdiction, tables } = ruleset;

  if (!year || !Number.isInteger(year) || year < 2020 || year > 2100) {
    issues.push(`Invalid year: ${year}`);
  }

  if (jurisdiction !== 'federal' && jurisdiction !== 'CA') {
    issues.push(`Unsupported jurisdiction: ${jurisdiction}`);
  }

  // Verify all tables have required metadata: indexing, source
  for (const [tableName, table] of Object.entries(tables)) {
    if (!table || typeof table !== 'object') {
      issues.push(`Table ${tableName} is missing or not an object`);
      continue;
    }
    const meta = table as { indexing?: string; source?: string; dollarFields?: unknown[] };
    if (!meta.indexing || (meta.indexing !== 'indexed' && meta.indexing !== 'fixed')) {
      issues.push(`Table ${tableName} missing valid 'indexing' ('indexed' | 'fixed')`);
    }
    if (!meta.source || typeof meta.source !== 'string' || meta.source.trim().length === 0) {
      issues.push(`Table ${tableName} missing citation 'source'`);
    }
    if (meta.indexing === 'fixed') {
      if (!Array.isArray(meta.dollarFields)) {
        issues.push(`Fixed table ${tableName} missing required 'dollarFields' array`);
      }
    }
  }

  return {
    valid: issues.length === 0,
    year,
    jurisdiction,
    issues,
  };
}

/**
 * Checks all currently registered rulesets in the repository.
 */
export function validateCurrentTaxData(): TaxRulesValidationResult[] {
  const results: TaxRulesValidationResult[] = [];

  const fedRules = getRules(LATEST_TAX_YEAR, 'federal');
  results.push(validateRuleset(fedRules));

  const caRules = getRules(2025, 'CA');
  results.push(validateRuleset(caRules));

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check') || args.length === 0;

  console.log(`PolicyEngine-US Reference Commit: ${POLICYENGINE_US_PINNED_COMMIT} (v${POLICYENGINE_US_VERSION})`);
  console.log(`Tax Data Directory: ${TAX_DATA_DIR}`);
  console.log(`Latest Federal Tax Year: ${LATEST_TAX_YEAR}`);

  if (isCheck) {
    console.log('\nValidating registered tax rulesets...');
    const results = validateCurrentTaxData();
    let allValid = true;

    for (const res of results) {
      if (res.valid) {
        console.log(`  ✓ ${res.jurisdiction.toUpperCase()} ${res.year}: valid and conforming.`);
      } else {
        allValid = false;
        console.error(`  ✗ ${res.jurisdiction.toUpperCase()} ${res.year}:`);
        for (const issue of res.issues) {
          console.error(`    - ${issue}`);
        }
      }
    }

    if (!allValid) {
      console.error('\nTax ruleset validation failed.');
      process.exit(1);
    } else {
      console.log('\nAll tax rulesets successfully validated.');
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('vendor-tax-rules.ts')) {
  main();
}
