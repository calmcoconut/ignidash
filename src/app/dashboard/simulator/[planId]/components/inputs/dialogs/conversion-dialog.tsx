'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { ArrowRightLeftIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import { api } from '@/convex/_generated/api';
import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Fieldset, FieldGroup, Field, Label, Legend, Description } from '@/components/catalyst/fieldset';
import { Text } from '@/components/catalyst/text';
import { Divider } from '@/components/catalyst/divider';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Select } from '@/components/catalyst/select';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { conversionsToConvex } from '@/lib/utils/data-transformers';
import { currentLocalISODate } from '@/lib/utils/system-clock';
import { accountTypeForDisplay, isRothAccount, isTraditionalAccount, type AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import {
  CONVERSION_YEAR_RANGE,
  FILL_TO_BRACKET_RATE_TOLERANCE,
  conversionFillToBracketRates,
  conversionsProblems,
  conversionsSchema,
  type ConversionInputs,
  type ConversionJurisdiction,
} from '@/lib/schemas/inputs/conversion-form-schema';

interface ConversionDialogProps {
  onClose: () => void;
  conversions: ConversionInputs[];
  accounts: AccountInputs[];
}

/**
 * The timing a row can name, as the select offers it.
 *
 * `atLifeExpectancy` is in the stored union but not in the list below: `simulation-engine.ts` filters
 * conversions by `now`, `atRetirement`, `customAge` and `customDate` and has no branch for it, so a
 * life-expectancy row converts nothing. It is still *rendered* when a stored row carries it — an
 * imported schedule must not be silently rewritten — as a last option that says it is not honoured,
 * and the shared rule refuses to save until the row is changed.
 */
type TimingMode = 'year' | 'now' | 'atRetirement' | 'customAge' | 'atLifeExpectancy';

const TIMING_OPTIONS: { value: TimingMode; label: string }[] = [
  { value: 'year', label: 'In a calendar year' },
  { value: 'now', label: 'This year (the plan’s first year)' },
  { value: 'atRetirement', label: 'When the plan reaches retirement' },
  { value: 'customAge', label: 'At an age' },
];

const IGNORED_TIMING_OPTION: { value: TimingMode; label: string } = {
  value: 'atLifeExpectancy',
  label: 'At life expectancy (not honoured — pick another timing)',
};

/** A row's target: a fixed amount of dollars, or the top of a bracket to fill. */
type TargetMode = 'amount' | 'fillToBracket';

const TARGET_OPTIONS: { value: TargetMode; label: string }[] = [
  { value: 'amount', label: 'A fixed amount' },
  { value: 'fillToBracket', label: 'Fill up to a bracket' },
];

/**
 * One editor row. Every numeric field is a string while it is being typed, so a blank stays blank
 * and becomes `NaN` on the way out — the schema then reports "expected number" rather than a `0` that
 * would silently mean "convert nothing".
 *
 * `storedAsCustomDate` and the two recurrence fields are what makes the round trip non-destructive: a
 * row loaded from `timePoint: { type: 'customDate', month: 1, year: 2031 }` shows under "In a
 * calendar year" (the engine compares exactly that one year either way) but is written back in its
 * own union member, and a hand-authored `everyNYears`/`recurrenceYears` is carried back untouched —
 * the conversion filter never reads them, but dropping them is still a silent edit nobody asked for.
 */
interface ConversionRow {
  id: string;
  name: string;
  fromAccountId: string;
  toAccountId: string;
  timing: TimingMode;
  year: string;
  age: string;
  storedAsCustomDate: boolean;
  everyNYears?: number;
  recurrenceYears?: number;
  target: TargetMode;
  amount: string;
  bracketRate: string;
  jurisdiction: ConversionJurisdiction;
}

const toRow = (conversion: ConversionInputs): ConversionRow => {
  const { timePoint } = conversion;
  const timing: TimingMode =
    conversion.year !== undefined ? 'year' : timePoint === undefined ? 'year' : timePoint.type === 'customDate' ? 'year' : timePoint.type;

  const year =
    conversion.year !== undefined
      ? String(conversion.year)
      : timePoint?.type === 'customDate' && timePoint.year !== undefined
        ? String(timePoint.year)
        : '';

  const amount = 'amount' in conversion ? conversion.amount : undefined;
  const fillToBracket = 'fillToBracket' in conversion ? conversion.fillToBracket : undefined;

  const row: ConversionRow = {
    id: conversion.id,
    name: conversion.name ?? '',
    fromAccountId: conversion.fromAccountId,
    toAccountId: conversion.toAccountId,
    timing,
    year,
    age: timePoint?.type === 'customAge' && timePoint.age !== undefined ? String(timePoint.age) : '',
    storedAsCustomDate: timePoint?.type === 'customDate',
    target: fillToBracket === undefined ? 'amount' : 'fillToBracket',
    amount: amount === undefined ? '' : String(amount),
    bracketRate:
      fillToBracket === undefined
        ? ''
        : typeof fillToBracket === 'number'
          ? String(fillToBracket)
          : String(fillToBracket.targetBracketRate),
    jurisdiction: typeof fillToBracket === 'object' && fillToBracket.jurisdiction ? fillToBracket.jurisdiction : 'federal',
  };

  if (timePoint?.everyNYears !== undefined) row.everyNYears = timePoint.everyNYears;
  if (timePoint?.recurrenceYears !== undefined) row.recurrenceYears = timePoint.recurrenceYears;

  return row;
};

/** A year input's value, or `NaN`: `conversionSchema` rejects `NaN`, which is how a blank is reported. */
const toNumber = (value: string): number => (value.trim() === '' ? Number.NaN : Number(value));

/** The parts of a Zod issue this dialog reads. Structural, so it fits `z.ZodError['issues']`. */
type IssueLike = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly IssueLike[])[];
};

