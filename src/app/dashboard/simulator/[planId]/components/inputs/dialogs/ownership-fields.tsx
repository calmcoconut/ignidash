'use client';

import { useWatch, type Control, type FieldErrors, type FieldValues, type Path, type UseFormRegister } from 'react-hook-form';

import { Field, Label, ErrorMessage } from '@/components/catalyst/fieldset';
import { Select } from '@/components/catalyst/select';
import type { Owner, PropertyRegime } from '@/lib/schemas/inputs/household-schema';

/**
 * The ownership controls every entity dialog shares (parity plan P1-P2).
 *
 * `Owner` is a three-way select — primary, partner, joint — and the property regime appears
 * only when the item is jointly held, because `propertyRegime` is meaningless otherwise. Both
 * are plain selects on the same catalyst primitives the rest of the dialogs use.
 *
 * The stored value is normalised on submit (`ownershipForStorage`), so switching an item back
 * from `joint` to a single owner does not leave a regime behind.
 */

export const OWNER_OPTIONS: readonly { value: Owner; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'partner', label: 'Partner' },
  { value: 'joint', label: 'Joint' },
];

/**
 * `community` is the California default (E2): joint property is community property unless the
 * user tags it otherwise. Transmutation and quasi-community property are not modelled (F10).
 */
export const PROPERTY_REGIME_OPTIONS: readonly { value: PropertyRegime; label: string }[] = [
  { value: 'community', label: 'Community property' },
  { value: 'jointTenancy', label: 'Joint tenancy' },
];

interface OwnershipFieldsProps<T extends FieldValues> {
  control: Control<T>;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  /** Grid class for the fields; the savings dialog stacks its fields, so it passes `''`. */
  className?: string;
}

export default function OwnershipFields<T extends FieldValues>({
  control,
  register,
  errors,
  className = 'col-span-1',
}: OwnershipFieldsProps<T>) {
  const owner = useWatch({ control, name: 'owner' as Path<T> }) as Owner | undefined;
  const ownershipErrors = errors as Record<string, { message?: string } | undefined>;

  return (
    <>
      <Field className={className}>
        <Label htmlFor="owner">Owner</Label>
        <Select {...register('owner' as Path<T>)} id="owner" name="owner">
          {OWNER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {ownershipErrors.owner && <ErrorMessage>{ownershipErrors.owner.message}</ErrorMessage>}
      </Field>
      {owner === 'joint' && (
        <Field className={className}>
          <Label htmlFor="propertyRegime">Property Regime</Label>
          <Select {...register('propertyRegime' as Path<T>)} id="propertyRegime" name="propertyRegime">
            {PROPERTY_REGIME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {ownershipErrors.propertyRegime && <ErrorMessage>{ownershipErrors.propertyRegime.message}</ErrorMessage>}
        </Field>
      )}
    </>
  );
}
