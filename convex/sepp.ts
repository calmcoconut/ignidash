import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';

import { seppValidator } from './validators/sepp_validator';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { patchPlanWithSnapshot } from './utils/snapshot_utils';
import { seppRateWindowProblem } from '../src/lib/schemas/inputs/sepp-form-schema';

/**
 * The plan's Substantially Equal Periodic Payments schedules (IRC §72(t)(2)(A)(iv)).
 *
 * A plan-level list, written whole — exactly how the milestones and the glide path are written: the
 * editor owns the list, so one mutation replaces it and `patchPlanWithSnapshot` keeps the undo
 * history. An absent field and an empty list both mean *no schedules*; `get` answers `[]` for the
 * editor so a plan saved before the field existed opens on an empty list rather than on
 * `undefined`.
 *
 * What this mutation checks, and what it deliberately does not:
 *
 * - **Checked: the start year, and — for a fixed method — the rate.** The year must be a whole year
 *   in the schema's range, and a fixed method's Notice 2022-6 rate window must be vendored with the
 *   row's rate at or below the cap that window sets. `seppRateWindowProblem` in
 *   `src/lib/schemas/inputs/sepp-form-schema.ts` is the one rule the editor and this handler share,
 *   so a schedule the dialog accepts is a schedule this writes and vice versa. Neither is a
 *   modelling question: `processSeppDistributions` prices a fixed method from `${startYear}-01`
 *   through `seppRateWindow`, so `federalMidTermRate` throws for a month it has no rate for, and
 *   `seppAnnualAmountFromTables` throws for a rate above the window's maximum. Those throws happen
 *   inside the simulation, which runs during render, so writing such a schedule would leave a plan
 *   that commits but cannot be displayed — with the editor that could undo it inside the tree that
 *   fails to render. The cap is read from the vendored rates (`seppRateCapForStartYear`), never
 *   restated as a constant, so this refusal and the engine's throw cannot drift apart.
 * - **Not checked: anything a run answers.** A start year already in the past, an account with no
 *   balance, a stop year before the §72(t)(4) period ends: each is a legitimate modelling input
 *   whose *outcome* the engine reports (`$0`, or a shorter series), and none of them is invalid plan
 *   data. (A blank rate is likewise not zero: it means "use the maximum", which the engine does,
 *   so it is never refused — an `rmd` row is never refused for a rate at all, since the method
 *   reads none.) The reasons are not symmetric with the start year, so they are not treated as if
 *   they were.
 */
export const get = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return plan.sepp ?? [];
  },
});

export const update = mutation({
  args: {
    planId: v.id('plans'),
    sepp: seppValidator,
  },
  handler: async (ctx, { planId, sepp }) => {
    await getPlanForCurrentUserOrThrow(ctx, planId);

    // `seppValidator` checks types only (`v.number()` accepts 2027.5, and any rate). The predicates
    // below are the ones the Zod schema states and the editor enforces; repeating them here is what
    // makes the stored list as strict as the form that writes it.
    sepp.forEach((schedule, index) => {
      if (schedule.rate !== undefined && !(schedule.rate >= 0 && schedule.rate <= 1)) {
        throw new ConvexError(`Schedule ${index + 1}: the rate is a decimal between 0 and 1 (5% is 0.05); got ${schedule.rate}.`);
      }
      if (schedule.annualAmount !== undefined && !(schedule.annualAmount >= 0)) {
        throw new ConvexError(`Schedule ${index + 1}: the annual amount cannot be negative; got ${schedule.annualAmount}.`);
      }
      if (schedule.stopYear !== undefined && !Number.isInteger(schedule.stopYear)) {
        throw new ConvexError(`Schedule ${index + 1}: the stop year must be a whole year; got ${schedule.stopYear}.`);
      }

      const problem = seppRateWindowProblem(schedule);
      if (problem !== null) throw new ConvexError(`Schedule ${index + 1}: ${problem}`);
    });

    await patchPlanWithSnapshot(ctx, planId, { sepp });
  },
});
