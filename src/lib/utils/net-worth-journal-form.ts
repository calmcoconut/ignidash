/**
 * The journal entry form's pure half (P4-P7).
 *
 * The manual journal takes three things — a date, per-account balances and an optional note — and
 * this module is everything about accepting them that is not DOM: trimming, the three date
 * precisions, currency-shaped balances, and the issues to show under the fields. The drawer calls
 * it and renders the result; the mutation is the server's authority on the same rules.
 *
 * Dates follow the model's own rule rather than re-deriving it: `parseJournalDate` in
 * `../utils/net-worth-journal` (shared with the Convex module) accepts `YYYY`, `YYYY-MM` and
 * `YYYY-MM-DD`, and a partial date means the END of the period it names — `2026` is 2026-12-31,
 * `2026-09` is 2026-09-30. The form shows that resolved date back to the user so a year typed in
 * September is not mistaken for a September snapshot.
 */

import { parseJournalDate, type JournalDatePrecision } from './net-worth-journal';

/** Mirrors `MAX_NOTE_LENGTH` in `convex/net_worth_journal.ts`, which is the authority. */
export const JOURNAL_NOTE_MAX_LENGTH = 500;

const FORMAT_HINT = 'Enter a year (2026), a year and month (2026-09) or a full date (2026-09-30).';

/** The shape of a typed date, before it is checked against the calendar. */
const DATE_SHAPE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** A parsed date input: the canonical string to store, and the period end it stands for. */
export type JournalDateInputResult =
  | { readonly ok: true; readonly date: string; readonly effectiveDate: string; readonly precision: JournalDatePrecision }
  | { readonly ok: false; readonly message: string };

/**
 * Validates the date field.
 *
 * Three precisions are accepted, and each resolves to the end of its period. A syntactically
 * plausible but impossible date (`2026-02-30`, `2026-13`) is reported as not a real date; anything
 * else is reported as the wrong shape. Both messages name what to type instead.
 */
export function parseJournalDateInput(value: string): JournalDateInputResult {
  const date = value.trim();

  if (!DATE_SHAPE.test(date)) return { ok: false, message: FORMAT_HINT };

  const parsed = parseJournalDate(date);
  if (parsed === null) return { ok: false, message: `"${date}" is not a real calendar date. ${FORMAT_HINT}` };

  return { ok: true, date: parsed.input, effectiveDate: parsed.effectiveDate, precision: parsed.precision };
}

/** One account's balance field, as typed. A blank field means "not recorded". */
export interface JournalBalanceField {
  readonly accountId: string;
  /** Shown in the message when the field is not a number (the account's name). */
  readonly label: string;
  readonly amount: string;
}

/** What a balance field parsed to. */
export type JournalBalanceInput =
  | { readonly kind: 'blank' }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'invalid' };

/**
 * Parses one balance field. Currency shaping is accepted because people paste it: `$1,234.56` and
 * `-45,000` both work. A blank field is not an error — it means the account was not recorded in
 * that snapshot — but a value that is not a finite number is.
 */
export function parseBalanceInput(amount: string): JournalBalanceInput {
  const cleaned = amount.replace(/[$,\s]/g, '');
  if (cleaned === '') return { kind: 'blank' };

  const value = Number(cleaned);

  return Number.isFinite(value) ? { kind: 'value', value } : { kind: 'invalid' };
}

/** The entry the form would submit. */
export interface JournalEntryDraft {
  readonly date: string;
  readonly balances: Record<string, number>;
  readonly note?: string;
}

/** The form's verdict: a draft to submit, or the messages to show. */
export type JournalEntryDraftResult =
  | { readonly ok: true; readonly entry: JournalEntryDraft }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Builds the mutation payload from the form's fields.
 *
 * A journal entry needs at least one balance (a snapshot with no accounts says nothing), so a form
 * with every balance blank is refused here rather than at the mutation, where the message would be
 * less specific. The note is trimmed and omitted when blank; its limit matches the server's.
 */
export function buildJournalEntryDraft(inputs: {
  date: string;
  balances: readonly JournalBalanceField[];
  note?: string | undefined;
}): JournalEntryDraftResult {
  const issues: string[] = [];

  const date = parseJournalDateInput(inputs.date);
  if (!date.ok) issues.push(date.message);

  const balances: Record<string, number> = {};
  let invalidFields = 0;
  for (const field of inputs.balances) {
    const parsed = parseBalanceInput(field.amount);
    if (parsed.kind === 'value') balances[field.accountId] = parsed.value;
    if (parsed.kind === 'invalid') {
      invalidFields += 1;
      issues.push(`Enter a number for ${field.label}, or leave it blank.`);
    }
  }

  // Only when every field was genuinely left blank: a field that says `lots` has already been
  // reported above, and adding "record a balance" on top of it is a cascade, not a second problem.
  if (Object.keys(balances).length === 0 && invalidFields === 0) issues.push('Record a balance for at least one account.');

  const note = (inputs.note ?? '').trim();
  if (note.length > JOURNAL_NOTE_MAX_LENGTH) issues.push(`Keep the note to ${JOURNAL_NOTE_MAX_LENGTH} characters or fewer.`);

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, entry: { date: date.ok ? date.date : inputs.date.trim(), balances, ...(note === '' ? {} : { note }) } };
}
