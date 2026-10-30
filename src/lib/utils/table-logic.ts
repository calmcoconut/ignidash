/**
 * Pure logic behind the shared results table (`outputs/tables/table.tsx`).
 *
 * The component itself is DOM-only — it renders a `<table>`, paginates with local state,
 * copies through `navigator.clipboard` and exports through a file picker or a Blob. The
 * decisions inside it, though, are plain functions: the three-state sort cycle, the row
 * ordering, the page window and padding, and the exact tab- and comma-separated strings the
 * Copy and Export buttons produce. They live here so they can be tested without a DOM.
 *
 * Behaviour is byte-for-byte the component's previous inline behaviour: nullish values sort
 * last in both directions, numbers compare numerically and everything else with
 * `localeCompare`, copying is tab-separated with a header row, and the CSV carries a UTF-8
 * BOM because Excel needs one to read `$` columns as text on some locales.
 */

import type { TableColumn } from '@/lib/types/table-column';

export type SortDirection = 'asc' | 'desc' | null;

export interface SortState<T> {
  column: keyof T | null;
  direction: SortDirection;
}

/** The initial state: unsorted, so the rows keep the order the extractor produced. */
export const INITIAL_SORT_STATE = { column: null, direction: null } as const satisfies SortState<Record<string, unknown>>;

/**
 * Advances the sort cycle for a column: ascending → descending → unsorted.
 *
 * Clicking a different column always starts at ascending.
 *
 * @param current - Current sort state
 * @param column - Column that was clicked
 * @returns The next sort state
 */
export function nextSortState<T>(current: SortState<T>, column: keyof T): SortState<T> {
  if (current.column === column) {
    if (current.direction === 'asc') return { column, direction: 'desc' };
    if (current.direction === 'desc') return { column: null, direction: null };
  }

  return { column, direction: 'asc' };
}

/**
 * Orders rows for display.
 *
 * @param rows - Rows in extractor order
 * @param sort - Sort state; unsorted returns the SAME array (the component relies on the reference)
 * @returns The rows to render
 */
export function sortRows<T extends Record<string, unknown>>(rows: T[], sort: SortState<T>): T[] {
  if (!sort.column || !sort.direction) return rows;

  const column = sort.column;
  const direction = sort.direction;

  return [...rows].sort((a, b) => {
    const aVal = a[column];
    const bVal = b[column];

    const aIsNull = aVal == null;
    const bIsNull = bVal == null;

    // Missing values sink to the bottom whichever way the column is sorted.
    if (aIsNull && bIsNull) return 0;
    if (aIsNull) return 1;
    if (bIsNull) return -1;

    if (aVal === bVal) return 0;

    const comparison = typeof aVal === 'number' && typeof bVal === 'number' ? aVal - bVal : String(aVal).localeCompare(String(bVal));

    return direction === 'asc' ? comparison : -comparison;
  });
}

export interface PageWindow<T> {
  /** The rows that belong on the current page. */
  paginatedData: T[];
  totalPages: number;
  /** Blank rows the component renders so every page is the same height. */
  emptyRows: number;
}

/**
 * Slices one page out of the sorted rows.
 *
 * @param rows - Sorted rows
 * @param currentPage - 1-based page number as held in component state
 * @param itemsPerPage - Rows per page
 * @param showPagination - When false, everything is "page 1" and nothing is padded
 * @returns The page window
 */
export function paginateRows<T>(rows: T[], currentPage: number, itemsPerPage: number, showPagination: boolean): PageWindow<T> {
  if (!showPagination) {
    return { paginatedData: rows, totalPages: 1, emptyRows: 0 };
  }

  const totalPages = Math.ceil(rows.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = rows.slice(startIndex, endIndex);

  return { paginatedData, totalPages, emptyRows: itemsPerPage - paginatedData.length };
}

/** Quotes a CSV cell only when it has to be, doubling embedded quotes. */
export function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * The Copy button's payload: a header row plus one row per row, tab-separated.
 *
 * @param columns - Columns in display order
 * @param rows - Rows in their current (sorted) order
 * @returns Plain text for the clipboard
 */
export function buildCopyText<T extends Record<string, unknown>>(columns: TableColumn<T>[], rows: T[]): string {
  const headers = columns.map((column) => column.title).join('\t');
  const body = rows.map((row) => columns.map((column) => column.format(row[column.key])).join('\t')).join('\n');

  return `${headers}\n${body}`;
}

/**
 * The Export button's payload: a UTF-8 BOM, a header row and one row per row, comma-separated.
 *
 * @param columns - Columns in display order
 * @param rows - Rows in their current (sorted) order
 * @returns CSV text, ready for the file picker or a Blob download
 */
export function buildCsvText<T extends Record<string, unknown>>(columns: TableColumn<T>[], rows: T[]): string {
  const BOM = '\uFEFF';
  const headers = columns.map((column) => escapeCsvValue(column.title)).join(',');
  const body = rows
    .map((row) =>
      columns
        .map((column) => {
          const rawValue = row[column.key];
          return escapeCsvValue(column.format(rawValue));
        })
        .join(',')
    )
    .join('\n');

  return `${BOM}${headers}\n${body}`;
}
