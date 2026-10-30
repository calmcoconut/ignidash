/**
 * Net-worth journal and actual-vs-projected overlay (P4-P7, logic only).
 *
 * The journal is a manual record of what the household is actually worth: a dated snapshot of
 * per-account balances plus an optional note. Persistence belongs to P5.1b (the Convex
 * `netWorthJournal` table, contract 3.2); this module owns the model, its validation and the
 * overlay maths, all pure — no clock, no store, no I/O.
 *
 * ALIGNMENT RULE (deliberate, and pinned by tests).
 * A projection row is an annual snapshot, so an actual recorded mid-period has no exact
 * projected counterpart. Rather than snap to the nearest row (which would bias the deviation by
 * up to half a year of returns) this module INTERPOLATES the projected net worth linearly
 * between the two rows that bracket the actual's date. Therefore:
 *
 * - a recorded date that falls exactly on a projection row compares against that row exactly
 *   (the interpolation weight is 0, so the projected value is the row's own value);
 * - a date between two rows compares against a straight line drawn between them;
 * - a date before the first row or after the last row is REPORTED as an issue and produces no
 *   point: it is never clamped to the nearest row and never silently dropped;
 * - a partial date names the END of its period, because a balance snapshot is taken at period
 *   close: `2026` is 2026-12-31 and `2026-09` is 2026-09-30.
 */

import type { SimulationDataPoint } from '@/lib/calc/simulation-engine';
import { SimulationDataExtractor } from '@/lib/calc/data-extractors/simulation-data-extractor';

/** How much of the date the user recorded. */
export type JournalDatePrecision = 'year' | 'month' | 'day';

/** A validated journal date. `year`/`month`/`day` describe the END of the recorded period. */
export interface ParsedJournalDate {
  /** The value as recorded. */
  readonly input: string;
  readonly precision: JournalDatePrecision;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Canonical `YYYY-MM-DD` of the end of the recorded period. */
  readonly effectiveDate: string;
}

/** One recorded snapshot: per-account balances at a date, plus an optional note. */
export interface NetWorthJournalEntry {
  readonly id: string;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Partial dates resolve to the end of their period. */
  readonly date: string;
  /** Account id → balance at that date. Liabilities are recorded as negative amounts. */
  readonly balances: Readonly<Record<string, number>>;
  readonly note?: string;
}

/** Result of validating one journal entry. */
export type JournalEntryValidation = { readonly ok: true } | { readonly ok: false; readonly issues: string[] };

export const JOURNAL_MIN_YEAR = 1900;
export const JOURNAL_MAX_YEAR = 2100;

/** Default tolerance band around the projection: ±5% of the projected net worth. */
export const DEFAULT_DEVIATION_BAND_PERCENT = 0.05;

const JOURNAL_DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in a 1-based month, without touching `Date`. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Days since the Unix epoch for a civil (proleptic Gregorian) date. Howard Hinnant's
 * `days_from_civil`, used for interpolation weights; pure integer arithmetic, no `Date`.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146097 + dayOfEra - 719468;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Parses a recorded journal date, resolving a partial date to the END of its period.
 *
 * @param value - `YYYY`, `YYYY-MM` or `YYYY-MM-DD`
 * @returns The parsed date, or `null` when it is not a real calendar date in range
 */
export function parseJournalDate(value: string): ParsedJournalDate | null {
  const match = JOURNAL_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  if (!Number.isInteger(year) || year < JOURNAL_MIN_YEAR || year > JOURNAL_MAX_YEAR) return null;

  const precision: JournalDatePrecision = match[3] !== undefined ? 'day' : match[2] !== undefined ? 'month' : 'year';
  const month = precision === 'year' ? 12 : Number(match[2]);
  if (month < 1 || month > 12) return null;

  const day = precision === 'day' ? Number(match[3]) : daysInMonth(year, month);
  if (day < 1 || day > daysInMonth(year, month)) return null;

  return { input: value, precision, year, month, day, effectiveDate: `${year}-${pad2(month)}-${pad2(day)}` };
}

