import { describe, it, expect } from 'vitest';

import { getRules, LATEST_TAX_YEAR } from './index';
import { FEDERAL_2026 } from './years/2026';
import type { TableMeta } from './types';

describe('getRules — year resolution', () => {
  it('resolves the requested year exactly', () => {
    expect(getRules(2026)).toBe(FEDERAL_2026);
    expect(getRules(2026).year).toBe(2026);
  });

  it('falls back to the nearest prior year for a later year', () => {
    expect(getRules(2027)).toBe(FEDERAL_2026);
    expect(getRules(2027).year).toBe(2026);
    expect(getRules(2056)).toBe(FEDERAL_2026);
  });

  it('throws rather than borrowing a future ruleset for an earlier year', () => {
    // 2025 is the boundary: the only ruleset (2026) is in the future, so there is nothing at or
    // before it to resolve to. Silently using 2026 would apply law that does not exist yet.
    expect(() => getRules(2025)).toThrow(/No federal tax ruleset for 2025 or any earlier year/);
    expect(() => getRules(2025)).toThrow(/earliest available: 2026/);
    expect(() => getRules(1990)).toThrow(/No federal tax ruleset for 1990/);
  });

  it('rejects a non-integer year', () => {
    expect(() => getRules(2026.5)).toThrow(/must be an integer/);
  });

  it('resolves the explicit federal jurisdiction and reports the latest year', () => {
    expect(getRules(2026, 'federal')).toBe(FEDERAL_2026);
    expect(LATEST_TAX_YEAR).toBe(2026);
  });

  it('fails loudly for a jurisdiction that has no ruleset yet', () => {
    // California (§3-P8) arrives as a registry entry with the same shape; until then a request
    // must throw rather than quietly return federal law.
    expect(() => getRules(2026, 'CA')).toThrow(/No CA tax ruleset registry/);
  });
});

describe('2026 federal ruleset metadata', () => {
  const ruleset = getRules(2026);
  const tables = ruleset.tables;

  it('declares its jurisdiction, year and provenance', () => {
    expect(ruleset.jurisdiction).toBe('federal');
    expect(ruleset.year).toBe(2026);
    expect(ruleset.source.trim().length).toBeGreaterThan(0);
  });

  it('declares every table with its values, its indexing and a source citation', () => {
    const entries = Object.entries(tables) as Array<[string, TableMeta<unknown>]>;

    expect(entries.length).toBeGreaterThan(0);
    for (const [_name, table] of entries) {
      expect(table.values).toBeDefined();
      expect(['indexed', 'fixed']).toContain(table.indexing);
      expect(typeof table.source).toBe('string');
      expect(table.source.trim().length).toBeGreaterThan(0);
    }
  });

  it('distinguishes inflation-indexed tables from statutory amounts', () => {
    // The point of `indexing`: brackets and the standard deduction are re-issued every year,
    // while these three are fixed by statute and must be copied forward unchanged.
    expect(tables.incomeTaxBrackets.indexing).toBe('indexed');
    expect(tables.standardDeduction.indexing).toBe('indexed');
    expect(tables.capitalGainsTaxBrackets.indexing).toBe('indexed');

    expect(tables.netInvestmentIncomeTax.indexing).toBe('fixed');
    expect(tables.socialSecurityTaxation.indexing).toBe('fixed');
    expect(tables.section121Exclusion.indexing).toBe('fixed');
  });

  it.each([
    ['incomeTaxBrackets', tables.incomeTaxBrackets.values],
    ['standardDeduction', tables.standardDeduction.values],
    ['capitalGainsTaxBrackets', tables.capitalGainsTaxBrackets.values],
    ['netInvestmentIncomeTax', tables.netInvestmentIncomeTax.values.thresholds],
    ['socialSecurityTaxation', tables.socialSecurityTaxation.values],
    ['section121Exclusion', tables.section121Exclusion.values],
  ] as Array<[string, Record<string, unknown>]>)('%s has an amount for every filing status', (_name, values) => {
    expect(Object.keys(values).sort()).toEqual(['headOfHousehold', 'marriedFilingJointly', 'single']);
  });
});
