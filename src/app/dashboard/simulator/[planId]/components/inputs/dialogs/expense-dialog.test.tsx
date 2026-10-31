// @vitest-environment jsdom
/**
 * Essential spending in the expense dialog (P1-P4).
 *
 * The switch is off unless the expense says otherwise, and the one thing that matters downstream
 * is the flag the save mutation receives: `essential: true` only when the user asked for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { upsertExpense, onClose } = vi.hoisted(() => ({ upsertExpense: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => upsertExpense }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));
// No timeline: the form falls back to its own age bounds, which is what a plan without one sees.
vi.mock('@/hooks/use-convex-data', () => ({ useTimelineData: () => null }));

import { Dialog } from '@/components/catalyst/dialog';
import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import ExpenseDialog from './expense-dialog';

/** The drawer is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = (selectedExpense: ExpenseInputs | null = null) =>
  render(
    <Dialog open onClose={() => {}}>
      <ExpenseDialog onClose={onClose} selectedExpense={selectedExpense} numExpenses={0} />
    </Dialog>
  );

const essentialSwitch = () => screen.getByRole('switch', { name: 'Essential spending' });

const fillAmountAndSave = (amount = '24000') => {
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

beforeEach(() => {
  upsertExpense.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the amount labels', () => {
  it('names the amount input and the basis select separately', () => {
    renderDialog();

    // A bare `getByLabelText('Amount')` only works while exactly one control answers to that name: the
    // amount input and the basis select used to sit in one `Field`, which made Headless UI label both of
    // them "Amount Amount Basis" and made this query match two elements.
    const amountInput = screen.getByLabelText('Amount');
    expect(amountInput.id).toBe('amount');
    expect(amountInput.tagName).toBe('INPUT');

    // Role queries resolve the computed accessible name, so these fail if the names ever merge again.
    expect(screen.getByRole('textbox', { name: 'Amount' }).id).toBe('amount');
    const basisSelect = screen.getByRole('combobox', { name: 'Amount Basis' });
    expect(basisSelect.id).toBe('amountBasis');
    expect(basisSelect.tagName).toBe('SELECT');
    expect(basisSelect).not.toBe(amountInput);

    // The mechanism itself: the two controls must not be named by any label in common.
    const labelledBy = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(labelledBy(amountInput)).not.toHaveLength(0);
    expect(labelledBy(basisSelect).filter((id) => labelledBy(amountInput).includes(id))).toEqual([]);

    // Neither control may answer to the other's name.
    expect(screen.queryByRole('combobox', { name: 'Amount' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Amount Basis' })).toBeNull();
  });
});

describe('the essential spending switch', () => {
  it('defaults to off', () => {
    renderDialog();

    expect(essentialSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('submits `essential: true` once the user turns it on', async () => {
    renderDialog();

    fireEvent.click(essentialSwitch());
    expect(essentialSwitch().getAttribute('aria-checked')).toBe('true');

    fillAmountAndSave();

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    const payload = upsertExpense.mock.calls[0][0];
    expect(payload.planId).toBe('plan-1');
    expect(payload.expense).toMatchObject({ name: 'Expense 1', amount: 24000, essential: true, frequency: 'yearly' });
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves the flag off the payload when the expense is not essential', async () => {
    renderDialog();

    fillAmountAndSave('60000');

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    const expense = upsertExpense.mock.calls[0][0].expense;
    // Storing `essential: false` would be a statement the old documents never made.
    expect(expense).not.toHaveProperty('essential');
    expect(expense).toMatchObject({ amount: 60000 });
  });
});

/** A stored expense as the read transformer hands it over: absent flags already resolved to `false`. */
const storedExpense = (overrides: Partial<ExpenseInputs> = {}): ExpenseInputs => ({
  id: 'expense-1',
  name: 'Medical bills',
  amount: 5000,
  amountBasis: undefined,
  owner: 'primary',
  frequency: 'yearly',
  timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
  growth: { growthRate: 0 },
  disabled: false,
  essential: false,
  qualifiedMedical: false,
  satisfyFromIra: false,
  ...overrides,
});

