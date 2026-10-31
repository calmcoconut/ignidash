// @vitest-environment jsdom
/**
 * The amount field and the basis select in the income dialog.
 *
 * They used to sit in one Headless UI `Field`, whose label registry named both controls
 * "Pre-tax Amount Amount Basis" — a merged name for assistive tech, and the reason a plain
 * label query matched twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { upsertIncome, onClose } = vi.hoisted(() => ({ upsertIncome: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => upsertIncome }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));
// No timeline: the form falls back to its own age bounds, which is what a plan without one sees.
vi.mock('@/hooks/use-convex-data', () => ({ useTimelineData: () => null }));

import { Dialog } from '@/components/catalyst/dialog';
import IncomeDialog from './income-dialog';

/** The drawer is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = () =>
  render(
    <Dialog open onClose={() => {}}>
      <IncomeDialog onClose={onClose} selectedIncome={null} numIncomes={0} />
    </Dialog>
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the amount labels', () => {
  it('names the pre-tax amount input and the basis select separately', () => {
    renderDialog();

    // Role queries resolve the computed accessible name, so these fail if the names ever merge again.
    const amountInput = screen.getByRole('textbox', { name: 'Pre-tax Amount' });
    expect(amountInput.id).toBe('amount');
    expect(amountInput.tagName).toBe('INPUT');

    const basisSelect = screen.getByRole('combobox', { name: 'Amount Basis' });
    expect(basisSelect.id).toBe('amountBasis');
    expect(basisSelect.tagName).toBe('SELECT');
    expect(basisSelect).not.toBe(amountInput);

    // The mechanism itself: the two controls must not be named by any label in common.
    const labelledBy = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(labelledBy(amountInput)).not.toHaveLength(0);
    expect(labelledBy(basisSelect)).not.toHaveLength(0);
    expect(labelledBy(basisSelect).filter((id) => labelledBy(amountInput).includes(id))).toEqual([]);

    // Neither control may answer to the other's name, in whole or as a fragment of a merged name.
    expect(screen.queryByRole('combobox', { name: 'Pre-tax Amount' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Amount Basis' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Amount Basis/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Pre-tax Amount/ })).toBeNull();
  });
});
