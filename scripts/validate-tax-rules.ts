#!/usr/bin/env tsx
/**
 * Validation for the registered annual tax rulesets (P3-P2, R10).
 *
 *   npx tsx scripts/validate-tax-rules.ts        (or: npm run tax:validate)
 *
 * Checks the metadata the engine relies on in every ruleset that
 * `src/lib/calc/tax-data/index.ts` registers, federal and California alike: a valid `indexing`
 * ('indexed' | 'fixed'), a non-empty `source` citation, and a `dollarFields` array on every
 * `fixed` table (`real-dollars.ts` throws without one).
 *
 * This script only reads the rulesets; it does not fetch, vendor or write anything. Adding a new
 * tax year stays an editor's job — create `src/lib/calc/tax-data/years/<year>.ts` (federal) or
 * `states/CA/<year>.ts` (CA) and register it in `src/lib/calc/tax-data/index.ts`. Nothing here
 * hard-codes a year, so a newly registered ruleset is validated the next time this runs.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRules, LATEST_TAX_YEAR } from '../src/lib/calc/tax-data/index';
import type { Jurisdiction, TaxRuleset, TaxYear } from '../src/lib/calc/tax-data/types';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAX_DATA_DIR = join(REPO_ROOT, 'src', 'lib', 'calc', 'tax-data');

/** The jurisdictions the resolver can return today; a new one is added here with its registry. */
const JURISDICTIONS: readonly Jurisdiction[] = ['federal', 'CA'];

/** The year range `validateRuleset` itself accepts, reused as the probe range. */
const EARLIEST_PROBE_YEAR = 2020;
const LATEST_PROBE_YEAR = 2100;

export interface TaxRulesValidationResult {
  valid: boolean;
  year: TaxYear;
  jurisdiction: Jurisdiction;
  issues: string[];
}

/**
 * Validates the structural integrity and required indexing attributes of a ruleset.
 */
export function validateRuleset(ruleset: TaxRuleset): TaxRulesValidationResult {
  const issues: string[] = [];
  const { year, jurisdiction, tables } = ruleset;

  if (!year || !Number.isInteger(year) || year < EARLIEST_PROBE_YEAR || year > LATEST_PROBE_YEAR) {
    issues.push(`Invalid year: ${year}`);
  }

  if (!JURISDICTIONS.includes(jurisdiction)) {
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
 * Every ruleset registered for `jurisdiction`, newest last.
 *
 * `getRules` resolves the nearest prior year, so walking down from `LATEST_PROBE_YEAR` yields each
 * registered ruleset in turn (several probe years resolve to the same one). The walk stops at the
 * first year that resolves to nothing — every year before it would throw as well. Enumerating this
 * way means the validator cannot silently keep checking a stale year once a newer ruleset lands.
 */
function registeredRulesets(jurisdiction: Jurisdiction): TaxRuleset[] {
  const found = new Map<TaxYear, TaxRuleset>();

  for (let year = LATEST_PROBE_YEAR; year >= EARLIEST_PROBE_YEAR; year--) {
    let ruleset: TaxRuleset;
    try {
      ruleset = getRules(year, jurisdiction);
    } catch {
      break;
    }
    found.set(ruleset.year, ruleset);
  }

  return [...found.values()].sort((a, b) => a.year - b.year);
}

/**
 * Checks all currently registered rulesets in the repository.
 */
export function validateCurrentTaxData(): TaxRulesValidationResult[] {
  return JURISDICTIONS.flatMap((jurisdiction) => registeredRulesets(jurisdiction).map((ruleset) => validateRuleset(ruleset)));
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    console.error(`Unknown argument(s): ${args.join(' ')}`);
    console.error('Usage: npx tsx scripts/validate-tax-rules.ts    (validation is the default and only action)');
    process.exit(2);
  }

  console.log(`Tax Data Directory: ${TAX_DATA_DIR}`);
  console.log(`Latest Federal Tax Year: ${LATEST_TAX_YEAR}`);

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
  }

  console.log('\nAll tax rulesets successfully validated.');
}

if (process.argv[1] && process.argv[1].endsWith('validate-tax-rules.ts')) {
  main();
}
