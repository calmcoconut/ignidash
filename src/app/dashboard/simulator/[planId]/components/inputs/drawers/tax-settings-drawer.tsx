'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { taxSettingsToConvex } from '@/lib/utils/data-transformers';
import { type TaxSettingsInputs, taxSettingsFormSchema } from '@/lib/schemas/inputs/tax-settings-form-schema';
import SectionHeader from '@/components/ui/section-header';
import SectionContainer from '@/components/ui/section-container';
import Card from '@/components/ui/card';
import { Field, FieldGroup, Fieldset, Label, Description, ErrorMessage } from '@/components/catalyst/fieldset';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Select } from '@/components/catalyst/select';
import { Switch, SwitchField } from '@/components/catalyst/switch';
import NumberInput from '@/components/ui/number-input';
import { getCurrencySymbol, formatCurrencyPlaceholder } from '@/lib/utils/number-formatters';
import { Divider } from '@/components/catalyst/divider';
import { Button } from '@/components/catalyst/button';
import { DialogActions } from '@/components/catalyst/dialog';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';

interface TaxSettingsDrawerProps {
  setOpen: (open: boolean) => void;
  taxSettings: TaxSettingsInputs | null;
}

export default function TaxSettingsDrawer({ setOpen, taxSettings }: TaxSettingsDrawerProps) {
  const planId = useSelectedPlanId();

  const withDeductionDefaults = useCallback(
    (settings: TaxSettingsInputs | null): TaxSettingsInputs => ({
      filingStatus: settings?.filingStatus ?? 'single',
      stateResidency: settings?.stateResidency ?? 'CA',
      itemizedDeductions: {
        mortgageInterest: settings?.itemizedDeductions?.mortgageInterest ?? 0,
        charitable: settings?.itemizedDeductions?.charitable ?? 0,
        stateAndLocalTaxes: settings?.itemizedDeductions?.stateAndLocalTaxes ?? 0,
        medicalExpenses: settings?.itemizedDeductions?.medicalExpenses ?? 0,
      },
      spouseQualifiesForSeniorDeduction: settings?.spouseQualifiesForSeniorDeduction ?? false,
    }),
    []
  );

  const defaultValues = useMemo(() => withDeductionDefaults(taxSettings), [taxSettings, withDeductionDefaults]);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(taxSettingsFormSchema),
    defaultValues,
  });

  useEffect(() => {
    reset(withDeductionDefaults(taxSettings));
  }, [taxSettings, reset, withDeductionDefaults]);

  const updateTaxSettings = useMutation(api.tax_settings.update);
  const [saveError, setSaveError] = useState<string | null>(null);

  const onSubmit = async (data: TaxSettingsInputs) => {
    try {
      setSaveError(null);
      await updateTaxSettings({ taxSettings: taxSettingsToConvex(data), planId });
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save tax settings.');
      console.error('Error saving tax settings: ', error);
    }
  };

  return (
    <>
      <SectionContainer showBottomBorder={false} location="drawer">
        <SectionHeader title="Tax Settings" desc="Manage settings that affect your tax calculations." />
        <Card>
          <form onSubmit={handleSubmit(onSubmit)}>
            <Fieldset aria-label="Tax settings details">
              <FieldGroup>
                {saveError && <ErrorMessageCard errorMessage={saveError} />}
                <Field>
                  <Label htmlFor="filingStatus">Filing Status</Label>
                  <Select {...register('filingStatus')} id="filingStatus" name="filingStatus">
                    <option value="single">Single</option>
                    <option value="marriedFilingJointly">Married Filing Jointly</option>
                    <option value="marriedFilingSeparately">Married Filing Separately</option>
                    <option value="headOfHousehold">Head of Household</option>
                  </Select>
                  {errors.filingStatus && <ErrorMessage>{errors.filingStatus?.message}</ErrorMessage>}
                  <Description>
                    Your filing status determines your tax rates and standard deduction. Married Filing Separately files two returns, one
                    per spouse: the engine splits community income and joint property half and half, as California requires.
                  </Description>
                </Field>
                <Field>
                  <Label htmlFor="stateResidency">State Return</Label>
                  <Select {...register('stateResidency')} id="stateResidency" name="stateResidency">
                    <option value="CA">California</option>
                    <option value="none">None</option>
                  </Select>
                  {errors.stateResidency && <ErrorMessage>{errors.stateResidency?.message}</ErrorMessage>}
                  <Description>
                    California files its own return: its brackets, its standard deduction and exemption credits, capital gains as ordinary
                    income, and Social Security excluded. Choose None only if this plan is not a California resident.
                  </Description>
                </Field>
                <Divider />
                <Fieldset aria-label="Itemized deductions">
                  <legend className="text-base font-semibold text-zinc-950 dark:text-white">Itemized Deductions</legend>
                  <Description className="mt-1">
                    Enter yearly amounts. The return takes whichever is larger — these or the standard deduction — and the engine applies
                    the statutory caps: the SALT limit and the 7.5%-of-AGI floor on medical expenses.
                  </Description>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <Label htmlFor="itemizedDeductions.mortgageInterest">Mortgage Interest</Label>
                      <NumberInput
                        name="itemizedDeductions.mortgageInterest"
                        control={control}
                        id="itemizedDeductions.mortgageInterest"
                        inputMode="decimal"
                        placeholder={formatCurrencyPlaceholder(12000)}
                        prefix={getCurrencySymbol()}
                      />
                      {errors.itemizedDeductions?.mortgageInterest && (
                        <ErrorMessage>{errors.itemizedDeductions.mortgageInterest.message}</ErrorMessage>
                      )}
                    </Field>
                    <Field>
                      <Label htmlFor="itemizedDeductions.charitable">Charitable Contributions</Label>
                      <NumberInput
                        name="itemizedDeductions.charitable"
                        control={control}
                        id="itemizedDeductions.charitable"
                        inputMode="decimal"
                        placeholder={formatCurrencyPlaceholder(5000)}
                        prefix={getCurrencySymbol()}
                      />
                      {errors.itemizedDeductions?.charitable && <ErrorMessage>{errors.itemizedDeductions.charitable.message}</ErrorMessage>}
                    </Field>
                    <Field>
                      <Label htmlFor="itemizedDeductions.stateAndLocalTaxes">Property &amp; Local Taxes</Label>
                      <NumberInput
                        name="itemizedDeductions.stateAndLocalTaxes"
                        control={control}
                        id="itemizedDeductions.stateAndLocalTaxes"
                        inputMode="decimal"
                        placeholder={formatCurrencyPlaceholder(20000)}
                        prefix={getCurrencySymbol()}
                      />
                      {errors.itemizedDeductions?.stateAndLocalTaxes && (
                        <ErrorMessage>{errors.itemizedDeductions.stateAndLocalTaxes.message}</ErrorMessage>
                      )}
                      <Description>
                        Property and local taxes only — the California income tax is computed and added to the SALT line for you. Capped by
                        the SALT limit, which phases down above the MAGI threshold.
                      </Description>
                    </Field>
                    <Field>
                      <Label htmlFor="itemizedDeductions.medicalExpenses">Medical Expenses</Label>
                      <NumberInput
                        name="itemizedDeductions.medicalExpenses"
                        control={control}
                        id="itemizedDeductions.medicalExpenses"
                        inputMode="decimal"
                        placeholder={formatCurrencyPlaceholder(0)}
                        prefix={getCurrencySymbol()}
                      />
                      {errors.itemizedDeductions?.medicalExpenses && (
                        <ErrorMessage>{errors.itemizedDeductions.medicalExpenses.message}</ErrorMessage>
                      )}
                      <Description>Only the amount above 7.5% of your adjusted gross income is deductible.</Description>
                    </Field>
                  </div>
                </Fieldset>
                <Divider />
                <SwitchField>
                  <Label>Spouse is 65 or older</Label>
                  <Description>
                    Only used on a joint return, for the temporary senior deduction. Your own age comes from the timeline.
                  </Description>
                  <Controller
                    name="spouseQualifiesForSeniorDeduction"
                    control={control}
                    render={({ field: { onChange, value, name } }) => <Switch name={name} checked={value ?? false} onChange={onChange} />}
                  />
                </SwitchField>
                <Divider />
              </FieldGroup>
            </Fieldset>
            <DialogActions>
              <Button outline onClick={() => reset()}>
                Reset
              </Button>
              <Button color="rose" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Save'}
              </Button>
            </DialogActions>
          </form>
        </Card>
      </SectionContainer>
    </>
  );
}
