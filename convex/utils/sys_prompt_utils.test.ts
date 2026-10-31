import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  timePointLabel,
  keyMetricsForDisplay,
  formatPlanData,
  buildTable,
  getSystemPrompt,
  withTaxOptimizationSkill,
  isTaxOptimizationConversation,
  resolveTaxOptimizationTurn,
  TAX_OPTIMIZATION_TOOLS_DISABLED_MESSAGE,
} from './sys_prompt_utils';
import { TAX_OPTIMIZATION_SKILL_MARKER } from '../prompts/tax-optimization';
import type { KeyMetrics } from '../validators/key_metrics_validator';
import type { SimulationResult } from '../validators/simulation_result_validator';
import type { Doc } from '../_generated/dataModel';

// --- formatNumber ---

describe('formatNumber', () => {
  it('formats billions', () => {
    expect(formatNumber(1500000000)).toBe('1.50B');
  });

  it('formats millions', () => {
    expect(formatNumber(2500000)).toBe('2.50M');
  });

  it('formats thousands', () => {
    expect(formatNumber(100000)).toBe('100.0k');
    expect(formatNumber(1000)).toBe('1.0k');
  });

  it('formats small numbers', () => {
    expect(formatNumber(999)).toBe('999.00');
    expect(formatNumber(0)).toBe('0.00');
  });

  it('handles negatives with prefix', () => {
    expect(formatNumber(-1500000, 2, '$')).toBe('-$1.50M');
    expect(formatNumber(-500, 2, '$')).toBe('-$500.00');
  });
});

// --- timePointLabel ---

describe('timePointLabel', () => {
  it('returns simple type labels', () => {
    expect(timePointLabel({ type: 'now' })).toBe('Now');
    expect(timePointLabel({ type: 'atRetirement' })).toBe('Retirement');
    expect(timePointLabel({ type: 'atLifeExpectancy' })).toBe('Life Expectancy');
  });

  it('formats customDate with month and year', () => {
    const result = timePointLabel({ type: 'customDate', month: 1, year: 2030 });
    expect(result).toBe('Jan 2030');
  });

  it('returns "Custom Date" when month/year missing', () => {
    expect(timePointLabel({ type: 'customDate' })).toBe('Custom Date');
    expect(timePointLabel({ type: 'customDate', month: 1 })).toBe('Custom Date');
    expect(timePointLabel({ type: 'customDate', year: 2030 })).toBe('Custom Date');
  });

  it('formats customAge and handles fallback', () => {
    expect(timePointLabel({ type: 'customAge', age: 65 })).toBe('Age 65');
    expect(timePointLabel({ type: 'customAge' })).toBe('Custom Age');
  });
});

// --- keyMetricsForDisplay ---

describe('keyMetricsForDisplay', () => {
  const baseMetrics: Omit<KeyMetrics, 'type'> = {
    success: 1,
    retirementAge: 65,
    yearsToRetirement: 30,
    bankruptcyAge: null,
    yearsToBankruptcy: null,
    portfolioAtRetirement: 2000000,
    lifetimeTaxesAndPenalties: 500000,
    finalPortfolio: 3000000,
    progressToRetirement: 0.75,
  };

  it('single type: success >= 0.99 shows "Yes!", <= 0.01 shows "No"', () => {
    const yesResult = keyMetricsForDisplay({ type: 'single', ...baseMetrics, success: 0.99 });
    expect(yesResult.successForDisplay).toBe('Yes!');

    const noResult = keyMetricsForDisplay({ type: 'single', ...baseMetrics, success: 0.01 });
    expect(noResult.successForDisplay).toBe('No');

    const midResult = keyMetricsForDisplay({ type: 'single', ...baseMetrics, success: 0.5 });
    expect(midResult.successForDisplay).toBe('50.0%');
  });

  it('single type: null retirement/bankruptcy age shows infinity', () => {
    const result = keyMetricsForDisplay({ type: 'single', ...baseMetrics, retirementAge: null, bankruptcyAge: null });
    expect(result.retirementAgeForDisplay).toBe('∞');
    expect(result.bankruptcyAgeForDisplay).toBe('∞');
  });

  it('multi type: success always as percentage', () => {
    const result = keyMetricsForDisplay({
      type: 'multi',
      ...baseMetrics,
      success: 0.99,
      chanceOfRetirement: 0.95,
      chanceOfBankruptcy: 0.05,
      minRetirementAge: 60,
      maxRetirementAge: 70,
      minBankruptcyAge: null,
      maxBankruptcyAge: null,
    });
    expect(result.successForDisplay).toBe('99.0%');
  });

  it('null portfolio values show "N/A"', () => {
    const result = keyMetricsForDisplay({
      type: 'single',
      ...baseMetrics,
      portfolioAtRetirement: null,
      progressToRetirement: null,
    });
    expect(result.portfolioAtRetirementForDisplay).toBe('N/A');
    expect(result.progressToRetirementForDisplay).toBe('N/A');
  });
});

