/** Filters NW Tracker finance items to those linkable from a simulator dialog. */
import { useMemo } from 'react';

interface FinanceItem {
  id: string;
  type: string;
}

export function useLinkableFinances<T extends FinanceItem>(
  items: T[] | null | undefined,
  alreadySyncedIds: Set<string>,
  typeFilter: string[]
): T[] {
  return useMemo(
    () => items?.filter((item) => !alreadySyncedIds.has(item.id) && typeFilter.includes(item.type)) ?? [],
    [items, alreadySyncedIds, typeFilter]
  );
}
