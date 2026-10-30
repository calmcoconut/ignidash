'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { useState } from 'react';

import { api } from '@/convex/_generated/api';
import { useAccountsData } from '@/hooks/use-convex-data';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { buildJournalEntryDraft, JOURNAL_NOTE_MAX_LENGTH, parseJournalDateInput } from '@/lib/utils/net-worth-journal-form';
import { formatCurrencyPlaceholder } from '@/lib/utils/number-formatters';
import SectionHeader from '@/components/ui/section-header';
import SectionContainer from '@/components/ui/section-container';
import Card from '@/components/ui/card';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Field, FieldGroup, Fieldset, Label, ErrorMessage, Description } from '@/components/catalyst/fieldset';
import { Input } from '@/components/catalyst/input';
import { Textarea } from '@/components/catalyst/textarea';
import { Button } from '@/components/catalyst/button';
import { DialogActions } from '@/components/catalyst/dialog';
import { Divider } from '@/components/catalyst/divider';

interface NetWorthJournalDrawerProps {
  setOpen: (open: boolean) => void;
}

/**
 * Records one manual net-worth snapshot (P4-P7).
 *
 * The journal is manual by design: the operator types what the accounts actually hold on a date,
 * and the overlay compares that with the projection. So this is deliberately one entry at a time —
 * a date, a balance per account, an optional note — not a bulk editor or an importer.
 *
 * The date field takes a year, a year-month or a full date; a partial date covers the whole period
 * it names (`2026` is 2026-12-31), and the field says which day it will be recorded as, because
 * "2026" typed in September is not a September snapshot. Validation lives in
 * `buildJournalEntryDraft` so the same rules can be tested without a DOM; the mutation re-checks
 * them on the server and its message is shown if it disagrees.
 */
export default function NetWorthJournalDrawer({ setOpen }: NetWorthJournalDrawerProps) {
  const planId = useSelectedPlanId();
  const { data: accounts, isLoading } = useAccountsData();
  const createEntry = useMutation(api.net_worth_journal.create);

  const [date, setDate] = useState('');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const accountList = Object.values(accounts);
  const parsedDate = date.trim() === '' ? null : parseJournalDateInput(date);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const draft = buildJournalEntryDraft({
      date,
      balances: accountList.map((account) => ({ accountId: account.id, label: account.name, amount: balances[account.id] ?? '' })),
      note,
    });

    if (!draft.ok) {
      setIssues(draft.issues);
      return;
    }

    setIssues([]);
    setSaveError(null);
    setIsSubmitting(true);

    try {
      await createEntry({ planId, entry: draft.entry });
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to record the entry.');
      console.error('Error recording the journal entry: ', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SectionContainer showBottomBorder={false} location="drawer">
      <SectionHeader
        title="Net Worth Journal"
        desc="Record what your accounts actually hold, so the projection can be compared with reality."
      />
      <Card>
        <form onSubmit={onSubmit}>
          <Fieldset aria-label="Journal entry">
            <FieldGroup>
              {saveError && <ErrorMessageCard errorMessage={saveError} />}
              {issues.length > 0 && (
                <ul role="alert" className="list-disc pl-5 text-sm text-red-600 dark:text-red-400">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}

              <Field>
                <Label htmlFor="journal-date">Date</Label>
                <Input
                  id="journal-date"
                  name="journal-date"
                  inputMode="numeric"
                  placeholder="2026"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
                {parsedDate && !parsedDate.ok ? (
                  <ErrorMessage>{parsedDate.message}</ErrorMessage>
                ) : (
                  <Description>
                    {parsedDate
                      ? `Recorded as the end of that period: ${parsedDate.effectiveDate}.`
                      : 'A year (2026), a year and month (2026-09) or a full date (2026-09-30). A partial date covers the whole period it names.'}
                  </Description>
                )}
              </Field>

              <Divider />

              {isLoading ? (
                <Description>Loading accounts…</Description>
              ) : accountList.length === 0 ? (
                <Description>This plan has no accounts yet. Add an account before recording a snapshot.</Description>
              ) : (
                accountList.map((account) => (
                  <Field key={account.id}>
                    <Label htmlFor={`journal-balance-${account.id}`}>{account.name}</Label>
                    <Input
                      id={`journal-balance-${account.id}`}
                      name={`journal-balance-${account.id}`}
                      inputMode="decimal"
                      placeholder={formatCurrencyPlaceholder(account.balance ?? 0)}
                      value={balances[account.id] ?? ''}
                      onChange={(event) => setBalances((current) => ({ ...current, [account.id]: event.target.value }))}
                    />
                    <Description>What this account holds today. Leave it blank to omit it from this snapshot.</Description>
                  </Field>
                ))
              )}

              <Divider />

              <Field>
                <Label htmlFor="journal-note">Note (optional)</Label>
                <Textarea
                  id="journal-note"
                  name="journal-note"
                  rows={3}
                  maxLength={JOURNAL_NOTE_MAX_LENGTH}
                  placeholder="Anything worth remembering about this snapshot."
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>
            </FieldGroup>
          </Fieldset>

          <DialogActions>
            <Button outline type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button color="rose" type="submit" disabled={isSubmitting || isLoading}>
              {isSubmitting ? 'Recording…' : 'Record entry'}
            </Button>
          </DialogActions>
        </form>
      </Card>
    </SectionContainer>
  );
}
