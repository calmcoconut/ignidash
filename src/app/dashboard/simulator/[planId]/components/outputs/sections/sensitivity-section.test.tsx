// @vitest-environment jsdom
/**
 * The sensitivity section (R9).
 *
 * The report itself is stubbed, not `simulate()`: the numbers are the engine's business and
 * `src/lib/calc/sensitivity.test.ts` owns them. What this file pins is the surface the user reads —
 * every variable appears once, the rows keep the report's effect-descending order, the base case
 * and the sweep sizes are stated, and the deterministic-baseline disclosure is on the card (it is
 * the only thing stopping this table from reading as a contradiction of the headline projection on
 * a stochastic plan).
 *
 * It also pins *when* the sweep runs, which is the reason this section is not computed during the
 * first render: a report is up to nine full simulations of the plan, the section is mounted
 * unconditionally by the results page and remounted by the mobile section selector, so computing
 * it on mount made the results page's first paint wait for it. Nothing may run until the reader
 * presses the trigger, and the trigger must say what pressing it costs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { SensitivityReport } from '@/lib/calc/sensitivity';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { createSimulatorInputs } from '@/lib/calc/__tests__/test-utils';

const { oneAtATimeSensitivity } = vi.hoisted(() => ({ oneAtATimeSensitivity: vi.fn() }));

vi.mock('@/lib/calc/sensitivity', () => ({ oneAtATimeSensitivity }));

import SensitivitySection from './sensitivity-section';

const AS_OF = '2026-03-15';

/** The disclosure the card owes the reader; spelled out here so a wording change is a test change. */
const DISCLOSURE =
  'This analysis always re-runs the plan with deterministic fixed returns and seed 1, so its numbers can differ from the projection above.';

/** The trigger and its price, spelled out for the same reason. */
const TRIGGER_LABEL = 'Analyse sensitivity';

/** The plan pins its own as-of date, so no test depends on today. */
const inputs = createSimulatorInputs({
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns', asOfDate: AS_OF },
});

const sample = (outcome: number, input: number) => ({ outcome, success: 1, input });

/**
 * A faithful report shape with four distinct effects, already in the order `oneAtATimeSensitivity`
 * returns (largest swing first). The base outcome is repeated per entry, as the real module does.
 */
const report: SensitivityReport = {
  metric: 'finalPortfolio',
  asOf: AS_OF,
  sweeps: { returnDeltaPct: 2, inflationDeltaPct: 1, retirementAgeDeltaYears: 2, spendingDeltaPct: 10 },
  baseOutcome: 1_000_000,
  entries: [
    { variable: 'spending', base: sample(1_000_000, 0), low: sample(1_600_000, 0.9), high: sample(600_000, 1.1), effect: 1_000_000 },
    { variable: 'returns', base: sample(1_000_000, 0), low: sample(1_400_000, 7), high: sample(600_000, 11), effect: 800_000 },
    { variable: 'inflation', base: sample(1_000_000, 0), low: sample(1_100_000, 2), high: sample(900_000, 4), effect: 200_000 },
    { variable: 'retirementAge', base: sample(1_000_000, 0), low: sample(975_000, 60), high: sample(1_025_000, 64), effect: 50_000 },
  ],
};

const renderSection = (
  simulationMode: 'fixedReturns' | 'stochasticReturns' | 'historicalReturns' = 'fixedReturns',
  plan: SimulatorInputs = inputs
) => render(<SensitivitySection inputs={plan} simulationMode={simulationMode} />);

/**
 * Presses the trigger and waits for the card to settle.
 *
 * The handler yields one macrotask before it sweeps (so the disabled "Analysing…" state can
 * paint), which is why the assertions have to flush that macrotask inside `act` rather than assert
 * straight after the click.
 */
