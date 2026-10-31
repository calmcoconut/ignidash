'use client';

import { useMutation, useQuery } from 'convex/react';
import { useRef, useState } from 'react';
import { ArrowDownToLineIcon } from 'lucide-react';

import { api } from '@/convex/_generated/api';
import type { Doc } from '@/convex/_generated/dataModel';
import Card from '@/components/ui/card';
import { Fieldset, FieldGroup, Field, Label, Legend, Description } from '@/components/catalyst/fieldset';
import { Alert, AlertActions, AlertBody, AlertDescription, AlertTitle } from '@/components/catalyst/alert';
import { Button } from '@/components/catalyst/button';
import { Select } from '@/components/catalyst/select';
import { Divider } from '@/components/catalyst/divider';
import { downloadText } from '@/lib/export/download-json';
import {
  createPlanEnvelope,
  createPlansEnvelope,
  exportFilename,
  financesFromParts,
  parseEnvelope,
  prepareImport,
  serializeEnvelope,
  type ExportEnvelope,
  type ImportIssue,
  type ImportPlan,
} from '@/lib/export/plan-envelope';

import ImportIssues from '@/components/ui/import-issues';

interface BackupSettingsFormProps {
  showSuccessNotification: (title: string, desc?: string) => void;
}

type PreparedImport = Extract<ImportPlan, { ok: true }>;

