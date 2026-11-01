import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';
import { mutationDef } from './utils/function_defs';

import { physicalAssetValidator } from './validators/physical_asset_validator';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { patchPlanWithSnapshot } from './utils/snapshot_utils';

export const getPhysicalAssets = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return plan.physicalAssets ?? [];
  },
});

export const getCountOfPhysicalAssets = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return (plan.physicalAssets ?? []).length;
  },
});

export const getPhysicalAsset = query({
  args: { planId: v.id('plans'), physicalAssetId: v.union(v.string(), v.null()) },
  handler: async (ctx, { planId, physicalAssetId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return (plan.physicalAssets ?? []).find((pa) => pa.id === physicalAssetId) ?? null;
  },
});

export const upsertPhysicalAssetDef = mutationDef({
  args: {
    planId: v.id('plans'),
    physicalAsset: physicalAssetValidator,
  },
  handler: async (ctx, { planId, physicalAsset }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);
    const physicalAssets = plan.physicalAssets ?? [];

    const existingIndex = physicalAssets.findIndex((pa) => pa.id === physicalAsset.id);
    const isNewAsset = existingIndex === -1;
    if (isNewAsset && physicalAssets.length >= 10) throw new ConvexError('Maximum of 10 physical assets reached.');

    const updatedPhysicalAssets = isNewAsset
      ? [...physicalAssets, physicalAsset]
      : physicalAssets.map((pa, index) => (index === existingIndex ? physicalAsset : pa));

    await patchPlanWithSnapshot(ctx, planId, { physicalAssets: updatedPhysicalAssets });
  },
});

export const upsertPhysicalAsset = mutation(upsertPhysicalAssetDef);

export const deletePhysicalAssetDef = mutationDef({
  args: {
    planId: v.id('plans'),
    physicalAssetId: v.string(),
  },
  handler: async (ctx, { planId, physicalAssetId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    const updatedPhysicalAssets = (plan.physicalAssets ?? []).filter((pa) => pa.id !== physicalAssetId);

    await patchPlanWithSnapshot(ctx, planId, { physicalAssets: updatedPhysicalAssets });
  },
});

export const deletePhysicalAsset = mutation(deletePhysicalAssetDef);
