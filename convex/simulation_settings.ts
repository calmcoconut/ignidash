import { v } from 'convex/values';
import { query, mutation } from './_generated/server';
import { mutationDef } from './utils/function_defs';

import { simulationSettingsValidator } from './validators/simulation_settings_validator';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { patchPlanWithSnapshot } from './utils/snapshot_utils';

export const get = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return plan.simulationSettings;
  },
});

export const updateDef = mutationDef({
  args: {
    planId: v.id('plans'),
    simulationSettings: simulationSettingsValidator,
  },
  handler: async (ctx, { planId, simulationSettings }) => {
    await getPlanForCurrentUserOrThrow(ctx, planId);

    await patchPlanWithSnapshot(ctx, planId, { simulationSettings });
  },
});

export const update = mutation(updateDef);
