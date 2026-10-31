import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';

import { conversionsValidator } from './validators/conversion_validator';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { patchPlanWithSnapshot } from './utils/snapshot_utils';
import { conversionsProblems } from '../src/lib/schemas/inputs/conversion-form-schema';

/**
 * The plan's Roth conversion schedule (parity plan P3-P5).
 *
 * A plan-level list, written whole — exactly how the SEPP schedules, the milestones and the glide
 * path are written: the editor owns the list, so one mutation replaces it and `patchPlanWithSnapshot`
 * keeps the undo history. An absent field and an empty list both mean *no conversions*; `get` answers
 * `[]` for the editor so a plan saved before the field existed opens on an empty list rather than on
 * `undefined`, and the importer keeps the difference (absent stays absent) because
 * `EXPORT_SCHEMA_VERSION` 14 defined the absent field as "no conversions".
 *
 * Until this module existed the only writers were `createPlanWithData` (JSON import) and `clonePlan`,
 * so a schedule could enter a plan and never be seen or edited afterwards.
 *
 * What this mutation checks, and what it deliberately does not:
 *
 * - **Checked: everything the stored data decides.** `conversionsProblems` in
 *   `src/lib/schemas/inputs/conversion-form-schema.ts` is the one rule the editor and this handler
 *   share, so a row the dialog accepts is a row this writes and vice versa. Half of it is the
 *   plan-bricking class: `processConversions` (`portfolio.ts`) and the `fillToBracket` block in
 *   `simulation-engine.ts` both `throw` on a `fromAccountId`/`toAccountId` the plan does not have —
 *   inside the simulation, which runs during render, with no error boundary above it. A plan that
 *   commits such a conversion cannot be painted again, and the dialog that could undo it is inside
 *   the tree that fails. The other half is the silent misreadings — source = destination, a
 *   non-Roth destination, a non-tax-deferred source, both or neither of `year`/`timePoint`, an
 *   `atLifeExpectancy` timing the engine's filter has no branch for, a duplicated id (the engine
 *   remembers executed rows by id), and a `fillToBracket` rate that is not a bracket (the engine
 *   substitutes the nearest instead of throwing). None of those may reach the document.
 * - **Not checked: anything a run answers.** An account with no balance (the conversion is capped at
 *   the balance), a year already past (it never fires), a conversion that lands the year in another
 *   bracket: each is a legitimate modelling input whose outcome the results report. The reasons are
 *   not symmetric, so they are not treated as if they were.
 *
 * `conversionsValidator` checks types only — `v.number()` accepts a negative amount and any rate, and
 * `v.string()` accepts an account id that never existed — which is why the shared rule is asked here
 * rather than trusted to the validator.
 */
export const get = query({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return plan.conversions ?? [];
  },
});

export const update = mutation({
  args: {
    planId: v.id('plans'),
    conversions: conversionsValidator,
  },
  handler: async (ctx, { planId, conversions }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    // The accounts the plan currently holds: the rule refuses a row naming anything else, which is
    // the only check here that needs the document rather than the payload.
    const accounts = plan.accounts.map((account) => ({ id: account.id, name: account.name, type: account.type }));

    // Every problem is reported at once, in row order, so a payload that is wrong in three ways does
    // not have to be submitted three times to find out.
    const problems = conversionsProblems(conversions, accounts);
    if (problems.length > 0) {
      throw new ConvexError(problems.map(({ index, problem }) => `Conversion ${index + 1}: ${problem}`).join(' · '));
    }

    await patchPlanWithSnapshot(ctx, planId, { conversions });
  },
});
