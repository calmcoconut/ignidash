// @vitest-environment jsdom
/**
 * Withdrawal-strategy control in the simulation settings drawer (P1-P4).
 *
 * What the user can observe: the four strategies, `ordered` selected for a plan that has never
 * stored one, and the chosen id reaching the save mutation. The mutation is mocked at the hook,
 * the way every component test in this repo mocks Convex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SimulationSettingsInputs } from '@/lib/schemas/inputs/simulation-settings-form-schema';

const { updateSettings, setOpen } = vi.hoisted(() => ({ updateSettings: vi.fn(), setOpen: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => updateSettings }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));

import SimulationSettingsDrawer from './simulation-settings-drawer';

/** A plan saved before strategies existed: no `withdrawalStrategy` on the document. */
const legacySettings = {
  simulationSeed: 5000,
  simulationMode: 'monteCarloStochasticReturns',
} as SimulationSettingsInputs;

const strategySelect = () => screen.getByLabelText('Withdrawal Strategy') as HTMLSelectElement;

beforeEach(() => {
  updateSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the withdrawal strategy select', () => {
  it('offers exactly the four strategies, ordered first', () => {
    render(<SimulationSettingsDrawer setOpen={setOpen} simulationSettings={null} />);

    expect(Array.from(strategySelect().options).map((option) => option.value)).toEqual(['ordered', 'vpw', 'xPercentRule', 'guytonKlinger']);
    expect(Array.from(strategySelect().options).map((option) => option.textContent)).toEqual([
      'Ordered (default)',
      'VPW (variable percentage)',
      'Fixed percentage of balance',
      'Guyton-Klinger guardrails',
    ]);
  });

  it('shows `ordered` for an existing plan that never stored a strategy', () => {
    render(<SimulationSettingsDrawer setOpen={setOpen} simulationSettings={legacySettings} />);

    expect(strategySelect().value).toBe('ordered');
  });

  it('submits the chosen strategy id to the save mutation', async () => {
    render(<SimulationSettingsDrawer setOpen={setOpen} simulationSettings={legacySettings} />);

    fireEvent.change(strategySelect(), { target: { value: 'guytonKlinger' } });
    // The description tracks the selection, so the user can read what they picked.
    expect(screen.getByText('Starts at 5.2% and only changes the withdrawal by 10% when a 20% guardrail is crossed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      simulationSettings: expect.objectContaining({
        withdrawalStrategy: 'guytonKlinger',
        simulationMode: 'monteCarloStochasticReturns',
        simulationSeed: 5000,
      }),
      planId: 'plan-1',
    });
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it('can go back to `ordered` and submits that id', async () => {
    const stored = { ...legacySettings, withdrawalStrategy: 'vpw' } as SimulationSettingsInputs;
    render(<SimulationSettingsDrawer setOpen={setOpen} simulationSettings={stored} />);

    expect(strategySelect().value).toBe('vpw');
    fireEvent.change(strategySelect(), { target: { value: 'ordered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      simulationSettings: expect.objectContaining({ withdrawalStrategy: 'ordered' }),
      planId: 'plan-1',
    });
  });
});
