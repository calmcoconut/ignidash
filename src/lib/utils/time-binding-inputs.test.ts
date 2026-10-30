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
  amountBasisFieldOptions,
  clearRecurrenceOnAnchorChange,
  hasDollarDate,
  isAmountBasisSelectable,
  normalizeStoredAmountBasis,
  OPTIONAL_YEARS_FIELD,
  optionalYearCount,
  RECURRING_ENTITIES,
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
  mount(name: string, options?: Record<string, unknown>, domValue?: unknown): void;
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

  /**
   * Attaches a control's element.
   *
   * `domValue` is what the control shows before anyone touches it: an empty text input, or a
   * `<select>`'s first option. React Hook Form seeds a mounted field from exactly this value
   * when form state has nothing, which is how an untouched dialog used to smuggle
   * `amountBasis: 'real'` into the plan.
   */
  const mount = (name: string, options?: Record<string, unknown>, domValue: unknown = ''): FakeElement => {
    const registration = form.register(name as never, options as never);
    let element = elements.get(name);
    if (!element) {
      element = { name, value: domValue };
      elements.set(name, element);
    }
    // The ref callback is what pushes the current form value into the element after a reset,
    // and what reads the element's own value when form state has nothing.
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
    mount(name, options, domValue) {
      mount(name, options, domValue);
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
  it('starts on an empty placeholder, so a freshly mounted select selects "not set"', () => {
    // A browser selects the first option of a mounted <select>, and React Hook Form seeds the
    // field from it. A list that started at `real` therefore stored `amountBasis: 'real'` for a
    // dialog nobody touched.
    expect(AMOUNT_BASIS_OPTIONS[0]).toEqual({ value: '', label: "In today's dollars" });
    expect(AMOUNT_BASIS_OPTIONS.map((option) => option.value)).toEqual(['', 'nominal']);
    expect(amountBasisFieldOptions.setValueAs(AMOUNT_BASIS_OPTIONS[0].value)).toBeUndefined();
  });

  it('maps the placeholder, and a stale stored `real`, to an absent field', () => {
    expect(amountBasisFieldOptions.setValueAs('')).toBeUndefined();
    expect(amountBasisFieldOptions.setValueAs('real')).toBeUndefined();
    expect(amountBasisFieldOptions.setValueAs('nominal')).toBe('nominal');

    expect(normalizeStoredAmountBasis({ amountBasis: 'real' as const, id: 'x' })).toEqual({ amountBasis: undefined, id: 'x' });
    const nominal = { amountBasis: 'nominal' as const, id: 'x' };
    expect(normalizeStoredAmountBasis(nominal)).toBe(nominal);
    expect(normalizeStoredAmountBasis(null)).toBeNull();
  });

  it('only enables nominal where the anchor has a dollar date', () => {
    // The four dialogs bind the option's `disabled` attribute to this matrix.
    const anchors = ['now', 'customDate', 'customAge', 'atRetirement', 'atLifeExpectancy'] as const;

    for (const anchor of anchors) {
      expect(hasDollarDate(anchor), anchor).toBe(anchor !== 'atRetirement' && anchor !== 'atLifeExpectancy');
      // The default (empty) option is always pickable; `nominal` only where a conversion can
      // actually happen.
      expect(isAmountBasisSelectable('', anchor), anchor).toBe(true);
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

  it('offers the cadence only on a stream, never on a single-point anchor', () => {
    const entities = ['income', 'expense', 'debt', 'physicalAsset'] as const;
    const anchors = ['now', 'customDate', 'customAge', 'atRetirement', 'atLifeExpectancy'] as const;

    // A debt's start date and an asset's purchase date are single points: a cadence there
    // would switch the event off in the gap years (no payment, no interest, no purchase).
    expect(RECURRING_ENTITIES).toEqual(['income', 'expense']);
    for (const entity of entities) {
      for (const anchor of anchors) {
        expect(showsRecurrenceControl(entity, anchor), `${entity} @ ${anchor}`).toBe(
          (entity === 'income' || entity === 'expense') && anchor !== 'now'
        );
      }
    }

    expect(entities.filter((entity) => showsRecurrenceControl(entity, 'customAge'))).toEqual(['income', 'expense']);
    expect(anchors.filter((anchor) => showsRecurrenceControl('income', anchor))).toEqual([
      'customDate',
      'customAge',
      'atRetirement',
      'atLifeExpectancy',
    ]);
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
    const { mount, type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    type('amount', '85000');
    // Mount the basis select the way a browser presents it: its first option selected.
    mount('amountBasis', amountBasisFieldOptions, AMOUNT_BASIS_OPTIONS[0].value);

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(values).toBeDefined();

    expect(values!.amountBasis).toBeUndefined();
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

  it('keeps a stored `now`-anchored cadence through an untouched save', async () => {
    // `timePointSchema` allows a cadence on a `now` anchor and the engine honours it (plan-year
    // multiples), so the mount-time cleanup must not touch it: the effect also runs when the
    // dialog opens, and clearing whenever the anchor *is* `now` deleted stored data nobody
    // asked to change.
    const existing: Doc<'plans'>['incomes'][number] = {
      id: 'income-1',
      name: 'Consulting',
      amount: 50000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now', everyNYears: 3 }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 20 },
      disabled: false,
    };

    const { form, type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    form.reset(incomeFromConvex(existing));
    expect(form.getValues('timeframe.start.everyNYears' as never)).toBe(3);

    // What the mount effect does: previous anchor and current anchor are both `now`.
    clearRecurrenceOnAnchorChange({ setValue: form.setValue, unregister: form.unregister }, 'now', 'now', 'timeframe.start.everyNYears');

    // An unrelated edit, then save.
    type('amount', '60000');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect((values!.timeframe.start as { everyNYears?: number }).everyNYears).toBe(3);
    expect(stored(incomeToConvex({ ...values!, id: 'income-1' }))).toStrictEqual(stored(incomeToConvex({ ...existing, amount: 60000 })));
  });

  it('clears only on a transition into `now`', () => {
    const field = 'timeframe.start.everyNYears';

    const valueAfter = (previous: 'customAge' | 'now', next: 'customAge' | 'now') => {
      const start = { type: previous, age: 45, everyNYears: 5 };
      const { form } = harness<IncomeInputs>(incomeFormSchema, {
        ...defaults,
        timeframe: { start, end: { type: 'atRetirement' } },
      } as never);

      expect(form.getValues(field as never)).toBe(5);
      clearRecurrenceOnAnchorChange({ setValue: form.setValue, unregister: form.unregister }, previous, next, field);

      return form.getValues(field as never);
    };

    // A mount (no transition) keeps it, whichever anchor the plan already had.
    expect(valueAfter('now', 'now')).toBe(5);
    // Leaving `now` keeps it as well: the control comes back carrying the value.
    expect(valueAfter('now', 'customAge')).toBe(5);
    // The one transition that removes the control also removes the value.
    expect(valueAfter('customAge', 'now')).toBeUndefined();
  });

  it('reads a mounted basis value, so the untouched case is a real mount', async () => {
    // Positive control for the test above: the harness seeds from the element, so a mounted
    // `nominal` really does reach the payload (and a mounted empty placeholder really does not).
    const { mount, type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    type('amount', '85000');
    mount('amountBasis', amountBasisFieldOptions, 'nominal');

    const { values } = await submit();
    expect(values!.amountBasis).toBe('nominal');
  });

  it('drops the cadence when the start switches to `now`', async () => {
    const existing: Doc<'plans'>['incomes'][number] = {
      id: 'income-1',
      name: 'Consulting',
      amount: 50000,
      frequency: 'yearly',
      timeframe: { start: { type: 'customAge', age: 45, everyNYears: 5 }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 20 },
      disabled: false,
    };

    const { form, type, submit } = harness<IncomeInputs>(incomeFormSchema, defaults);
    form.reset(incomeFromConvex(existing));
    expect(form.getValues('timeframe.start.everyNYears' as never)).toBe(5);

    // The anchor becomes `now`: the control disappears, and the dialog's cleanup effect runs
    // the same helper. `setValue` clears the live value; `unregister` drops the field and its
    // default seed so a re-render cannot restore it.
    type('timeframe.start.type', 'now');
    clearRecurrenceOnAnchorChange(
      { setValue: form.setValue, unregister: form.unregister },
      'customAge',
      'now',
      'timeframe.start.everyNYears'
    );

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect((values!.timeframe.start as { everyNYears?: number }).everyNYears).toBeUndefined();
    expect('everyNYears' in timePointOf(stored(incomeToConvex({ ...values!, id: 'income-1' })), 'timeframe')).toBe(false);

    // Control: without the clear the value survives the switch and would be stored, so the
    // assertion above fails if the cleanup is removed.
    const control = harness<IncomeInputs>(incomeFormSchema, defaults);
    control.form.reset(incomeFromConvex(existing));
    control.type('timeframe.start.type', 'now');
    const controlValues = await control.submit();
    expect((controlValues.values!.timeframe.start as { everyNYears?: number }).everyNYears).toBe(5);
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
    const { mount, type, submit } = harness<ExpenseInputs>(expenseFormSchema, defaults);
    type('amount', '50000');
    mount('amountBasis', amountBasisFieldOptions, AMOUNT_BASIS_OPTIONS[0].value);

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(values!.amountBasis).toBeUndefined();
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
    const { mount, type, submit } = harness<DebtInputs>(debtFormSchema, defaults);
    type('balance', '7500');
    type('monthlyPayment', '500');
    mount('amountBasis', amountBasisFieldOptions, AMOUNT_BASIS_OPTIONS[0].value);

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(values!.amountBasis).toBeUndefined();
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
    mount('amountBasis');

    // The debt dialog no longer renders a cadence control (a single-point date would be gated
    // by it), but a value already stored is carried through untouched rather than dropped.
    expect(form.getValues('startDate.everyNYears' as never)).toBe(10);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(debtToConvex({ ...values!, id: 'debt-1' }))).toStrictEqual(stored(existing));
  });

  it('offers no cadence at all, because a start date is a single point', () => {
    expect(showsRecurrenceControl('debt', 'customDate')).toBe(false);
    expect(showsRecurrenceControl('debt', 'customAge')).toBe(false);
    expect(showsRecurrenceControl('debt', 'atRetirement')).toBe(false);
  });
});

describe('physical asset dialog', () => {
  const defaults = newPhysicalAssetDefaults(0);

  it('an untouched dialog submits today\u2019s payload', async () => {
    const { mount, type, submit } = harness<PhysicalAssetInputs>(physicalAssetFormSchema, defaults);
    type('purchasePrice', '460000');
    mount('amountBasis', amountBasisFieldOptions, AMOUNT_BASIS_OPTIONS[0].value);

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(values!.amountBasis).toBeUndefined();
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
    mount('amountBasis');

    // No cadence control here either; the stored value is preserved, not silently dropped.
    expect(form.getValues('purchaseDate.everyNYears' as never)).toBe(4);
    expect(form.getValues('amountBasis' as never)).toBe('nominal');
    expect(rendered('amountBasis')).toBe('nominal');

    const { values, errors } = await submit();
    expect(errors).toBeUndefined();
    expect(stored(physicalAssetToConvex({ ...values!, id: 'asset-1' }))).toStrictEqual(stored(existing));
  });

  it('offers no cadence at all, because a purchase date is a single point', () => {
    expect(showsRecurrenceControl('physicalAsset', 'customDate')).toBe(false);
    expect(showsRecurrenceControl('physicalAsset', 'customAge')).toBe(false);
    expect(showsRecurrenceControl('physicalAsset', 'atRetirement')).toBe(false);
  });
});