describe('the qualified medical switch', () => {
  it('describes what the engine does with the flag, not a California non-conformity it does not model', () => {
    renderDialog();

    const description = screen.getByRole('switch', { name: 'Qualified medical expense' }).closest('[data-slot=field]') as HTMLElement;

    // Measured on a California plan: the flag moves the federal return (taxable ordinary income
    // 253,900 → 133,900 and the 20% HSA penalty 24,000 → 0 for a $120,000 qualified withdrawal) and
    // does not move the California income base at all — `processStateTaxes` adds HSA *earnings* to
    // that base, never a qualified withdrawal. The old copy claimed California "does not conform",
    // which reads as a California tax on the withdrawal.
    expect(description.textContent).toContain('leaves it out of federal taxable income');
    expect(description.textContent).toContain('California differs in this model only on HSA earnings');
    expect(description.textContent).not.toContain('but California does not conform');
  });

  it('submits `qualifiedMedical: true` once the user turns it on', async () => {
    renderDialog();

    const medicalSwitch = screen.getByRole('switch', { name: 'Qualified medical expense' });
    expect(medicalSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(medicalSwitch);
    expect(medicalSwitch.getAttribute('aria-checked')).toBe('true');

    fillAmountAndSave();

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    expect(upsertExpense.mock.calls[0][0].expense).toMatchObject({ amount: 24000, qualifiedMedical: true });
  });

  it('leaves the flag off the payload when it is off', async () => {
    renderDialog();

    fillAmountAndSave('60000');

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    // Absent, not `false`: the document made no statement about this expense.
    expect(upsertExpense.mock.calls[0][0].expense).not.toHaveProperty('qualifiedMedical');
  });

  it('keeps a stored `true` when the expense is edited for an unrelated field', async () => {
    renderDialog(storedExpense({ qualifiedMedical: true }));

    expect(screen.getByRole('switch', { name: 'Qualified medical expense' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Medical bills (updated)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    expect(upsertExpense.mock.calls[0][0].expense).toMatchObject({
      id: 'expense-1',
      name: 'Medical bills (updated)',
      qualifiedMedical: true,
    });
  });
});

describe('the satisfy-from-IRA switch', () => {
  it('submits `satisfyFromIra: true` once the user turns it on', async () => {
    renderDialog();

    const qcdSwitch = screen.getByRole('switch', { name: 'Satisfy from IRA (QCD)' });
    expect(qcdSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(qcdSwitch);
    expect(qcdSwitch.getAttribute('aria-checked')).toBe('true');

    fillAmountAndSave();

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    expect(upsertExpense.mock.calls[0][0].expense).toMatchObject({ amount: 24000, satisfyFromIra: true });
  });

  it('leaves the flag off the payload when it is off', async () => {
    renderDialog();

    fillAmountAndSave('60000');

    await waitFor(() => expect(upsertExpense).toHaveBeenCalledTimes(1));
    expect(upsertExpense.mock.calls[0][0].expense).not.toHaveProperty('satisfyFromIra');
  });
});

describe('the three expense switches and their labels', () => {
  it('gives each switch its own accessible name', () => {
    renderDialog();

    // Role queries resolve the computed accessible name, so a switch named by more than one label
    // fails here: `SwitchField` renders the `Field` a Headless UI label registry would share.
    const essential = screen.getByRole('switch', { name: 'Essential spending' });
    const medical = screen.getByRole('switch', { name: 'Qualified medical expense' });
    const qcd = screen.getByRole('switch', { name: 'Satisfy from IRA (QCD)' });

    const labelledBy = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    for (const [element, other] of [
      [medical, essential],
      [qcd, essential],
      [qcd, medical],
    ] as const) {
      expect(labelledBy(element)).not.toHaveLength(0);
      expect(labelledBy(element).filter((id) => labelledBy(other).includes(id))).toEqual([]);
    }

    // No switch answers to a merged name.
    expect(screen.queryByRole('switch', { name: 'Essential spending Qualified medical expense' })).toBeNull();
  });
});
