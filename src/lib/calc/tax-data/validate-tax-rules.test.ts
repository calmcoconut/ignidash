import { describe, expect, it } from 'vitest';
import { validateCurrentTaxData, validateRuleset } from '../../../../scripts/validate-tax-rules';
import { getRules, LATEST_TAX_YEAR } from './index';

describe('Annual tax-data validation (R10)', () => {
  it('validates every registered tax ruleset as conforming', () => {
    const results = validateCurrentTaxData();
    expect(results.length).toBeGreaterThanOrEqual(2);

    const jurisdictions = results.map((res) => res.jurisdiction);
    expect(jurisdictions).toContain('federal');
    expect(jurisdictions).toContain('CA');

    for (const res of results) {
      expect(res.valid).toBe(true);
      expect(res.issues).toEqual([]);
    }
  });

  it('checks the newest registered CA ruleset rather than a hard-coded year', () => {
    // A hard-coded year would keep validating 2025 after `states/CA/2026.ts` is registered.
    const newestCa = getRules(LATEST_TAX_YEAR, 'CA');
    const caResults = validateCurrentTaxData().filter((res) => res.jurisdiction === 'CA');

    expect(caResults.map((res) => res.year)).toContain(newestCa.year);
  });

  it('detects missing indexing metadata when broken (falsifiability proof)', () => {
    const rules = getRules(LATEST_TAX_YEAR, 'federal');
    // Break a table metadata to prove falsifiability
    const broken = {
      ...rules,
      tables: {
        ...rules.tables,
        incomeTaxBrackets: {
          ...rules.tables.incomeTaxBrackets,
          indexing: 'invalid' as unknown as 'indexed',
        },
      },
    };

    const res = validateRuleset(broken);
    expect(res.valid).toBe(false);
    expect(res.issues.some((issue) => issue.includes("missing valid 'indexing'"))).toBe(true);
  });
});