const analyse = async () => {
  fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  oneAtATimeSensitivity.mockReturnValue(report);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('before the reader asks for the analysis', () => {
  it('does not run the sweep on mount', () => {
    renderSection();

    // The pin for this change: mounting the section must cost nothing. Nine simulations (~220 ms
    // on a 52-year plan) used to run here, before the first paint of the results page.
    expect(oneAtATimeSensitivity).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('says how expensive the analysis is, next to the trigger', () => {
    renderSection();

    const note = screen.getByText(/full simulations/).textContent ?? '';
    expect(note).toContain('nine');
    expect(note).toContain('one base case plus two per variable');
  });

  it('does not run the sweep on an unrelated re-render either', () => {
    const { rerender } = renderSection();

    rerender(<SensitivitySection inputs={inputs} simulationMode="fixedReturns" />);

    expect(oneAtATimeSensitivity).not.toHaveBeenCalled();
  });
});

describe('the assumptions table', () => {
  it('renders one row per variable, largest swing first', async () => {
    renderSection();
    await analyse();

    const bodyRows = screen.getAllByRole('row').slice(1);
    const variables = bodyRows.map((row) => within(row).getAllByRole('cell')[0].textContent);

    expect(variables).toEqual(['Spending', 'Returns', 'Inflation', 'Retirement age']);
  });

  it('shows the low, base, high and swing outcome of each row', async () => {
    renderSection();
    await analyse();

    const firstRow = screen.getAllByRole('row')[1];
    const cells = within(firstRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);

    expect(cells).toEqual(['Spending', '$1,600,000', '$1,000,000', '$600,000', '$1,000,000']);
  });

  it('states the base case and the sweep sizes the rows were built from', async () => {
    renderSection();
    await analyse();

    const statement = screen.getByText(/Base case:/).textContent ?? '';
    expect(statement).toContain('$1,000,000');
    expect(statement).toContain('±2 points of return');
    expect(statement).toContain('±1 point of inflation');
    expect(statement).toContain('±2 years of retirement age');
    expect(statement).toContain('±10% of spending');
  });

  it("asks the sweep for the plan's own as-of date", async () => {
    renderSection();
    await analyse();

    expect(oneAtATimeSensitivity).toHaveBeenCalledWith(inputs, { asOf: AS_OF });
  });

  it('does not re-run the sweep once the report is on screen', async () => {
    const { rerender } = renderSection();
    await analyse();

    rerender(<SensitivitySection inputs={inputs} simulationMode="fixedReturns" />);

    expect(oneAtATimeSensitivity).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Base case:/)).toBeTruthy();
  });

  it('drops a report that describes a plan the reader has since edited', async () => {
    const { rerender } = renderSection();
    await analyse();

    const edited = createSimulatorInputs({
      simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns', asOfDate: AS_OF },
      expenses: {
        'expense-1': { id: 'expense-1', name: 'Living', amount: 2000, frequency: 'monthly', timeframe: { start: { type: 'now' } } },
      },
    });
    rerender(<SensitivitySection inputs={edited} simulationMode="fixedReturns" />);

    expect(oneAtATimeSensitivity).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
    expect(screen.queryByText(/Base case:/)).toBeNull();
  });
});

describe('the deterministic-baseline disclosure', () => {
  it('is visible text on the card before anything is analysed, not a tooltip', () => {
    renderSection();

    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
    // Nothing on the card hides it behind an interactive element, and it does not wait for the
    // trigger: it qualifies the section's existence, not just its numbers.
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(oneAtATimeSensitivity).not.toHaveBeenCalled();
  });

  it("names the plan's own mode when the headline is not deterministic", () => {
    renderSection('stochasticReturns');

    expect(screen.getByText(/The projection above uses this plan's stochastic returns instead\./)).toBeTruthy();
    expect(oneAtATimeSensitivity).not.toHaveBeenCalled();
  });
});

describe('an unavailable report', () => {
  it('renders one explanatory line instead of the table when the sweep throws', async () => {
    oneAtATimeSensitivity.mockImplementation(() => {
      throw new Error('the engine cannot price this plan');
    });

    renderSection();
    await analyse();

    expect(screen.getByText(/Sensitivity is unavailable for this plan/)).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    // The disclosure still qualifies the section it could not fill.
    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
  });

  it('renders the same line when the report has no applicable variable', async () => {
    oneAtATimeSensitivity.mockReturnValue({ ...report, entries: [] });

    renderSection();
    await analyse();

    expect(screen.getByText(/Sensitivity is unavailable for this plan/)).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});
