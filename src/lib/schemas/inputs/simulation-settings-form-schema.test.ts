import { describe, it, expect } from 'vitest';

import { WITHDRAWAL_STRATEGY_IDS, WITHDRAWAL_STRATEGIES } from '@/lib/calc/withdrawal-strategies';

import { simulationSettingsSchema, withdrawalStrategies } from './simulation-settings-form-schema';

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

  it('leaves the historical backtest on its default (looping) when absent', () => {
    const result = simulationSettingsSchema.parse(validSettings);

    // Absent, not defaulted into the plan: a plan saved before P2-P4 keeps the wrapping behaviour
    // the engine applied by default, and `historicalBacktestMode()` reads the absence as 'looping'.
    expect('historicalBacktest' in result).toBe(false);
  });

  it('accepts both historical backtest modes', () => {
    for (const mode of ['looping', 'truncate'] as const) {
      const result = simulationSettingsSchema.safeParse({ ...validSettings, historicalBacktest: { mode } });
      expect(result.success, mode).toBe(true);
      expect(result.data?.historicalBacktest?.mode).toBe(mode);
    }
  });

  it('rejects an unknown historical backtest mode', () => {
    for (const mode of ['wrap', 'truncated', '', null]) {
      const result = simulationSettingsSchema.safeParse({ ...validSettings, historicalBacktest: { mode } });
      expect(result.success, String(mode)).toBe(false);
    }
  });
});

describe('simulationSettingsSchema withdrawalStrategy', () => {
  it('is optional, and absence stays absence: absent means ordered, not a stored value', () => {
    const result = simulationSettingsSchema.parse(validSettings);

    // Not defaulted into the plan: a plan saved before P1-P4 is read as `ordered` by the engine
    // (`getWithdrawalStrategy(undefined)`), so its numbers do not move and no value is invented.
    expect('withdrawalStrategy' in result).toBe(false);
    expect(result.withdrawalStrategy).toBeUndefined();
  });

  it('accepts exactly the strategies the engine ships, and nothing else', () => {
    // The enum is the registry's id list, so this pins the two together rather than restating it.
    expect(withdrawalStrategies).toStrictEqual(WITHDRAWAL_STRATEGY_IDS);
    expect([...withdrawalStrategies]).toStrictEqual(['ordered', 'vpw', 'xPercentRule', 'guytonKlinger']);

    for (const strategy of withdrawalStrategies) {
      const result = simulationSettingsSchema.safeParse({ ...validSettings, withdrawalStrategy: strategy });
      expect(result.success, strategy).toBe(true);
      expect(result.data?.withdrawalStrategy).toBe(strategy);
      // Every accepted id names a strategy the engine can actually resolve.
      expect(WITHDRAWAL_STRATEGIES[strategy].id).toBe(strategy);
    }
  });

  it('rejects a strategy id the engine does not have', () => {
    for (const withdrawalStrategy of ['static', 'ordered ', 'VPW', '', null]) {
      const result = simulationSettingsSchema.safeParse({ ...validSettings, withdrawalStrategy });
      expect(result.success, String(withdrawalStrategy)).toBe(false);
    }
  });
});
