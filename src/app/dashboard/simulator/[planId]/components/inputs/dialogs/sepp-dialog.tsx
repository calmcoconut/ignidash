'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { CalendarClockIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

import { api } from '@/convex/_generated/api';
import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Fieldset, FieldGroup, Field, Label, Legend, Description } from '@/components/catalyst/fieldset';
import { Text } from '@/components/catalyst/text';
import { Switch, SwitchField } from '@/components/catalyst/switch';
import { Divider } from '@/components/catalyst/divider';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Select } from '@/components/catalyst/select';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { seppToConvex } from '@/lib/utils/data-transformers';
import { currentLocalISODate } from '@/lib/utils/system-clock';
import {
  SEPP_YEAR_RANGE,
  seppFixedRateCoverage,
  seppRateCapForStartYear,
  seppRateWindowProblem,
  seppScheduleSchema,
  type SeppMethod,
  type SeppScheduleInputs,
} from '@/lib/schemas/inputs/sepp-form-schema';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';

interface SeppDialogProps {
  onClose: () => void;
  sepp: SeppScheduleInputs[];
  accounts: AccountInputs[];
}

const METHOD_OPTIONS: { value: SeppMethod; label: string }[] = [
  { value: 'rmd', label: 'Required minimum distribution' },
  { value: 'fixedAmortization', label: 'Fixed amortization' },
  { value: 'fixedAnnuitization', label: 'Fixed annuitization' },
];

/**
 * The account types a schedule may name.
 *
 * The engine takes the payment through the ordinary withdrawal path, so the account type decides how
 * the distribution is taxed: `ira`, `401k` and `403b` are the tax-deferred retirement accounts, where
 * the §72(t)(2)(A)(iv) exception actually buys something (the distribution is ordinary income, and
 * the 10 % additional tax would otherwise apply). A Roth schedule has no penalty to escape in this
 * model, and a taxable or savings account is not a plan the exception reaches, so neither is offered
 * rather than offered and quietly ignored.
 */
const SEPP_ACCOUNT_TYPES: AccountInputs['type'][] = ['ira', '401k', '403b'];

/**
 * One editor row. Every numeric field is a string while it is being typed, so a blank stays blank:
 * blank means *absent* — no rate (use the Notice 2022-6 cap), no explicit amount (use the method's
 * own figure), no stop year (pay for the rest of the simulation) — and only a filled-in field is
 * written. `toSchedule` is the single place that turns a row into a stored schedule.
 */
interface SeppRow {
  id: string;
  name: string;
  accountId: string;
  method: SeppMethod;
  startYear: string;
  ratePercent: string;
  annualAmount: string;
  stopYear: string;
  disabled: boolean;
}

const toRow = (schedule: SeppScheduleInputs): SeppRow => ({
  id: schedule.id,
  name: schedule.name ?? '',
  accountId: schedule.accountId,
  method: schedule.method,
  startYear: String(schedule.startYear),
  ratePercent: schedule.rate === undefined ? '' : String(schedule.rate * 100),
  annualAmount: schedule.annualAmount === undefined ? '' : String(schedule.annualAmount),
  stopYear: schedule.stopYear === undefined ? '' : String(schedule.stopYear),
  disabled: schedule.disabled ?? false,
});

const toSchedule = (row: SeppRow): SeppScheduleInputs => ({
  id: row.id,
  accountId: row.accountId,
  method: row.method,
  // A blank year is `NaN` on purpose: `seppScheduleSchema` rejects it, so the dialog reports "start
  // year: expected number" instead of writing a 0 that would silently mean year zero.
  startYear: row.startYear.trim() === '' ? Number.NaN : Number(row.startYear),
  ...(row.name.trim() === '' ? {} : { name: row.name.trim() }),
  // The rate is only the fixed methods' input: the RMD method divides the balance by the
  // life-expectancy period and never reads a rate (`processSeppDistributions` passes `rate ?? 0`
  // and `seppAnnualAmount` returns `balance / period` for `rmd`), so a stored rate here would be a
  // value nothing reads — and one that would come back to life if the method were changed later.
  ...(row.method !== 'rmd' && row.ratePercent.trim() !== '' ? { rate: Number(row.ratePercent) / 100 } : {}),
  ...(row.annualAmount.trim() === '' ? {} : { annualAmount: Number(row.annualAmount) }),
  ...(row.stopYear.trim() === '' ? {} : { stopYear: Number(row.stopYear) }),
  ...(row.disabled ? { disabled: true } : {}),
});

