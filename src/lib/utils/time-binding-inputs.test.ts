import { describe, expect, it } from 'vitest';
import { createFormControl, type FieldErrors, type FieldValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';

import { debtFormSchema, type DebtInputs } from '@/lib/schemas/inputs/debt-form-schema';
import { expenseFormSchema, type ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import { incomeFormSchema, type IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';
import { physicalAssetFormSchema, type PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import {
  debtFromConvex,
  debtToConvex,
  expenseFromConvex,
  expenseToConvex,
  incomeFromConvex,
  incomeToConvex,
  physicalAssetFromConvex,
  physicalAssetToConvex,
} from '@/lib/utils/data-transformers';
import { getErrorMessages } from '@/lib/utils/form-utils';
import type { Doc } from '../../../convex/_generated/dataModel';

import { newDebtDefaults, newExpenseDefaults, newIncomeDefaults, newPhysicalAssetDefaults } from './entity-form-defaults';
import {
  AMOUNT_BASIS_OPTIONS,
  amountBasisAnchorHint,
  hasDollarDate,
  isAmountBasisSelectable,
  OPTIONAL_YEARS_FIELD,
  optionalYearCount,
  showsRecurrenceControl,
} from './time-binding-inputs';

/**
 * Form behaviour of the two time-binding controls (parity plan P1-P1) in the four entity
 * dialogs.
 *
 * Each dialog is a React component, and this repo has no DOM test environment, so these tests
 * drive the same form layer the dialogs drive — `react-hook-form`'s own form control, the
 * dialog's default values, its Zod schema through `zodResolver`, and the same `register` rules
 * and transformer the submit handler uses. That covers the three properties that matter:
 *
 * 1. an untouched dialog submits today's payload (no `amountBasis`, no cadence);
 * 2. a stored cadence and basis survive a reset (opening an existing item) and the submit;
 * 3. an invalid cadence is refused with a message the dialog renders.
 */

type FormOf<T extends FieldValues> = ReturnType<typeof createFormControl<T>>;

interface Harness<T extends FieldValues> {
  form: FormOf<T>;
  /** Type into a registered field, exactly as the DOM would. */
  type(name: string, value: string, options?: Record<string, unknown>): void;
  /** Attach the control's element, as a re-render after `reset` does. */
  mount(name: string, options?: Record<string, unknown>): void;
  /** The value the DOM control currently holds, which is what the user sees. */
  rendered(name: string): unknown;
  submit(): Promise<{ values?: T; errors?: FieldErrors<T> }>;
}

/**
 * A stand-in for the `<input>`/`<select>` element a registered field is bound to.
 *
 * React Hook Form reads a field's value from `field._f.ref.value` and writes it back with the
 * same property, so holding one per field is enough to exercise the display path without a DOM.
 */
interface FakeElement {
  name: string;
  value: unknown;
}

function harness<T extends FieldValues>(schema: z.ZodType, defaults: Partial<T>): Harness<T> {
  const form = createFormControl<T>({
    resolver: zodResolver(schema as never) as never,
    defaultValues: defaults as never,
    mode: 'onSubmit',
  });

  const elements = new Map<string, FakeElement>();

  const mount = (name: string, options?: Record<string, unknown>): FakeElement => {
    const registration = form.register(name as never, options as never);
    let element = elements.get(name);
    if (!element) {
      element = { name, value: '' };
      elements.set(name, element);
    }
    // The ref callback is what pushes the current form value into the element after a reset.
    registration.ref(element as never);

    return element;
  };

  return {
    form,
    type(name, value, options) {
      const element = mount(name, options);
      element.value = value;
      // `target.type` is what makes RHF read the value off the element rather than the event.
      const { onChange } = form.register(name as never, options as never);
      onChange({ target: { name, value, type: 'text' }, type: 'change' } as never);
    },
    mount(name, options) {
      mount(name, options);
    },
    rendered(name) {
      return elements.get(name)?.value;
    },
    async submit() {
      let values: T | undefined;
      let errors: FieldErrors<T> | undefined;

      await form.handleSubmit(
        (submitted) => {
          values = submitted;
        },
        (formErrors) => {
          errors = formErrors as FieldErrors<T>;
        }
      )();

      return { values, errors };
    },
  };
}

/** The JSON a value produces once it is stored: `undefined` keys disappear. */
const stored = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const timePointOf = (input: Record<string, unknown>, field: string): Record<string, unknown> => {
  const container = field === 'timeframe' ? (input.timeframe as Record<string, unknown>) : input;
  return (container[field === 'timeframe' ? 'start' : field] ?? {}) as Record<string, unknown>;
};

describe('the amount-basis control defaults to real', () => {
  it('lists real first, so an absent field shows the default option', () => {
    expect(AMOUNT_BASIS_OPTIONS[0]).toEqual({ value: 'real', label: "In today's dollars" });
    expect(AMOUNT_BASIS_OPTIONS.map((option) => option.value)).toEqual(['real', 'nominal']);
  });

  it('only enables nominal where the anchor has a dollar date', () => {
    // The four dialogs bind the option's `disabled` attribute to this matrix.
    const anchors = ['now', 'customDate', 'customAge', 'atRetirement', 'atLifeExpectancy'] as const;

    for (const anchor of anchors) {
      expect(hasDollarDate(anchor), anchor).toBe(anchor !== 'atRetirement' && anchor !== 'atLifeExpectancy');
      // `real` is always pickable; `nominal` only where a conversion can actually happen.
      expect(isAmountBasisSelectable('real', anchor), anchor).toBe(true);
      expect(isAmountBasisSelectable('nominal', anchor), anchor).toBe(hasDollarDate(anchor));
    }

    // Exactly the anchors the engine can convert are the ones the control offers.
    expect(anchors.filter((anchor) => isAmountBasisSelectable('nominal', anchor))).toEqual(['now', 'customDate', 'customAge']);
    expect(anchors.filter((anchor) => isAmountBasisSelectable('nominal', anchor) === false)).toEqual(['atRetirement', 'atLifeExpectancy']);
  });

  it('explains the disabled option instead of silently ignoring it', () => {
    expect(amountBasisAnchorHint('atRetirement')).toBe('This start has no dollar date, so the amount is always in today\u2019s dollars.');
    expect(amountBasisAnchorHint('atLifeExpectancy')).toBe(amountBasisAnchorHint('atRetirement'));
    for (const anchor of ['now', 'customDate', 'customAge'] as const) {
      expect(amountBasisAnchorHint(anchor), anchor).toBeNull();
    }
  });

  it('offers no cadence for a `now` start, and one for every dated start', () => {
    expect(showsRecurrenceControl('now')).toBe(false);
    for (const type of ['customDate', 'customAge', 'atRetirement', 'atLifeExpectancy'] as const) {
      expect(showsRecurrenceControl(type)).toBe(true);
    }
  });

  it('reads an empty cadence field as "no cadence" and keeps a typed number', () => {
    expect(optionalYearCount('')).toBeUndefined();
    expect(optionalYearCount(undefined)).toBeUndefined();
    expect(optionalYearCount('5')).toBe(5);
    expect(optionalYearCount(7)).toBe(7);
    // A non-numeric entry stays NaN on purpose, so the schema reports it instead of the value
    // disappearing.
    expect(optionalYearCount('five')).toBeNaN();
  });
});

describe('income dialog', () => {
  const defaults = newIncomeDefaults(0);

  it('an untouched dialog submits today\u2019s payload', async () => {
    const { type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    type('amount', '85000');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(values).toBeDefined();

    expect('amountBasis' in values!).toBe(false);
    const start = timePointOf(values as unknown as Record<string, unknown>, 'timeframe');
    expect('everyNYears' in start).toBe(false);
    expect('recurrenceYears' in start).toBe(false);

    const doc = stored(incomeToConvex({ ...values!, id: 'income-1' }));
    expect('amountBasis' in doc).toBe(false);
    expect('everyNYears' in timePointOf(doc, 'timeframe')).toBe(false);
  });

  it('a stored cadence and nominal basis survive the reset path and the submit', async () => {
    const existing: Doc<'plans'>['incomes'][number] = {
      id: 'income-1',
      name: 'Consulting',
      amount: 50000,
      frequency: 'yearly',
      timeframe: {
        start: { type: 'customAge', age: 45, everyNYears: 5 },
        end: { type: 'atRetirement' },
      },
      taxes: { incomeType: 'wage', withholding: 20 },
      amountBasis: 'nominal',
      disabled: false,
    };

    const { form, mount, rendered, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    form.reset(incomeFromConvex(existing));
    // A re-render after the reset re-registers the two controls the dialog shows for a
    // `customAge` start, which is what pushes the stored values into them.
    mount('timeframe.start.everyNYears', OPTIONAL_YEARS_FIELD);
    mount('amountBasis');

    // The controls read the stored values back, not the dialog defaults.
    expect(form.getValues('timeframe.start.everyNYears' as never)).toBe(5);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(form.getValues('timeframe.start.type' as never)).toBe('customAge');
    expect(rendered('timeframe.start.everyNYears')).toBe(5);
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(incomeToConvex({ ...values!, id: 'income-1' }))).toStrictEqual(stored(existing));
  });

  it('clearing the cadence stores no cadence', async () => {
    const { type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    type('amount', '85000');
    type('timeframe.start.everyNYears', '5', OPTIONAL_YEARS_FIELD);
    type('timeframe.start.everyNYears', '', OPTIONAL_YEARS_FIELD);

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect('everyNYears' in timePointOf(stored(incomeToConvex({ ...values!, id: 'income-1' })), 'timeframe')).toBe(false);
  });

  it.each([
    ['0', 'Repeat interval must be at least 1 year'],
    ['1.5', 'Invalid input'],
    ['101', 'Repeat interval must be at most 100 years'],
    ['five', 'Invalid input'],
  ])('rejects a cadence of %s with a visible message', async (entry, expectedMessage) => {
    const { type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    type('amount', '85000');
    type('timeframe.start.everyNYears', entry, OPTIONAL_YEARS_FIELD);

    const { values, errors } = await submit();
    expect(values).toBeUndefined();

    const cadenceError = errors?.timeframe?.start?.everyNYears as { message?: string } | undefined;
    expect(cadenceError?.message).toContain(expectedMessage);
    // The dialog shows field errors and the top-of-form banner from the same tree.
    expect(getErrorMessages(errors as FieldErrors)).toEqual([expect.stringContaining(expectedMessage)]);
  });
});

describe('expense dialog', () => {
  const defaults = newExpenseDefaults(0);

  it('an untouched dialog submits today\u2019s payload', async () => {
    const { type, submit } = harness<ExpenseInputs>(expenseFormSchema, defaults);
    type('amount', '50000');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect('amountBasis' in values!).toBe(false);
    expect('everyNYears' in timePointOf(values as unknown as Record<string, unknown>, 'timeframe')).toBe(false);

    const doc = stored(expenseToConvex({ ...values!, id: 'expense-1' }));
    expect('amountBasis' in doc).toBe(false);
    expect('everyNYears' in timePointOf(doc, 'timeframe')).toBe(false);
  });

  it('a stored cadence and nominal basis survive the reset path and the submit', async () => {
    const existing: Doc<'plans'>['expenses'][number] = {
      id: 'expense-1',
      name: 'Tuition',
      amount: 30000,
      frequency: 'yearly',
      timeframe: {
        start: { type: 'customDate', year: 2031, month: 9, everyNYears: 2 },
        end: { type: 'atLifeExpectancy' },
      },
      amountBasis: 'nominal',
      disabled: false,
    };

    const { form, mount, rendered, submit } = harness<ExpenseInputs>(expenseFormSchema, defaults);
    form.reset(expenseFromConvex(existing));
    mount('timeframe.start.everyNYears', OPTIONAL_YEARS_FIELD);
    mount('amountBasis');

    expect(form.getValues('timeframe.start.everyNYears' as never)).toBe(2);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(rendered('timeframe.start.everyNYears')).toBe(2);
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(expenseToConvex({ ...values!, id: 'expense-1' }))).toStrictEqual(stored(existing));
  });

  it('rejects a cadence of 0 with a visible message', async () => {
    const { type, submit } = harness<ExpenseInputs>(expenseFormSchema, defaults);
    type('amount', '50000');
    type('timeframe.start.everyNYears', '0', OPTIONAL_YEARS_FIELD);

    const { values, errors } = await submit();
    expect(values).toBeUndefined();
    expect((errors?.timeframe?.start?.everyNYears as { message?: string } | undefined)?.message).toContain(
      'Repeat interval must be at least 1 year'
    );
  });
});

describe('debt dialog', () => {
  const defaults = newDebtDefaults(0);

  it('an untouched dialog submits today\u2019s payload', async () => {
    const { type, submit } = harness<DebtInputs>(debtFormSchema, defaults);
    type('balance', '7500');
    type('monthlyPayment', '500');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect('amountBasis' in values!).toBe(false);
    expect('everyNYears' in (values as unknown as Record<string, unknown>)).toBe(false);

    const doc = stored(debtToConvex({ ...values!, id: 'debt-1' }));
    expect('amountBasis' in doc).toBe(false);
    expect('everyNYears' in timePointOf(doc, 'startDate')).toBe(false);
  });

  it('a stored cadence and nominal basis survive the reset path and the submit', async () => {
    const existing: NonNullable<Doc<'plans'>['debts']>[number] = {
      id: 'debt-1',
      name: 'Mortgage',
      balance: 250000,
      apr: 4.25,
      interestType: 'compound',
      compoundingFrequency: 'monthly',
      startDate: { type: 'customDate', year: 2027, month: 4, everyNYears: 10 },
      monthlyPayment: 1500,
      amountBasis: 'nominal',
      disabled: false,
    };

    const { form, mount, rendered, submit } = harness<DebtInputs>(debtFormSchema, defaults);
    form.reset(debtFromConvex(existing));
    mount('startDate.everyNYears', OPTIONAL_YEARS_FIELD);
    mount('amountBasis');

    expect(form.getValues('startDate.everyNYears' as never)).toBe(10);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(rendered('startDate.everyNYears')).toBe(10);
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(debtToConvex({ ...values!, id: 'debt-1' }))).toStrictEqual(stored(existing));
  });

  it('rejects a cadence of 0 with a visible message', async () => {
    const { type, submit } = harness<DebtInputs>(debtFormSchema, defaults);
    type('balance', '7500');
    type('monthlyPayment', '500');
    type('startDate.everyNYears', '0', OPTIONAL_YEARS_FIELD);

    const { values, errors } = await submit();
    expect(values).toBeUndefined();
    expect((errors?.startDate?.everyNYears as { message?: string } | undefined)?.message).toContain(
      'Repeat interval must be at least 1 year'
    );
  });
});

describe('physical asset dialog', () => {
  const defaults = newPhysicalAssetDefaults(0);

  it('an untouched dialog submits today\u2019s payload', async () => {
    const { type, submit } = harness<PhysicalAssetInputs>(physicalAssetFormSchema, defaults);
    type('purchasePrice', '460000');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect('amountBasis' in values!).toBe(false);
    expect('everyNYears' in (values as unknown as Record<string, unknown>)).toBe(false);

    const doc = stored(physicalAssetToConvex({ ...values!, id: 'asset-1' }));
    expect('amountBasis' in doc).toBe(false);
    expect('everyNYears' in timePointOf(doc, 'purchaseDate')).toBe(false);
  });

  it('a stored cadence and nominal basis survive the reset path and the submit', async () => {
    const existing: NonNullable<Doc<'plans'>['physicalAssets']>[number] = {
      id: 'asset-1',
      name: 'Cabin',
      assetType: 'other',
      purchaseDate: { type: 'customAge', age: 50, everyNYears: 4 },
      purchasePrice: 300000,
      appreciationRate: 3,
      saleDate: { type: 'atLifeExpectancy' },
      amountBasis: 'nominal',
      paymentMethod: { type: 'cash' },
    };

    const { form, mount, rendered, submit } = harness<PhysicalAssetInputs>(physicalAssetFormSchema, defaults);
    form.reset(physicalAssetFromConvex(existing));
    mount('purchaseDate.everyNYears', OPTIONAL_YEARS_FIELD);
    mount('amountBasis');

    expect(form.getValues('purchaseDate.everyNYears' as never)).toBe(4);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(rendered('purchaseDate.everyNYears')).toBe(4);
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(physicalAssetToConvex({ ...values!, id: 'asset-1' }))).toStrictEqual(stored(existing));
  });

  it('rejects a cadence of 0 with a visible message', async () => {
    const { type, submit } = harness<PhysicalAssetInputs>(physicalAssetFormSchema, defaults);
    type('purchasePrice', '460000');
    type('purchaseDate.everyNYears', '0', OPTIONAL_YEARS_FIELD);

    const { values, errors } = await submit();
    expect(values).toBeUndefined();
    expect((errors?.purchaseDate?.everyNYears as { message?: string } | undefined)?.message).toContain(
      'Repeat interval must be at least 1 year'
    );
  });
});
