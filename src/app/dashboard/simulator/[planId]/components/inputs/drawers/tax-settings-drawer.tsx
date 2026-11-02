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

/**
 * Drop the ACA numbers the user left blank (Phase 0a).
 *
 * Absent and zero are different claims in this plan: absent says "the operator did not state this
 * figure", a stated `0` says they stated zero. The form registers all three numeric controls, so a
 * field nobody filled in arrives as `undefined` — rebuilding the block without those keys is what
 * keeps a plan's `taxSettings.aca` byte-identical when the drawer is saved untouched, which is
 * exactly what the old code failed to do (it dropped the whole `aca` block).
 */
function withStatedAca(taxSettings: TaxSettingsInputs): TaxSettingsInputs {
  const aca = taxSettings.aca;
  if (aca === undefined) return taxSettings;

  return {
    ...taxSettings,
    aca: {
      optIn: aca.optIn,
      ...(aca.householdSize !== undefined ? { householdSize: aca.householdSize } : {}),
      ...(aca.slcsp !== undefined ? { slcsp: aca.slcsp } : {}),
      ...(aca.actualPremium !== undefined ? { actualPremium: aca.actualPremium } : {}),
      ...(aca.stateSubsidy !== undefined ? { stateSubsidy: aca.stateSubsidy } : {}),
      ...(aca.stateSubsidyMaxFplPercent !== undefined ? { stateSubsidyMaxFplPercent: aca.stateSubsidyMaxFplPercent } : {}),
    },
  };
}