/**
 * A row's identity, for the group a screen reader announces and for the remove button.
 *
 * Headless UI's `<Fieldset>` takes its accessible name from its `<Legend>`, so a row is announced as
 * "Schedule 2 — Traditional IRA" instead of as seven controls named Name, Account, Method, … with
 * nothing saying which row they belong to. The name the user typed comes first (it is the row's own
 * label); the account names it when the name is blank, so two blank-name rows on different accounts
 * are still distinguishable. With neither, the position is all there is.
 */
const rowIdentity = (row: SeppRow, index: number, accountName: string | undefined): string => {
  const label = row.name.trim() || accountName?.trim();

  return label ? `Schedule ${index + 1} — ${label}` : `Schedule ${index + 1}`;
};

/**
 * Plan SEPP schedules: add, edit and remove the distributions the engine takes each January.
 *
 * One dialog over the whole list, saved in one mutation, exactly like the milestones and the glide
 * path: the plan owns one `sepp` array and the editor owns the list. Absent and empty both mean "no
 * schedules", so removing the last row and saving is a real edit rather than an invalid one.
 *
 * The copy below states what `src/lib/calc/portfolio.ts` and `src/lib/calc/retirement-rules/sepp.ts`
 * actually do, including the parts a real series needs that this model does not check.
 *
 * It also refuses a fixed-method schedule the engine would throw on from inside the run: a start
 * year the vendored mid-term rates cannot price, and a rate above the Notice 2022-6 cap for that
 * year. That throw is not survivable from the editor — the mutation would already have committed,
 * and the plan can no longer render the dialog that would undo it. See `seppRateWindowProblem`.
 */