export default function BackupSettingsForm({ showSuccessNotification }: BackupSettingsFormProps) {
  const plans = useQuery(api.plans.listPlans);
  const assets = useQuery(api.finances.getAssets);
  const liabilities = useQuery(api.finances.getLiabilities);

  const createPlanMutation = useMutation(api.plans.createPlanWithData);
  const replaceFinancesMutation = useMutation(api.finances.replaceAllFinances);

  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [issues, setIssues] = useState<ImportIssue[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [pendingEnvelope, setPendingEnvelope] = useState<ExportEnvelope | null>(null);
  // A file the engine can run but the app's forms would not have written: shown, then the
  // operator decides. Same confirmation pattern as the finances guard below.
  const [pendingUnusual, setPendingUnusual] = useState<{ envelope: ExportEnvelope; warnings: ImportIssue[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isLoading = plans === undefined || assets === undefined || liabilities === undefined;
  const finances = isLoading ? null : financesFromParts(assets, liabilities);
  const selectedPlan: Doc<'plans'> | undefined = plans?.find((plan) => plan._id === selectedPlanId) ?? plans?.[0];

  // The wall clock is read here, at the UI boundary: the envelope module stays pure.
  const exportedAt = () => new Date().toISOString();

  const exportPlan = () => {
    if (!selectedPlan) return;
    const envelope = createPlanEnvelope({ plan: selectedPlan, finances, exportedAt: exportedAt() });
    downloadText(exportFilename(envelope), serializeEnvelope(envelope));
    setStatus(`Exported "${selectedPlan.name}".`);
    showSuccessNotification('Plan exported!', 'Keep the downloaded file somewhere safe.');
  };

  const exportEverything = () => {
    const envelope = createPlansEnvelope({ plans: plans ?? [], finances, exportedAt: exportedAt() });
    downloadText(exportFilename(envelope), serializeEnvelope(envelope));
    setStatus(`Exported ${plans?.length ?? 0} plan(s) and the finances.`);
    showSuccessNotification('Backup exported!', 'It contains every plan and your finances.');
  };

  /** Writes the import, finances first so imported plans keep their synced links. */
  const applyImport = async (prepared: PreparedImport) => {
    setIsBusy(true);
    setIssues(null);
    setStatus(null);
    try {
      if (prepared.finances) {
        // The snapshot of what is about to be overwritten is downloaded *before* the
        // first write, so a failed import still leaves the operator with a backup.
        downloadText(exportFilename(prepared.snapshot, 'ignidash-snapshot'), serializeEnvelope(prepared.snapshot));
        await replaceFinancesMutation({
          assets: prepared.finances.assets,
          liabilities: prepared.finances.liabilities,
          confirmReplace: true,
        });
      }

      for (const plan of prepared.plans) {
        const { name, isDefault: _isDefault, ...planData } = plan;
        // An import never takes over the account's default plan: the file's flag is
        // deliberately ignored so restoring a backup cannot switch the active plan.
        await createPlanMutation({ ...planData, newPlanName: name, isDefault: false });
      }

      const imported = `Imported ${prepared.plans.length} plan(s)${prepared.finances ? ' and the finances' : ''}.`;
      setStatus(imported);
      showSuccessNotification('Import complete!', imported);
    } catch (error) {
      setIssues([{ path: '', message: error instanceof Error ? error.message : 'The import failed.' }]);
    } finally {
      setIsBusy(false);
      setPendingEnvelope(null);
    }
  };

  const startImport = (envelope: ExportEnvelope) => {
    const prepared = prepareImport(envelope, { plans: plans ?? [], finances }, { confirmReplaceFinances: false, exportedAt: exportedAt() });

    if (prepared.ok) {
      void applyImport(prepared);
      return;
    }

    // The only recoverable refusal is the finances confirmation: open the guard.
    if (prepared.issues.length === 1 && prepared.issues[0].path === 'finances') {
      setPendingEnvelope(envelope);
      return;
    }

    setIssues(prepared.issues);
  };

  const confirmFinancesImport = () => {
    if (!pendingEnvelope) return;
    const prepared = prepareImport(
      pendingEnvelope,
      { plans: plans ?? [], finances },
      { confirmReplaceFinances: true, exportedAt: exportedAt() }
    );
    if (!prepared.ok) {
      setIssues(prepared.issues);
      setPendingEnvelope(null);
      return;
    }
    void applyImport(prepared);
  };

  const handleFile = async (file: File | undefined) => {
    setIssues(null);
    setStatus(null);
    setPendingUnusual(null);
    if (!file) return;

    const parsed = parseEnvelope(await file.text());
    if (!parsed.ok) {
      setIssues(parsed.issues);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    if (parsed.warnings.length > 0) {
      // Not a refusal: the engine runs this plan, the app's forms just would not have
      // written it. Name every unusual field and let the operator continue.
      setPendingUnusual({ envelope: parsed.envelope, warnings: parsed.warnings });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    startImport(parsed.envelope);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confirmUnusualImport = () => {
    if (!pendingUnusual) return;
    const { envelope } = pendingUnusual;
    setPendingUnusual(null);
    startImport(envelope);
  };

  const financeCounts = finances ? `${finances.assets.length} asset(s) and ${finances.liabilities.length} liability(ies)` : 'no finances';

  return (
    <>
      <Card className="my-6">
        <form onSubmit={(e) => e.preventDefault()}>
          <Fieldset>
            <Legend className="flex items-center gap-2">
              <ArrowDownToLineIcon className="text-primary h-6 w-6" aria-hidden="true" />
              Backup &amp; restore
            </Legend>
            {/* Headless UI's <Description> only resolves inside a <Field>: with a bare <Fieldset> parent it throws at
                render time, which took the whole settings page down. The sentence introduces the card, so it gets a
                field of its own rather than being dropped. */}
            <Field>
              <Description>
                One plan, or every plan plus the net-worth tracker, as a versioned JSON file. Restoring a full backup replaces your
                finances.
              </Description>
            </Field>
            <FieldGroup>
              <Field>
                <Label htmlFor="exportPlanId">Export a plan</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Select
                    id="exportPlanId"
                    name="exportPlanId"
                    className="sm:flex-1"
                    value={selectedPlan?._id ?? ''}
                    onChange={(event) => setSelectedPlanId(event.target.value)}
                    disabled={isLoading || !plans?.length}
                  >
                    {(plans ?? []).map((plan) => (
                      <option key={plan._id} value={plan._id}>
                        {plan.name}
                        {plan.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </Select>
                  <Button type="button" onClick={exportPlan} disabled={isLoading || !selectedPlan}>
                    <ArrowDownToLineIcon data-slot="icon" aria-hidden="true" />
                    Export plan
                  </Button>
                </div>
                <Description>The file carries the plan as stored, including its glide path, plus your current finances.</Description>
              </Field>

              <Field>
                <Button type="button" onClick={exportEverything} disabled={isLoading || !plans?.length}>
                  <ArrowDownToLineIcon data-slot="icon" aria-hidden="true" />
                  Export everything ({plans?.length ?? 0} plan(s), {financeCounts})
                </Button>
                <Description>A complete backup: every plan and the finances, in one file.</Description>
              </Field>

              <Divider />

              <Field>
                <Label htmlFor="importFile">Restore from a file</Label>
                <input
                  ref={fileInputRef}
                  id="importFile"
                  name="importFile"
                  type="file"
                  accept="application/json,.json"
                  disabled={isBusy || isLoading}
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                  className="text-foreground file:border-border file:bg-background file:text-foreground block w-full text-sm file:mr-3 file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm"
                />
                <Description>
                  Imports add plans as new plans. A file that contains finances replaces your current assets and liabilities, so it asks
                  first and downloads a snapshot of the current state before writing anything.
                </Description>
              </Field>

              {status && <p className="text-sm text-green-700 dark:text-green-400">{status}</p>}
              <ImportIssues issues={issues} />
            </FieldGroup>
          </Fieldset>
        </form>
      </Card>

      <Alert
        open={pendingEnvelope !== null}
        onClose={() => {
          setPendingEnvelope(null);
        }}
      >
        <AlertTitle>Replace your finances with the ones in this file?</AlertTitle>
        <AlertDescription>
          The file contains finances ({pendingEnvelope?.finances?.assets.length ?? 0} asset(s),{' '}
          {pendingEnvelope?.finances?.liabilities.length ?? 0} liability(ies)). Importing them replaces every current asset and liability.
          Your current state is downloaded as a snapshot first, so you can undo this by importing it again.
        </AlertDescription>
        <AlertBody>
          <p className="text-sm">
            Both the snapshot and the imported file are plain JSON. Keep them somewhere you can reach after a restore.
          </p>
        </AlertBody>
        <AlertActions>
          <Button plain onClick={() => setPendingEnvelope(null)} disabled={isBusy}>
            Cancel
          </Button>
          <Button color="red" onClick={confirmFinancesImport} disabled={isBusy}>
            {isBusy ? 'Importing...' : 'Replace finances and import'}
          </Button>
        </AlertActions>
      </Alert>

      <Alert
        open={pendingUnusual !== null}
        onClose={() => {
          setPendingUnusual(null);
        }}
      >
        <AlertTitle>Import a file with values this version of the app would not have written?</AlertTitle>
        <AlertDescription>
          The plan runs as it is: everything below is a rule the forms enforce when you edit a plan, not a value the simulation cannot use.
          Nothing is changed by importing — the file is stored as it is, so you can repair these in the app afterwards.
        </AlertDescription>
        <AlertBody>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {(pendingUnusual?.warnings ?? []).map((warning, index) => (
              <li key={`${warning.path}-${index}`}>
                {warning.path ? (
                  <>
                    <code className="font-mono text-xs break-all">{warning.path}</code>
                    {': '}
                  </>
                ) : null}
                {warning.message}
              </li>
            ))}
          </ul>
        </AlertBody>
        <AlertActions>
          <Button plain onClick={() => setPendingUnusual(null)} disabled={isBusy}>
            Cancel
          </Button>
          <Button onClick={confirmUnusualImport} disabled={isBusy}>
            {isBusy ? 'Importing...' : 'Import anyway'}
          </Button>
        </AlertActions>
      </Alert>
    </>
  );
}
