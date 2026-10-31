'use client';

import { ConvexError } from 'convex/values';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react';
import { MinusIcon, PlusIcon } from '@heroicons/react/24/outline';
import { CalendarIcon, HomeIcon, BanknoteArrowDownIcon, BanknoteXIcon, InfoIcon } from 'lucide-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch, Controller } from 'react-hook-form';

import { useAccountsData, useTimelineData, useMarketAssumptionsData } from '@/hooks/use-convex-data';
import { useAlreadySyncedIds } from '@/hooks/use-already-synced-ids';
import { useLinkableFinances } from '@/hooks/use-linkable-finances';
import { usePayoffEstimate } from '@/hooks/use-payoff-estimate';
import { computeLoanPayment } from '@/lib/calc/amortization-schedule';
import { accountTypeForDisplay } from '@/lib/schemas/inputs/account-form-schema';
import { physicalAssetToConvex } from '@/lib/utils/data-transformers';
import { ownershipForStorage } from '@/lib/schemas/inputs/household-schema';
import type { DisclosureState } from '@/lib/types/disclosure-state';
import { physicalAssetFormSchema, type PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import { assetTypeForDisplay, type AssetInputs } from '@/lib/schemas/finances/asset-form-schema';
import { liabilityTypeForDisplay, type LiabilityInputs } from '@/lib/schemas/finances/liability-form-schema';
import { calculateAge } from '@/lib/schemas/inputs/timeline-form-schema';
import { currentLocalISODate } from '@/lib/utils/system-clock';
import { physicalAssetTimeFrameForDisplay } from '@/lib/utils/display-formatters';
import { newPhysicalAssetDefaults } from '@/lib/utils/entity-form-defaults';
import {
  AMOUNT_BASIS_HINTS,
  AMOUNT_BASIS_OPTIONS,
  amountBasisAnchorHint,
  amountBasisFieldOptions,
  isAmountBasisSelectable,
  normalizeStoredAmountBasis,
} from '@/lib/utils/time-binding-inputs';
import { DialogTitle, DialogDescription, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import NumberInput from '@/components/ui/number-input';
import { Field, Fieldset, FieldGroup, Label, ErrorMessage, Description } from '@/components/catalyst/fieldset';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { Combobox, ComboboxLabel, ComboboxOption } from '@/components/catalyst/combobox';
import { Select } from '@/components/catalyst/select';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { getErrorMessages } from '@/lib/utils/form-utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Divider } from '@/components/catalyst/divider';
import { getCurrencySymbol, formatCurrencyPlaceholder } from '@/lib/utils/number-formatters';
import OwnershipFields from './ownership-fields';

import SyncWithNetWorthTrackerSelect from './sync-with-nw-tracker-select';
import { PayoffEstimate } from './payoff-estimate';

const LINKABLE_PHYSICAL_ASSET_TYPES: AssetInputs['type'][] = ['realEstate', 'vehicle', 'preciousMetals', 'other'];
const LINKABLE_SECURED_DEBT_TYPES: LiabilityInputs['type'][] = ['mortgage', 'autoLoan', 'other'];

interface PhysicalAssetDialogProps {
  onClose: () => void;
  selectedPhysicalAsset: PhysicalAssetInputs | null;
  physicalAssets: Record<string, PhysicalAssetInputs>;
  nwAssets: AssetInputs[] | null;
  nwLiabilities: LiabilityInputs[] | null;
}

export default function PhysicalAssetDialog({
  onClose,
  selectedPhysicalAsset: _selectedPhysicalAsset,
  physicalAssets,
  nwAssets,
  nwLiabilities,
}: PhysicalAssetDialogProps) {
  const planId = useSelectedPlanId();
  const [selectedPhysicalAsset] = useState(_selectedPhysicalAsset);
  const numPhysicalAssets = Object.keys(physicalAssets).length;

  const newAssetDefaultValues = useMemo(() => newPhysicalAssetDefaults(numPhysicalAssets), [numPhysicalAssets]);

  const defaultValues = normalizeStoredAmountBasis(selectedPhysicalAsset) || newAssetDefaultValues;

  const {
    register,
    unregister,
    control,
    handleSubmit,
    getFieldState,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(physicalAssetFormSchema),
    defaultValues,
  });

  const hasFormErrors = Object.keys(errors).length > 0;

  const { error: loanBalanceError } = getFieldState('paymentMethod.loanBalance');
  const { error: monthlyPaymentError } = getFieldState('paymentMethod.monthlyPayment');
  const { error: aprError } = getFieldState('paymentMethod.apr');
  const { error: downPaymentError } = getFieldState('paymentMethod.downPayment');
  const { error: termMonthsError } = getFieldState('paymentMethod.termMonths');
  const { error: offsetAccountIdError } = getFieldState('paymentMethod.offsetAccountId');
  const { error: propertyTaxRateError } = getFieldState('propertyTax.ratePercent');
  const { error: propertyTaxAmountError } = getFieldState('propertyTax.annualAmount');

  const m = useMutation(api.physical_asset.upsertPhysicalAsset);
  const [saveError, setSaveError] = useState<string | null>(null);

  const onSubmit = async (data: PhysicalAssetInputs) => {
    const processedData = { ...data };
    processedData.marketValue ??= data.purchasePrice;

    const assetId = processedData.id === '' ? uuidv4() : processedData.id;
    try {
      setSaveError(null);
      await m({ physicalAsset: physicalAssetToConvex(ownershipForStorage({ ...processedData, id: assetId })), planId });
      onClose();
    } catch (error) {
      setSaveError(error instanceof ConvexError ? error.message : 'Failed to save physical asset.');
      console.error('Error saving physical asset: ', error);
    }
  };

  const purchaseTimePoint = useWatch({ control, name: 'purchaseDate' });
  const purchaseDateType = purchaseTimePoint.type;
  const amountBasisHint = amountBasisAnchorHint(purchaseDateType);
  const showDownPaymentField = purchaseDateType !== 'now';

  const saleTimePoint = useWatch({ control, name: 'saleDate' });
  const saleDateType = saleTimePoint?.type;

  const assetType = useWatch({ control, name: 'assetType' });
  const paymentMethod = useWatch({ control, name: 'paymentMethod' });
  const paymentMethodType = paymentMethod.type;

  const syncedAssetId = useWatch({ control, name: 'syncedAssetId' });
  const isAssetSynced = !!syncedAssetId;

  const alreadySyncedAssetIds = useAlreadySyncedIds(physicalAssets, 'syncedAssetId', selectedPhysicalAsset?.id);
  const linkableAssets = useLinkableFinances(nwAssets, alreadySyncedAssetIds, LINKABLE_PHYSICAL_ASSET_TYPES);

  const handleAssetSyncChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const assetId = e.target.value;
    if (!assetId) {
      setValue('syncedAssetId', undefined);
      return;
    }

    const asset = linkableAssets.find((a) => a.id === assetId);
    if (!asset) return;

    setValue('syncedAssetId', asset.id);
    setValue('name', asset.name);
    setValue('marketValue', asset.value);
  };

  const syncedLiabilityId = useWatch({ control, name: 'syncedLiabilityId' });
  const isLiabilitySynced = !!syncedLiabilityId;

  const alreadySyncedLiabilityIds = useAlreadySyncedIds(physicalAssets, 'syncedLiabilityId', selectedPhysicalAsset?.id);
  const linkableLiabilities = useLinkableFinances(nwLiabilities, alreadySyncedLiabilityIds, LINKABLE_SECURED_DEBT_TYPES);

  const handleLiabilitySyncChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const liabilityId = e.target.value;
    if (!liabilityId) {
      setValue('syncedLiabilityId', undefined);
      return;
    }

    const liability = linkableLiabilities.find((l) => l.id === liabilityId);
    if (!liability) return;

    setValue('syncedLiabilityId', liability.id);
    setValue('paymentMethod.loanBalance', liability.balance);
  };

  // The engine deflates loan payments and interest by the plan's inflation assumption, so the
  // estimate has to use the same assumption to agree with the simulation. While the assumption is
  // still loading there is no honest estimate: show none rather than a nominal one that jumps.
  const annualInflationRate = useMarketAssumptionsData()?.inflationRate;

  const { data: accounts } = useAccountsData();
  const accountOptions = useMemo(
    () => Object.values(accounts).map((account) => ({ id: account.id, label: `${account.name} | ${accountTypeForDisplay(account.type)}` })),
    [accounts]
  );

  // A stated loan term (P1-P5) means the engine derives the payment from the term and the APR, so
  // the term *is* the payoff estimate and the payment is written down from the same function.
  const loanPaymentMethod = paymentMethod.type === 'loan' ? paymentMethod : null;
  const rawTermMonths = Number(loanPaymentMethod?.termMonths);
  const rawLoanBalance = Number(loanPaymentMethod?.loanBalance);
  const rawApr = Number(loanPaymentMethod?.apr);
  const statedTermMonths =
    Number.isInteger(rawTermMonths) && rawTermMonths > 0 && !isNaN(rawLoanBalance) && rawLoanBalance > 0 && !isNaN(rawApr)
      ? rawTermMonths
      : null;

  const derivedTermPayment =
    statedTermMonths !== null && annualInflationRate !== undefined
      ? computeLoanPayment({
          principal: rawLoanBalance,
          annualRatePercent: rawApr,
          termMonths: statedTermMonths,
          annualInflationPercent: annualInflationRate,
        })
      : null;

  // Store the derived payment so the saved document never carries a payment that contradicts the
  // term. Two decimals: money the user reads, and exactly what the engine would charge to the cent.
  useEffect(() => {
    if (derivedTermPayment === null || !Number.isFinite(derivedTermPayment)) return;

    const stored = Number(getValues('paymentMethod.monthlyPayment'));
    const rounded = Number(derivedTermPayment.toFixed(2));
    if (Math.abs(stored - rounded) < 0.005) return;

    setValue('paymentMethod.monthlyPayment', rounded, { shouldValidate: true });
  }, [derivedTermPayment, getValues, setValue]);

  const loanPayoffMonths = usePayoffEstimate(
    statedTermMonths === null &&
      loanPaymentMethod !== null &&
      !isNaN(rawLoanBalance) &&
      !isNaN(Number(loanPaymentMethod.monthlyPayment)) &&
      !isNaN(rawApr) &&
      annualInflationRate !== undefined
      ? {
          balance: rawLoanBalance,
          monthlyPayment: Number(loanPaymentMethod.monthlyPayment),
          apr: rawApr,
          interestType: 'simple',
          annualInflationRate,
        }
      : null
  );

  const payoffMonths = statedTermMonths ?? loanPayoffMonths;

  useEffect(() => {
    if (purchaseDateType !== 'customDate') {
      unregister('purchaseDate.month');
      unregister('purchaseDate.year');
    }

    if (purchaseDateType !== 'customAge') {
      unregister('purchaseDate.age');
    }

    if (saleDateType !== 'customDate') {
      unregister('saleDate.month');
      unregister('saleDate.year');
    }

    if (saleDateType !== 'customAge') {
      unregister('saleDate.age');
    }

    if (paymentMethodType !== 'loan') {
      unregister('syncedLiabilityId');
      unregister('paymentMethod.downPayment');
      unregister('paymentMethod.loanBalance');
      unregister('paymentMethod.apr');
      unregister('paymentMethod.monthlyPayment');
      unregister('paymentMethod.termMonths');
      unregister('paymentMethod.offsetAccountId');
    }

    if (!showDownPaymentField) {
      unregister('paymentMethod.downPayment');
    }
  }, [purchaseDateType, saleDateType, paymentMethodType, showDownPaymentField, unregister]);

  const getDateColSpan = (type: string | undefined) => {
    if (type === 'customDate') return 'col-span-2';
    if (type === 'customAge') return 'col-span-1';
    return 'col-span-2';
  };

  const getAPRColSpan = () => {
    if (showDownPaymentField) return 'col-span-1';
    return 'col-span-2';
  };

  const getNameColSpan = () => {
    if (linkableAssets.length === 0) return 'col-span-2';
    return 'col-span-1';
  };

  const getPaymentMethodColSpan = () => {
    if (paymentMethodType !== 'loan' || linkableLiabilities.length === 0) return 'col-span-2';
    return 'col-span-1';
  };

  const months = [
    { value: 1, name: 'January' },
    { value: 2, name: 'February' },
    { value: 3, name: 'March' },
    { value: 4, name: 'April' },
    { value: 5, name: 'May' },
    { value: 6, name: 'June' },
    { value: 7, name: 'July' },
    { value: 8, name: 'August' },
    { value: 9, name: 'September' },
    { value: 10, name: 'October' },
    { value: 11, name: 'November' },
    { value: 12, name: 'December' },
  ];

  const currentMonth = months[new Date().getMonth()];
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 2100 - currentYear + 1 }, (_, i) => currentYear + i);

  const timeline = useTimelineData();
  const currentAge = timeline ? calculateAge(timeline.birthMonth, timeline.birthYear, currentLocalISODate()) : 18;
  const lifeExpectancy = timeline?.lifeExpectancy ?? 110;

  const ages = Array.from({ length: lifeExpectancy - currentAge + 1 }, (_, i) => currentAge + i);

  const timeFrameButtonRef = useRef<HTMLButtonElement>(null);
  const paymentMethodButtonRef = useRef<HTMLButtonElement>(null);
  const taxTreatmentButtonRef = useRef<HTMLButtonElement>(null);

  const [activeDisclosure, setActiveDisclosure] = useState<DisclosureState | null>(null);
  const toggleDisclosure = useCallback(
    (newDisclosure: DisclosureState) => {
      if (activeDisclosure?.open && activeDisclosure.key !== newDisclosure.key) {
        let targetRef = undefined;
        switch (newDisclosure.key) {
          case 'timeframe':
            targetRef = timeFrameButtonRef.current;
            break;
          case 'paymentMethod':
            targetRef = paymentMethodButtonRef.current;
            break;
          case 'taxTreatment':
            targetRef = taxTreatmentButtonRef.current;
            break;
        }

        activeDisclosure.close(targetRef || undefined);
      }

      setActiveDisclosure({
        ...newDisclosure,
        open: !newDisclosure.open,
      });
    },
    [activeDisclosure]
  );

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <HomeIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>{selectedPhysicalAsset ? 'Edit Physical Asset' : 'New Physical Asset'}</span>
        </div>
      </DialogTitle>
      <DialogDescription className="hidden sm:block">
        Any real estate, vehicle, or other physical asset you own or expect to acquire during your lifetime.
      </DialogDescription>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Fieldset aria-label="Physical asset details">
          <DialogBody className="sm:mt-4">
            <FieldGroup>
              {(saveError || hasFormErrors) && <ErrorMessageCard errorMessage={saveError || getErrorMessages(errors).join(', ')} />}
              <Divider soft className="hidden sm:block" />
              <div className="grid grid-cols-2 gap-4">
                <Field className={getNameColSpan()}>
                  <Label htmlFor="name">Name</Label>
                  <Input
                    {...register('name')}
                    id="name"
                    name="name"
                    placeholder="My Primary Residence"
                    autoComplete="off"
                    inputMode="text"
                    invalid={!!errors.name}
                    aria-invalid={!!errors.name}
                    readOnly={isAssetSynced}
                  />
                  {errors.name && <ErrorMessage>{errors.name?.message}</ErrorMessage>}
                </Field>
                <SyncWithNetWorthTrackerSelect
                  fieldId="syncedAssetId"
                  options={linkableAssets.map((a) => ({ id: a.id, label: `${a.name} | ${assetTypeForDisplay(a.type)}` }))}
                  value={syncedAssetId}
                  onChange={handleAssetSyncChange}
                />
                <Field>
                  <Label htmlFor="purchasePrice">Purchase Price</Label>
                  <NumberInput
                    name="purchasePrice"
                    control={control}
                    id="purchasePrice"
                    inputMode="decimal"
                    placeholder={formatCurrencyPlaceholder(460000)}
                    prefix={getCurrencySymbol()}
                    autoFocus
                  />
                  <Label htmlFor="amountBasis" className="mt-3 flex w-full items-center justify-between">
                    <span className="whitespace-nowrap">Amount Basis</span>
                    <Tooltip>
                      <TooltipTrigger className="text-muted-foreground">
                        <InfoIcon className="size-4 fill-white dark:fill-stone-950" />
                      </TooltipTrigger>
                      <TooltipContent>
                        {AMOUNT_BASIS_HINTS.map((hint) => (
                          <p key={hint}>{hint}</p>
                        ))}
                        <p>Applies to the purchase price, market value and loan amounts.</p>
                      </TooltipContent>
                    </Tooltip>
                  </Label>
                  <Select {...register('amountBasis', amountBasisFieldOptions)} id="amountBasis" name="amountBasis">
                    {AMOUNT_BASIS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} disabled={!isAmountBasisSelectable(option.value, purchaseDateType)}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  {amountBasisHint && <p className="text-muted-foreground mt-1 text-sm/6">{amountBasisHint}</p>}
                  {errors.purchasePrice && <ErrorMessage>{errors.purchasePrice?.message}</ErrorMessage>}
                  {errors.amountBasis && <ErrorMessage>{errors.amountBasis?.message}</ErrorMessage>}
                </Field>
                <Field>
                  <Label htmlFor="marketValue" className="flex w-full items-center justify-between">
                    <span className="whitespace-nowrap">Market Value</span>
                    <span className="text-muted-foreground hidden truncate text-sm/6 sm:inline">Optional</span>
                  </Label>
                  <NumberInput
                    name="marketValue"
                    control={control}
                    id="marketValue"
                    inputMode="decimal"
                    placeholder={formatCurrencyPlaceholder(525000)}
                    prefix={getCurrencySymbol()}
                    readOnly={isAssetSynced}
                  />
                  {errors.marketValue && <ErrorMessage>{errors.marketValue?.message}</ErrorMessage>}
                </Field>
                <Field className="col-span-2">
                  <Label htmlFor="appreciationRate">Real Annual Appreciation</Label>
                  <NumberInput
                    name="appreciationRate"
                    control={control}
                    id="appreciationRate"
                    inputMode="decimal"
                    placeholder="1%"
                    suffix="%"
                  />
                  {errors.appreciationRate && <ErrorMessage>{errors.appreciationRate?.message}</ErrorMessage>}
                </Field>
                <OwnershipFields control={control} register={register} errors={errors} />
              </div>
              <Disclosure as="div" className="border-border/25 border-t pt-4">
                {({ open, close }) => (
                  <>
                    <DisclosureButton
                      ref={timeFrameButtonRef}
                      onClick={() => {
                        if (!open) close();
                        toggleDisclosure({ open, close, key: 'timeframe' });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          if (!open) close();
                          toggleDisclosure({ open, close, key: 'timeframe' });
                        }
                      }}
                      className="group data-open:border-border/25 focus-outline flex w-full items-start justify-between text-left transition-opacity duration-150 hover:opacity-75 data-open:border-b data-open:pb-4"
                    >
                      <div className="flex items-center gap-2">
                        <CalendarIcon className="text-primary size-5 shrink-0" aria-hidden="true" />
                        <span className="text-base/7 font-semibold">Timeframe</span>
                        <span className="hidden sm:inline">|</span>
                        <span className="text-muted-foreground hidden truncate sm:inline">
                          {physicalAssetTimeFrameForDisplay(purchaseTimePoint, saleTimePoint)}
                        </span>
                      </div>
                      <span className="text-muted-foreground ml-6 flex h-7 items-center">
                        <PlusIcon aria-hidden="true" className="size-6 group-data-open:hidden" />
                        <MinusIcon aria-hidden="true" className="size-6 group-not-data-open:hidden" />
                      </span>
                    </DisclosureButton>
                    <DisclosurePanel className="pt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 grid grid-cols-2 items-end gap-x-4 gap-y-2">
                          <Field className={getDateColSpan(purchaseDateType)}>
                            <Label htmlFor="purchaseDate.type">Purchase Time</Label>
                            <Select {...register('purchaseDate.type')} id="purchaseDate.type" name="purchaseDate.type">
                              <option value="now">Already Owned</option>
                              <option value="atRetirement">At Retirement</option>
                              <option value="customDate">Custom Date</option>
                              <option value="customAge">Custom Age</option>
                            </Select>
                          </Field>
                          {purchaseDateType === 'customDate' && (
                            <>
                              <Field>
                                <Label className="sr-only">Month</Label>
                                <Controller
                                  name="purchaseDate.month"
                                  defaultValue={currentMonth.value}
                                  control={control}
                                  render={({ field: { onChange, value, name } }) => (
                                    <Combobox
                                      name={name}
                                      options={months}
                                      displayValue={(month) => month?.name || currentMonth.name}
                                      value={months.find((m) => m.value === value) || currentMonth}
                                      onChange={(month) => onChange(month?.value || currentMonth.value)}
                                      filter={(month, query) =>
                                        month.name.toLowerCase().includes(query.toLowerCase()) || String(month.value).includes(query)
                                      }
                                    >
                                      {(month) => (
                                        <ComboboxOption value={month}>
                                          <ComboboxLabel>{month.name}</ComboboxLabel>
                                        </ComboboxOption>
                                      )}
                                    </Combobox>
                                  )}
                                />
                              </Field>
                              <Field>
                                <Label className="sr-only">Year</Label>
                                <Controller
                                  name="purchaseDate.year"
                                  defaultValue={currentYear}
                                  control={control}
                                  render={({ field: { onChange, value, name } }) => (
                                    <Combobox
                                      name={name}
                                      options={years}
                                      displayValue={(year) => String(year || currentYear)}
                                      value={value || currentYear}
                                      onChange={(year) => onChange(year || currentYear)}
                                    >
                                      {(year) => (
                                        <ComboboxOption value={year}>
                                          <ComboboxLabel>{year}</ComboboxLabel>
                                        </ComboboxOption>
                                      )}
                                    </Combobox>
                                  )}
                                />
                              </Field>
                            </>
                          )}
                          {purchaseDateType === 'customAge' && (
                            <Field>
                              <Label className="sr-only">Age</Label>
                              <Controller
                                name="purchaseDate.age"
                                defaultValue={currentAge}
                                control={control}
                                render={({ field: { onChange, value, name } }) => (
                                  <Combobox
                                    name={name}
                                    options={ages}
                                    displayValue={(age) => String(age || currentAge) + ' y/o'}
                                    value={value || currentAge}
                                    onChange={(age) => onChange(age || currentAge)}
                                  >
                                    {(age) => (
                                      <ComboboxOption value={age}>
                                        <ComboboxLabel>{age}</ComboboxLabel>
                                      </ComboboxOption>
                                    )}
                                  </Combobox>
                                )}
                              />
                            </Field>
                          )}
                        </div>
                        <div className="col-span-2 grid grid-cols-2 items-end gap-x-4 gap-y-2">
                          <Field className={getDateColSpan(saleDateType)}>
                            <Label htmlFor="saleDate.type">Sale Time</Label>
                            <Select {...register('saleDate.type')} id="saleDate.type" name="saleDate.type">
                              <option value="atLifeExpectancy">Never Sold</option>
                              <option value="atRetirement">At Retirement</option>
                              <option value="customDate">Custom Date</option>
                              <option value="customAge">Custom Age</option>
                            </Select>
                          </Field>
                          {saleDateType === 'customDate' && (
                            <>
                              <Field>
                                <Label className="sr-only">Month</Label>
                                <Controller
                                  name="saleDate.month"
                                  defaultValue={currentMonth.value}
                                  control={control}
                                  render={({ field: { onChange, value, name } }) => (
                                    <Combobox
                                      name={name}
                                      options={months}
                                      displayValue={(month) => month?.name || currentMonth.name}
                                      value={months.find((m) => m.value === value) || currentMonth}
                                      onChange={(month) => onChange(month?.value || currentMonth.value)}
                                      filter={(month, query) =>
                                        month.name.toLowerCase().includes(query.toLowerCase()) || String(month.value).includes(query)
                                      }
                                    >
                                      {(month) => (
                                        <ComboboxOption value={month}>
                                          <ComboboxLabel>{month.name}</ComboboxLabel>
                                        </ComboboxOption>
                                      )}
                                    </Combobox>
                                  )}
                                />
                              </Field>
                              <Field>
                                <Label className="sr-only">Year</Label>
                                <Controller
                                  name="saleDate.year"
                                  defaultValue={currentYear}
                                  control={control}
                                  render={({ field: { onChange, value, name } }) => (
                                    <Combobox
                                      name={name}
                                      options={years}
                                      displayValue={(year) => String(year || currentYear)}
                                      value={value || currentYear}
                                      onChange={(year) => onChange(year || currentYear)}
                                    >
                                      {(year) => (
                                        <ComboboxOption value={year}>
                                          <ComboboxLabel>{year}</ComboboxLabel>
                                        </ComboboxOption>
                                      )}
                                    </Combobox>
                                  )}
                                />
                              </Field>
                            </>
                          )}
                          {saleDateType === 'customAge' && (
                            <Field>
                              <Label className="sr-only">Age</Label>
                              <Controller
                                name="saleDate.age"
                                defaultValue={currentAge}
                                control={control}
                                render={({ field: { onChange, value, name } }) => (
                                  <Combobox
                                    name={name}
                                    options={ages}
                                    displayValue={(age) => String(age || currentAge) + ' y/o'}
                                    value={value || currentAge}
                                    onChange={(age) => onChange(age || currentAge)}
                                  >
                                    {(age) => (
                                      <ComboboxOption value={age}>
                                        <ComboboxLabel>{age}</ComboboxLabel>
                                      </ComboboxOption>
                                    )}
                                  </Combobox>
                                )}
                              />
                            </Field>
                          )}
                        </div>
                      </div>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
              <Disclosure as="div" className="border-border/25 border-t pt-4">
                {({ open, close }) => (
                  <>
                    <DisclosureButton
                      ref={paymentMethodButtonRef}
                      onClick={() => {
                        if (!open) close();
                        toggleDisclosure({ open, close, key: 'paymentMethod' });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          if (!open) close();
                          toggleDisclosure({ open, close, key: 'paymentMethod' });
                        }
                      }}
                      className="group data-open:border-border/25 focus-outline flex w-full items-start justify-between text-left transition-opacity duration-150 hover:opacity-75 data-open:border-b data-open:pb-4"
                    >
                      <div className="flex items-center gap-2">
                        <BanknoteArrowDownIcon className="text-primary size-5 shrink-0" aria-hidden="true" />
                        <span className="text-base/7 font-semibold">Payment</span>
                        <span className="hidden sm:inline">|</span>
                        <span className="text-muted-foreground hidden truncate sm:inline">
                          {paymentMethod.type === 'loan' ? 'Financed' : 'Paid in Full'}
                        </span>
                      </div>
                      <span className="text-muted-foreground ml-6 flex h-7 items-center">
                        <PlusIcon aria-hidden="true" className="size-6 group-data-open:hidden" />
                        <MinusIcon aria-hidden="true" className="size-6 group-not-data-open:hidden" />
                      </span>
                    </DisclosureButton>
                    <DisclosurePanel className="pt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <Field className={getPaymentMethodColSpan()}>
                          <Label htmlFor="paymentMethod.type">Payment Method</Label>
                          <Select {...register('paymentMethod.type')} id="paymentMethod.type" name="paymentMethod.type">
                            <option value="cash">Paid in Full</option>
                            <option value="loan">Financed</option>
                          </Select>
                        </Field>
                        {paymentMethod.type === 'loan' && (
                          <>
                            <SyncWithNetWorthTrackerSelect
                              fieldId="syncedLiabilityId"
                              options={linkableLiabilities.map((l) => ({
                                id: l.id,
                                label: `${l.name} | ${liabilityTypeForDisplay(l.type)}`,
                              }))}
                              value={syncedLiabilityId}
                              onChange={handleLiabilitySyncChange}
                            />
                            <Field>
                              <Label htmlFor="paymentMethod.loanBalance">Loan Balance</Label>
                              <NumberInput
                                name="paymentMethod.loanBalance"
                                control={control}
                                id="paymentMethod.loanBalance"
                                inputMode="decimal"
                                placeholder={formatCurrencyPlaceholder(400000)}
                                prefix={getCurrencySymbol()}
                                readOnly={isLiabilitySynced}
                              />
                              {loanBalanceError && <ErrorMessage>{loanBalanceError.message}</ErrorMessage>}
                            </Field>
                            <Field>
                              <Label htmlFor="paymentMethod.monthlyPayment">Monthly Payment</Label>
                              <NumberInput
                                name="paymentMethod.monthlyPayment"
                                control={control}
                                id="paymentMethod.monthlyPayment"
                                inputMode="decimal"
                                placeholder={formatCurrencyPlaceholder(2400)}
                                prefix={getCurrencySymbol()}
                                readOnly={statedTermMonths !== null}
                              />
                              {statedTermMonths !== null && (
                                <Description>Derived from the loan term and APR: the loan is paid off in exactly the term.</Description>
                              )}
                              {monthlyPaymentError && <ErrorMessage>{monthlyPaymentError.message}</ErrorMessage>}
                            </Field>
                            <Field>
                              <Label htmlFor="paymentMethod.termMonths" className="flex w-full items-center justify-between">
                                <span className="whitespace-nowrap">Loan Term</span>
                                <span className="text-muted-foreground hidden truncate text-sm/6 sm:inline">Optional</span>
                              </Label>
                              <NumberInput
                                name="paymentMethod.termMonths"
                                control={control}
                                id="paymentMethod.termMonths"
                                inputMode="numeric"
                                placeholder="360"
                                suffix="months"
                              />
                              <Description>
                                In months. With a term, the payment is derived so the loan clears in exactly that many months.
                              </Description>
                              {termMonthsError && <ErrorMessage>{termMonthsError.message}</ErrorMessage>}
                            </Field>
                            <Field className="col-span-2">
                              <Label htmlFor="paymentMethod.offsetAccountId" className="flex w-full items-center justify-between">
                                <span className="whitespace-nowrap">Offset Account</span>
                                <span className="text-muted-foreground hidden truncate text-sm/6 sm:inline">Optional</span>
                              </Label>
                              <Select
                                {...register('paymentMethod.offsetAccountId', {
                                  // An empty choice is "no offset", not an account named "".
                                  setValueAs: (value: string) => (value === '' ? undefined : value),
                                })}
                                id="paymentMethod.offsetAccountId"
                                name="paymentMethod.offsetAccountId"
                              >
                                <option value="">No offset account</option>
                                {accountOptions.map((account) => (
                                  <option key={account.id} value={account.id}>
                                    {account.label}
                                  </option>
                                ))}
                              </Select>
                              <Description>
                                Its balance reduces the interest charged on this loan. The payment is unchanged, so the loan is paid off
                                sooner.
                              </Description>
                              {offsetAccountIdError && <ErrorMessage>{offsetAccountIdError.message}</ErrorMessage>}
                            </Field>
                            <Field className={getAPRColSpan()}>
                              <Label htmlFor="paymentMethod.apr">APR</Label>
                              <NumberInput
                                name="paymentMethod.apr"
                                control={control}
                                id="paymentMethod.apr"
                                inputMode="decimal"
                                placeholder="6%"
                                suffix="%"
                              />
                              {aprError && <ErrorMessage>{aprError.message}</ErrorMessage>}
                            </Field>
                            {showDownPaymentField && (
                              <Field>
                                <Label htmlFor="paymentMethod.downPayment">Down Payment</Label>
                                <NumberInput
                                  name="paymentMethod.downPayment"
                                  control={control}
                                  id="paymentMethod.downPayment"
                                  inputMode="decimal"
                                  placeholder={formatCurrencyPlaceholder(100000)}
                                  prefix={getCurrencySymbol()}
                                />
                                {downPaymentError && <ErrorMessage>{downPaymentError.message}</ErrorMessage>}
                              </Field>
                            )}
                          </>
                        )}
                        <PayoffEstimate months={payoffMonths} className="col-span-2" />
                      </div>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
              <Disclosure as="div" className="border-border/25 border-t pt-4">
                {({ open, close }) => (
                  <>
                    <DisclosureButton
                      ref={taxTreatmentButtonRef}
                      onClick={() => {
                        if (!open) close();
                        toggleDisclosure({ open, close, key: 'taxTreatment' });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          if (!open) close();
                          toggleDisclosure({ open, close, key: 'taxTreatment' });
                        }
                      }}
                      className="group data-open:border-border/25 focus-outline flex w-full items-start justify-between text-left transition-opacity duration-150 hover:opacity-75 data-open:border-b data-open:pb-4"
                    >
                      <div className="flex items-center gap-2">
                        <BanknoteXIcon className="text-primary size-5 shrink-0" aria-hidden="true" />
                        <span className="text-base/7 font-semibold">Taxes</span>
                        <span className="hidden sm:inline">|</span>
                        <span className="text-muted-foreground hidden truncate sm:inline">
                          {assetType === 'primaryResidence' ? 'Primary Residence' : 'Not Primary Residence'}
                        </span>
                      </div>
                      <span className="text-muted-foreground ml-6 flex h-7 items-center">
                        <PlusIcon aria-hidden="true" className="size-6 group-data-open:hidden" />
                        <MinusIcon aria-hidden="true" className="size-6 group-not-data-open:hidden" />
                      </span>
                    </DisclosureButton>
                    <DisclosurePanel className="pt-4">
                      <div className="grid grid-cols-1 gap-4">
                        <Field>
                          <Label htmlFor="assetType">Asset Type</Label>
                          <Select {...register('assetType')} id="assetType" name="assetType">
                            <option value="primaryResidence">Primary Residence</option>
                            <option value="other">Other</option>
                          </Select>
                          {errors.assetType && <ErrorMessage>{errors.assetType?.message}</ErrorMessage>}
                          <Description>
                            When sold, primary residences may qualify for the Section 121 exclusion, reducing capital gains taxes.
                          </Description>
                        </Field>
                        <Field>
                          <Label htmlFor="propertyTax.ratePercent" className="flex w-full items-center justify-between">
                            <span className="whitespace-nowrap">Property Tax Rate</span>
                            <span className="text-muted-foreground hidden truncate text-sm/6 sm:inline">Optional</span>
                          </Label>
                          <NumberInput
                            name="propertyTax.ratePercent"
                            control={control}
                            id="propertyTax.ratePercent"
                            inputMode="decimal"
                            placeholder="1.1%"
                            suffix="%"
                          />
                          <Description>
                            Per year of the assessed value. California&rsquo;s Prop 13 caps the assessment&rsquo;s growth at 2% a year.
                          </Description>
                          {propertyTaxRateError && <ErrorMessage>{propertyTaxRateError.message}</ErrorMessage>}
                        </Field>
                        <Field>
                          <Label htmlFor="propertyTax.annualAmount" className="flex w-full items-center justify-between">
                            <span className="whitespace-nowrap">Annual Property Tax</span>
                            <span className="text-muted-foreground hidden truncate text-sm/6 sm:inline">Optional</span>
                          </Label>
                          <NumberInput
                            name="propertyTax.annualAmount"
                            control={control}
                            id="propertyTax.annualAmount"
                            inputMode="decimal"
                            placeholder={formatCurrencyPlaceholder(6600)}
                            prefix={getCurrencySymbol()}
                          />
                          <Description>Stated in today&rsquo;s dollars. Overrides the rate when both are filled in.</Description>
                          {propertyTaxAmountError && <ErrorMessage>{propertyTaxAmountError.message}</ErrorMessage>}
                        </Field>
                      </div>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
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