/**
 * A Zod failure as one line per problem, with the field named.
 *
 * `conversionSchema` is a **union**, and a union reports its own failure as a bare "Invalid input" at
 * the row's index — the field that failed is inside `issue.errors`, one list per member. Showing the
 * outer message alone would tell the reader nothing about which control to fix, so the member errors
 * are what is shown, each prefixed with the row's index so a multi-row list still says which row.
 */
const issueMessages = (issues: readonly IssueLike[]): string[] =>
  issues.flatMap((issue) => {
    if (issue.code === 'invalid_union' && issue.errors !== undefined) {
      const prefix = issue.path.length > 0 ? `${issue.path.join('.')}.` : '';
      const nested = issue.errors.flatMap((group) => issueMessages(group));

      return nested.length > 0 ? nested.map((message) => `${prefix}${message}`) : [`${issue.path.join('.')}: ${issue.message}`];
    }

    return [`${issue.path.join('.')}: ${issue.message}`];
  });

const toConversion = (row: ConversionRow): ConversionInputs => {
  const base = {
    id: row.id,
    ...(row.name.trim() === '' ? {} : { name: row.name.trim() }),
    fromAccountId: row.fromAccountId,
    toAccountId: row.toAccountId,
  };

  const target =
    row.target === 'amount'
      ? { amount: toNumber(row.amount) }
      : { fillToBracket: { targetBracketRate: toNumber(row.bracketRate), jurisdiction: row.jurisdiction } };

  // A recurrence on a conversion is dead weight — the filter reads only `type`, `year` and `age`, and a
  // row fires once — but it is preserved rather than dropped. See `ConversionRow`.
  const recurrence = {
    ...(row.everyNYears === undefined ? {} : { everyNYears: row.everyNYears }),
    ...(row.recurrenceYears === undefined ? {} : { recurrenceYears: row.recurrenceYears }),
  };

  switch (row.timing) {
    case 'year':
      if (!row.storedAsCustomDate) return { ...base, ...target, year: toNumber(row.year) };
      // The engine fires a conversion in January of its year for a fixed amount (and prices a
      // fill-to-bracket row at the December settlement), and reads only `year` from a custom date.
      // `month` is 1 because `timePointSchema` requires it and January is when the amount moves.
      return { ...base, ...target, timePoint: { type: 'customDate', month: 1, year: toNumber(row.year), ...recurrence } };
    case 'customAge':
      return { ...base, ...target, timePoint: { type: 'customAge', age: toNumber(row.age), ...recurrence } };
    case 'now':
    case 'atRetirement':
    case 'atLifeExpectancy':
      return { ...base, ...target, timePoint: { type: row.timing, ...recurrence } };
  }
};

