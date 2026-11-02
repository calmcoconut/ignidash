import { v, ConvexError } from 'convex/values';
import { query, mutation } from './_generated/server';
import { mutationDef, queryDef } from './utils/function_defs';

import { JOURNAL_MAX_YEAR, JOURNAL_MIN_YEAR, parseJournalDate } from '../src/lib/utils/net-worth-journal';
import { netWorthJournalEntryValidator, type NetWorthJournalEntry } from './validators/net_worth_journal_validator';
import { getUserIdOrThrow } from './utils/auth_utils';
import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { getJournalEntryForCurrentUserOrThrow } from './utils/net_worth_journal_utils';

/**
 * The manual net-worth journal (contract 3.2, persisted for P4-P7).
 *
 * One row is one **dated snapshot**: the balances the operator observed, per account of the plan
 * the snapshot was taken against, plus an optional note. P4-P7 overlays these dates onto the
 * projection and computes the deviation band; nothing here computes, aggregates or interprets
 * them, so the numbers are exactly what was entered.
 *
 * The payload is deliberately the same shape as `NetWorthJournalEntry` in
 * `src/lib/utils/net-worth-journal.ts`, the module P4-P7 uses for the overlay: the date parser and
 * the `YYYY`/`YYYY-MM`/`YYYY-MM-DD` semantics come from that module rather than being re-derived
 * here, and `balances` is its account-id-keyed object. The two differences are the ones Convex
 * owns: the row's id is the document id, and `effectiveDate` is the parsed end of the recorded
 * period, stored so the overlay never has to re-parse a stored date.
 *
 * Design notes:
 *
 * - **A period, not an instant.** `date` accepts a year, a month or a day, and a partial date
 *   covers the whole period it names (P4-P7's alignment rule: `2026` is 2026-12-31). The derived
 *   `effectiveDate` is what orders rows and what "one snapshot per day" is enforced on, so
 *   `2026` and `2026-12-31` cannot both be recorded for the same plan.
 * - **No stored total.** Net worth is the sum of the balances; denormalising it invites a total
 *   that disagrees with its own rows.
 * - **Account ids are history.** They are never validated against the plan's current accounts: an
 *   account renamed or closed must not invalidate a snapshot that recorded it.
 *
 * Every function here is per-user: the plan is checked with the standard plan-ownership helper, and
 * entries are read and written under the caller's `userId` only.
 */

/** A note is a line of context, not a second journal. */
export const MAX_NOTE_LENGTH = 500;

/** The stored row, minus the columns Convex owns. */
interface NormalizedEntry {
  date: string;
  effectiveDate: string;
  balances: Record<string, number>;
  note?: string;
}

/**
 * Validates and normalises the payload. The Convex validator already checks types; this checks the
 * things types cannot: a real date in range, at least one balance, non-blank account ids, finite
 * amounts and a note that fits.
 */
function normalizeEntry(entry: NetWorthJournalEntry): NormalizedEntry {
  const parsed = parseJournalDate(entry.date);
  if (!parsed) {
    throw new ConvexError(
      `"${entry.date}" is not a real date between ${JOURNAL_MIN_YEAR} and ${JOURNAL_MAX_YEAR}; use YYYY, YYYY-MM or YYYY-MM-DD.`
    );
  }

  const accountIds = Object.keys(entry.balances);
  if (accountIds.length === 0) throw new ConvexError('A journal entry needs at least one account balance.');

  for (const accountId of accountIds) {
    if (accountId.trim() === '') throw new ConvexError('A balances key is empty; use the account id.');
  }

  for (const [accountId, balance] of Object.entries(entry.balances)) {
    // Convex stores NaN and ±Infinity as floats, and one of them in a balance would poison every
    // overlay sum, so they are refused before the row is written.
    if (!Number.isFinite(balance)) throw new ConvexError(`The balance for account "${accountId}" must be a finite number.`);
  }

  const note = entry.note?.trim();
  if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
    throw new ConvexError(`A note cannot be longer than ${MAX_NOTE_LENGTH} characters.`);
  }

  return {
    date: entry.date,
    effectiveDate: parsed.effectiveDate,
    balances: entry.balances,
    ...(note ? { note } : {}),
  };
}

/** The plan's journal, oldest snapshot first: the order the overlay reads it in. */
export const listDef = queryDef({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const { userId } = await getUserIdOrThrow(ctx);
    // Ownership of the plan is what gates the list; the index adds the user as defence in depth.
    await getPlanForCurrentUserOrThrow(ctx, planId);

    return await ctx.db
      .query('netWorthJournal')
      .withIndex('by_userId_planId_effectiveDate', (q) => q.eq('userId', userId).eq('planId', planId))
      .order('asc')
      .collect();
  },
});

export const list = query(listDef);

export const get = query({
  args: { entryId: v.id('netWorthJournal') },
  handler: async (ctx, { entryId }) => {
    return await getJournalEntryForCurrentUserOrThrow(ctx, entryId);
  },
});

export const createDef = mutationDef({
  args: { planId: v.id('plans'), entry: netWorthJournalEntryValidator },
  handler: async (ctx, { planId, entry }) => {
    const { userId } = await getUserIdOrThrow(ctx);
    await getPlanForCurrentUserOrThrow(ctx, planId);

    const normalized = normalizeEntry(entry);

    const sameDay = await ctx.db
      .query('netWorthJournal')
      .withIndex('by_userId_planId_effectiveDate', (q) =>
        q.eq('userId', userId).eq('planId', planId).eq('effectiveDate', normalized.effectiveDate)
      )
      .first();
    if (sameDay) throw new ConvexError('This plan already has a journal snapshot for that date; edit that entry instead.');

    return await ctx.db.insert('netWorthJournal', { userId, planId, ...normalized, updatedAt: Date.now() });
  },
});

export const create = mutation(createDef);

export const updateDef = mutationDef({
  args: { entryId: v.id('netWorthJournal'), entry: netWorthJournalEntryValidator },
  handler: async (ctx, { entryId, entry }) => {
    const existing = await getJournalEntryForCurrentUserOrThrow(ctx, entryId);
    const normalized = normalizeEntry(entry);

    const sameDay = await ctx.db
      .query('netWorthJournal')
      .withIndex('by_userId_planId_effectiveDate', (q) =>
        q.eq('userId', existing.userId).eq('planId', existing.planId).eq('effectiveDate', normalized.effectiveDate)
      )
      .first();
    if (sameDay && sameDay._id !== entryId) {
      throw new ConvexError('This plan already has a journal snapshot for that date; edit that entry instead.');
    }

    // `replace` rather than `patch`: clearing a note has to remove the optional field, and a patch
    // cannot unset one.
    const { _id, _creationTime, note: _note, ...rest } = existing;
    await ctx.db.replace(_id, { ...rest, ...normalized, updatedAt: Date.now() });
  },
});

export const update = mutation(updateDef);

export const deleteEntryDef = mutationDef({
  args: { entryId: v.id('netWorthJournal') },
  handler: async (ctx, { entryId }) => {
    await getJournalEntryForCurrentUserOrThrow(ctx, entryId);
    await ctx.db.delete(entryId);
  },
});

export const deleteEntry = mutation(deleteEntryDef);
