import { describe, it, expect } from 'vitest';

import {
  extractSimulationEvents,
  selectAnnotatedEvents,
  type SimulationEvent,
  type SimulationEventKind,
  type SimulationEventScope,
} from './annotations-extractor';
import { FinancialSimulationEngine } from '../simulation-engine';
import { FixedReturnsProvider } from '../returns-providers/fixed-returns-provider';
import {
  TEST_CLOCK,
  create401kAccount,
  createContributionRule,
  createDebtInput,
  createLivingExpense,
  createPhysicalAssetInput,
  createSavingsAccount,
  createSimulatorInputs,
  createWageIncome,
} from '../__tests__/test-utils';

/**
 * A plan with one known value for every annotation:
 *
 * - retirement at 65 (fixed age strategy),
 * - RMDs at 75 (birth year 1960+, so the engine's automatic RMD age),
 * - a 12 000 card at 0% APR paying 500/month, so it is paid off after exactly 24 months,
 * - a rental bought at 45 and sold at 60,
 * - a wage that runs from the first year to retirement (so no "income starts" event),
 * - living expenses that run to life expectancy (so no "expense ends" event).
 *
 * Returns and inflation are zero so the debt payoff is exact rather than approximate.
 */
function buildAnnotatedPlan() {
  const inputs = createSimulatorInputs({
    timeline: { lifeExpectancy: 87, birthMonth: 1, birthYear: 1990, retirementStrategy: { type: 'fixedAge', retirementAge: 65 } },
    marketAssumptions: { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 },
    incomes: { salary: createWageIncome({ amount: 120000 }) },
    expenses: { living: createLivingExpense({ amount: 40000 }) },
    accounts: { retirement: create401kAccount({ balance: 1500000 }) },
    contributionRules: { rule: createContributionRule({ accountId: '401k-1', contributionType: 'unlimited' }) },
    debts: { card: createDebtInput({ id: 'debt-1', name: 'Credit Card', balance: 12000, apr: 0, monthlyPayment: 500 }) },
    physicalAssets: {
      rental: createPhysicalAssetInput({
        id: 'asset-1',
        name: 'Rental',
        purchaseDate: { type: 'customAge', age: 45 },
        saleDate: { type: 'customAge', age: 60 },
        paymentMethod: { type: 'cash' },
      }),
    },
  });

  return new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
}

/** A plan with no debt and no physical assets: the instrument events must not appear. */
function buildQuietPlan() {
  const inputs = createSimulatorInputs({
    timeline: { lifeExpectancy: 87, birthMonth: 1, birthYear: 1990, retirementStrategy: { type: 'fixedAge', retirementAge: 65 } },
    incomes: { salary: createWageIncome({ amount: 80000 }) },
    expenses: { living: createLivingExpense({ amount: 30000 }) },
    // Savings only: no tax-deferred balance, so there is no RMD to report either.
    accounts: { savings: createSavingsAccount({ balance: 500000 }) },
  });

  return new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
}

const agesOf = (events: SimulationEvent[], kind: SimulationEventKind): number[] =>
  events
    .filter((event) => event.kind === kind)
    .map((event) => event.age)
    .sort((a, b) => a - b);

const syntheticEvent = (kind: SimulationEventKind, age: number, scope: SimulationEventScope, detail?: string): SimulationEvent => ({
  id: `${kind}:${age}:${detail ?? 'plan'}`,
  kind,
  age,
  label: kind,
  scope,
  ...(detail === undefined ? {} : { detail }),
});

