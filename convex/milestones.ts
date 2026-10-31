import { v } from 'convex/values';
import { query, mutation } from './_generated/server';

import { milestonesValidator } from './validators/milestone_validator';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { patchPlanWithSnapshot } from './utils/snapshot_utils';

/**
 * The plan's milestones (parity plan P1-P7 wiring).
 *
 * A plan-level list, written whole — exactly how the glide path is written: the editor owns the
 * list, so one mutation replaces it and `patchPlanWithSnapshot` keeps the undo history. An absent
 * field and an empty list both mean *no milestones*; `get` answers `[]` for the editor so a plan
 * saved before the field existed opens on an empty list rather than on `undefined`.
 *
 * The reference rules (a dangling id, a loop) are checked by `milestonesSchema` in the app before
 * this mutation is called. They are not repeated here because a Convex validator cannot inspect a
 * sibling value, and an unchecked reference does not corrupt a run: every milestone is evaluated
 * from the same month snapshot, so `references` never gates an evaluation.
 */

export const get = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return plan.milestones ?? [];
  },
});

export const update = mutation({
  args: {
    planId: v.id('plans'),
    milestones: milestonesValidator,
  },
  handler: async (ctx, { planId, milestones }) => {
    await getPlanForCurrentUserOrThrow(ctx, planId);

    await patchPlanWithSnapshot(ctx, planId, { milestones });
  },
});
