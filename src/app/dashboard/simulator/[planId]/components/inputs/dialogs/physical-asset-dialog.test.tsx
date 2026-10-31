// @vitest-environment jsdom
/**
 * The purchase price field and the basis select in the physical asset dialog.
 *
 * They used to sit in one Headless UI `Field`, whose label registry named both controls
 * "Purchase Price Amount Basis" — a merged name for assistive tech, and the reason a plain
 * label query matched twice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { upsertPhysicalAsset, onClose } = vi.hoisted(() => ({ upsertPhysicalAsset: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => upsertPhysicalAsset }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));
// No timeline, no market assumptions and no accounts: the form falls back to its own defaults,
// which is what a plan without any of them sees.
vi.mock('@/hooks/use-convex-data', () => ({
  useTimelineData: () => null,
  useMarketAssumptionsData: () => null,
  useAccountsData: () => ({ data: [] }),
}));

import { Dialog } from '@/components/catalyst/dialog';
import PhysicalAssetDialog from './physical-asset-dialog';

/** The drawer is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = () =>
  render(
    <Dialog open onClose={() => {}}>
      <PhysicalAssetDialog onClose={onClose} selectedPhysicalAsset={null} physicalAssets={{}} nwAssets={null} nwLiabilities={null} />
    </Dialog>
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the amount labels', () => {
  it('names the purchase price input and the basis select separately', () => {
    renderDialog();

    // Role queries resolve the computed accessible name, so these fail if the names ever merge again.
    const purchasePriceInput = screen.getByRole('textbox', { name: 'Purchase Price' });
    expect(purchasePriceInput.id).toBe('purchasePrice');
    expect(purchasePriceInput.tagName).toBe('INPUT');

    const basisSelect = screen.getByRole('combobox', { name: 'Amount Basis' });
    expect(basisSelect.id).toBe('amountBasis');
    expect(basisSelect.tagName).toBe('SELECT');
    expect(basisSelect).not.toBe(purchasePriceInput);

    // The mechanism itself: the two controls must not be named by any label in common.
    const labelledBy = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(labelledBy(purchasePriceInput)).not.toHaveLength(0);
    expect(labelledBy(basisSelect)).not.toHaveLength(0);
    expect(labelledBy(basisSelect).filter((id) => labelledBy(purchasePriceInput).includes(id))).toEqual([]);

    // Neither control may answer to the other's name, in whole or as a fragment of a merged name.
    expect(screen.queryByRole('combobox', { name: 'Purchase Price' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Amount Basis' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Amount Basis/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Purchase Price/ })).toBeNull();
  });
});
