/**
 * The plan's manual net-worth journal, in the shape the overlay consumes (contract 3.2, P4-P7).
 *
 * `convex/net_worth_journal.list` returns the stored rows: the document id, the date as recorded,
 * the derived `effectiveDate`, the account-keyed balances and an optional note. The overlay works
 * on `NetWorthJournalEntry` (src/lib/utils/net-worth-journal.ts), whose `id` is the document id and
 * which has no `effectiveDate` — it re-derives the period end from `date` through the shared parser
 * rather than trusting a stored copy. This hook is that translation, in one place.
 *
 * The three states are deliberately distinct:
 * - `isLoading` — Convex has not answered yet (`useQuery` returns `undefined`). A loading journal
 *   must not be mistaken for an empty one, or the results surface would flash "no actuals" and an
 *   overlay that is about to appear would render nothing for a frame.
 * - `isEmpty` — answered, with no rows: the overlay section renders nothing at all.
 * - otherwise `entries`, oldest first, which is the index order the query returns.
 *
 * The module is addressed as `api.net_worth_journal`, not `api.netWorthJournal`: Convex keys the
 * api object by the module's file path (as `api.simulation_settings` and `api.tax_settings` are
 * used elsewhere in these hooks), so that is the name codegen will produce and the name that keeps
 * working when it runs. The table it queries is `netWorthJournal`; the module is
 * `convex/net_worth_journal.ts`.
 */

import { useQuery } from 'convex/react';
import { useMemo } from 'react';

import { api } from '@/convex/_generated/api';
import type { NetWorthJournalEntry } from '@/lib/utils/net-worth-journal';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';

export interface NetWorthJournalState {
  /** The plan's snapshots in the overlay's shape, oldest first. */
  entries: NetWorthJournalEntry[];
  /** True until Convex answers; not the same thing as an empty journal. */
  isLoading: boolean;
  /** True only once the query has answered with no rows. */
  isEmpty: boolean;
}

export const useNetWorthJournal = (): NetWorthJournalState => {
  const planId = useSelectedPlanId();
  const docs = useQuery(api.net_worth_journal.list, { planId });

  return useMemo(() => {
    if (docs === undefined) return { entries: [], isLoading: true, isEmpty: false };

    const entries: NetWorthJournalEntry[] = docs.map((doc) => ({
      id: doc._id,
      date: doc.date,
      balances: doc.balances,
      ...(doc.note === undefined ? {} : { note: doc.note }),
    }));

    return { entries, isLoading: false, isEmpty: entries.length === 0 };
  }, [docs]);
};
