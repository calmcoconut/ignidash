import { z } from 'zod';

/**
 * Zod schema for a net-worth journal snapshot entry (P4-P7, R11).
 * Mirrors `netWorthJournalEntryValidator` in Convex.
 */
export const journalEntryFormSchema = z.object({
  /** As recorded: YYYY, YYYY-MM or YYYY-MM-DD */
  date: z.string(),
  /** Account id → balance at that date. Liabilities are negative amounts. */
  balances: z.record(z.string(), z.number()),
  note: z.string().optional(),
});

export const journalFormSchema = z.array(journalEntryFormSchema);

export type JournalEntryInputs = z.infer<typeof journalEntryFormSchema>;
