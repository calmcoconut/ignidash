import { describe, it, expect } from 'vitest';

import { buildCopyText, buildCsvText, escapeCsvValue, nextSortState, paginateRows, sortRows, type SortState } from './table-logic';
import type { TableColumn } from '@/lib/types/table-column';

interface Row extends Record<string, unknown> {
  year: number;
  name: string;
  value: number | null;
}

const rows: Row[] = [
  { year: 2, name: 'beta', value: 20 },
  { year: 1, name: 'alpha', value: 10 },
  { year: 3, name: 'gamma', value: null },
];

const money = (value: unknown): string => (value == null ? '–' : `$${Number(value).toLocaleString('en-US')}`);
const plain = (value: unknown): string => (value == null ? '' : String(value));

const columns: TableColumn<Row>[] = [
  { key: 'year', title: 'Year', format: plain },
  { key: 'name', title: 'Name', format: plain },
  { key: 'value', title: 'Value, $', format: money },
];

describe('nextSortState', () => {
  it('cycles ascending → descending → unsorted', () => {
    const asc = nextSortState<Row>({ column: null, direction: null }, 'year');
    expect(asc).toEqual({ column: 'year', direction: 'asc' });

    const desc = nextSortState<Row>(asc, 'year');
    expect(desc).toEqual({ column: 'year', direction: 'desc' });

    const none = nextSortState<Row>(desc, 'year');
    expect(none).toEqual({ column: null, direction: null });
  });

  it('starts a different column at ascending', () => {
    expect(nextSortState<Row>({ column: 'year', direction: 'desc' }, 'name')).toEqual({ column: 'name', direction: 'asc' });
  });
});

describe('sortRows', () => {
  it('returns the same array reference while unsorted', () => {
    expect(sortRows(rows, { column: null, direction: null })).toBe(rows);
  });

  it('sorts numbers numerically in both directions', () => {
    const asc = sortRows(rows, { column: 'year', direction: 'asc' });
    const desc = sortRows(rows, { column: 'year', direction: 'desc' });

    expect(asc.map((row) => row.year)).toEqual([1, 2, 3]);
    expect(desc.map((row) => row.year)).toEqual([3, 2, 1]);
  });

  it('sorts text with localeCompare', () => {
    expect(sortRows(rows, { column: 'name', direction: 'asc' }).map((row) => row.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(sortRows(rows, { column: 'name', direction: 'desc' }).map((row) => row.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('sinks nullish values to the bottom in both directions', () => {
    expect(sortRows(rows, { column: 'value', direction: 'asc' }).map((row) => row.value)).toEqual([10, 20, null]);
    expect(sortRows(rows, { column: 'value', direction: 'desc' }).map((row) => row.value)).toEqual([20, 10, null]);
  });

  it('does not mutate the input order', () => {
    const snapshot = rows.map((row) => row.year);

    sortRows(rows, { column: 'year', direction: 'desc' });

    expect(rows.map((row) => row.year)).toEqual(snapshot);
  });
});

describe('paginateRows', () => {
  const many: Row[] = Array.from({ length: 25 }, (_, index) => ({ year: index + 1, name: `row-${index + 1}`, value: index }));

  it('slices the requested page and reports the page count', () => {
    expect(paginateRows(many, 1, 10, true)).toMatchObject({ totalPages: 3, emptyRows: 0 });
    expect(paginateRows(many, 1, 10, true).paginatedData).toHaveLength(10);
    expect(paginateRows(many, 2, 10, true).paginatedData[0].year).toBe(11);
  });

  it('pads the final partial page', () => {
    const lastPage = paginateRows(many, 3, 10, true);

    expect(lastPage.paginatedData).toHaveLength(5);
    expect(lastPage.emptyRows).toBe(5);
  });

  it('treats an out-of-range page as empty and pads it', () => {
    // The component resets the page when the data changes, so this window should not be reached;
    // if it is, it renders a page of blank rows rather than throwing.
    const beyond = paginateRows(many, 4, 10, true);

    expect(beyond.paginatedData).toEqual([]);
    expect(beyond.emptyRows).toBe(10);
  });

  it('ignores pagination when it is switched off', () => {
    const all = paginateRows(many, 2, 10, false);

    expect(all.paginatedData).toBe(many);
    expect(all.totalPages).toBe(1);
    expect(all.emptyRows).toBe(0);
  });
});

describe('CSV escaping and export text', () => {
  it('quotes only the values that need it, doubling inner quotes', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('two\nlines')).toBe('"two\nlines"');
  });

  it('builds a BOM-prefixed CSV with a header row and one line per row', () => {
    const csv = buildCsvText(columns, rows);
    const lines = csv.split('\n');

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines[0]).toBe('\uFEFFYear,Name,"Value, $"');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1]).toBe('2,beta,$20');
    // The header that contains a comma is quoted; the empty value formats to the em dash.
    expect(lines[3]).toBe('3,gamma,–');
  });

  it('formats through the column definitions, so export matches the screen', () => {
    const csv = buildCsvText(columns, [{ year: 1, name: 'a', value: 1234 }]);

    expect(csv.split('\n')[1]).toBe('1,a,"$1,234"');
  });

  it('builds tab-separated copy text with a header row', () => {
    const text = buildCopyText(columns, rows);
    const lines = text.split('\n');

    expect(lines[0]).toBe('Year\tName\tValue, $');
    expect(lines[1]).toBe('2\tbeta\t$20');
    expect(lines).toHaveLength(rows.length + 1);
    // Commas are data inside a TSV cell, not separators, so no quoting happens here.
    expect(lines[2]).toBe('1\talpha\t$10');
  });

  it('does not mutate the rows it formats', () => {
    const snapshot = structuredClone(rows);

    buildCsvText(columns, rows);
    buildCopyText(columns, rows);

    expect(rows).toEqual(snapshot);
  });
});

describe('sorting feeds the export', () => {
  it('exports in the order the table shows, not the extractor order', () => {
    const sort: SortState<Row> = { column: 'year', direction: 'desc' };
    const sorted = sortRows(rows, sort);

    expect(
      buildCsvText(columns, sorted)
        .split('\n')
        .slice(1)
        .map((line) => line.split(',')[0])
    ).toEqual(['3', '2', '1']);
    expect(
      buildCopyText(columns, sorted)
        .split('\n')
        .slice(1)
        .map((line) => line.split('\t')[0])
    ).toEqual(['3', '2', '1']);
  });
});
