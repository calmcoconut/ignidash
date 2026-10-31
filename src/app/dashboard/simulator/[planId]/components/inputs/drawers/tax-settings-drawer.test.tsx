// @vitest-environment jsdom
/**
 * The ACA Premium Tax Credit block in the tax settings drawer (Phase 0a).
 *
 * The bug this pins: `convex/tax_settings.ts` replaces the whole `taxSettings` object, so every key
 * the form does not carry is erased on save. The drawer's form defaults used to omit `aca`
 * entirely, so a plan that carried one (from a JSON import or a clone) lost it the first time
 * anyone opened the drawer and pressed Save. The mutation is mocked at the hook, the way every
 * component test in this repo mocks Convex, so the assertion is on the payload the engine's
 * settings actually reach.
 *
 * The second half is absent-vs-zero: the three numbers are optional and unstated must stay absent,
 * because a stored `0` is a different claim from a figure nobody entered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { TaxSettingsInputs } from '@/lib/schemas/inputs/tax-settings-form-schema';

const { updateTaxSettings, setOpen } = vi.hoisted(() => ({ updateTaxSettings: vi.fn(), setOpen: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => updateTaxSettings }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));

import TaxSettingsDrawer from './tax-settings-drawer';

/** A plan that opted into ACA elsewhere — a JSON import or a clone, per the gap assessment. */
const acaPlan = {
  filingStatus: 'marriedFilingJointly',
  stateResidency: 'CA',
  aca: { optIn: true, householdSize: 2, slcsp: 12000, actualPremium: 9000 },
} as TaxSettingsInputs;

/** A plan saved before the ACA block existed: no `aca` key on the document. */
const planWithoutAca = { filingStatus: 'single', stateResidency: 'CA' } as TaxSettingsInputs;

const acaSwitch = () => screen.getByRole('switch', { name: 'Model the ACA Premium Tax Credit' });

const savedTaxSettings = () => updateTaxSettings.mock.calls[0][0].taxSettings;

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

beforeEach(() => {
  updateTaxSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the ACA block on save', () => {
  it('round-trips an aca block the plan already carried', { timeout: 30_000 }, async () => {
    render(<TaxSettingsDrawer setOpen={setOpen} taxSettings={acaPlan} />);

    // The stored figures are what the user sees before touching anything.
    expect(acaSwitch().getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Household Size') as HTMLInputElement).value).toBe('2');

    save();

    await waitFor(() => expect(updateTaxSettings).toHaveBeenCalledTimes(1));
    expect(savedTaxSettings().aca).toEqual({ optIn: true, householdSize: 2, slcsp: 12000, actualPremium: 9000 });
    expect(updateTaxSettings).toHaveBeenCalledWith({ taxSettings: expect.objectContaining({ aca: acaPlan.aca }), planId: 'plan-1' });
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it('keeps an unstated number absent rather than storing a zero', { timeout: 30_000 }, async () => {
    const partial: TaxSettingsInputs = { filingStatus: 'single', aca: { optIn: true, householdSize: 2 } };
    render(<TaxSettingsDrawer setOpen={setOpen} taxSettings={partial} />);

    save();

    await waitFor(() => expect(updateTaxSettings).toHaveBeenCalledTimes(1));
    const aca = savedTaxSettings().aca;
    expect(aca).toEqual({ optIn: true, householdSize: 2 });
    // `toEqual` treats a present-but-undefined key as equal to a missing one; the stored document
    // does not, so assert the keys outright.
    expect(aca).not.toHaveProperty('slcsp');
    expect(aca).not.toHaveProperty('actualPremium');
  });

  it('leaves the block off a plan that never opted in', { timeout: 30_000 }, async () => {
    render(<TaxSettingsDrawer setOpen={setOpen} taxSettings={planWithoutAca} />);

    expect(acaSwitch().getAttribute('aria-checked')).toBe('false');
    save();

    await waitFor(() => expect(updateTaxSettings).toHaveBeenCalledTimes(1));
    expect(savedTaxSettings()).not.toHaveProperty('aca');
  });

  it('submits the figures the user enters after opting in', { timeout: 30_000 }, async () => {
    render(<TaxSettingsDrawer setOpen={setOpen} taxSettings={null} />);

    fireEvent.click(acaSwitch());
    fireEvent.change(screen.getByLabelText('Household Size'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Benchmark Silver Premium'), { target: { value: '15000' } });
    fireEvent.change(screen.getByLabelText('Actual Premium'), { target: { value: '11000' } });

    save();

    await waitFor(() => expect(updateTaxSettings).toHaveBeenCalledTimes(1));
    expect(savedTaxSettings().aca).toEqual({ optIn: true, householdSize: 4, slcsp: 15000, actualPremium: 11000 });
  });

  it('drops the block when the user switches the credit back off', { timeout: 30_000 }, async () => {
    render(<TaxSettingsDrawer setOpen={setOpen} taxSettings={acaPlan} />);

    fireEvent.click(acaSwitch());
    expect(acaSwitch().getAttribute('aria-checked')).toBe('false');
    save();

    await waitFor(() => expect(updateTaxSettings).toHaveBeenCalledTimes(1));
    expect(savedTaxSettings()).not.toHaveProperty('aca');
  });
});
