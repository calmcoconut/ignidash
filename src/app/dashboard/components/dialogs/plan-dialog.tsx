'use client';

import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import type { Id, Doc } from '@/convex/_generated/dataModel';
import { FileTextIcon } from 'lucide-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { useState } from 'react';

import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { planMetadataSchema, type PlanMetadata } from '@/lib/schemas/plan-metadata-schema';
import { preparePastedPlan, type ImportIssue, type PastedPlanData } from '@/lib/export/plan-envelope';
import ImportIssues from '@/components/ui/import-issues';
import { Fieldset, FieldGroup, Field, Label, ErrorMessage, Description } from '@/components/catalyst/fieldset';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Select } from '@/components/catalyst/select';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Textarea } from '@/components/catalyst/textarea';
import { getErrorMessages } from '@/lib/utils/form-utils';

interface PlanDialogProps {
  onClose: () => void;
  numPlans: number;
  selectedPlan: Doc<'plans'> | null;
  allPlans: { id: Id<'plans'>; name: string }[];
  planToClone?: { id: Id<'plans'>; name: string };
}

export default function PlanDialog({ onClose, numPlans, selectedPlan: _selectedPlan, allPlans, planToClone }: PlanDialogProps) {
  const [selectedPlan] = useState(_selectedPlan);

  const getDefaultName = () => {
    if (selectedPlan !== null) return selectedPlan.name;
    if (planToClone) return `Copy of ${planToClone.name}`;
    return `Plan ${numPlans + 1}`;
  };

  const defaultValues: PlanMetadata = {
    name: getDefaultName(),
    clonedPlanId: selectedPlan !== null ? undefined : planToClone?.id,
    jsonImport: undefined,
  };

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    control,
  } = useForm({
    resolver: zodResolver(planMetadataSchema),
    defaultValues,
  });

  const hasFormErrors = Object.keys(errors).length > 0;

  const updateNameMutation = useMutation(api.plans.updatePlanName);
  const clonePlanMutation = useMutation(api.plans.clonePlan);
  const createPlanMutation = useMutation(api.plans.createBlankPlan);
  const createPlanWithDataMutation = useMutation(api.plans.createPlanWithData);

  const [saveError, setSaveError] = useState<ImportIssue[] | null>(null);
  // A pasted plan the engine can run but the app's forms would not have written: the operator
  // sees every unusual field and decides, exactly as the Settings restore does.
  const [pendingPaste, setPendingPaste] = useState<{ planData: PastedPlanData; name: string; warnings: ImportIssue[] } | null>(null);

  const clonedPlanId = useWatch({ control, name: 'clonedPlanId' });
  const isJsonImport = clonedPlanId === 'jsonImport';

  const onSubmit = async (data: PlanMetadata) => {
    try {
      setSaveError(null);
      if (selectedPlan) {
        await updateNameMutation({ planId: selectedPlan._id, name: data.name });
      } else if (isJsonImport && data.jsonImport !== undefined) {
        // A pasted export file, read by the same envelope reader the Settings restore uses,
        // so the dialog reports the same field paths instead of a JSON parse error.
        const prepared = preparePastedPlan(data.jsonImport);
        if (!prepared.ok) {
          setSaveError(prepared.issues);
          return;
        }
        if (prepared.warnings.length > 0) {
          // Not a refusal: the plan runs as it is, so show what is unusual and let the
          // operator continue from `confirmPastedPlan`.
          setPendingPaste({ planData: prepared.planData, name: data.name, warnings: prepared.warnings });
          return;
        }
        await createPlanWithDataMutation({ ...prepared.planData, newPlanName: data.name, isDefault: false });
      } else if (data.clonedPlanId) {
        await clonePlanMutation({ planId: data.clonedPlanId as Id<'plans'> | 'template1' | 'template2', newPlanName: data.name });
      } else {
        await createPlanMutation({ newPlanName: data.name });
      }

      onClose();
    } catch (error) {
      // No truncation: the whole message is shown, as one entry in the same list the
      // import path produces.
      setSaveError([{ path: '', message: error instanceof Error ? error.message : 'Failed to save plan.' }]);
    }
  };

  /** Writes the pasted plan the operator acknowledged, and only from here. */
  const confirmPastedPlan = async () => {
    if (!pendingPaste) return;
    try {
      setSaveError(null);
      await createPlanWithDataMutation({ ...pendingPaste.planData, newPlanName: pendingPaste.name, isDefault: false });
      setPendingPaste(null);
      onClose();
    } catch (error) {
      setPendingPaste(null);
      setSaveError([{ path: '', message: error instanceof Error ? error.message : 'Failed to save plan.' }]);
    }
  };

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <FileTextIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>{selectedPlan ? 'Edit Plan' : 'New Plan'}</span>
        </div>
      </DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Fieldset aria-label="Simulator plan details">
          <DialogBody>
            <FieldGroup>
              <ImportIssues issues={saveError} title="The plan could not be saved" />
              {!saveError && hasFormErrors && <ErrorMessageCard errorMessage={getErrorMessages(errors).join(', ')} />}
              {pendingPaste && (
                <div
                  role="alertdialog"
                  aria-label="Import a pasted plan with unusual values"
                  className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10"
                >
                  <h3 className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    Import a plan with values this version of the app would not have written?
                  </h3>
                  <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
                    The plan runs as it is: everything below is a rule the forms enforce when you edit a plan, not a value the simulation
                    cannot use. Nothing is changed by importing — you can repair these in the app afterwards.
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-200">
                    {pendingPaste.warnings.map((warning, index) => (
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
                  <div className="mt-3 flex gap-2">
                    <Button plain type="button" onClick={() => setPendingPaste(null)} disabled={isSubmitting}>
                      Cancel
                    </Button>
                    <Button type="button" onClick={() => void confirmPastedPlan()} disabled={isSubmitting}>
                      Import anyway
                    </Button>
                  </div>
                </div>
              )}
              <Field>
                <Label htmlFor="name">Name</Label>
                <Input
                  {...register('name')}
                  id="name"
                  name="name"
                  placeholder="My Plan"
                  autoComplete="off"
                  inputMode="text"
                  invalid={!!errors.name}
                  aria-invalid={!!errors.name}
                />
                {errors.name && <ErrorMessage>{errors.name?.message}</ErrorMessage>}
              </Field>
              {!selectedPlan && (
                <>
                  <Field>
                    <Label htmlFor="clonedPlanId">With Template</Label>
                    <Select {...register('clonedPlanId')} id="clonedPlanId" name="clonedPlanId">
                      <option value="">Blank plan</option>
                      <optgroup label="Your Plans">
                        {allPlans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            Copy of {plan.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Demo Plans">
                        <option value="template1">Standard Plan</option>
                        <option value="template2">Early Retirement Plan</option>
                      </optgroup>
                      <optgroup label="Import">
                        <option value="jsonImport">Import from JSON</option>
                      </optgroup>
                    </Select>
                    {errors.clonedPlanId && <ErrorMessage>{errors.clonedPlanId?.message}</ErrorMessage>}
                  </Field>
                  {isJsonImport && (
                    <Field>
                      <Label htmlFor="jsonImport">Export file contents</Label>
                      <Textarea
                        {...register('jsonImport')}
                        id="jsonImport"
                        name="jsonImport"
                        aria-label="JSON Plan Data"
                        placeholder="Paste JSON data to import here..."
                        resizable={false}
                        rows={4}
                      />
                      {errors.jsonImport && <ErrorMessage>{errors.jsonImport?.message}</ErrorMessage>}
                      <Description>
                        Paste a plan exported from Settings → Backup &amp; restore. Files that contain finances must be restored from
                        Settings so replacing them can be confirmed.
                      </Description>
                    </Field>
                  )}
                </>
              )}
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
