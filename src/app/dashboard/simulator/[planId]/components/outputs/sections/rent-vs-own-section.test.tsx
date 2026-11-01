// @vitest-environment jsdom
/**
 * The rent-vs-own section.
 *
 * The comparison itself is stubbed, not `compareHousing()`: the numbers are the engine's business and
 * `src/lib/calc/housing-comparison.test.ts` owns them. What this file pins is what the reader sees
 * and does: the form feeds the choice the builder makes, the headline says what the report says,
 * one table row per year, the disclosure and the primary-residence caveat are on the card, a result
 * is dropped once the plan or the clock pin changes, and an engine refusal is shown rather than
 * crashing the page.
 *
 * It also pins *when* the comparison runs: two full simulations, so nothing may run on mount.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { HousingComparisonReport } from '@/lib/calc/housing-comparison';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { createSimulatorInputs } from '@/lib/calc/__tests__/test-utils';

const { compareHousing } = vi.hoisted(() => ({ compareHousing: vi.fn() }));

vi.mock('@/lib/calc/housing-comparison', () => ({ compareHousing }));

/**
 * The clock override. `asOf` comes from the plan, so moving the clock while keeping the same plan
 * object is not something a real render can do; the override is the only way to test that the
 * section checks the clock on its own. With no override the real `useSimulationClock` runs, and the
 * hook is always called, so the hook order is the same either way.
 */
const clockOverride = vi.hoisted(() => ({ asOf: null as string | null }));

vi.mock('@/lib/stores/simulator-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stores/simulator-store')>();
  return {
    ...actual,
    useSimulationClock: (plan: Parameters<typeof actual.useSimulationClock>[0]) => {
      const real = actual.useSimulationClock(plan);
      return clockOverride.asOf === null ? real : { ...real, asOf: clockOverride.asOf };
    },
  };
});

import RentVsOwnSection from './rent-vs-own-section';

const AS_OF = '2026-03-15';

const DISCLOSURE =
  'This comparison always re-runs the plan with deterministic fixed returns and seed 1, so its numbers can differ from the projection above.';

const PRIMARY_RESIDENCE_WARNING =
  'This plan already has a primary residence. The comparison adds a second home on top of it, so the owning path holds both.';

const TRIGGER_LABEL = 'Compare renting and owning';

const inputs = createSimulatorInputs({
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns', asOfDate: AS_OF },
});

const path = (netWorth: number) => ({ netWorth, portfolio: netWorth, residenceValue: 0, liquidationValue: netWorth });

/** Three years, owning behind then ahead and staying ahead: break-even at the second year. */
const year = (yearIndex: number, age: number, calendarYear: number, owning: number, renting: number) => ({
  yearIndex,
  age,
  calendarYear,
  owning: path(owning),
  renting: path(renting),
  deltaNetWorth: owning - renting,
  deltaPortfolio: 0,
  deltaLiquidationValue: owning - renting,
});

const ownsAhead: HousingComparisonReport = {
  asOf: AS_OF,
  seed: 1,
  mode: 'fixedReturns',
  deltaMeaning: 'owning - renting',
  years: [year(0, 40, 2027, 100_000, 150_000), year(1, 41, 2028, 300_000, 250_000), year(2, 42, 2029, 400_000, 380_000)],
  breakEven: { yearIndex: 1, age: 41, calendarYear: 2028 },
  firstAhead: { yearIndex: 1, age: 41, calendarYear: 2028 },
  liquidationBreakEven: { yearIndex: 1, age: 41, calendarYear: 2028 },
  finalDeltaNetWorth: 20_000,
  finalDeltaLiquidationValue: 20_000,
  finalWinner: 'owning',
  finalLiquidationWinner: 'owning',
};

const primaryResidence = {
  id: 'home',
  name: 'Home',
  assetType: 'primaryResidence' as const,
  purchaseDate: { type: 'now' as const },
  purchasePrice: 400_000,
  appreciationRate: 3,
  paymentMethod: { type: 'cash' as const },
  saleDate: { type: 'atLifeExpectancy' as const },
};

const renderSection = (plan: SimulatorInputs = inputs) => render(<RentVsOwnSection inputs={plan} simulationMode="fixedReturns" />);

