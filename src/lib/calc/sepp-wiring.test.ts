import { describe, it, expect } from 'vitest';
import { simulate } from './simulate';
import { createSimulatorInputs, createDefaultTimeline } from './__tests__/test-utils';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

describe('SEPP engine execution (R7, IRC §72(t)(2)(A)(iv) and §72(t)(4))', () => {
  it('exempts distributions under an active SEPP schedule from the 10% early withdrawal penalty', () => {
    // Single taxpayer age 50 in 2026 (born 1976-01-01).
    // Starting balance in traditional IRA: $500,000.
    // SEPP schedule: $25,000 annual distribution under fixed amortization.
    const base = createSimulatorInputs();
    const inputsWithSepp: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1976,
        birthMonth: 1,
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
      },
      sepp: [
        {
          id: 'sepp-1',
          name: 'SEPP Schedule',
          accountId: 'ira-1',
          method: 'fixedAmortization',
          startYear: 2026,
          annualAmount: 25_000,
        },
      ],
      taxSettings: {
        ...base.taxSettings,
        filingStatus: 'single',
        stateResidency: 'none',
      },
    };

    const runWithSepp = simulate(inputsWithSepp, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1 = runWithSepp.result.data[1]; // 2026 settlement

    // The $25,000 SEPP distribution is taxable ordinary income...
    expect(year1.taxes?.incomeSources.taxDeferredWithdrawals).toBe(25_000);
    // ...but is EXEMPT from early withdrawal penalties under IRC §72(t)(2)(A)(iv)!
    expect(year1.taxes?.incomeSources.earlyWithdrawals['401kAndIra']).toBe(0);
    expect(year1.taxes?.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
    expect(year1.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);

    // Contrast with the same plan without SEPP where the $25,000 is taken as a regular early withdrawal:
    const inputsWithoutSepp: SimulatorInputs = {
      ...inputsWithSepp,
      sepp: undefined,
      expenses: {
        'living-1': {
          id: 'living-1',
          name: 'Living Expense',
          amount: 25_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
    };

    const runWithoutSepp = simulate(inputsWithoutSepp, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1WithoutSepp = runWithoutSepp.result.data[1];

    // Regular withdrawal before age 59½ incurs 10% penalty:
    expect(year1WithoutSepp.taxes?.incomeSources.earlyWithdrawals['401kAndIra']).toBeGreaterThan(25_000);
    expect(year1WithoutSepp.taxes?.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(
      year1WithoutSepp.taxes!.incomeSources.earlyWithdrawals['401kAndIra'] * 0.1
    );
    expect(year1WithoutSepp.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(
      year1WithoutSepp.taxes!.incomeSources.earlyWithdrawals['401kAndIra'] * 0.1
    );
  });

  it('assesses 10% recapture penalty under §72(t)(4) when stopped before 5 years or age 59½', () => {
    // Age 50 in 2026 (born 1976-01-01).
    // SEPP starts in 2026 with $20,000/yr.
    // 5 years is 2031-01-01; age 59½ is 2035-07-01.
    // Must continue until the later: 2035-07-01.
    // Taxpayer stops in 2029 (stopYear: 2029), having taken 3 payments (2026, 2027, 2028 = $60,000 total).
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1976,
        birthMonth: 1,
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
      },
      sepp: [
        {
          id: 'sepp-1',
          accountId: 'ira-1',
          method: 'fixedAmortization',
          startYear: 2026,
          annualAmount: 20_000,
          stopYear: 2029,
        },
      ],
      taxSettings: {
        ...base.taxSettings,
        filingStatus: 'single',
        stateResidency: 'none',
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    // Years 1, 2, 3 (2026, 2027, 2028): no penalty
    expect(run.result.data[1].taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
    expect(run.result.data[2].taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
    expect(run.result.data[3].taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);

    // Year 4 (2029): premature stoppage triggers §72(t)(4) recapture:
    // 10% on all cumulative prior distributions ($60,000) = $6,000!
    const year4 = run.result.data[4];
    expect(year4.taxes?.incomeSources.earlyWithdrawals.seppRecapture).toBe(60_000);
    expect(year4.taxes?.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(6_000);
    expect(year4.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(6_000);
  });

  it('assesses California 2.5% recapture penalty under FTB 3805P for CA residents', () => {
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1976,
        birthMonth: 1,
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
      },
      sepp: [
        {
          id: 'sepp-1',
          accountId: 'ira-1',
          method: 'fixedAmortization',
          startYear: 2026,
          annualAmount: 20_000,
          stopYear: 2029,
        },
      ],
      taxSettings: {
        ...base.taxSettings,
        filingStatus: 'single',
        stateResidency: 'CA',
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year4 = run.result.data[4];

    // Federal 10% ($6,000) + California 2.5% ($1,500) = $7,500 total penalty:
    expect(year4.taxes?.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(6_000);
    expect(year4.taxes?.earlyWithdrawalPenalties.californiaPenaltyAmount).toBe(1_500);
    expect(year4.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(7_500);
  });

  it('permits termination without recapture after both 5 years and age 59½', () => {
    // Age 56 in 2026 (born 1970-01-01).
    // Reaches age 59½ in 2029 (July 2029).
    // 5-year requirement requires continuation through 2031-01-01.
    // Later date is 2031-01-01.
    // Schedule stops in 2031 (after 5 full years: 2026, 2027, 2028, 2029, 2030).
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1970,
        birthMonth: 1,
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
      },
      sepp: [
        {
          id: 'sepp-1',
          accountId: 'ira-1',
          method: 'fixedAmortization',
          startYear: 2026,
          annualAmount: 20_000,
          stopYear: 2031,
        },
      ],
      taxSettings: {
        ...base.taxSettings,
        filingStatus: 'single',
        stateResidency: 'none',
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    // Year 6 (2031): stopped after fulfilling both requirements -> NO recapture penalty!
    const year6 = run.result.data[6];
    expect(year6.taxes?.incomeSources.earlyWithdrawals.seppRecapture).toBeUndefined();
    expect(year6.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
  });
});
