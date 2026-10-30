import { describe, expect, it } from 'vitest';

import {
  buildJournalEntryDraft,
  JOURNAL_NOTE_MAX_LENGTH,
  parseBalanceInput,
  parseJournalDateInput,
  type JournalBalanceField,
} from './net-worth-journal-form';

/**
 * The journal entry form's pure half (P4-P7).
 *
 * The form accepts the three date precisions the model accepts, resolves each to the END of the
 * period it names, and refuses anything that is not a real date — with the message a user sees.
 */

const field = (accountId: string, label: string, amount: string): JournalBalanceField => ({ accountId, label, amount });

describe('the date field', () => {
  it('accepts a year and resolves it to 31 December', () => {
    expect(parseJournalDateInput('2026')).toStrictEqual({ ok: true, date: '2026', effectiveDate: '2026-12-31', precision: 'year' });
  });

  it('accepts a year and month and resolves it to the month`s last day', () => {
    expect(parseJournalDateInput('2026-09')).toStrictEqual({
      ok: true,
      date: '2026-09',
      effectiveDate: '2026-09-30',
      precision: 'month',
    });
    // February in a leap year, so the resolution is the calendar's, not a fixed 30.
    expect(parseJournalDateInput('2024-02')).toStrictEqual({ ok: true, date: '2024-02', effectiveDate: '2024-02-29', precision: 'month' });
  });

  it('accepts a full date unchanged', () => {
    expect(parseJournalDateInput('2026-09-30')).toStrictEqual({
      ok: true,
      date: '2026-09-30',
      effectiveDate: '2026-09-30',
      precision: 'day',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseJournalDateInput('  2026-09  ')).toMatchObject({ ok: true, date: '2026-09' });
  });

  it('refuses a plausible but impossible date, naming what to type', () => {
    for (const value of ['2026-02-30', '2026-13', '2026-00']) {
      const result = parseJournalDateInput(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).toContain('not a real calendar date');
      expect(result.message).toContain('Enter a year (2026)');
    }
  });

  it('refuses the wrong shape', () => {
    for (const value of ['', 'September 2026', '26', '2026/09', '2026-9', '2026-09-30T00:00']) {
      const result = parseJournalDateInput(value);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.message).toBe('Enter a year (2026), a year and month (2026-09) or a full date (2026-09-30).');
    }
  });

  it('refuses a year outside the model`s range', () => {
    expect(parseJournalDateInput('1899').ok).toBe(false);
    expect(parseJournalDateInput('2101').ok).toBe(false);
  });
});

describe('the balance fields', () => {
  it('accepts plain and currency-shaped numbers', () => {
    expect(parseBalanceInput('0')).toStrictEqual({ kind: 'value', value: 0 });
    expect(parseBalanceInput('1234.56')).toStrictEqual({ kind: 'value', value: 1234.56 });
    expect(parseBalanceInput('$1,234.56')).toStrictEqual({ kind: 'value', value: 1234.56 });
    // Liabilities are recorded as negative amounts.
    expect(parseBalanceInput('-45,000')).toStrictEqual({ kind: 'value', value: -45000 });
  });

  it('treats a blank field as "not recorded", not as zero', () => {
    expect(parseBalanceInput('')).toStrictEqual({ kind: 'blank' });
    expect(parseBalanceInput('   ')).toStrictEqual({ kind: 'blank' });
    expect(parseBalanceInput('$')).toStrictEqual({ kind: 'blank' });
  });

  it('rejects text that is not a number', () => {
    expect(parseBalanceInput('abc')).toStrictEqual({ kind: 'invalid' });
    expect(parseBalanceInput('12,34.5.6')).toStrictEqual({ kind: 'invalid' });
  });
});

describe('the draft the form submits', () => {
  it('builds the payload with the date as typed and only the recorded balances', () => {
    const result = buildJournalEntryDraft({
      date: '2026-09',
      balances: [field('savings', 'Savings', '25000'), field('401k', '401(k)', ''), field('card', 'Credit card', '-1,200')],
      note: '  after the bonus  ',
    });

    expect(result).toStrictEqual({
      ok: true,
      entry: { date: '2026-09', balances: { savings: 25000, card: -1200 }, note: 'after the bonus' },
    });
  });

  it('omits a blank note instead of storing an empty string', () => {
    const result = buildJournalEntryDraft({ date: '2026', balances: [field('savings', 'Savings', '1')], note: '   ' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).not.toHaveProperty('note');
  });

  it('reports an invalid date and an invalid balance together', () => {
    const result = buildJournalEntryDraft({
      date: '2026-02-30',
      balances: [field('savings', 'Savings', 'lots')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toContain('not a real calendar date');
    expect(result.issues[1]).toBe('Enter a number for Savings, or leave it blank.');
  });

  it('refuses a snapshot with no balances at all', () => {
    const result = buildJournalEntryDraft({ date: '2026', balances: [field('savings', 'Savings', ''), field('401k', '401(k)', '  ')] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toStrictEqual(['Record a balance for at least one account.']);
  });

  it('refuses a note longer than the server accepts', () => {
    const atLimit = buildJournalEntryDraft({
      date: '2026',
      balances: [field('savings', 'Savings', '1')],
      note: 'x'.repeat(JOURNAL_NOTE_MAX_LENGTH),
    });
    expect(atLimit.ok).toBe(true);

    const overLimit = buildJournalEntryDraft({
      date: '2026',
      balances: [field('savings', 'Savings', '1')],
      note: 'x'.repeat(JOURNAL_NOTE_MAX_LENGTH + 1),
    });
    expect(overLimit.ok).toBe(false);
    if (overLimit.ok) return;
    expect(overLimit.issues).toStrictEqual(['Keep the note to 500 characters or fewer.']);
  });
});
