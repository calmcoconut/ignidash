/**
 * Form glue for the two time-binding controls (parity plan P1-P1).
 *
 * `amountBasis` and the `everyNYears` cadence are read and written by four entity dialogs
 * (income, expense, debt, physical asset). The option lists, the hint copy and the register
 * rules live here so the four dialogs cannot drift apart, and so the form tests exercise the
 * same wiring the dialogs use.
 *
 * Nothing here changes a stored plan on its own: an untouched dialog leaves both fields
 * absent, which every reader treats as `amountBasis: 'real'` and "no cadence".
 */

import type { AmountBasis, TimePoint } from '@/lib/schemas/inputs/income-expenses-shared-schemas';

export interface AmountBasisOption {
  value: AmountBasis;
  label: string;
}

/** Ordered so the default (`real`) is the option a browser selects while the field is absent. */
export const AMOUNT_BASIS_OPTIONS: readonly AmountBasisOption[] = [
  { value: 'real', label: "In today's dollars" },
  { value: 'nominal', label: 'In the start date\u2019s dollars' },
];

/**
 * Whether an anchor has a calendar location of its own, i.e. a dollar date a nominal amount
 * can be expressed in.
 *
 * `now`, `customDate` and `customAge` all resolve to a point in time. `atRetirement` and
 * `atLifeExpectancy` are phase boundaries: the plan does not know *when* they fall, so
 * `yearsFromPlanStart` returns `undefined`, `TimeBinding.amountScale` returns 1, and the
 * engine uses a nominal amount as today's dollars (asserted in `time-binding.test.ts`).
 * Offering the option there would promise a conversion that never happens, so the dialogs
 * disable it instead.
 */
export const hasDollarDate = (startType: TimePoint['type']): boolean =>
  startType === 'now' || startType === 'customDate' || startType === 'customAge';

/**
 * Whether an option may be picked for a given anchor: `real` always, `nominal` only where the
 * anchor has a dollar date. The dialogs use this for the option's `disabled` attribute.
 */
export const isAmountBasisSelectable = (value: AmountBasis, startType: TimePoint['type']): boolean =>
  value === 'real' || hasDollarDate(startType);

/** Shown under the amount-basis control when the anchor has no dollar date, else `null`. */
export const amountBasisAnchorHint = (startType: TimePoint['type']): string | null =>
  hasDollarDate(startType) ? null : 'This start has no dollar date, so the amount is always in today\u2019s dollars.';

/** One line per option, shown in the amount-basis tooltip. */
export const AMOUNT_BASIS_HINTS: readonly string[] = [
  "Today's dollars: the figure keeps its purchasing power for the whole plan.",
  "Start-date dollars: what the event actually costs on that date, converted by the plan's inflation assumption.",
];

/** Shown in the cadence tooltip. */
export const RECURRENCE_HINTS: readonly string[] = [
  'In years. The event only happens in that year, then every N years after it.',
  'Leave empty for the event to run continuously.',
];

/**
 * Whether the cadence control applies to a start time point.
 *
 * A cadence counts from the event's anchor, so `now` (which has no date or age of its own in
 * the form) does not offer one; `customDate`, `customAge`, retirement and life expectancy do.
 */
export const showsRecurrenceControl = (startType: TimePoint['type']): boolean => startType !== 'now';

/**
 * Empty numeric input → `undefined`, anything else → a number.
 *
 * Without this an empty optional field submits as `''`, which an optional integer rejects, so
 * "no cadence" could never be saved. A non-numeric entry becomes `NaN` on purpose: the schema
 * rejects it, so the user sees a validation message instead of the value silently vanishing.
 */
export const optionalYearCount = (raw: unknown): number | undefined => {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return raw;

  return Number(raw);
};

/** `register` options for the cadence field (see `optionalYearCount`). */
export const OPTIONAL_YEARS_FIELD = { setValueAs: optionalYearCount } as const;