describe('simulation event extraction', () => {
  const simulation = buildAnnotatedPlan();
  const events = extractSimulationEvents(simulation.data);

  it('marks the retirement phase change at the plan retirement age', () => {
    expect(agesOf(events, 'retirement')).toEqual([65]);
  });

  it('marks the RMD start on the first year that reports a required distribution', () => {
    expect(simulation.context.rmdAge).toBe(75);
    // The engine checks the RMD age at the start of each simulated year (its month 1), while
    // an annual data point reports the age at the END of that year. The check first passes
    // inside the year ending at 76.75, so the marker sits on floor(76.75) = 76 — the same year
    // whose row and bars include the distribution, which is what keeps the line aligned.
    expect(agesOf(events, 'rmdStart')).toEqual([76]);
    expect(agesOf(events, 'rmdStart')[0]).toBeGreaterThanOrEqual(simulation.context.rmdAge);
  });

  it('marks a debt payoff at the year the balance is cleared', () => {
    const startAge = Math.floor(simulation.context.startAge);
    const payoffs = events.filter((event) => event.kind === 'debtPayoff');

    expect(payoffs).toHaveLength(1);
    // 12 000 at 0% APR paying 500/month is 24 months, and neither returns nor inflation move
    // the payment, so the payoff lands exactly two simulated years in.
    expect(payoffs[0].age).toBe(startAge + 2);
    expect(payoffs[0]).toMatchObject({ scope: 'instrument', detail: 'Credit Card', label: 'Debt paid off' });
  });

  it('marks an asset purchase and an asset sale at their scheduled ages', () => {
    const purchase = events.find((event) => event.kind === 'assetPurchase');
    const sale = events.find((event) => event.kind === 'assetSale');

    expect(purchase).toMatchObject({ age: 45, scope: 'instrument', detail: 'Rental' });
    expect(sale).toMatchObject({ age: 60, scope: 'instrument', detail: 'Rental' });
  });

  it('marks the income boundary on the last year with any wage income', () => {
    // The wage ends at retirement, but the simulated year that contains the 65th birthday
    // still earns wages for its first months, so the last year with income floors to 65.
    expect(agesOf(events, 'incomeEnd')).toEqual([65]);
  });

  it('does not mark a boundary that never changes inside the plan', () => {
    // Income is active from the first simulated year and expenses run to life expectancy:
    // nothing changes on the chart, so there is nothing to annotate.
    expect(agesOf(events, 'incomeStart')).toEqual([]);
    expect(agesOf(events, 'expenseStart')).toEqual([]);
    expect(agesOf(events, 'expenseEnd')).toEqual([]);
  });

  it('returns events in age order with usable labels', () => {
    expect(events.map((event) => event.age)).toEqual([...events.map((event) => event.age)].sort((a, b) => a - b));

    for (const event of events) {
      expect(event.label.length, event.id).toBeGreaterThan(0);
      expect(Number.isInteger(event.age), event.id).toBe(true);
      expect(event.age, event.id).toBeGreaterThan(0);
      expect(['plan', 'instrument']).toContain(event.scope);
    }

    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it('produces no instrument event for a plan with no debt and no assets', () => {
    const quiet = extractSimulationEvents(buildQuietPlan().data);

    expect(quiet.filter((event) => event.kind === 'debtPayoff')).toEqual([]);
    expect(quiet.filter((event) => event.kind === 'assetPurchase')).toEqual([]);
    expect(quiet.filter((event) => event.kind === 'assetSale')).toEqual([]);
    expect(quiet.filter((event) => event.kind === 'rmdStart')).toEqual([]);
  });

  it('produces nothing for an empty simulation rather than a placeholder', () => {
    expect(extractSimulationEvents([])).toEqual([]);
  });

  it('is pure: repeat calls are equal and the input is not mutated', () => {
    const snapshot = structuredClone(simulation.data);
    const first = extractSimulationEvents(simulation.data);

    expect(extractSimulationEvents(simulation.data)).toEqual(first);
    expect(simulation.data).toEqual(snapshot);
  });
});

describe('annotation density', () => {
  const crowded: SimulationEvent[] = [
    syntheticEvent('retirement', 65, 'plan'),
    syntheticEvent('rmdStart', 75, 'plan'),
    syntheticEvent('incomeStart', 30, 'plan'),
    syntheticEvent('incomeEnd', 64, 'plan'),
    syntheticEvent('expenseStart', 31, 'plan'),
    syntheticEvent('expenseEnd', 80, 'plan'),
    syntheticEvent('debtPayoff', 40, 'instrument', 'card'),
    syntheticEvent('debtPayoff', 41, 'instrument', 'car'),
    syntheticEvent('assetSale', 50, 'instrument', 'rental'),
    syntheticEvent('assetPurchase', 45, 'instrument', 'boat'),
  ];

  it('caps how many events a small screen draws, keeping plan events first', () => {
    const mobile = selectAnnotatedEvents(crowded, { isSmallScreen: true });

    expect(mobile).toHaveLength(7);
    expect(mobile.filter((entry) => entry.event.scope === 'plan')).toHaveLength(6);
    expect(mobile.filter((entry) => entry.event.scope === 'instrument')).toHaveLength(1);
  });

  it('draws more events and more labels on a large screen', () => {
    expect(selectAnnotatedEvents(crowded, { isSmallScreen: false })).toHaveLength(10);
    expect(selectAnnotatedEvents(crowded, { isSmallScreen: false }).filter((entry) => entry.showLabel).length).toBeLessThanOrEqual(5);
    expect(selectAnnotatedEvents(crowded, { isSmallScreen: true }).filter((entry) => entry.showLabel).length).toBeLessThanOrEqual(2);
  });

  it('spaces labels so two never collide on a narrow chart', () => {
    const mobile = selectAnnotatedEvents(crowded, { isSmallScreen: true });
    const labelledAges = mobile.filter((entry) => entry.showLabel).map((entry) => entry.event.age);

    for (let index = 1; index < labelledAges.length; index++) {
      expect(labelledAges[index] - labelledAges[index - 1]).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps the drawn events in age order and is deterministic', () => {
    const first = selectAnnotatedEvents(crowded, { isSmallScreen: true });
    const ages = first.map((entry) => entry.event.age);

    expect(ages).toEqual([...ages].sort((a, b) => a - b));
    expect(selectAnnotatedEvents(crowded, { isSmallScreen: true })).toEqual(first);
  });
});