/**
 * A row's identity, for the group a screen reader announces and for the remove button.
 *
 * Headless UI's `<Fieldset>` takes its accessible name from its `<Legend>`, so a row is announced as
 * "Conversion 2 — Traditional IRA → Roth IRA" instead of as nine controls named Name, From, To, …
 * with nothing saying which row they belong to. The name the user typed comes first (it is the row's
 * own label); otherwise the pair of accounts names it, which is the row's whole point. With neither —
 * an account that no longer exists — the position is all there is.
 */
const rowIdentity = (row: ConversionRow, index: number, accounts: readonly AccountInputs[]): string => {
  const label = row.name.trim() || undefined;
  if (label !== undefined) return `Conversion ${index + 1} — ${label}`;

  const from = accounts.find((account) => account.id === row.fromAccountId)?.name;
  const to = accounts.find((account) => account.id === row.toAccountId)?.name;

  return from !== undefined && to !== undefined ? `Conversion ${index + 1} — ${from} → ${to}` : `Conversion ${index + 1}`;
};

/**
 * Plan Roth conversions: add, edit and remove the schedule, and see what is already there.
 *
 * One dialog over the whole list, saved in one mutation, exactly like the SEPP schedules and the
 * milestones: the plan owns one `conversions` array and the editor owns the list. Absent and empty
 * both mean "no conversions", so removing the last row and saving is a real edit rather than an
 * invalid one.
 *
 * Every refusal comes from `conversionsProblems` in `src/lib/schemas/inputs/conversion-form-schema.ts`
 * — the same rule `convex/conversion.ts` applies — so the dialog cannot accept a row the mutation
 * would refuse, and it cannot refuse one the mutation would take. The reason this matters here rather
 * than being tidy: the simulation throws on a conversion whose account is gone, it throws during
 * render, and there is no error boundary above it. A save that committed such a row would take the
 * plan and this dialog down with it.
 *
 * The copy states what `portfolio.ts`, `simulation-engine.ts` and `taxes.ts` actually do, including
 * the parts only a run can answer: a conversion capped at the account's balance, a fill-to-bracket row
 * that converts nothing when the year's income is already over the ceiling, and a row whose timing
 * lands in a year the plan never reaches.
 */
