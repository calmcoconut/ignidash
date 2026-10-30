import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id, Doc } from '../_generated/dataModel';

/**
 * Loads a journal entry and proves the caller owns it (contract 3.2).
 *
 * Rows are owned by `userId`, and a row's `planId` is only ever written after the plan itself has
 * been checked with `getPlanForCurrentUserOrThrow`, so the two checks together mean "this row is
 * yours and it belongs to a plan of yours".
 */
export async function getJournalEntryForCurrentUserOrThrow(ctx: QueryCtx, entryId: Id<'netWorthJournal'>): Promise<Doc<'netWorthJournal'>> {
  const [identity, entry] = await Promise.all([ctx.auth.getUserIdentity(), ctx.db.get(entryId)]);

  const userId = identity?.subject;

  if (!entry) throw new ConvexError('Journal entry not found');
  if (entry.userId !== userId) throw new ConvexError('Not authorized to access this journal entry');

  return entry;
}

async function getAllJournalEntriesForPlan(ctx: QueryCtx, planId: Id<'plans'>): Promise<Doc<'netWorthJournal'>[]> {
  return await ctx.db
    .query('netWorthJournal')
    .withIndex('by_planId', (q) => q.eq('planId', planId))
    .collect();
}

/**
 * Removes a plan's journal entries when the plan is deleted.
 *
 * A journal entry's balances are account ids of its plan, so an entry that outlived its plan would
 * be unreadable history. This mirrors `deleteAllConversationsForPlan` and friends.
 */
export async function deleteAllJournalEntriesForPlan(ctx: MutationCtx, planId: Id<'plans'>): Promise<void> {
  const entries = await getAllJournalEntriesForPlan(ctx, planId);
  await Promise.all(entries.map((entry) => ctx.db.delete(entry._id)));
}