/**
 * Presses the trigger and lets the handler's one macrotask (the "Comparing…" paint) run inside `act`,
 * the same way the sensitivity section's test does.
 */
const compare = async () => {
  fireEvent.click(screen.getByRole('button', { name: TRIGGER_LABEL }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/**
 * jsdom has no `matchMedia`, which the chart's Y axis reads through `useIsMobile`. A desktop-width
 * stub (`matches: false`) is the honest answer for this file; it is restored after the suite.
 */
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

beforeEach(() => {
  compareHousing.mockReturnValue(ownsAhead);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clockOverride.asOf = null;
});

describe('before the reader runs the comparison', () => {
  it('does not run the comparison on mount', () => {
    renderSection();

    expect(compareHousing).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('says that pressing the trigger is two full simulations', () => {
    renderSection();

    const note = screen.getByText(/full simulations/).textContent ?? '';
    expect(note).toContain('two full simulations');
  });

  it('starts from a home and rent the reader can change', () => {
    renderSection();

    expect((screen.getByLabelText('Home price') as HTMLInputElement).value).toBe('500000');
    expect((screen.getByLabelText('Monthly rent') as HTMLInputElement).value).toBe('2500');
    expect((screen.getByLabelText('Down payment (%)') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('Mortgage rate (%)') as HTMLInputElement).value).toBe('6.5');
    expect((screen.getByLabelText('Mortgage term (years)') as HTMLInputElement).value).toBe('30');
  });

  it('shows the deterministic-baseline disclosure as visible text, not a tooltip', () => {
    renderSection();

    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('running the comparison', () => {
  it('compares this plan, on its own as-of date, with the fixed seed and fixed returns', async () => {
    renderSection();
    await compare();

    expect(compareHousing).toHaveBeenCalledTimes(1);
    const [base, , options] = compareHousing.mock.calls[0];
    expect(base).toBe(inputs);
    expect(options).toEqual({ asOf: AS_OF, seed: 1, mode: 'fixedReturns' });
  });

  it('builds the home from the form: a down payment of 100% makes it a cash purchase', async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText('Down payment (%)'), { target: { value: '100' } });
    await compare();

    const [, choice] = compareHousing.mock.calls[0];
    expect(choice.residence.purchasePrice).toBe(500_000);
    expect(choice.residence.paymentMethod).toEqual({ type: 'cash' });
    expect(choice.monthlyRent).toBe(2_500);
  });

  it('leaves a blank optional field to the comparison default', async () => {
    renderSection();
    await compare();

    const [, choice] = compareHousing.mock.calls[0];
    expect(choice.propertyTaxRatePercent).toBeUndefined();
    expect(choice.maintenanceRatePercent).toBeUndefined();
    expect(choice.rentRealGrowthRatePercent).toBeUndefined();
  });

  it('states the headline from the winner and the break-even year', async () => {
    renderSection();
    await compare();

    expect(screen.getByText('Owning pulls ahead at age 41 (2028) and stays ahead.')).toBeTruthy();
  });

  it('shows one table row per year, with the owning, renting and difference net worth', async () => {
    renderSection();
    await compare();

    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(3);

    const firstRow = within(bodyRows[0])
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(firstRow).toEqual(['40', '2027', '$100,000', '$150,000', '-$50,000']);
  });

  it('keeps the disclosure on the card once the result is on screen', async () => {
    renderSection();
    await compare();

    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
  });
});

describe('the headline', () => {
  it('says renting stays ahead when renting wins at the end and owning never led', async () => {
    compareHousing.mockReturnValue({
      ...ownsAhead,
      finalWinner: 'renting',
      breakEven: null,
      firstAhead: null,
      liquidationBreakEven: null,
      finalDeltaNetWorth: -50_000,
    });

    renderSection();
    await compare();

    expect(screen.getByText('Renting stays ahead through the plan.')).toBeTruthy();
  });

  it('says owning led for a while but renting is ahead again, when owning led and the lead did not hold', async () => {
    compareHousing.mockReturnValue({
      ...ownsAhead,
      finalWinner: 'renting',
      breakEven: null,
      firstAhead: { yearIndex: 0, age: 40, calendarYear: 2027 },
      finalDeltaNetWorth: -50_000,
    });

    renderSection();
    await compare();

    expect(screen.getByText(/Owning was ahead from age 40 \(2027\), but renting is ahead again/)).toBeTruthy();
    expect(screen.queryByText(/pulls ahead/)).toBeNull();
  });

  it('says the two finish level when the final winner is a tie', async () => {
    compareHousing.mockReturnValue({ ...ownsAhead, finalWinner: 'tie', breakEven: null, finalDeltaNetWorth: 0 });

    renderSection();
    await compare();

    expect(screen.getByText('Owning and renting finish level at the end of the plan.')).toBeTruthy();
  });
});

describe('the residence caveat', () => {
  it('is absent when the plan has no primary residence', () => {
    renderSection();

    expect(screen.queryByText(PRIMARY_RESIDENCE_WARNING)).toBeNull();
  });

  it('is shown before anything is run when the plan already has a primary residence', () => {
    renderSection(createSimulatorInputs({ physicalAssets: { home: primaryResidence } }));

    expect(screen.getByText(PRIMARY_RESIDENCE_WARNING)).toBeTruthy();
    expect(compareHousing).not.toHaveBeenCalled();
  });

  it('is absent for a plan whose only physical asset is not a primary residence', () => {
    renderSection(createSimulatorInputs({ physicalAssets: { car: { ...primaryResidence, id: 'car', assetType: 'other' } } }));

    expect(screen.queryByText(PRIMARY_RESIDENCE_WARNING)).toBeNull();
  });
});

describe('a stale result', () => {
  it('is dropped when the plan is edited', async () => {
    const { rerender } = renderSection();
    await compare();
    expect(screen.getByText(/pulls ahead/)).toBeTruthy();

    const edited = createSimulatorInputs({
      simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns', asOfDate: AS_OF },
      expenses: {
        'expense-1': { id: 'expense-1', name: 'Living', amount: 2000, frequency: 'monthly', timeframe: { start: { type: 'now' } } },
      },
    });
    rerender(<RentVsOwnSection inputs={edited} simulationMode="fixedReturns" />);

    expect(screen.queryByText(/pulls ahead/)).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
  });

  it("is dropped when the plan's own as-of pin changes", async () => {
    const { rerender } = renderSection();
    await compare();

    const repinned = createSimulatorInputs({
      simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns', asOfDate: '2027-03-15' },
    });
    rerender(<RentVsOwnSection inputs={repinned} simulationMode="fixedReturns" />);

    expect(screen.queryByText(/pulls ahead/)).toBeNull();
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
  });

  it('is dropped when the clock moves while the plan object is the same', async () => {
    const { rerender } = renderSection();
    await compare();
    expect(screen.getByText(/pulls ahead/)).toBeTruthy();

    // The same `inputs` object, so only the clock check can drop the result.
    clockOverride.asOf = '2027-03-15';
    rerender(<RentVsOwnSection inputs={inputs} simulationMode="fixedReturns" />);

    expect(screen.queryByText(/pulls ahead/)).toBeNull();
    expect(screen.getByRole('button', { name: TRIGGER_LABEL })).toBeTruthy();
  });

  it('is dropped when a form field is edited after the run', async () => {
    renderSection();
    await compare();
    expect(screen.getByText(/pulls ahead/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Monthly rent'), { target: { value: '3000' } });

    expect(screen.queryByText(/pulls ahead/)).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('is kept across an unrelated re-render of the same plan', async () => {
    const { rerender } = renderSection();
    await compare();

    rerender(<RentVsOwnSection inputs={inputs} simulationMode="fixedReturns" />);

    expect(screen.getByText(/pulls ahead/)).toBeTruthy();
    expect(compareHousing).toHaveBeenCalledTimes(1);
  });
});

describe('a comparison the engine refuses', () => {
  it('shows the engine message in place of the table', async () => {
    compareHousing.mockImplementation(() => {
      throw new Error('the base plan cannot fund this home');
    });

    renderSection();
    await compare();

    expect(screen.getByRole('alert').textContent).toBe('the base plan cannot fund this home');
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('asks for the home price and rent, and does not run, when a required field is blank', async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText('Monthly rent'), { target: { value: '' } });
    await compare();

    expect(compareHousing).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Enter the home price and the monthly rent');
  });
});
