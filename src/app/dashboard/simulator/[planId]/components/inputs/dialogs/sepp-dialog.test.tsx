// @vitest-environment jsdom
/**
 * The SEPP schedule editor (IRC §72(t)(2)(A)(iv)).
 *
 * The dialog owns the whole list and saves it in one mutation, so what matters is the payload:
 * every field a row shows has to reach `api.sepp.update`, and a field the chosen method does not
 * have must not come along. Both are asserted on the mutation argument rather than on the DOM.
 *
 * The rest is the hardening that keeps the editor from writing a plan the simulation cannot run or
 * the browser cannot submit: the fixed-method rate window is refused before the mutation, every
 * numeric input that can hold a fraction says `step="any"`, each row is a named group, and the
 * dialog is not handed the whole help text as its accessible description.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { updateSepp, onClose } = vi.hoisted(() => ({ updateSepp: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => updateSepp }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));

import { Dialog } from '@/components/catalyst/dialog';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import { seppFixedRateCoverage, seppRateCapForStartYear } from '@/lib/schemas/inputs/sepp-form-schema';
import SeppDialog from './sepp-dialog';

const ACCOUNTS: AccountInputs[] = [
  { id: 'ira-1', name: 'Traditional IRA', type: 'ira', balance: 500_000, percentBonds: 0 },
  { id: 'brokerage-1', name: 'Brokerage', type: 'taxableBrokerage', balance: 50_000, percentBonds: 0, costBasis: 40_000 },
];

/** Two accounts a schedule may name, so a row's identity can fall back to the account. */
const TWO_IRAS: AccountInputs[] = [...ACCOUNTS, { id: 'ira-2', name: 'Rollover IRA', type: 'ira', balance: 250_000, percentBonds: 0 }];

/**
 * The first start year the vendored mid-term rates cannot price. Derived, then pinned: the tables
 * stop at `NEWEST_MID_TERM_RATE_MONTH = '2026-11'` today, and whoever advances that constant has to
 * revisit this file (the pins below then say which fixture moved).
 */
const UNPRICED_START_YEAR = seppFixedRateCoverage().latestStartYear + 1;

