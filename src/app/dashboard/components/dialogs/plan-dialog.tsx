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

  const [saveError, setSaveError] = useState<string | null>(null);

  const clonedPlanId = useWatch({ control, name: 'clonedPlanId' });
  const isJsonImport = clonedPlanId === 'jsonImport';

  const onSubmit = async (data: PlanMetadata) => {
    try {
      setSaveError(null);
      if (selectedPlan) {
        await updateNameMutation({ planId: selectedPlan._id, name: data.name });
      } else if (isJsonImport && data.jsonImport !== undefined) {
        const { name: _name, isDefault: _isDefault, ...planData } = JSON.parse(data.jsonImport);
        await createPlanWithDataMutation({ ...planData, newPlanName: data.name, isDefault: false });
      } else if (data.clonedPlanId) {
        await clonePlanMutation({ planId: data.clonedPlanId as Id<'plans'> | 'template1' | 'template2', newPlanName: data.name });
      } else {
        await createPlanMutation({ newPlanName: data.name });
      }

      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save plan.';
      const truncated = message.length > 250 ? message.slice(0, 250) + '...' : message;
      setSaveError(truncated);
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
              {(saveError || hasFormErrors) && <ErrorMessageCard errorMessage={saveError || getErrorMessages(errors).join(', ')} />}
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
                      <Label htmlFor="jsonImport">JSON Plan Data</Label>
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
                      <Description>Create a new plan by pasting JSON data copied from an existing plan.</Description>
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
