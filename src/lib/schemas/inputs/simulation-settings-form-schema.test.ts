import { describe, it, expect } from 'vitest';

import { simulationSettingsSchema } from './simulation-settings-form-schema';

const validSettings = {
  simulationSeed: 9521,
  simulationMode: 'fixedReturns' as const,
};

describe('simulationSettingsSchema asOfDate', () => {
  it('is optional and absent by default', () => {
    const result = simulationSettingsSchema.parse(validSettings);
    expect(result.asOfDate).toBeUndefined();
    expect('asOfDate' in result).toBe(false);
  });

  it('accepts a pinned ISO date', () => {
    const result = simulationSettingsSchema.safeParse({ ...validSettings, asOfDate: '2026-03-15' });
    expect(result.success).toBe(true);
    expect(result.data?.asOfDate).toBe('2026-03-15');
  });

  it('rejects a non-ISO or impossible date', () => {
    const cases = ['2026-3-15', '03/15/2026', '2026-02-30', '2026-13-01', 'today'];
    for (const asOfDate of cases) {
      const result = simulationSettingsSchema.safeParse({ ...validSettings, asOfDate });
      expect(result.success, asOfDate).toBe(false);
    }
  });
});
