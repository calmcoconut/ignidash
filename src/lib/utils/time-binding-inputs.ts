/**
 * Form glue for the two time-binding controls (parity plan P1-P1).
 *
 * `amountBasis` is read and written by four entity dialogs (income, expense, debt, physical
 * asset); the `everyNYears` cadence by the two that describe a stream (income and expense).
 * The option lists, the hint copy and the register rules live here so the dialogs cannot
 * drift apart, and so the form tests exercise the same wiring the dialogs use.
 *
 * An untouched dialog adds no field to the plan: the amount basis starts on its empty
 * placeholder, which maps to `undefined`, and no cadence field is set. Every reader treats
 * both absences as `amountBasis: 'real'` and "does not repeat".
 */

import type { AmountBasis, TimePoint } from '@/lib/schemas/inputs/income-expenses-shared-schemas';

export interface AmountBasisOption {
  /** `''` is the "not set" placeholder, which every reader treats as `real`. */
  value: AmountBasis | '';
  label: string;
}

/**
 * Ordered so the empty placeholder is what a freshly mounted `<select>` shows.
 *
 * Two separate guards keep an untouched dialog from writing `amountBasis`, and either one
 * would do it on its own:
 *
 * 1. the placeholder is a UX affordance — the control opens on a blank choice ("today's
 *    dollars") instead of a pre-selected entry, so nothing is asserted before the user looks;
 * 2. `amountBasisFieldOptions.setValueAs` below is the actual guard against a stored or
 *    mounted value: it maps both the placeholder and a stale `'real'` to `undefined`.
 *
 * Because both are in place, no test can distinguish them; do not remove either.
 */
export const AMOUNT_BASIS_OPTIONS: readonly AmountBasisOption[] = [
  { value: '', label: "In today's dollars" },
  { value: 'nominal', label: 'In the start date\u2019s dollars' },
];

/**
 * Maps the placeholder back to "not set", and lets a stored `real` display as the placeholder
 * too (they mean the same thing).
 */
export const amountBasisFieldOptions = {
  setValueAs: (raw: unknown): AmountBasis | undefined => (raw === '' || raw === 'real' ? undefined : (raw as AmountBasis)),
} as const;

/** A stored `real` and an absent basis are the same thing, so the dialog shows both as unset. */
export const normalizeStoredAmountBasis = <T extends { amountBasis?: AmountBasis }>(input: T | null): T | null =>
  input !== null && input.amountBasis === 'real' ? { ...input, amountBasis: undefined } : input;

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
 * Whether an option may be picked for a given anchor: the placeholder always, `nominal` only
 * where the anchor has a dollar date. The dialogs use this for the option's `disabled`.
 */
export const isAmountBasisSelectable = (value: AmountBasis | '', startType: TimePoint['type']): boolean =>
  value !== 'nominal' || hasDollarDate(startType);

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

/** Every entity dialog that has a dated input. */
export type EntityKind = 'income' | 'expense' | 'debt' | 'physicalAsset';

/** The two entities whose date is a window (start → end), so a repeating event is meaningful. */
export const RECURRING_ENTITIES: readonly EntityKind[] = ['income', 'expense'];

/**
 * Whether an editor offers the cadence control.
 *
 * Only an income or an expense is a stream. A debt's start date and an asset's purchase date
 * are single points, and `TimeBinding.isActiveAt` would gate them on the cadence: a debt on a
 * ten-year cadence would accrue no interest and make no payment in nine years out of ten, and
 * an asset would simply never be bought. Those dialogs therefore do not offer the control.
 * `now` is excluded as well, because a cadence counts from the event's own anchor.
 */
export const showsRecurrenceControl = (entity: EntityKind, startType: TimePoint['type']): boolean =>
  RECURRING_ENTITIES.includes(entity) && startType !== 'now';

/** The form surface `clearRecurrence` needs, so the dialogs and the tests share one path. */
export interface RecurrenceFormControls {
  setValue(name: never, value: never): void;
  unregister(name: never): void;
}

/**
 * Clears the cadence value and its registration.
 *
 * `setValue(…, undefined)` clears the live value; `unregister` also drops the field and its
 * default seed, so a re-render cannot restore it. The order matters less than having both.
 */
export const clearRecurrence = (form: RecurrenceFormControls, field: string): void => {
  form.setValue(field as never, undefined as never);
  form.unregister(field as never);
};

/**
 * Clears the cadence only when the anchor *becomes* `now`, never when it already is.
 *
 * The dialogs call this from their cleanup effect, which also runs on mount. Clearing whenever
 * `startType === 'now'` would therefore delete a stored cadence from a plan that was already
 * `now`-anchored, on any save — and `timePointSchema` allows that combination while the engine
 * honours it (a `now` anchor repeats on the plan's year grid). Losing it to an untouched edit
 * is exactly the data loss the hidden control must not cause.
 */
export const clearRecurrenceOnAnchorChange = (
  form: RecurrenceFormControls,
  previousStartType: TimePoint['type'],
  startType: TimePoint['type'],
  field: string
): void => {
  if (previousStartType !== startType && startType === 'now') clearRecurrence(form, field);
};

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