/** The dialog is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = (sepp: Parameters<typeof SeppDialog>[0]['sepp'] = []) =>
  render(
    <Dialog open onClose={() => {}}>
      <SeppDialog onClose={onClose} sepp={sepp} accounts={ACCOUNTS} />
    </Dialog>
  );

const addRow = () => fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
const field = (name: string) => screen.getByLabelText(name, { selector: 'input' });
const select = (name: string) => screen.getByLabelText(name, { selector: 'select' });

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

const payload = () => {
  const [call] = updateSepp.mock.calls.at(-1) as [{ planId: string; sepp: Record<string, unknown>[] }];

  return call;
};

beforeEach(() => {
  updateSepp.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the SEPP editor', () => {
  it('sends a fixed-method row to the mutation with its rate and stop year', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Rate %'), { target: { value: '5' } });
    // 2026, not 2027: a fixed method is priced from the Notice 2022-6 rates and the tables stop at
    // 2026-11, so 2027 cannot be computed. The refusal itself is asserted further down.
    fireEvent.change(field('Start year'), { target: { value: '2026' } });
    fireEvent.change(field('Annual amount'), { target: { value: '25000' } });
    fireEvent.change(field('Stop year'), { target: { value: '2032' } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));

    expect(payload().planId).toBe('plan-1');
    expect(payload().sepp).toStrictEqual([
      expect.objectContaining({
        accountId: 'ira-1',
        method: 'fixedAmortization',
        startYear: 2026,
        // Stored as a decimal (0.05), the unit the engine's §72(t) arithmetic reads.
        rate: 0.05,
        annualAmount: 25_000,
        stopYear: 2032,
      }),
    ]);
    // A blank name and an off switch are absent, not `''` and `false`.
    expect(payload().sepp[0]).not.toHaveProperty('name');
    expect(payload().sepp[0]).not.toHaveProperty('disabled');
    expect(onClose).toHaveBeenCalled();
  });

  it('drops the rate when the method does not use one', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAnnuitization' } });
    fireEvent.change(field('Rate %'), { target: { value: '4.5' } });
    // Switching back to the RMD method removes the rate input; the value must not survive the switch
    // and be written to a field the RMD method never reads.
    fireEvent.change(select('Method'), { target: { value: 'rmd' } });
    fireEvent.change(field('Start year'), { target: { value: '2026' } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));

    expect(payload().sepp[0]).toStrictEqual({
      id: expect.any(String),
      accountId: 'ira-1',
      method: 'rmd',
      startYear: 2026,
    });
    expect(screen.queryByLabelText('Rate %')).toBeNull();
  });

  it('offers only the accounts a schedule can be taken from', () => {
    renderDialog();

    addRow();

    const options = Array.from(select('Account').querySelectorAll('option')).map((option) => option.textContent);

    // A taxable brokerage is not a plan §72(t) reaches, so it is not offered.
    expect(options).toStrictEqual(['Traditional IRA']);
  });

  it('loads an existing schedule into the form and saves it back unchanged', async () => {
    renderDialog([
      {
        id: 'sepp-1',
        name: 'IRA 72(t)',
        accountId: 'ira-1',
        method: 'fixedAmortization',
        startYear: 2026,
        rate: 0.05,
        stopYear: 2032,
        disabled: true,
      },
    ]);

    expect((field('Start year') as HTMLInputElement).value).toBe('2026');
    // A decimal rate is shown as a percentage: 0.05 → 5.
    expect((field('Rate %') as HTMLInputElement).value).toBe('5');
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));

    expect(payload().sepp).toStrictEqual([
      {
        id: 'sepp-1',
        name: 'IRA 72(t)',
        accountId: 'ira-1',
        method: 'fixedAmortization',
        startYear: 2026,
        rate: 0.05,
        stopYear: 2032,
        disabled: true,
      },
    ]);
  });
});

describe('the fixed-method rate window', () => {
  it('refuses a start year the vendored rates cannot price, and names the covered range', async () => {
    // Today's tables stop at 2026-11, which prices a first January in 2022–2026. Pinned here so a
    // change to NEWEST_MID_TERM_RATE_MONTH says so instead of quietly widening the rule.
    expect(UNPRICED_START_YEAR).toBe(2027);

    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    const startYear = field('Start year') as HTMLInputElement;
    fireEvent.change(startYear, { target: { value: String(UNPRICED_START_YEAR) } });

    // The `max` the row carries is what blocks the natural action: the browser refuses to submit a
    // number past it. (jsdom models constraint validation, the same way it fires `onSubmit` for a
    // form the browser would refuse.)
    expect(startYear.validity.rangeOverflow).toBe(true);
    save();
    expect(updateSepp).not.toHaveBeenCalled();

    // A submit that bypasses native validation — a programmatic form submit, a browser without
    // constraint checking, `noValidate` — still cannot write the plan, and says why.
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    // The mutation is never reached: the engine would throw while rendering, and the save would
    // already have committed, leaving a plan that cannot be opened.
    expect(updateSepp).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Fixed amortization can only start in 2022–2026');
    expect(alert.textContent).toContain('2027 has no rate to price from');
    expect(alert.textContent).toContain('Use the required-minimum-distribution method');
    // And which row it is about, so the reader knows what to change.
    expect(alert.textContent).toContain('Schedule 1 — Traditional IRA');
  });

  it('never refuses the RMD method, which reads no rate', async () => {
    renderDialog();

    addRow();
    // Past the last vendored month by years: `rmd` divides the balance by the Single Life Table
    // period and never prices an interest rate, so there is nothing to be unpriceable.
    fireEvent.change(field('Start year'), { target: { value: '2030' } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));
    expect(payload().sepp[0]).toMatchObject({ method: 'rmd', startYear: 2030 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('bounds the start year so the natural action cannot name an unpriceable year', () => {
    renderDialog();

    addRow();
    const startYear = field('Start year') as HTMLInputElement;

    // A schedule starts as RMD: only the schema's own bounds apply.
    expect([startYear.min, startYear.max]).toStrictEqual(['1900', '2200']);

    fireEvent.change(select('Method'), { target: { value: 'fixedAnnuitization' } });
    const { earliestStartYear, latestStartYear } = seppFixedRateCoverage();

    expect([startYear.min, startYear.max]).toStrictEqual([String(earliestStartYear), String(latestStartYear)]);
  });
});

/**
 * The Notice 2022-6 cap a fixed method's rate has to stay under, as the vendored rates state it.
 *
 * 2024 is the interesting start year: its window is 2023-12 (4.82 %) and 2023-11 (4.69 %), so the cap
 * is 120 % of 4.82 % = 5.784 %, above the statute's 5 % floor. 2026's window is 3.79 % and 3.83 %,
 * which the floor lifts to exactly 5 %. That pair is what proves the rule reads the data: the same
 * 5.5 % is inside one cap and outside the other.
 */
