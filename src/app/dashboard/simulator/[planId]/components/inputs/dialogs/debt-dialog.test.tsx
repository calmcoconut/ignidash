// @vitest-environment jsdom
/**
 * The balance field and the basis select in the debt dialog.
 *
 * They used to sit in one Headless UI `Field`, whose label registry named both controls
 * "Balance Amount Basis" — a merged name for assistive tech, and the reason a plain label
 * query matched twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { upsertDebt, onClose } = vi.hoisted(() => ({ upsertDebt: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => upsertDebt }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));
// No timeline and no market assumptions: the form falls back to its own defaults, which is what a
// plan without either sees.
vi.mock('@/hooks/use-convex-data', () => ({ useTimelineData: () => null, useMarketAssumptionsData: () => null }));

import { Dialog } from '@/components/catalyst/dialog';
import DebtDialog from './debt-dialog';

/** The drawer is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = () =>
  render(
    <Dialog open onClose={() => {}}>
      <DebtDialog onClose={onClose} selectedDebt={null} debts={{}} nwLiabilities={null} />
    </Dialog>
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the amount labels', () => {
  it('names the balance input and the basis select separately', () => {
    renderDialog();

    // Role queries resolve the computed accessible name, so these fail if the names ever merge again.
    const balanceInput = screen.getByRole('textbox', { name: 'Balance' });
    expect(balanceInput.id).toBe('balance');
    expect(balanceInput.tagName).toBe('INPUT');

    const basisSelect = screen.getByRole('combobox', { name: 'Amount Basis' });
    expect(basisSelect.id).toBe('amountBasis');
    expect(basisSelect.tagName).toBe('SELECT');
    expect(basisSelect).not.toBe(balanceInput);

    // The mechanism itself: the two controls must not be named by any label in common.
    const labelledBy = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(labelledBy(balanceInput)).not.toHaveLength(0);
    expect(labelledBy(basisSelect)).not.toHaveLength(0);
    expect(labelledBy(basisSelect).filter((id) => labelledBy(balanceInput).includes(id))).toEqual([]);

    // Neither control may answer to the other's name, in whole or as a fragment of a merged name.
    expect(screen.queryByRole('combobox', { name: 'Balance' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Amount Basis' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Amount Basis/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Balance/ })).toBeNull();
  });
});
