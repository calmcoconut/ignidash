import { describe, expect, it } from 'vitest';
import {
  validateCurrentTaxData,
  validateRuleset,
  POLICYENGINE_US_PINNED_COMMIT,
  POLICYENGINE_US_VERSION,
} from '../../../../scripts/vendor-tax-rules';
import { getRules, LATEST_TAX_YEAR } from './index';

describe('Annual tax-data update pipeline (R10)', () => {
  it('cites a pinned PolicyEngine-US commit and version', () => {
    expect(POLICYENGINE_US_PINNED_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(POLICYENGINE_US_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('validates the current registered tax rulesets as conforming', () => {
    const results = validateCurrentTaxData();
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const res of results) {
      expect(res.valid).toBe(true);
      expect(res.issues).toEqual([]);
    }
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