describe('the fixed-method rate cap', () => {
  const CAP_ABOVE_FLOOR_YEAR = 2024;
  const FLOOR_CAP_YEAR = 2026;
  const capAboveFloor = seppRateCapForStartYear(CAP_ABOVE_FLOOR_YEAR)?.maximumRate ?? Number.NaN;

  it('derives a cap per start year from the vendored mid-term rates, not from the 5% floor', () => {
    const { earliestStartYear, latestStartYear } = seppFixedRateCoverage();
    const years = Array.from({ length: latestStartYear - earliestStartYear + 1 }, (_, offset) => earliestStartYear + offset);
    const caps = years.map((year) => Number(((seppRateCapForStartYear(year)?.maximumRate ?? Number.NaN) * 100).toFixed(3)));

    // Pinned, so advancing the vendored months moves this file with it instead of silently moving
    // the boundary. 2023, 2024 and 2025 are all above 5 %, which a constant cap could not produce.
    expect(years).toStrictEqual([2022, 2023, 2024, 2025, 2026]);
    expect(caps).toStrictEqual([5, 5.124, 5.784, 5.016, 5]);
    // And the month the winning cap came from, so the message can name it.
    expect(seppRateCapForStartYear(CAP_ABOVE_FLOOR_YEAR)?.governingMonth).toBe('2023-12');
    expect(seppRateCapForStartYear(CAP_ABOVE_FLOOR_YEAR)?.governingMidTermRate).toBe(0.0482);
    // No vendored window, no cap to state — never a cap of zero.
    expect(seppRateCapForStartYear(UNPRICED_START_YEAR)).toBeNull();
  });

  it('accepts a rate exactly at the computed cap', async () => {
    expect(capAboveFloor).toBeCloseTo(0.05784, 12);

    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Start year'), { target: { value: String(CAP_ABOVE_FLOOR_YEAR) } });
    const rate = field('Rate %') as HTMLInputElement;
    // The 5.784 the field shows for 0.057839999999999996, which is the highest entry the engine's
    // own `rate > maximumRate` comparison allows.
    fireEvent.change(rate, { target: { value: String(capAboveFloor * 100) } });
    expect(rate.validity.rangeOverflow).toBe(false);
    save();

    // The cap itself survives the round trip through the percentage field as the same decimal, so
    // the guard is `>`, not `>=` — a cap nudged under by the conversion would be off by an epsilon.
    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));
    expect(payload().sepp[0]).toMatchObject({ startYear: CAP_ABOVE_FLOOR_YEAR, rate: capAboveFloor });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a rate above the cap, names the cap and the month it came from, and writes nothing', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Start year'), { target: { value: String(CAP_ABOVE_FLOOR_YEAR) } });
    const rate = field('Rate %') as HTMLInputElement;
    fireEvent.change(rate, { target: { value: '6' } });

    // The row's `max` is the same number, so the natural action cannot produce the value …
    expect(rate.validity.rangeOverflow).toBe(true);
    save();
    expect(updateSepp).not.toHaveBeenCalled();

    // … and a submit that bypasses native validation is refused by the shared rule, before the write.
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    // The mutation is never reached: the engine would throw on this rate while rendering, and the
    // save would already have committed, leaving a plan that cannot be opened.
    expect(updateSepp).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('A rate of 6% is above the Notice 2022-6 maximum for a 2024 start (5.78%)');
    expect(alert.textContent).toContain('the 2023-12 rate is 4.82%');
    expect(alert.textContent).toContain('Enter a rate at or below 5.78%, or leave it blank to use the maximum.');
    // And which row it is about, so the reader knows what to change.
    expect(alert.textContent).toContain('Schedule 1 — Traditional IRA');
  });

  it('accepts 5.5% for a start year whose cap is above the 5% floor', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Start year'), { target: { value: String(CAP_ABOVE_FLOOR_YEAR) } });
    fireEvent.change(field('Rate %'), { target: { value: '5.5' } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));
    expect(payload().sepp[0]).toMatchObject({ startYear: CAP_ABOVE_FLOOR_YEAR, rate: 0.055 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses the same 5.5% for a start year whose cap is the 5% floor', async () => {
    expect(seppRateCapForStartYear(FLOOR_CAP_YEAR)?.maximumRate).toBe(0.05);

    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAnnuitization' } });
    fireEvent.change(field('Start year'), { target: { value: String(FLOOR_CAP_YEAR) } });
    fireEvent.change(field('Rate %'), { target: { value: '5.5' } });
    save();
    expect(updateSepp).not.toHaveBeenCalled();

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    expect(updateSepp).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('A rate of 5.5% is above the Notice 2022-6 maximum for a 2026 start (5.00%)');
  });

  it('never suggests a figure its own guard would refuse, so the message is a usable instruction', async () => {
    // 2025's cap is 1.2 × 4.18 % = 5.015999… %. Printed with `toFixed(2)` that would read 5.02 %, and
    // a reader who retyped the message's own number would hand the guard 0.0502 > the cap and be
    // refused by the sentence that told them to. So the suggestion is replayed from the rendered
    // alert into the field, which is the only way to check the message and the rule agree.
    const cap = seppRateCapForStartYear(2025)?.maximumRate ?? Number.NaN;
    expect(cap).toBeCloseTo(0.05016, 12);

    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Start year'), { target: { value: '2025' } });
    fireEvent.change(field('Rate %'), { target: { value: '6' } });
    save();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(updateSepp).not.toHaveBeenCalled();

    const message = screen.getByRole('alert').textContent ?? '';
    const suggested = /at or below ([0-9.]+)%/.exec(message)?.[1] ?? '';
    expect(suggested).not.toBe('');
    expect(Number(suggested) / 100).toBeLessThanOrEqual(cap);

    fireEvent.change(field('Rate %'), { target: { value: suggested } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));
    expect(payload().sepp[0]).toMatchObject({ startYear: 2025, rate: Number(suggested) / 100 });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('fractional values', () => {
  it('declares `step="any"` on the rate and the annual amount', () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });

    // Native `<input type="number">` defaults to step 1, which makes 4.5 a stepMismatch: the browser
    // blocks the submit before `onSubmit` and nothing is reported. jsdom does not model that, so the
    // attribute itself is the assertion.
    expect((field('Rate %') as HTMLInputElement).step).toBe('any');
    expect((field('Annual amount') as HTMLInputElement).step).toBe('any');
  });

  it('saves a fractional rate and a fractional amount unchanged', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Method'), { target: { value: 'fixedAmortization' } });
    fireEvent.change(field('Rate %'), { target: { value: '4.5' } });
    fireEvent.change(field('Annual amount'), { target: { value: '25000.75' } });
    save();

    await waitFor(() => expect(updateSepp).toHaveBeenCalledTimes(1));
    expect(payload().sepp[0]).toMatchObject({ rate: 0.045, annualAmount: 25_000.75 });
  });
});