// --- formatPlanData ---

describe('formatPlanData', () => {
  // Minimal plan doc shape for testing
  function makePlanDoc(overrides: Partial<Doc<'plans'>> = {}): Doc<'plans'> {
    return {
      _id: 'test-plan-id' as unknown as Doc<'plans'>['_id'],
      _creationTime: Date.now(),
      userId: 'test-user',
      name: 'Test Plan',
      isDefault: true,
      timeline: {
        birthMonth: 6,
        birthYear: 1990,
        lifeExpectancy: 85,
        retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
      },
      incomes: [
        {
          id: 'inc-1',
          name: 'Salary',
          amount: 100000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
          taxes: { incomeType: 'wage', withholding: 20 },
          disabled: false,
        },
      ],
      expenses: [
        {
          id: 'exp-1',
          name: 'Living',
          amount: 50000,
          frequency: 'yearly',
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          disabled: false,
        },
      ],
      debts: [
        {
          id: 'debt-1',
          name: 'Car Loan',
          balance: 20000,
          apr: 5,
          interestType: 'compound',
          compoundingFrequency: 'monthly',
          monthlyPayment: 400,
          startDate: { type: 'now' },
        },
      ],
      physicalAssets: [],
      accounts: [{ id: 'acc-1', name: 'My 401k', type: '401k', balance: 50000, percentBonds: 20 }],
      contributionRules: [
        { id: 'cr-1', accountId: 'acc-1', rank: 1, amount: { type: 'unlimited' }, disabled: false },
        { id: 'cr-2', accountId: 'acc-1', rank: 2, amount: { type: 'unlimited' }, disabled: true },
      ],
      baseContributionRule: { type: 'spend' },
      marketAssumptions: { stockReturn: 10, stockYield: 3.5, bondReturn: 5, bondYield: 4.5, cashReturn: 3, inflationRate: 3 },
      taxSettings: { filingStatus: 'single' },
      privacySettings: { isPrivate: true },
      simulationSettings: { simulationMode: 'fixedReturns', simulationSeed: 9521 },
      ...overrides,
    } as Doc<'plans'>;
  }

  it('formats full plan with all entity types populated', () => {
    const result = formatPlanData(makePlanDoc());

    expect(result).toContain('Timeline:');
    expect(result).toContain('Life Expectancy: 85');
    expect(result).toContain('Retirement Age: 65');
    expect(result).toContain('Incomes: Salary');
    expect(result).toContain('$100.0k');
    expect(result).toContain('Expenses: Living');
    expect(result).toContain('Debts: Car Loan');
    expect(result).toContain('Accounts: My 401k');
    expect(result).toContain('401(k)');
    expect(result).toContain('Contributions');
    expect(result).toContain('Filing Status: single');
    expect(result).toContain('Simulation Mode: fixedReturns');
  });

  it('handles empty arrays with "None" for each section', () => {
    const result = formatPlanData(
      makePlanDoc({
        timeline: null,
        incomes: [],
        expenses: [],
        debts: [],
        physicalAssets: [],
        accounts: [],
        contributionRules: [],
      })
    );

    expect(result).toContain('Incomes: None');
    expect(result).toContain('Expenses: None');
    expect(result).toContain('Debts: None');
    expect(result).toContain('Physical Assets: None');
    expect(result).toContain('Accounts: None');
    expect(result).toContain('Contributions: None');
    expect(result).not.toContain('Timeline:');
  });

  it('filters out disabled contribution rules', () => {
    const result = formatPlanData(makePlanDoc());

    // Only 1 enabled rule (cr-1), the disabled one (cr-2) should not appear
    // The contributions section should show the one enabled rule
    expect(result).toContain('Contributions (in priority order):');
    // The account name for cr-1 is "My 401k"
    expect(result).toContain('My 401k');
  });
});

