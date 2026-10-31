// @vitest-environment jsdom
/**
 * The compare view (P2-P5).
 *
 * Two things the user relies on: the one clock/seed both plans share, and deltas that read as
 * signed differences (`A − B`, positive means A is larger). `comparePlans` is stubbed with a
 * faithful 17-metric report so the formatting is asserted exactly; the core's own numbers are
 * covered by `src/lib/calc/compare.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { CompareMetric, CompareReport } from '@/lib/calc/compare';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { currentLocalISODate } from '@/lib/utils/system-clock';

const { comparePlans, plans, inputsByPlanId } = vi.hoisted(() => {
  return {
    comparePlans: vi.fn(),
    plans: [] as Array<{ _id: string; name: string }>,
    inputsByPlanId: {} as Record<string, unknown>,
  };
});

vi.mock('@convex-dev/better-auth/nextjs/client', () => ({ usePreloadedAuthQuery: () => plans }));
vi.mock('@/lib/calc/compare', () => ({ comparePlans }));
vi.mock('@/lib/utils/data-transformers', () => ({ simulatorFromConvex: (plan: { _id: string }) => inputsByPlanId[plan._id] }));
vi.mock('@/lib/stores/simulator-store', () => ({
  getIsCalculationReady: () => ({
    timelineIsReady: true,
    accountsAreReady: true,
    incomesAreReady: true,
    expensesAreReady: true,
  }),
}));

import CompareView from './compare-view';

const metric = (
  id: string,
  label: string,
  group: CompareMetric['group'],
  format: CompareMetric['format'],
  a: number | null,
  b: number | null
): CompareMetric => ({
  id,
  label,
  group,
  format,
  a,
  b,
  delta: a === null && b === null ? 0 : a === null || b === null ? null : a - b,
});

/** The real report's 17 metrics, with the signs this test asserts. */
const metrics: CompareMetric[] = [
  metric('finalPortfolioValue', 'Final portfolio value', 'projection', 'currency', 1_200_000, 1_000_000),
  metric('success', 'Success', 'projection', 'flag', 1, 1),
  metric('retirementAge', 'Retirement age', 'projection', 'age', 62, 60),
  metric('bankruptcyAge', 'Bankruptcy age', 'projection', 'age', null, 85),
  metric('lifetimeTaxesAndPenalties', 'Lifetime taxes and penalties', 'taxes', 'currency', 150_000, 210_000),
  metric('lifetimeFederalIncomeTax', 'Federal income tax', 'taxes', 'currency', 100_000, 100_000),
  metric('lifetimeFicaTax', 'FICA tax', 'taxes', 'currency', 30_000, 40_000),
  metric('lifetimeCapitalGainsTax', 'Capital gains tax', 'taxes', 'currency', 15_000, 60_000),
  metric('lifetimeNiit', 'Net investment income tax', 'taxes', 'currency', 0, 0),
  metric('lifetimeEarlyWithdrawalPenalties', 'Early withdrawal penalties', 'taxes', 'currency', 5_000, 10_000),
  metric('monteCarloSuccessRate', 'Monte Carlo success rate', 'monteCarlo', 'percentage', 0.92, 0.81),
  metric('monteCarloMeanFinalValue', 'Mean final value', 'monteCarlo', 'currency', 1_350_000, 1_150_000),
  metric('monteCarloP10FinalValue', 'P10 final value', 'monteCarlo', 'currency', 400_000, 500_000),
  metric('monteCarloP50FinalValue', 'P50 final value', 'monteCarlo', 'currency', 1_300_000, 1_100_000),
  metric('monteCarloP90FinalValue', 'P90 final value', 'monteCarlo', 'currency', 2_400_000, 2_100_000),
  metric('monteCarloRetirementAge', 'Mean retirement age', 'monteCarlo', 'age', 61.5, 59),
  metric('monteCarloBankruptcyAge', 'Mean bankruptcy age', 'monteCarlo', 'age', null, null),
];

const report: CompareReport = {
  asOf: '2026-03-15',
  seed: 9521,
  trials: 500,
  deltaMeaning: 'a - b',
  metrics,
  yearly: [
    { year: 0, age: 40, a: 500_000, b: 500_000, delta: 0 },
    { year: 1, age: 41, a: 540_000, b: 520_000, delta: 20_000 },
    { year: 2, age: 42, a: 560_000, b: 590_000, delta: -30_000 },
  ],
};

const planInputs = (seed: number, asOfDate?: string): SimulatorInputs =>
  ({
    simulationSettings: { simulationSeed: seed, simulationMode: 'fixedReturns', ...(asOfDate ? { asOfDate } : {}) },
  }) as unknown as SimulatorInputs;

/**
 * Plan A pins the clock; plan B pins a different one and carries a different seed. The view must
 * hand `comparePlans` one clock and one seed for both sides.
 */
const setUpPlans = () => {
  plans.splice(
    0,
    plans.length,
    { _id: 'plan-a', name: 'Retire early' },
    { _id: 'plan-b', name: 'Work longer' },
    { _id: 'plan-c', name: 'Sabbatical' }
  );
  for (const key of Object.keys(inputsByPlanId)) delete inputsByPlanId[key];
  inputsByPlanId['plan-a'] = planInputs(9521, '2026-03-15');
  inputsByPlanId['plan-b'] = planInputs(1111, '2020-01-01');
  inputsByPlanId['plan-c'] = planInputs(4242, '2024-06-30');

  comparePlans.mockReturnValue(report);
};