/**
 * Validates a journal entry as a whole.
 *
 * @param entry - Unknown value (e.g. straight from a form or a mutation argument)
 * @returns `{ ok: true }` or the list of human-readable issues
 */
export function validateJournalEntry(entry: unknown): JournalEntryValidation {
  const issues: string[] = [];

  if (typeof entry !== 'object' || entry === null) return { ok: false, issues: ['A journal entry must be an object.'] };

  const candidate = entry as Partial<NetWorthJournalEntry>;

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') issues.push('Every journal entry needs an id.');
  if (typeof candidate.date !== 'string') {
    issues.push('Every journal entry needs a date (YYYY, YYYY-MM or YYYY-MM-DD).');
  } else if (parseJournalDate(candidate.date) === null) {
    issues.push(`"${candidate.date}" is not a real date between ${JOURNAL_MIN_YEAR} and ${JOURNAL_MAX_YEAR}.`);
  }

  if (typeof candidate.balances !== 'object' || candidate.balances === null) {
    issues.push('A journal entry needs a balances object keyed by account id.');
  } else {
    for (const [accountId, balance] of Object.entries(candidate.balances)) {
      if (accountId.trim() === '') issues.push('A balances key is empty; use the account id.');
      if (typeof balance !== 'number' || !Number.isFinite(balance)) issues.push(`Balance for "${accountId}" must be a finite number.`);
    }
  }

  if (candidate.note !== undefined && typeof candidate.note !== 'string') issues.push('A note must be text when it is present.');

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Total net worth recorded by an entry: the sum of its account balances. */
export function netWorthOfEntry(entry: NetWorthJournalEntry): number {
  return Object.values(entry.balances).reduce((sum, balance) => sum + balance, 0);
}

/** One projection row the overlay aligns against. */
export interface ProjectionRow {
  readonly age: number;
  readonly date: string;
  readonly netWorth: number;
}

/**
 * The projection's annual net-worth snapshots, oldest first.
 *
 * @param data - Annual simulation data points
 * @returns Rows keyed by canonical date, with duplicate dates collapsed to the first
 */
export function projectionRows(data: readonly SimulationDataPoint[]): ProjectionRow[] {
  const rows = data.map((point) => ({
    age: point.age,
    date: point.date.slice(0, 10),
    netWorth: SimulationDataExtractor.getAssetsAndLiabilitiesData(point).netWorth,
  }));

  const byDate = new Map<string, ProjectionRow>();
  for (const row of rows) if (!byDate.has(row.date)) byDate.set(row.date, row);

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Why an entry produced no overlay point. */
export type OverlayIssueReason = 'invalid-date' | 'before-projection' | 'after-projection' | 'no-projection';

export interface OverlayIssue {
  readonly entryId: string;
  readonly reason: OverlayIssueReason;
  readonly message: string;
}

/** One recorded actual, aligned to the projection. */
export interface OverlayPoint {
  readonly entryId: string;
  /** Canonical date of the end of the recorded period. */
  readonly date: string;
  readonly precision: JournalDatePrecision;
  /** Projection age at that date, interpolated between the bracketing rows. */
  readonly age: number;
  readonly actualNetWorth: number;
  /** Projected net worth at that date, interpolated between the bracketing rows. */
  readonly projectedNetWorth: number;
  /** `actual - projected`: positive means ahead of the plan, negative means behind. */
  readonly deviation: number;
  readonly note?: string;
}

/** One row of the deviation band around the projection. */
export interface DeviationBandPoint {
  readonly age: number;
  readonly date: string;
  readonly projectedNetWorth: number;
  readonly lower: number;
  readonly upper: number;
}

export interface NetWorthOverlay {
  /** Actual points, oldest first; a stable order for equal dates. */
  readonly points: OverlayPoint[];
  /** Entries that could not be placed, with the reason. */
  readonly issues: OverlayIssue[];
  /** The projection with its tolerance band, one row per projection date. */
  readonly band: DeviationBandPoint[];
}

export interface OverlayOptions {
  /** Half-width of the band as a fraction of the projected value. Default 5%. */
  readonly bandPercent?: number;
}

const assertBandPercent = (bandPercent: number): void => {
  if (!Number.isFinite(bandPercent) || bandPercent < 0) {
    throw new Error(`bandPercent must be a finite, non-negative fraction, received ${String(bandPercent)}.`);
  }
};

/** Linear interpolation between the two rows bracketing a date. */
function interpolateAt(rows: readonly ProjectionRow[], date: string): { age: number; netWorth: number } {
  const before = rows.filter((row) => row.date <= date).at(-1) ?? rows[0];
  const after = rows.find((row) => row.date >= date) ?? rows[rows.length - 1];

  if (before.date === after.date) return { age: before.age, netWorth: before.netWorth };

  const span = daysFromCivil(...toCivil(after.date)) - daysFromCivil(...toCivil(before.date));
  const position = daysFromCivil(...toCivil(date)) - daysFromCivil(...toCivil(before.date));
  const weight = span === 0 ? 0 : position / span;

  return {
    age: before.age + weight * (after.age - before.age),
    netWorth: before.netWorth + weight * (after.netWorth - before.netWorth),
  };
}

/** `YYYY-MM-DD` → `[year, month, day]` (already validated or produced by this module). */
const toCivil = (date: string): [number, number, number] => [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];

/**
 * Aligns the journal to a projection and computes the deviation and its band.
 *
 * @param data - Annual simulation data points (the projection)
 * @param entries - Journal entries, in any order
 * @param options - Band width (default ±5% of the projected net worth)
 * @returns Actual points, unplaceable entries, and the banded projection
 */
export function buildNetWorthOverlay(
  data: readonly SimulationDataPoint[],
  entries: readonly NetWorthJournalEntry[],
  options: OverlayOptions = {}
): NetWorthOverlay {
  const bandPercent = options.bandPercent ?? DEFAULT_DEVIATION_BAND_PERCENT;
  assertBandPercent(bandPercent);

  const rows = projectionRows(data);

  const band: DeviationBandPoint[] = rows.map((row) => {
    const a = row.netWorth * (1 - bandPercent);
    const b = row.netWorth * (1 + bandPercent);
    return { age: row.age, date: row.date, projectedNetWorth: row.netWorth, lower: Math.min(a, b), upper: Math.max(a, b) };
  });

  const points: OverlayPoint[] = [];
  const issues: OverlayIssue[] = [];

  for (const entry of entries) {
    const parsed = parseJournalDate(entry.date);

    if (parsed === null) {
      issues.push({ entryId: entry.id, reason: 'invalid-date', message: `"${entry.date}" is not a usable journal date.` });
      continue;
    }

    if (rows.length === 0) {
      issues.push({ entryId: entry.id, reason: 'no-projection', message: 'There is no projection to align this entry with.' });
      continue;
    }

    const first = rows[0];
    const last = rows[rows.length - 1];

    if (parsed.effectiveDate < first.date) {
      issues.push({
        entryId: entry.id,
        reason: 'before-projection',
        message: `${parsed.effectiveDate} is before the projection starts (${first.date}).`,
      });
      continue;
    }

    if (parsed.effectiveDate > last.date) {
      issues.push({
        entryId: entry.id,
        reason: 'after-projection',
        message: `${parsed.effectiveDate} is after the projection ends (${last.date}).`,
      });
      continue;
    }

    const projected = interpolateAt(rows, parsed.effectiveDate);
    const actualNetWorth = netWorthOfEntry(entry);

    points.push({
      entryId: entry.id,
      date: parsed.effectiveDate,
      precision: parsed.precision,
      age: projected.age,
      actualNetWorth,
      projectedNetWorth: projected.netWorth,
      deviation: actualNetWorth - projected.netWorth,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });
  }

  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));

  return { points, issues, band };
}
