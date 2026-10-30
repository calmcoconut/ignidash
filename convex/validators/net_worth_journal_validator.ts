import { v, type Infer } from 'convex/values';

/**
 * The payload of one net-worth journal entry (contract 3.2).
 *
 * The shape mirrors `NetWorthJournalEntry` in `src/lib/utils/net-worth-journal.ts`, which P4-P7
 * uses for the actual-vs-projected overlay: the same `date` semantics (`YYYY`, `YYYY-MM` or
 * `YYYY-MM-DD`, where a partial date names the END of the period it covers) and the same
 * account-id-keyed `balances` object. Persisting a different shape would force the overlay to
 * translate on every read, and translation is where a shape drifts.
 *
 * Two things are not in the payload, because Convex owns them: the row's `id` (the document id,
 * which P4-P7 maps onto the model's `id`) and the derived `effectiveDate` (see the table).
 *
 * `accountId`s are deliberately not validated against the plan's current accounts: a journal is
 * history, so a snapshot must keep meaning after the operator renames or closes an account. The
 * overlay matches ids that still exist and reports the rest as no-longer-modelled.
 */
export const netWorthJournalEntryValidator = v.object({
  /** As recorded: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  date: v.string(),
  /** Account id → balance at that date. Liabilities are negative amounts. */
  balances: v.record(v.string(), v.number()),
  note: v.optional(v.string()),
});

export type NetWorthJournalEntry = Infer<typeof netWorthJournalEntryValidator>;