const renderView = () => render(<CompareView preloadedPlans={{} as Parameters<typeof CompareView>[0]['preloadedPlans']} />);

const runComparison = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  await waitFor(() => expect(comparePlans).toHaveBeenCalledTimes(1));
};

beforeEach(setUpPlans);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('what the comparison is run with', () => {
  it('compares the first two plans by default on one shared clock and seed', async () => {
    renderView();
    await runComparison();

    expect(comparePlans).toHaveBeenCalledWith(planInputs(9521, '2026-03-15'), planInputs(1111, '2020-01-01'), {
      asOf: '2026-03-15',
      seed: 9521,
    });
    // The note under the button states the clock and seed the numbers came from.
    expect(screen.getByText(/Seed: 9521/)).toBeTruthy();
    expect(screen.getByText(/As of 2026-03-15/)).toBeTruthy();
  });

  it('uses today when neither plan pins a date, and still shares it', async () => {
    inputsByPlanId['plan-a'] = planInputs(777);
    inputsByPlanId['plan-b'] = planInputs(888);
    renderView();
    await runComparison();

    expect(comparePlans).toHaveBeenCalledWith(planInputs(777), planInputs(888), { asOf: currentLocalISODate(), seed: 777 });
  });

  it('uses the reference plan`s pinned date when the subject has none', async () => {
    inputsByPlanId['plan-a'] = planInputs(9521);
    inputsByPlanId['plan-b'] = planInputs(1111, '2021-07-04');
    renderView();
    await runComparison();

    // The seed still comes from plan A; the clock is whichever plan pins one, then today.
    expect(comparePlans).toHaveBeenCalledWith(planInputs(9521), planInputs(1111, '2021-07-04'), { asOf: '2021-07-04', seed: 9521 });
  });

  it('compares the plan the user selects', async () => {
    renderView();

    fireEvent.change(screen.getByLabelText('Plan B (reference)'), { target: { value: 'plan-c' } });
    await runComparison();

    expect(comparePlans).toHaveBeenCalledWith(planInputs(9521, '2026-03-15'), planInputs(4242, '2024-06-30'), {
      asOf: '2026-03-15',
      seed: 9521,
    });
    // The metrics card names the two plans the numbers belong to.
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'Retire early vs Sabbatical')).toBeTruthy();
  });
});

describe('the metrics table', () => {
  it('renders all 17 metrics, grouped', async () => {
    renderView();
    await runComparison();

    // One table per group, then the yearly table.
    expect(screen.getAllByRole('table')).toHaveLength(4);
    expect(screen.getByText('Projection')).toBeTruthy();
    expect(screen.getByText('Lifetime taxes')).toBeTruthy();
    expect(screen.getByText('Monte Carlo')).toBeTruthy();

    // 17 data rows across the three group tables, one per metric.
    const groupTables = screen.getAllByRole('table').slice(0, 3);
    const dataRows = groupTables.flatMap((table) => within(table).getAllByRole('row').slice(1));
    expect(dataRows).toHaveLength(17);

    // Every row sits under the group its metric belongs to.
    for (const expected of metrics) {
      const row = screen.getByText(expected.label).closest('tr');
      const owningTable = groupTables.findIndex((table) => table.contains(row));
      expect(owningTable, expected.label).toBe(['projection', 'taxes', 'monteCarlo'].indexOf(expected.group));
    }
  });

  it('renders each delta signed, as A − B', async () => {
    renderView();
    await runComparison();

    const cell = (label: string) => screen.getByText(label).closest('tr')?.querySelectorAll('td')[3]?.textContent;

    // Positive: A is larger.
    expect(cell('Final portfolio value')).toBe('+$200,000');
    expect(cell('Retirement age')).toBe('+2.0');
    expect(cell('Monte Carlo success rate')).toBe('+11.0%');
    // Negative: B is larger (more lifetime tax is worse, so the sign is meaningful).
    expect(cell('Lifetime taxes and penalties')).toBe('-$60,000');
    expect(cell('P10 final value')).toBe('-$100,000');
    expect(cell('Mean retirement age')).toBe('+2.5');
    // Zero and "one side has nothing" are not signed.
    expect(cell('Federal income tax')).toBe('$0');
    expect(cell('Bankruptcy age')).toBe('—');
    // Flags compare as words, not numbers.
    expect(cell('Success')).toBe('Same');
  });

  it('renders the A and B values beside the delta', async () => {
    renderView();
    await runComparison();

    const row = screen.getByText('Final portfolio value').closest('tr');
    const cells = Array.from(row?.querySelectorAll('td') ?? []).map((td) => td.textContent);

    expect(cells).toEqual(['Final portfolio value', '$1,200,000', '$1,000,000', '+$200,000']);
  });
});

describe('the yearly table', () => {
  it('signs the portfolio difference for every year', async () => {
    renderView();
    await runComparison();

    const table = screen.getAllByRole('table')[3];
    const rows = within(table).getAllByRole('row').slice(1);
    const deltas = rows.map((row) => row.querySelectorAll('td')[4].textContent);

    expect(deltas).toEqual(['$0', '+$20,000', '-$30,000']);
  });
});

describe('with no plans', () => {
  it('explains that a plan has to exist first', () => {
    plans.splice(0, plans.length);
    renderView();

    expect(screen.getByText(/No plans yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
  });
});