// --- buildTable ---

describe('buildTable', () => {
  function makeDataPoint(
    overrides: Partial<SimulationResult['simulationResult'][number]> = {}
  ): SimulationResult['simulationResult'][number] {
    return {
      age: 30,
      phaseName: 'accum',
      netWorth: 0,
      stockHoldings: 0,
      bondHoldings: 0,
      cashHoldings: 0,
      taxableValue: 0,
      taxDeferredValue: 0,
      taxFreeValue: 0,
      cashSavings: 0,
      totalValue: 0,
      earnedIncome: 0,
      socialSecurityIncome: 0,
      taxFreeIncome: 0,
      retirementDistributions: 0,
      interestIncome: 0,
      realizedGains: 0,
      dividendIncome: 0,
      taxesAndPenalties: 0,
      expenses: 0,
      surplusDeficit: 0,
      savingsRate: null,
      netCashFlow: 0,
      grossIncome: 0,
      adjustedGrossIncome: 0,
      taxableIncome: 0,
      ficaTax: 0,
      federalIncomeTax: 0,
      capitalGainsTax: 0,
      niit: 0,
      earlyWithdrawalPenalties: 0,
      netInvestmentIncome: 0,
      effectiveFederalIncomeTaxRate: 0,
      topMarginalFederalIncomeTaxRate: 0,
      effectiveCapitalGainsTaxRate: 0,
      topMarginalCapitalGainsTaxRate: 0,
      taxDeductibleContributions: 0,
      capitalLossDeduction: 0,
      totalContributions: 0,
      taxableContributions: 0,
      taxDeferredContributions: 0,
      taxFreeContributions: 0,
      cashContributions: 0,
      employerMatch: 0,
      totalWithdrawals: 0,
      taxableWithdrawals: 0,
      taxDeferredWithdrawals: 0,
      taxFreeWithdrawals: 0,
      cashWithdrawals: 0,
      requiredMinimumDistributions: 0,
      annualRothConversions: 0,
      earlyWithdrawals: 0,
      rothEarningsWithdrawals: 0,
      withdrawalRate: null,
      unsecuredDebtBalance: 0,
      securedDebtBalance: 0,
      debtPayments: 0,
      debtPaydown: 0,
      debtPayoff: 0,
      debtIncurred: 0,
      assetValue: 0,
      assetEquity: 0,
      assetPurchaseOutlay: 0,
      assetSaleProceeds: 0,
      assetAppreciation: 0,
      realStockReturnRate: 0,
      realBondReturnRate: 0,
      realCashReturnRate: 0,
      inflationRate: 0,
      annualStockGain: 0,
      annualBondGain: 0,
      annualCashGain: 0,
      totalAnnualGains: 0,
      ...overrides,
    };
  }

  it('omits columns that are all zero/null across all rows', () => {
    const data = [
      makeDataPoint({ age: 30, totalValue: 100000, stockHoldings: 80000 }),
      makeDataPoint({ age: 31, totalValue: 110000, stockHoldings: 90000 }),
    ];

    const columns = [
      { header: 'total', value: (d: (typeof data)[number]) => d.totalValue, format: (n: number) => `$${n}` },
      { header: 'stocks', value: (d: (typeof data)[number]) => d.stockHoldings, format: (n: number) => `$${n}` },
      { header: 'bonds', value: (d: (typeof data)[number]) => d.bondHoldings, format: (n: number) => `$${n}` },
    ];

    const result = buildTable('Test', data, columns);
    expect(result).not.toBeNull();
    expect(result).toContain('total');
    expect(result).toContain('stocks');
    expect(result).not.toContain('bonds');
  });

  it('returns null when no columns have data', () => {
    const data = [makeDataPoint({ age: 30 }), makeDataPoint({ age: 31 })];

    const columns = [
      { header: 'bonds', value: (d: (typeof data)[number]) => d.bondHoldings, format: (n: number) => `$${n}` },
      { header: 'cash', value: (d: (typeof data)[number]) => d.cashHoldings, format: (n: number) => `$${n}` },
    ];

    const result = buildTable('Empty', data, columns);
    expect(result).toBeNull();
  });
});

// --- tax-optimization skill (§7-A2) ---