describe('row identity', () => {
  it('names every row, so its identically-named controls belong to a known schedule', () => {
    render(
      <Dialog open onClose={() => {}}>
        <SeppDialog
          onClose={onClose}
          accounts={TWO_IRAS}
          sepp={[
            { id: 'sepp-1', name: 'IRA 72(t)', accountId: 'ira-1', method: 'rmd', startYear: 2026 },
            // No name: the account identifies it, which is what a blank row falls back to.
            { id: 'sepp-2', accountId: 'ira-2', method: 'rmd', startYear: 2026 },
          ]}
        />
      </Dialog>
    );

    const named = screen.getByRole('group', { name: 'Schedule 1 — IRA 72(t)' });
    const byAccount = screen.getByRole('group', { name: 'Schedule 2 — Rollover IRA' });

    // Each row owns exactly one of each control, so a screen reader reading "Name" knows the row.
    for (const label of ['Name', 'Account', 'Method', 'Start year', 'Annual amount', 'Stop year']) {
      expect(within(named).getByLabelText(label, { selector: 'input, select' })).toBeTruthy();
      expect(within(byAccount).getByLabelText(label, { selector: 'input, select' })).toBeTruthy();
    }

    // The remove buttons are distinguishable too — they used to read "Remove schedule" apiece.
    expect(screen.getByRole('button', { name: 'Remove Schedule 1 — IRA 72(t)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Schedule 2 — Rollover IRA' })).toBeTruthy();
  });

  it('falls back to the position when the row has neither a name nor a known account', () => {
    renderDialog([{ id: 'sepp-1', accountId: 'closed-account', method: 'rmd', startYear: 2026 }]);

    expect(screen.getByRole('group', { name: 'Schedule 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Schedule 1' })).toBeTruthy();
  });
});

describe('the dialog accessible description', () => {
  it('is not the whole help text', () => {
    renderDialog([
      { id: 'sepp-1', accountId: 'ira-1', method: 'fixedAmortization', startYear: 2026, rate: 0.05 },
      { id: 'sepp-2', accountId: 'ira-1', method: 'fixedAnnuitization', startYear: 2026, rate: 0.05 },
      { id: 'sepp-3', accountId: 'ira-1', method: 'rmd', startYear: 2026 },
    ]);

    const dialog = screen.getByRole('dialog');
    const description = (dialog.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    // Measured before the fix: 4,249 characters with three fixed-method rows and 3,547 with three
    // RMD rows, because seven `<Description>` elements with no `<Field>` ancestor registered into
    // this Dialog's description registry. Body copy is now a `<Text>`; 0 remain.
    expect(description).not.toContain('Substantially equal periodic payments');
    expect(description).not.toContain('An annual amount overrides');
    expect(description.length).toBeLessThan(600);
  });
});