export default function ConversionDialog({ onClose, conversions, accounts }: ConversionDialogProps) {
  const planId = useSelectedPlanId();

  const taxDeferredAccounts = accounts.filter((account) => isTraditionalAccount(account.type));
  const rothAccounts = accounts.filter((account) => isRothAccount(account.type));
  const canAdd = taxDeferredAccounts.length > 0 && rothAccounts.length > 0;

  // The editor's working copy: saved whole, so removing a conversion is just removing a row.
  const [draft, setDraft] = useState<ConversionRow[]>(() => conversions.map(toRow));

  const updateConversions = useMutation(api.conversion.update);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const identity = (row: ConversionRow, index: number) => rowIdentity(row, index, accounts);

  const patch = (index: number, change: Partial<ConversionRow>) =>
    setDraft((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));

  const addConversion = () =>
    setDraft((current) => [
      ...current,
      {
        id: uuidv4(),
        name: '',
        fromAccountId: taxDeferredAccounts[0]?.id ?? '',
        toAccountId: rothAccounts[0]?.id ?? '',
        timing: 'year',
        // The calendar year the user is looking at; a row's first guess, and editable to any year.
        year: currentLocalISODate().slice(0, 4),
        age: '',
        storedAsCustomDate: false,
        target: 'amount',
        amount: '',
        bracketRate: String(conversionFillToBracketRates('federal')[0]),
        jurisdiction: 'federal',
      },
    ]);

  const removeConversion = (index: number) => setDraft((current) => current.filter((_, position) => position !== index));

  /**
   * Switching a row to a bracket target seeds the lowest bracket of the row's own bracket set.
   *
   * Without it a row that started as a fixed amount has no rate to show, and a blank `<select>` value
   * would be the only hint that the choice was not made: the rate is required, so the row would be
   * refused on save with "expected number" and nothing on screen to fix.
   */
  const switchTarget = (index: number, target: TargetMode) =>
    patch(index, {
      target,
      ...(target === 'fillToBracket' && draft[index].bracketRate.trim() === ''
        ? { bracketRate: String(conversionFillToBracketRates(draft[index].jurisdiction)[0]) }
        : {}),
    });

  /** The accounts a row may name, plus the one it already names if that is no longer a valid choice. */
  const accountChoices = (eligible: AccountInputs[], currentId: string): AccountInputs[] => {
    const current = accounts.find((account) => account.id === currentId);

    return current !== undefined && !eligible.some((account) => account.id === current.id) ? [...eligible, current] : eligible;
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = conversionsSchema.safeParse(draft.map(toConversion));
    if (!parsed.success) {
      setSaveError(issueMessages(parsed.error.issues).join(' · '));
      return;
    }

    // The editor cannot hand the plan a conversion the simulation will refuse — or silently misread.
    // Each reason is checkable from the stored data alone, which is why it is checked before the
    // mutation: the throw it prevents happens inside the run, which happens during render, so the
    // save would commit first and the plan would then fail to paint on every load, leaving no dialog
    // to undo it with. The message names the row and what to change.
    const problems = conversionsProblems(parsed.data, accounts);
    if (problems.length > 0) {
      setSaveError(problems.map(({ index, problem }) => `${identity(draft[index], index)}: ${problem}`).join(' · '));
      return;
    }

    try {
      setSaveError(null);
      setIsSubmitting(true);
      await updateConversions({ planId, conversions: conversionsToConvex(parsed.data) });
      onClose();
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save Roth conversions.');
      console.error('Error saving Roth conversions: ', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <ArrowRightLeftIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>Roth conversions</span>
        </div>
      </DialogTitle>
      <form onSubmit={onSubmit}>
        <Fieldset aria-label="Roth conversions">
          <DialogBody>
            <FieldGroup>
              {saveError && <ErrorMessageCard errorMessage={saveError} />}
              {/* Body copy is a `<Text>`, not a `<Description>`: outside a `<Field>` Headless UI
                  registers a description into the nearest `Dialog`, and a page of these made the whole
                  help text the dialog's accessible description. `<Description>` is kept for the
                  per-control hints below, which sit inside their own `<Field>`. */}
              <Text>
                A Roth conversion moves money from a tax-deferred account (a traditional IRA or an employer plan) into a Roth account. The
                amount moved counts as ordinary income in the year it moves, so taxable income rises and the tax on it is paid from the rest
                of the plan. A traditional IRA&apos;s non-deductible basis is pro-rated first (Form 8606), so only the pre-tax share is
                income, and the Roth records the conversion&apos;s date: withdrawing converted money within five years and before age 59½
                costs the 10% additional tax that an ordinary Roth withdrawal would not.
              </Text>
              <Text>
                Each row fires once — the simulation remembers which conversions it has already run — and this model applies no income
                limit: a conversion is allowed whatever the year&apos;s income is.
              </Text>

              {!canAdd && (
                <Text>
                  A conversion needs a tax-deferred account to take from (IRA, 401(k), 403(b)) and a Roth account to land in. This plan does
                  not have both yet, so there is nothing to convert between.
                </Text>
              )}

              {draft.length === 0 && <Text>No conversions yet.</Text>}

              {draft.map((row, index) => {
                const rowLabel = identity(row, index);
                const fromChoices = accountChoices(taxDeferredAccounts, row.fromAccountId);
                const toChoices = accountChoices(rothAccounts, row.toAccountId);
                const bracketRates = conversionFillToBracketRates(row.jurisdiction);
                const currentRate = toNumber(row.bracketRate);
                // A stored rate that is not a bracket in the chosen jurisdiction stays visible, so an
                // imported schedule can be read and fixed instead of silently rewritten or hidden.
                const rateChoices =
                  !Number.isFinite(currentRate) ||
                  bracketRates.some((rate) => Math.abs(rate - currentRate) < FILL_TO_BRACKET_RATE_TOLERANCE)
                    ? bracketRates
                    : [...bracketRates, currentRate];

                return (
                  <Fieldset key={row.id} className="rounded-lg border border-stone-200 p-4 dark:border-stone-700">
                    <div className="flex items-start justify-between gap-4">
                      {/* The row's own name: `<Legend>` names the `<Fieldset>`, so the nine
                          identically-named controls below belong to "Conversion 2 — Traditional IRA
                          → Roth IRA" rather than to nothing. */}
                      <Legend className="min-w-0 flex-1 truncate text-base/6 font-medium text-stone-950 sm:text-sm/6 dark:text-white">
                        {rowLabel}
                      </Legend>
                      <Button plain type="button" onClick={() => removeConversion(index)} aria-label={`Remove ${rowLabel}`}>
                        <TrashIcon data-slot="icon" />
                      </Button>
                    </div>

                    <div className="mt-4 flex flex-wrap items-start gap-4">
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`conversion-name-${index}`}>Name</Label>
                        <Input
                          id={`conversion-name-${index}`}
                          value={row.name}
                          onChange={(event) => patch(index, { name: event.target.value })}
                        />
                        <Description>A label for this row only; the simulation never reads it.</Description>
                      </Field>
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`conversion-from-${index}`}>From</Label>
                        <Select
                          id={`conversion-from-${index}`}
                          value={row.fromAccountId}
                          onChange={(event) => patch(index, { fromAccountId: event.target.value })}
                        >
                          {fromChoices.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name} ({accountTypeForDisplay(account.type)})
                            </option>
                          ))}
                        </Select>
                        <Description>The tax-deferred side: the balance that is taxed when it moves.</Description>
                      </Field>
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`conversion-to-${index}`}>To</Label>
                        <Select
                          id={`conversion-to-${index}`}
                          value={row.toAccountId}
                          onChange={(event) => patch(index, { toAccountId: event.target.value })}
                        >
                          {toChoices.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name} ({accountTypeForDisplay(account.type)})
                            </option>
                          ))}
                        </Select>
                        <Description>The Roth side: where the money lands, and where it grows untaxed from then on.</Description>
                      </Field>
                    </div>

                    <div className="mt-4 flex flex-wrap items-start gap-4">
                      <Field className="min-w-44 flex-1">
                        <Label htmlFor={`conversion-timing-${index}`}>When</Label>
                        <Select
                          id={`conversion-timing-${index}`}
                          value={row.timing}
                          onChange={(event) => patch(index, { timing: event.target.value as TimingMode })}
                        >
                          {/* A stored `atLifeExpectancy` row is shown, so it can be seen and changed;
                              it is not offered to a new row because it never fires. */}
                          {(row.timing === 'atLifeExpectancy' ? [...TIMING_OPTIONS, IGNORED_TIMING_OPTION] : TIMING_OPTIONS).map(
                            (option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            )
                          )}
                        </Select>
                      </Field>
                      {row.timing === 'year' && (
                        <Field className="w-28">
                          <Label htmlFor={`conversion-year-${index}`}>Year</Label>
                          <Input
                            id={`conversion-year-${index}`}
                            type="number"
                            inputMode="numeric"
                            min={CONVERSION_YEAR_RANGE.min}
                            max={CONVERSION_YEAR_RANGE.max}
                            value={row.year}
                            onChange={(event) => patch(index, { year: event.target.value })}
                          />
                        </Field>
                      )}
                      {row.timing === 'customAge' && (
                        <Field className="w-24">
                          <Label htmlFor={`conversion-age-${index}`}>Age</Label>
                          <Input
                            id={`conversion-age-${index}`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={120}
                            value={row.age}
                            onChange={(event) => patch(index, { age: event.target.value })}
                          />
                        </Field>
                      )}
                      <Field className="min-w-44 flex-1">
                        <Label htmlFor={`conversion-target-${index}`}>Target</Label>
                        <Select
                          id={`conversion-target-${index}`}
                          value={row.target}
                          onChange={(event) => switchTarget(index, event.target.value as TargetMode)}
                        >
                          {TARGET_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {row.target === 'amount' ? (
                        <Field className="w-36">
                          <Label htmlFor={`conversion-amount-${index}`}>Amount</Label>
                          {/* `step="any"`: the default step of 1 makes cents a stepMismatch, and the
                              browser then blocks the submit without saying why. */}
                          <Input
                            id={`conversion-amount-${index}`}
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min={0}
                            placeholder="Dollars"
                            value={row.amount}
                            onChange={(event) => patch(index, { amount: event.target.value })}
                          />
                        </Field>
                      ) : (
                        <>
                          <Field className="w-36">
                            <Label htmlFor={`conversion-bracket-${index}`}>Bracket</Label>
                            <Select
                              id={`conversion-bracket-${index}`}
                              value={row.bracketRate}
                              onChange={(event) => patch(index, { bracketRate: event.target.value })}
                            >
                              {rateChoices.map((rate) => (
                                <option key={rate} value={String(rate)}>
                                  {`${Number((rate * 100).toFixed(4))}%`}
                                  {bracketRates.some((candidate) => Math.abs(candidate - rate) < FILL_TO_BRACKET_RATE_TOLERANCE)
                                    ? ''
                                    : ' (not a bracket here)'}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field className="w-36">
                            <Label htmlFor={`conversion-jurisdiction-${index}`}>Bracket set</Label>
                            <Select
                              id={`conversion-jurisdiction-${index}`}
                              value={row.jurisdiction}
                              onChange={(event) => patch(index, { jurisdiction: event.target.value as ConversionJurisdiction })}
                            >
                              <option value="federal">Federal</option>
                              <option value="california">California</option>
                            </Select>
                          </Field>
                        </>
                      )}
                    </div>

                    <div className="mt-4 flex flex-col gap-3">
                      <Text>
                        {row.timing === 'year'
                          ? 'A calendar year converts once, in January of that year, after that year’s required minimum distributions. A year the plan never reaches converts nothing.'
                          : row.timing === 'now'
                            ? 'This year is the plan’s first calendar year — the same as naming that year, written as a time point so it follows the plan if the year changes.'
                            : row.timing === 'atRetirement'
                              ? 'At retirement converts in the first January the phase is called retirement. A plan that never reaches retirement converts nothing.'
                              : row.timing === 'customAge'
                                ? 'At an age converts in the January the household age, rounded down, equals the age you name. An age the plan never reaches converts nothing.'
                                : 'A life-expectancy time point matches no branch of the simulation’s conversion filter, so this row converts nothing. Change the timing to save the schedule.'}
                      </Text>
                      <Text>
                        {row.target === 'amount'
                          ? 'A fixed amount moves that many dollars, or the account’s whole balance if it is smaller — the simulation never overdraws the account. The amount is required, so a blank row is refused on save rather than stored as zero.'
                          : `Fill up to a bracket converts whatever fits under the top of the ${row.jurisdiction === 'california' ? 'California' : 'federal'} bracket you pick, using that year’s other income — the simulation searches the amount that lands within a dollar of the ceiling. It is priced at the year’s final settlement rather than in January, and a year whose income is already over the ceiling converts nothing.`}
                      </Text>
                    </div>
                  </Fieldset>
                );
              })}

              <Button outline type="button" onClick={addConversion} disabled={!canAdd}>
                <PlusIcon data-slot="icon" />
                Conversion
              </Button>

              <Divider soft />
              <Text>
                This model implements the conversion itself, the ordinary income it creates (the net investment income tax included, since a
                conversion raises the MAGI that tax is measured against), the Roth’s five-year seasoning and the source IRA’s pro-rata
                basis. It does not check the conditions a real conversion has to satisfy — an employer plan that permits an in-service
                distribution, for one — and it applies no income limit.
              </Text>
            </FieldGroup>
          </DialogBody>
        </Fieldset>
        <DialogActions>
          <Button plain onClick={onClose} className="hidden sm:inline-flex" disabled={isSubmitting}>
            Cancel
          </Button>
          <Button color="rose" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </>
  );
}
