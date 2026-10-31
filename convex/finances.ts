import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';

import { assetValidator } from './validators/asset_validator';
import { liabilityValidator } from './validators/liability_validator';
import { getUserIdOrThrow } from './utils/auth_utils';
import { getFinancesForUser } from './utils/finances_utils';
import {
  syncAssetToPlans,
  unsyncAssetFromPlans,
  unsyncAllAssetsFromPlans,
  syncLiabilityToPlans,
  unsyncLiabilityFromPlans,
  unsyncAllLiabilitiesFromPlans,
} from './utils/finance_sync_utils';
function validateUrl(url: string | undefined): void {
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConvexError('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConvexError('URL must use http:// or https://');
  }
}

export const getAssets = query({
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);
    if (!finances) return null;

    return finances.assets;
  },
});

export const getLiabilities = query({
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);
    if (!finances) return null;

    return finances.liabilities;
  },
});

export const upsertAsset = mutation({
  args: {
    asset: assetValidator,
  },
  handler: async (ctx, { asset }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    validateUrl(asset.url);

    const finances = await getFinancesForUser(ctx, userId);

    const updatedAsset = { ...asset, updatedAt: Date.now() };
    if (!finances) {
      await ctx.db.insert('finances', { userId, assets: [updatedAsset], liabilities: [] });
      return;
    }

    const existingIndex = finances.assets.findIndex((a) => a.id === updatedAsset.id);
    if (existingIndex === -1 && finances.assets.length >= 25) throw new ConvexError('Maximum of 25 assets reached.');

    const updatedAssets =
      existingIndex !== -1
        ? finances.assets.map((a, index) => (index === existingIndex ? updatedAsset : a))
        : [...finances.assets, updatedAsset];

    await Promise.all([ctx.db.patch(finances._id, { assets: updatedAssets }), syncAssetToPlans(ctx, userId, updatedAsset)]);
  },
});

export const upsertLiability = mutation({
  args: {
    liability: liabilityValidator,
  },
  handler: async (ctx, { liability }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    validateUrl(liability.url);

    const finances = await getFinancesForUser(ctx, userId);

    const updatedLiability = { ...liability, updatedAt: Date.now() };
    if (!finances) {
      await ctx.db.insert('finances', { userId, assets: [], liabilities: [updatedLiability] });
      return;
    }

    const existingIndex = finances.liabilities.findIndex((l) => l.id === updatedLiability.id);
    if (existingIndex === -1 && finances.liabilities.length >= 25) throw new ConvexError('Maximum of 25 liabilities reached.');

    const updatedLiabilities =
      existingIndex !== -1
        ? finances.liabilities.map((l, index) => (index === existingIndex ? updatedLiability : l))
        : [...finances.liabilities, updatedLiability];

    await Promise.all([
      ctx.db.patch(finances._id, { liabilities: updatedLiabilities }),
      syncLiabilityToPlans(ctx, userId, updatedLiability),
    ]);
  },
});

/**
 * Replaces the whole net-worth tracker in one transaction: the restore path for an
 * imported export.
 *
 * Destructive by design, so it refuses to run without `confirmReplace: true` (the UI
 * only sets it after the operator confirms and after the pre-import snapshot is
 * downloaded). Stored `updatedAt` values are preserved so a restore keeps the
 * original history rather than stamping "now" on every row.
 */
export const replaceAllFinances = mutation({
  args: {
    assets: v.array(assetValidator),
    liabilities: v.array(liabilityValidator),
    confirmReplace: v.boolean(),
  },
  handler: async (ctx, { assets, liabilities, confirmReplace }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    if (confirmReplace !== true) throw new ConvexError('Replacing finances requires explicit confirmation.');
    if (assets.length > 25) throw new ConvexError('Maximum of 25 assets reached.');
    if (liabilities.length > 25) throw new ConvexError('Maximum of 25 liabilities reached.');
    if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new ConvexError('Duplicate asset ids in the import.');
    if (new Set(liabilities.map((liability) => liability.id)).size !== liabilities.length) {
      throw new ConvexError('Duplicate liability ids in the import.');
    }

    for (const asset of assets) validateUrl(asset.url);
    for (const liability of liabilities) validateUrl(liability.url);

    const finances = await getFinancesForUser(ctx, userId);
    const previousAssetIds = finances?.assets.map((asset) => asset.id) ?? [];
    const previousLiabilityIds = finances?.liabilities.map((liability) => liability.id) ?? [];

    if (finances) {
      await ctx.db.patch(finances._id, { assets, liabilities });
    } else {
      await ctx.db.insert('finances', { userId, assets, liabilities });
    }

    // A restored row keeps its id, so plans already linked to it must keep the link
    // and pick up the restored values. Only ids that no longer exist are unlinked —
    // clearing every link first would leave `sync*` with nothing to match.
    const restoredAssetIds = new Set(assets.map((asset) => asset.id));
    const restoredLiabilityIds = new Set(liabilities.map((liability) => liability.id));
    await Promise.all([
      ...previousAssetIds.filter((id) => !restoredAssetIds.has(id)).map((id) => unsyncAssetFromPlans(ctx, userId, id)),
      ...previousLiabilityIds.filter((id) => !restoredLiabilityIds.has(id)).map((id) => unsyncLiabilityFromPlans(ctx, userId, id)),
    ]);
    await Promise.all([
      ...assets.map((asset) => syncAssetToPlans(ctx, userId, asset)),
      ...liabilities.map((liability) => syncLiabilityToPlans(ctx, userId, liability)),
    ]);
  },
});

export const deleteAllFinances = mutation({
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);

    if (finances) {
      await Promise.all([ctx.db.delete(finances._id), unsyncAllAssetsFromPlans(ctx, userId), unsyncAllLiabilitiesFromPlans(ctx, userId)]);
    }
  },
});

export const deleteAllAssets = mutation({
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);

    if (finances) {
      await Promise.all([ctx.db.patch(finances._id, { assets: [] }), unsyncAllAssetsFromPlans(ctx, userId)]);
    }
  },
});

export const deleteAllLiabilities = mutation({
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);

    if (finances) {
      await Promise.all([ctx.db.patch(finances._id, { liabilities: [] }), unsyncAllLiabilitiesFromPlans(ctx, userId)]);
    }
  },
});

export const deleteAsset = mutation({
  args: {
    assetId: v.string(),
  },
  handler: async (ctx, { assetId }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);
    if (!finances) return;

    const updatedAssets = finances.assets.filter((a) => a.id !== assetId);

    await Promise.all([ctx.db.patch(finances._id, { assets: updatedAssets }), unsyncAssetFromPlans(ctx, userId, assetId)]);
  },
});

export const deleteLiability = mutation({
  args: {
    liabilityId: v.string(),
  },
  handler: async (ctx, { liabilityId }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const finances = await getFinancesForUser(ctx, userId);
    if (!finances) return;

    const updatedLiabilities = finances.liabilities.filter((l) => l.id !== liabilityId);

    await Promise.all([
      ctx.db.patch(finances._id, { liabilities: updatedLiabilities }),
      unsyncLiabilityFromPlans(ctx, userId, liabilityId),
    ]);
  },
});
