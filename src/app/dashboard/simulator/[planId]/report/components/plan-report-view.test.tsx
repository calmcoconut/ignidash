// @vitest-environment jsdom
/**
 * The printable report (P4-P5).
 *
 * The view is pure layout over `buildPlanReport`: the numbers are whatever the simulation and the
 * extractors produced, so these tests assert that the report it derives is what reaches the page —
 * facts, assumptions, milestones and the three year-by-year tables — and that the print button
 * asks the browser to print.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { simulate } from '@/lib/calc/simulate';
import type { SimulationResult } from '@/lib/calc/simulation-engine';
import { KeyMetricsExtractor } from '@/lib/calc/data-extractors/key-metrics-extractor';
import type { SingleSimulationKeyMetrics } from '@/lib/types/key-metrics';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { buildPlanReport } from '@/lib/utils/plan-report';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createWageIncome,
} from '@/lib/calc/__tests__/test-utils';

const { store } = vi.hoisted(() => ({
  store: {} as { simulation: SimulationResult | null; keyMetrics: SingleSimulationKeyMetrics | null },
}));

vi.mock('@/lib/stores/simulator-store', () => ({
  useSimulationResult: () => store.simulation,
  useKeyMetrics: () => store.keyMetrics,
}));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));

import PlanReportView from './plan-report-view';

const AS_OF = '2026-03-15';
const SEED = 9521;

const inputs: SimulatorInputs = createSimulatorInputs({
  timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 88 },
  accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 500_000 }) },
  incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90_000 }) },
  expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 60_000 }) },
  contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
  simulationSettings: { simulationSeed: SEED, simulationMode: 'fixedReturns', asOfDate: AS_OF },
});

const simulation = simulate(inputs, { mode: 'fixedReturns', seed: SEED, asOf: AS_OF }).result;
const keyMetrics = KeyMetricsExtractor.extractSingleSimulationMetrics(simulation);
const report = buildPlanReport({ planName: 'Retire early', inputs, simulation, keyMetrics, modeLabel: 'Fixed returns' });

/** The section a heading belongs to, so a repeated label is read in the right list. */
const sectionFor = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

/** The value printed beside a label, inside one section. */
const factValue = (scope: HTMLElement, label: string) => within(scope).getByText(label).parentElement?.querySelector('dd')?.textContent;

beforeAll(() => {
  store.simulation = simulation;
  store.keyMetrics = keyMetrics;
});

afterAll(() => {
  store.simulation = null;
  store.keyMetrics = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the printed report', () => {
  it('names the plan and the date the projection starts', () => {
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    expect(screen.getByText(report.title)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Retire early');
    expect(
      screen.getByText(`Projection starting ${report.asOf}, printed from the same simulation and extractors as the on-screen results.`)
    ).toBeTruthy();
  });

  it('prints every key result and assumption the report derived', () => {
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    const keyResults = sectionFor('Key results');
    for (const fact of report.facts) {
      expect(factValue(keyResults, fact.label), fact.label).toBe(fact.value);
    }
    const assumptions = sectionFor('Assumptions');
    for (const assumption of report.assumptions) {
      expect(factValue(assumptions, assumption.label), assumption.label).toBe(assumption.value);
    }
    // The small print travels with the numbers.
    expect(screen.getByText('For educational purposes only.')).toBeTruthy();
  });

  it('prints one table per section, with the year-by-year rows', () => {
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    expect(screen.getAllByRole('table')).toHaveLength(report.sections.length);

    const netWorth = report.sections[0];
    const table = screen.getByText(netWorth.title).closest('section')?.querySelector('table');
    expect(table).toBeTruthy();
    const rows = within(table as HTMLElement).getAllByRole('row');
    expect(rows).toHaveLength(netWorth.rows.length + 1); // header plus one row per simulated year
    expect(rows[1].textContent).toContain(netWorth.columns[0].format(netWorth.rows[0][netWorth.columns[0].key]));
  });

  it('asks the browser to print when the button is pressed', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    fireEvent.click(screen.getByRole('button', { name: /Print \/ save as PDF/ }));

    expect(print).toHaveBeenCalledTimes(1);
  });

  it('links back to the results page of the same plan', () => {
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    expect(screen.getByRole('link', { name: /Back to results/ }).getAttribute('href')).toBe('/dashboard/simulator/plan-1');
  });
});

describe('the mode label printed with the assumptions', () => {
  it('names the seed for a Monte Carlo run, because the numbers depend on it', () => {
    const monteCarloInputs: SimulatorInputs = {
      ...inputs,
      simulationSettings: { ...inputs.simulationSettings, simulationMode: 'monteCarloStochasticReturns' },
    };

    render(<PlanReportView inputs={monteCarloInputs} planName="Retire early" />);

    // `monteCarloStochasticReturns` prints on the stochastic single-run page shape, with the seed.
    expect(factValue(sectionFor('Assumptions'), 'Simulation mode')).toBe(`Stochastic returns (seed ${SEED})`);
  });

  it('does not print a seed for a fixed-returns run, which has none', () => {
    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    expect(factValue(sectionFor('Assumptions'), 'Simulation mode')).toBe('Fixed returns');
  });
});

describe('before the simulation is ready', () => {
  it('waits instead of printing a half-built report', () => {
    const simulationBefore = store.simulation;
    store.simulation = null;

    render(<PlanReportView inputs={inputs} planName="Retire early" />);

    expect(screen.getByRole('status').textContent).toContain('Running simulation');
    expect(screen.queryByRole('button', { name: /Print/ })).toBeNull();
    store.simulation = simulationBefore;
  });
});