export default function SeppDialog({ onClose, sepp, accounts }: SeppDialogProps) {
  const planId = useSelectedPlanId();

  const eligibleAccounts = accounts.filter((account) => SEPP_ACCOUNT_TYPES.includes(account.type));

  // The editor's working copy: saved whole, so removing a schedule is just removing a row.
  const [draft, setDraft] = useState<SeppRow[]>(() => sepp.map(toRow));

  // The vendored Notice 2022-6 rate window, derived from the data: a fixed method can only be
  // priced for a start year whose two-month window is on file.
  const rateCoverage = seppFixedRateCoverage();
  const identity = (row: SeppRow, index: number) => rowIdentity(row, index, accounts.find((account) => account.id === row.accountId)?.name);

  const updateSepp = useMutation(api.sepp.update);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const patch = (index: number, change: Partial<SeppRow>) =>
    setDraft((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));

  const addSchedule = () =>
    setDraft((current) => [
      ...current,
      {
        id: uuidv4(),
        name: '',
        accountId: eligibleAccounts[0]?.id ?? '',
        method: 'rmd',
        startYear: currentLocalISODate().slice(0, 4),
        ratePercent: '',
        annualAmount: '',
        stopYear: '',
        disabled: false,
      },
    ]);

  const removeSchedule = (index: number) => setDraft((current) => current.filter((_, position) => position !== index));

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const parsed = seppScheduleSchema.array().safeParse(draft.map(toSchedule));
    if (!parsed.success) {
      setSaveError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' · '));
      return;
    }

    // The editor cannot hand the plan a schedule the simulation will refuse. A fixed method is
    // priced from the Notice 2022-6 rates for the two months before its first January, and the
    // engine throws when those months are not vendored — or when the row's rate exceeds the cap
    // they set. Both throws come from inside the run, which happens during render, so the save
    // would commit first and the plan would then fail to paint on every load, leaving no dialog to
    // undo it with. Both facts are checkable without the engine, so they are checked here, before
    // the mutation, and the message names the covered range or the cap.
    const problems = parsed.data.flatMap((schedule, index) => {
      const problem = seppRateWindowProblem(schedule);

      return problem === null ? [] : [`${identity(draft[index], index)}: ${problem}`];
    });
    if (problems.length > 0) {
      setSaveError(problems.join(' · '));
      return;
    }

    try {
      setSaveError(null);
      setIsSubmitting(true);
      await updateSepp({ planId, sepp: seppToConvex(parsed.data) });
      onClose();
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save SEPP schedules.');
      console.error('Error saving SEPP schedules: ', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <CalendarClockIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>SEPP schedules</span>
        </div>
      </DialogTitle>
      <form onSubmit={onSubmit}>
        <Fieldset aria-label="SEPP schedules">
          <DialogBody>
            <FieldGroup>
              {saveError && <ErrorMessageCard errorMessage={saveError} />}
              {/* Body copy is a `<Text>`, not a `<Description>`: outside a `<Field>` Headless UI
                  registers a description into the nearest `Dialog`, and seven of these made the whole
                  help text the dialog's accessible description. `<Description>` is kept for the
                  per-control hints below, which sit inside their own `<Field>`. */}
              <Text>
                Substantially equal periodic payments are the IRC §72(t)(2)(A)(iv) exception to the 10% additional tax on early withdrawals:
                a series of payments taken at least annually for the longer of five years or until age 59½ is not an early distribution.
                Each schedule here pays once a year, in January of its start year and every January after, out of the account you name and
                into a savings account inside the model.
              </Text>

              {eligibleAccounts.length === 0 && (
                <Text>
                  A schedule needs a traditional IRA or an employer plan (401k, 403b) with a balance. This plan has none yet, so there is
                  nothing to take a payment from.
                </Text>
              )}

              {draft.length === 0 && <Text>No schedules yet.</Text>}

              {draft.map((row, index) => {
                // A fixed method may only start in a year the vendored rates can price; `rmd` reads
                // no rate, so its year is bounded only by the schema. The browser refuses an
                // out-of-range year before submit, and `seppRateWindowProblem` refuses it again in
                // `onSubmit` for the paths a native check cannot see.
                const startYearBounds =
                  row.method === 'rmd' ? SEPP_YEAR_RANGE : { min: rateCoverage.earliestStartYear, max: rateCoverage.latestStartYear };
                // The rate's own ceiling, from the engine's Notice 2022-6 window for this row's
                // start year: `null` (no vendored window, a blank year, or `rmd`) means there is no
                // bound to state, and `onSubmit` refuses the row for the year or drops the rate.
                const rateCap = row.method === 'rmd' ? null : seppRateCapForStartYear(Number(row.startYear));
                const rowLabel = identity(row, index);

                return (
                  <Fieldset key={row.id} className="rounded-lg border border-stone-200 p-4 dark:border-stone-700">
                    <div className="flex items-start justify-between gap-4">
                      {/* The row's own name: `<Legend>` names the `<Fieldset>`, so the seven
                          identically-named controls below belong to "Schedule 2 — Traditional IRA"
                          rather than to nothing. */}
                      <Legend className="min-w-0 flex-1 truncate text-base/6 font-medium text-stone-950 sm:text-sm/6 dark:text-white">
                        {rowLabel}
                      </Legend>
                      <Button plain type="button" onClick={() => removeSchedule(index)} aria-label={`Remove ${rowLabel}`}>
                        <TrashIcon data-slot="icon" />
                      </Button>
                    </div>

                    <div className="mt-4 flex flex-wrap items-start gap-4">
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`sepp-name-${index}`}>Name</Label>
                        <Input
                          id={`sepp-name-${index}`}
                          value={row.name}
                          onChange={(event) => patch(index, { name: event.target.value })}
                        />
                        <Description>A label for this row only; the simulation never reads it.</Description>
                      </Field>
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`sepp-account-${index}`}>Account</Label>
                        <Select
                          id={`sepp-account-${index}`}
                          value={row.accountId}
                          onChange={(event) => patch(index, { accountId: event.target.value })}
                        >
                          {eligibleAccounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field className="min-w-40 flex-1">
                        <Label htmlFor={`sepp-method-${index}`}>Method</Label>
                        <Select
                          id={`sepp-method-${index}`}
                          value={row.method}
                          onChange={(event) => patch(index, { method: event.target.value as SeppMethod })}
                        >
                          {METHOD_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field className="w-28">
                        <Label htmlFor={`sepp-start-year-${index}`}>Start year</Label>
                        <Input
                          id={`sepp-start-year-${index}`}
                          type="number"
                          inputMode="numeric"
                          min={startYearBounds.min}
                          max={startYearBounds.max}
                          value={row.startYear}
                          onChange={(event) => patch(index, { startYear: event.target.value })}
                        />
                      </Field>
                      {row.method !== 'rmd' && (
                        <Field className="w-32">
                          <Label htmlFor={`sepp-rate-${index}`}>Rate %</Label>
                          {/* `step="any"`: the default step of 1 makes 4.5 a stepMismatch, which the
                              browser reports by blocking the submit before `onSubmit` runs — i.e. a
                              fractional rate could never be saved and nothing said so. */}
                          <Input
                            id={`sepp-rate-${index}`}
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min={0}
                            max={rateCap === null ? undefined : rateCap.maximumRate * 100}
                            placeholder="Cap"
                            value={row.ratePercent}
                            onChange={(event) => patch(index, { ratePercent: event.target.value })}
                          />
                        </Field>
                      )}
                      <Field className="w-36">
                        <Label htmlFor={`sepp-annual-amount-${index}`}>Annual amount</Label>
                        {/* `step="any"` for the same reason as the rate: cents are a fraction. */}
                        <Input
                          id={`sepp-annual-amount-${index}`}
                          type="number"
                          inputMode="decimal"
                          step="any"
                          placeholder="Computed"
                          value={row.annualAmount}
                          onChange={(event) => patch(index, { annualAmount: event.target.value })}
                        />
                      </Field>
                      <Field className="w-28">
                        <Label htmlFor={`sepp-stop-year-${index}`}>Stop year</Label>
                        <Input
                          id={`sepp-stop-year-${index}`}
                          type="number"
                          inputMode="numeric"
                          placeholder="Never"
                          value={row.stopYear}
                          onChange={(event) => patch(index, { stopYear: event.target.value })}
                        />
                      </Field>
                    </div>

                    <div className="mt-4 flex flex-col gap-3">
                      <Text>
                        {row.method === 'rmd'
                          ? 'The required-minimum-distribution method re-reads the balance and your life-expectancy factor every year, so the payment moves with the account. It reads no interest rate, so any start year works.'
                          : `A fixed method computes the payment once, from the balance in the first year the schedule pays, and keeps that amount. Leave the rate blank to use the Notice 2022-6 maximum — the greater of 5% or 120% of the federal mid-term rate for either of the two months before the payments begin. The rate field above accepts nothing above that maximum, and a rate above it is refused on save with the maximum for that start year named, rather than written to the plan. The vendored rates run ${rateCoverage.firstCoveredMonth} through ${rateCoverage.lastCoveredMonth}, so a fixed method can only start in ${rateCoverage.earliestStartYear}–${rateCoverage.latestStartYear}, and the start year above accepts only that range.`}
                      </Text>
                      <Text>
                        An annual amount overrides the method&apos;s own figure: the account pays that much every year (or its balance, if
                        smaller). Leave it blank to let the method decide. A blank stop year keeps the payments running to the end of the
                        simulation, which is longer than the §72(t)(4) period a real series usually runs.
                      </Text>
                      <Text>
                        Stopping before the later of five years and age 59½ is a modification under §72(t)(4): the model adds back 10% of
                        every payment already taken (the tax the exception deferred, without the interest the IRS would also charge). The
                        method is the part a real plan cannot revisit — the IRS allows a one-time change from a fixed method to the
                        required-minimum-distribution method and treats any other change as a modification. This model does not police that:
                        it applies whichever method each row names, year by year.
                      </Text>
                    </div>

                    <SwitchField className="mt-4">
                      <Label>Disabled</Label>
                      <Description>
                        Pauses this schedule: it pays nothing. The engine skips a disabled schedule before it looks at the stop year, so
                        turning one off does not trigger the recapture tax — it does not model revocation as a §72(t) modification.
                      </Description>
                      <Switch checked={row.disabled} onChange={(checked) => patch(index, { disabled: checked })} color="rose" />
                    </SwitchField>
                  </Fieldset>
                );
              })}

              <Button outline type="button" onClick={addSchedule} disabled={eligibleAccounts.length === 0}>
                <PlusIcon data-slot="icon" />
                Schedule
              </Button>

              <Divider soft />
              <Text>
                This model implements the payment arithmetic and the recapture tax. It does not check the plan-level conditions a real
                series needs — separation from service for a 401(k), the account owner&apos;s birthday, or whether a method change was the
                permitted one.
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