/** The Medicare block, with unstated numbers dropped rather than stored as `undefined` (v20). */
function withStatedMedicare(taxSettings: TaxSettingsInputs): TaxSettingsInputs {
  const medicare = taxSettings.medicare;
  if (medicare === undefined) return taxSettings;

  return {
    ...taxSettings,
    medicare: {
      includePremiums: medicare.includePremiums,
      ...(medicare.enrollmentAge !== undefined ? { enrollmentAge: medicare.enrollmentAge } : {}),
      ...(medicare.partDMonthly !== undefined ? { partDMonthly: medicare.partDMonthly } : {}),
      ...(medicare.supplementalMonthly !== undefined ? { supplementalMonthly: medicare.supplementalMonthly } : {}),
    },
  };
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
      // The ACA block must survive a save: the mutation replaces the whole `taxSettings` object, so
      // anything the form does not carry is erased. Unstated numbers stay `undefined`, never 0.
      aca: {
        optIn: settings?.aca?.optIn ?? false,
        householdSize: settings?.aca?.householdSize,
        slcsp: settings?.aca?.slcsp,
        actualPremium: settings?.aca?.actualPremium,
        stateSubsidy: settings?.aca?.stateSubsidy,
        stateSubsidyMaxFplPercent: settings?.aca?.stateSubsidyMaxFplPercent,
      },
      medicare: {
        includePremiums: settings?.medicare?.includePremiums ?? false,
        enrollmentAge: settings?.medicare?.enrollmentAge,
        partDMonthly: settings?.medicare?.partDMonthly,
        supplementalMonthly: settings?.medicare?.supplementalMonthly,
      },
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
      await updateTaxSettings({ taxSettings: taxSettingsToConvex(withStatedMedicare(withStatedAca(data))), planId });
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save tax settings.');
      console.error('Error saving tax settings: ', error);
    }
  };

  return (
    <>
      <SectionContainer showBottomBorder={false} location="drawer">
        <SectionHeader
          title="Tax Settings"
          desc="Manage settings that affect your tax calculations. Statutory rules through 2026 (California: 2025) are vendored; rules for 2027+ are projected from 2026."
        />
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
                  {/* Headless UI's <Description> only resolves inside a <Field>: with a bare <Fieldset> parent it throws
                      at render time, which took the whole drawer down. The sentence introduces the group, so it gets a
                      field of its own rather than being dropped. */}
                  <Field>
                    <Description className="mt-1">
                      Enter yearly amounts. The return takes whichever is larger — these or the standard deduction — and the engine applies
                      the statutory caps: the SALT limit and the 7.5%-of-AGI floor on medical expenses.
                    </Description>
                  </Field>
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
                <Fieldset aria-label="ACA Premium Tax Credit">
                  <legend className="text-base font-semibold text-zinc-950 dark:text-white">ACA Premium Tax Credit</legend>
                  <SwitchField>
                    <Label>Model the ACA Premium Tax Credit</Label>
                    <Description>
                      For a plan that buys health insurance on the individual market: the credit is the benchmark silver premium for your
                      household, less the share of income the return says you pay, and it never exceeds the premium you actually paid. Off
                      by default.
                    </Description>
                    <Controller
                      name="aca.optIn"
                      control={control}
                      render={({ field: { onChange, value, name } }) => <Switch name={name} checked={value ?? false} onChange={onChange} />}
                    />
                  </SwitchField>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <Label htmlFor="aca.householdSize">Household Size</Label>
                      <NumberInput
                        name="aca.householdSize"
                        control={control}
                        id="aca.householdSize"
                        inputMode="numeric"
                        placeholder="–"
                        decimalScale={0}
                        disableThousandsSeparator
                      />
                      {errors.aca?.householdSize && <ErrorMessage>{errors.aca.householdSize.message}</ErrorMessage>}
                      <Description>Everyone on the policy. Leave blank to assume two on a joint return and one otherwise.</Description>
                    </Field>
                    <Field>
                      <Label htmlFor="aca.slcsp">Benchmark Silver Premium</Label>
                      <NumberInput
                        name="aca.slcsp"
                        control={control}
                        id="aca.slcsp"
                        inputMode="decimal"
                        placeholder="–"
                        prefix={getCurrencySymbol()}
                      />
                      {errors.aca?.slcsp && <ErrorMessage>{errors.aca.slcsp.message}</ErrorMessage>}
                      <Description>
                        The second-lowest-cost silver plan for your area, per year. Nothing is modelled without it — this is the premium the
                        credit is measured against.
                      </Description>
                    </Field>
                    <Field>
                      <Label htmlFor="aca.actualPremium">Actual Premium</Label>
                      <NumberInput
                        name="aca.actualPremium"
                        control={control}
                        id="aca.actualPremium"
                        inputMode="decimal"
                        placeholder="–"
                        prefix={getCurrencySymbol()}
                      />
                      {errors.aca?.actualPremium && <ErrorMessage>{errors.aca.actualPremium.message}</ErrorMessage>}
                      <Description>
                        What you actually pay for the plan, per year. The credit is capped at this figure. Leave blank to use the benchmark
                        alone.
                      </Description>
                    </Field>
                    <Field>
                      <Label htmlFor="aca.stateSubsidy">California State Subsidy</Label>
                      <NumberInput
                        name="aca.stateSubsidy"
                        control={control}
                        id="aca.stateSubsidy"
                        inputMode="decimal"
                        placeholder="–"
                        prefix={getCurrencySymbol()}
                      />
                      {errors.aca?.stateSubsidy && <ErrorMessage>{errors.aca.stateSubsidy.message}</ErrorMessage>}
                      <Description>
                        Covered California&apos;s state premium assistance, per year, from your eligibility notice. The state sets it each
                        budget year, so it is entered rather than calculated.
                      </Description>
                    </Field>
                    <Field>
                      <Label htmlFor="aca.stateSubsidyMaxFplPercent">State Subsidy Income Limit (% FPL)</Label>
                      <NumberInput
                        name="aca.stateSubsidyMaxFplPercent"
                        control={control}
                        id="aca.stateSubsidyMaxFplPercent"
                        inputMode="numeric"
                        placeholder="–"
                        decimalScale={0}
                        disableThousandsSeparator
                      />
                      {errors.aca?.stateSubsidyMaxFplPercent && <ErrorMessage>{errors.aca.stateSubsidyMaxFplPercent.message}</ErrorMessage>}
                      <Description>The state subsidy stops above this income. Leave blank to apply it at any income.</Description>
                    </Field>
                  </div>
                  <Description className="mt-4">
                    Both credits stop for anyone on Medicare: they are prorated to the months each member is off it.
                  </Description>
                </Fieldset>
                <Divider />
                <Fieldset aria-label="Medicare">
                  <legend className="text-base font-semibold text-zinc-950 dark:text-white">Medicare</legend>
                  <SwitchField>
                    <Label>Charge Medicare premiums</Label>
                    <Description>
                      Adds the standard Part B premium, a Part D premium and any supplemental premium for each member from enrollment, as
                      essential spending. Leave off if your expenses already include them. IRMAA is charged either way.
                    </Description>
                    <Controller
                      name="medicare.includePremiums"
                      control={control}
                      render={({ field: { onChange, value, name } }) => <Switch name={name} checked={value ?? false} onChange={onChange} />}
                    />
                  </SwitchField>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <Label htmlFor="medicare.enrollmentAge">Enrollment Age</Label>
                      <NumberInput
                        name="medicare.enrollmentAge"
                        control={control}
                        id="medicare.enrollmentAge"
                        inputMode="numeric"
                        placeholder="65"
                        decimalScale={0}
                        disableThousandsSeparator
                      />
                      {errors.medicare?.enrollmentAge && <ErrorMessage>{errors.medicare.enrollmentAge.message}</ErrorMessage>}
                      <Description>Later than 65 only while covered by an employer plan. IRMAA starts here too.</Description>
                    </Field>
                    <Field>
                      <Label htmlFor="medicare.partDMonthly">Part D Premium (monthly)</Label>
                      <NumberInput
                        name="medicare.partDMonthly"
                        control={control}
                        id="medicare.partDMonthly"
                        inputMode="decimal"
                        placeholder="–"
                        prefix={getCurrencySymbol()}
                      />
                      {errors.medicare?.partDMonthly && <ErrorMessage>{errors.medicare.partDMonthly.message}</ErrorMessage>}
                      <Description>Per member. Leave blank for the national base premium.</Description>
                    </Field>
                    <Field>
                      <Label htmlFor="medicare.supplementalMonthly">Supplemental Premium (monthly)</Label>
                      <NumberInput
                        name="medicare.supplementalMonthly"
                        control={control}
                        id="medicare.supplementalMonthly"
                        inputMode="decimal"
                        placeholder="–"
                        prefix={getCurrencySymbol()}
                      />
                      {errors.medicare?.supplementalMonthly && <ErrorMessage>{errors.medicare.supplementalMonthly.message}</ErrorMessage>}
                      <Description>Medigap or Medicare Advantage, per member. Not HSA-eligible.</Description>
                    </Field>
                  </div>
                </Fieldset>
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
