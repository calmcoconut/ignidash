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
import ExpenseDialog from './expense-dialog';

/** The drawer is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = () =>
  render(
    <Dialog open onClose={() => {}}>
      <ExpenseDialog onClose={onClose} selectedExpense={null} numExpenses={0} />
    </Dialog>
  );

const essentialSwitch = () => screen.getByRole('switch', { name: 'Essential spending' });

const fillAmountAndSave = (amount = '24000') => {
  // `Amount` and `Amount Basis` share an accessible name under Headless UI's field context, so the
  // query is pinned to the amount input itself.
  fireEvent.change(screen.getByLabelText('Amount', { selector: 'input' }), { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

beforeEach(() => {
  upsertExpense.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