/** A plan just complete enough for `getSystemPrompt` to render. */
function makeSkillPlanDoc(): Doc<'plans'> {
  return {
    _id: 'skill-plan-id' as unknown as Doc<'plans'>['_id'],
    _creationTime: 0,
    userId: 'test-user',
    name: 'Skill Plan',
    isDefault: true,
    timeline: {
      birthMonth: 1,
      birthYear: 1990,
      lifeExpectancy: 87,
      retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
    },
    incomes: [],
    expenses: [],
    debts: [],
    physicalAssets: [],
    accounts: [],
    contributionRules: [],
    baseContributionRule: { type: 'save' },
    marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
    taxSettings: { filingStatus: 'single' },
    privacySettings: { isPrivate: true },
    simulationSettings: { simulationMode: 'fixedReturns', simulationSeed: 1 },
  } as Doc<'plans'>;
}

describe('withTaxOptimizationSkill', () => {
  it('leaves the base prompt alone when the skill is not used', () => {
    const base = getSystemPrompt(makeSkillPlanDoc(), null);
    expect(base).not.toContain(TAX_OPTIMIZATION_SKILL_MARKER);
  });

  it('appends the skill prompt and its marker after the base', () => {
    const base = getSystemPrompt(makeSkillPlanDoc(), null);
    const withSkill = withTaxOptimizationSkill(base);

    expect(withSkill).toContain(TAX_OPTIMIZATION_SKILL_MARKER);
    expect(withSkill.length).toBeGreaterThan(base.length);
    // The base prompt survives intact: the skill is appended, never substituted.
    expect(withSkill.startsWith(base.trimEnd())).toBe(true);
    expect(withSkill).toContain('## Stance: rank, never recommend');
  });
});

describe('isTaxOptimizationConversation', () => {
  it('is true when the stored prompt carries the marker', () => {
    expect(isTaxOptimizationConversation({ systemPrompt: `${TAX_OPTIMIZATION_SKILL_MARKER}\n# Tax-optimization skill (v1)` })).toBe(true);
  });

  it('is false for a plain chat', () => {
    expect(isTaxOptimizationConversation({ systemPrompt: 'You are an educational assistant for Ignidash.' })).toBe(false);
  });

  it('is false when the conversation has no stored prompt', () => {
    expect(isTaxOptimizationConversation({ systemPrompt: undefined })).toBe(false);
    expect(isTaxOptimizationConversation({})).toBe(false);
    expect(isTaxOptimizationConversation(null)).toBe(false);
  });
});

describe('resolveTaxOptimizationTurn', () => {
  const marked = { systemPrompt: `${TAX_OPTIMIZATION_SKILL_MARKER}\n# Tax-optimization skill (v1)` };
  const plain = { systemPrompt: 'You are an educational assistant for Ignidash.' };

  it('enables the skill on creation when it is requested and tool calling is on', () => {
    expect(resolveTaxOptimizationTurn({ requested: true, isNewConversation: true, conversation: null, toolsEnabled: true })).toEqual({
      enabled: true,
    });
  });

  it('refuses on creation when tool calling is off (F4)', () => {
    expect(resolveTaxOptimizationTurn({ requested: true, isNewConversation: true, conversation: null, toolsEnabled: false })).toEqual({
      enabled: false,
      refusal: TAX_OPTIMIZATION_TOOLS_DISABLED_MESSAGE,
    });
  });

  it('opens a plain chat when the skill is not requested', () => {
    for (const requested of [false, undefined]) {
      expect(resolveTaxOptimizationTurn({ requested, isNewConversation: true, conversation: null, toolsEnabled: true })).toEqual({
        enabled: false,
      });
    }
  });

  it('derives later turns from the stored prompt, not from the request', () => {
    // The prompt is rebuilt from the plan every turn, so only the stored marker survives.
    expect(
      resolveTaxOptimizationTurn({ requested: undefined, isNewConversation: false, conversation: marked, toolsEnabled: true })
    ).toEqual({ enabled: true });
    expect(resolveTaxOptimizationTurn({ requested: false, isNewConversation: false, conversation: marked, toolsEnabled: true })).toEqual({
      enabled: true,
    });
    expect(resolveTaxOptimizationTurn({ requested: true, isNewConversation: false, conversation: plain, toolsEnabled: true })).toEqual({
      enabled: false,
    });
  });

  it('does not refuse a later turn when tool calling was disabled after creation', () => {
    expect(
      resolveTaxOptimizationTurn({ requested: undefined, isNewConversation: false, conversation: marked, toolsEnabled: false })
    ).toEqual({ enabled: true });
  });
});
