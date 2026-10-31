// @vitest-environment jsdom
/**
 * The Roth conversion editor (parity plan P3-P5).
 *
 * The dialog owns the whole list and saves it in one mutation, so what matters most is the payload:
 * a fixed-amount row has to arrive with its `year` and `amount`, a fill-to-bracket row with its nested
 * `{ targetBracketRate, jurisdiction }`, and a time-point row with its `timePoint` instead of a year —
 * and none of them may carry the field belonging to the other shape. All of that is asserted on the
 * mutation argument rather than on the DOM.
 *
 * The rest is the part that matters more than tidiness: a conversion naming an account the plan no
 * longer has makes the simulation `throw` (`portfolio.ts`), that throw happens during render, and
 * nothing above it catches. So the save must be refused before the mutation, with the row named —
 * which is what the last block asserts, by rendering a stored schedule whose source account is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { updateConversions, onClose } = vi.hoisted(() => ({ updateConversions: vi.fn(), onClose: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => updateConversions }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));

import { Dialog } from '@/components/catalyst/dialog';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import type { ConversionInputs } from '@/lib/schemas/inputs/conversion-form-schema';
import ConversionDialog from './conversion-dialog';

/** One account of each kind the editor cares about: tax-deferred, Roth, and neither. */
const ACCOUNTS: AccountInputs[] = [
  { id: 'ira-1', name: 'Traditional IRA', type: 'ira', balance: 500_000, percentBonds: 0 },
  { id: 'roth-1', name: 'Roth IRA', type: 'rothIra', balance: 100_000, percentBonds: 0, contributionBasis: 50_000 },
  { id: 'brokerage-1', name: 'Brokerage', type: 'taxableBrokerage', balance: 50_000, percentBonds: 0, costBasis: 40_000 },
];

/** Two tax-deferred accounts, so a row's identity can fall back to the account pair. */
const TWO_IRAS: AccountInputs[] = [...ACCOUNTS, { id: 'ira-2', name: 'Rollover IRA', type: 'ira', balance: 250_000, percentBonds: 0 }];

/** The dialog is mounted inside Headless UI's Dialog in the app; its title needs that parent. */
const renderDialog = (conversions: ConversionInputs[] = [], accounts: AccountInputs[] = ACCOUNTS) =>
  render(
    <Dialog open onClose={() => {}}>
      <ConversionDialog onClose={onClose} conversions={conversions} accounts={accounts} />
    </Dialog>
  );

const addRow = () => fireEvent.click(screen.getByRole('button', { name: 'Conversion' }));
const field = (name: string) => screen.getByLabelText(name, { selector: 'input' });
const select = (name: string) => screen.getByLabelText(name, { selector: 'select' });

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

const payload = () => {
  const [call] = updateConversions.mock.calls.at(-1) as [{ planId: string; conversions: Record<string, unknown>[] }];

  return call;
};

beforeEach(() => {
  updateConversions.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Roth conversion editor', () => {
  it('sends a fixed-amount row to the mutation with its year and amount', async () => {
    renderDialog();

    addRow();
    // A new row starts on the two accounts a conversion has to have, timed by a calendar year.
    expect((select('From') as HTMLSelectElement).value).toBe('ira-1');
    expect((select('To') as HTMLSelectElement).value).toBe('roth-1');

    fireEvent.change(field('Year'), { target: { value: '2031' } });
    fireEvent.change(field('Amount'), { target: { value: '40000' } });
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));

    expect(payload().planId).toBe('plan-1');
    expect(payload().conversions).toStrictEqual([
      {
        id: expect.any(String),
        fromAccountId: 'ira-1',
        toAccountId: 'roth-1',
        year: 2031,
        amount: 40_000,
      },
    ]);
    // A blank name is absent, not `''`, and the row carries no `timePoint` beside its year.
    expect(payload().conversions[0]).not.toHaveProperty('name');
    expect(payload().conversions[0]).not.toHaveProperty('timePoint');
    expect(onClose).toHaveBeenCalled();
  });

  it('sends a fill-to-bracket row with its rate and jurisdiction, and no amount', async () => {
    renderDialog();

    addRow();
    fireEvent.change(select('Target'), { target: { value: 'fillToBracket' } });
    // The California ladder is not the federal one, so the bracket set is chosen first: 9.3% is a
    // California bracket and 22% is not, which is the fact the shared rule checks.
    fireEvent.change(select('Bracket set'), { target: { value: 'california' } });
    fireEvent.change(select('Bracket'), { target: { value: '0.093' } });
    fireEvent.change(field('Year'), { target: { value: '2031' } });
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));

    expect(payload().conversions).toStrictEqual([
      {
        id: expect.any(String),
        fromAccountId: 'ira-1',
        toAccountId: 'roth-1',
        year: 2031,
        fillToBracket: { targetBracketRate: 0.093, jurisdiction: 'california' },
      },
    ]);
    expect(payload().conversions[0]).not.toHaveProperty('amount');
  });

  it('sends the timing union: one row on a year and one on a time point', async () => {
    renderDialog();

    addRow();
    fireEvent.change(field('Year'), { target: { value: '2031' } });
    fireEvent.change(field('Amount'), { target: { value: '40000' } });

    addRow();
    // Two rows now, so the second one's controls are reached by position rather than by name.
    const timingSelects = screen.getAllByLabelText('When', { selector: 'select' });
    fireEvent.change(timingSelects[1], { target: { value: 'atRetirement' } });
    const amounts = screen.getAllByLabelText('Amount', { selector: 'input' });
    fireEvent.change(amounts[1], { target: { value: '25000' } });
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));

    const [first, second] = payload().conversions;
    expect(first).toMatchObject({ year: 2031, amount: 40_000 });
    expect(first).not.toHaveProperty('timePoint');
    // The year input disappears with the timing, and the row is written as a time point instead.
    expect(second).toMatchObject({ timePoint: { type: 'atRetirement' }, amount: 25_000 });
    expect(second).not.toHaveProperty('year');
  });

  it('offers only tax-deferred sources and only Roth destinations', () => {
    renderDialog();

    addRow();

    const options = (name: string) => Array.from(select(name).querySelectorAll('option')).map((option) => option.textContent);

    // The taxable brokerage is neither, so neither select offers it.
    expect(options('From')).toStrictEqual(['Traditional IRA (IRA)']);
    expect(options('To')).toStrictEqual(['Roth IRA (Roth IRA)']);
  });

  it('loads a stored schedule into the form and saves it back unchanged', async () => {
    renderDialog(
      [
        { id: 'conversion-1', name: 'Fill the band', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031, amount: 40_000 },
        // A stored custom date is shown under "In a calendar year" — the engine compares the same one
        // year either way — but written back in its own union member rather than rewritten as `year`.
        {
          id: 'conversion-2',
          fromAccountId: 'ira-2',
          toAccountId: 'roth-1',
          timePoint: { type: 'customDate', month: 1, year: 2033 },
          amount: 25_000.75,
        },
      ],
      TWO_IRAS
    );

    expect((screen.getAllByLabelText('Year', { selector: 'input' })[0] as HTMLInputElement).value).toBe('2031');
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));

    expect(payload().conversions).toStrictEqual([
      { id: 'conversion-1', name: 'Fill the band', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031, amount: 40_000 },
      {
        id: 'conversion-2',
        fromAccountId: 'ira-2',
        toAccountId: 'roth-1',
        timePoint: { type: 'customDate', month: 1, year: 2033 },
        amount: 25_000.75,
      },
    ]);
  });
});

/**
 * The plan-bricking class, which this repository has shipped twice.
 *
 * `processConversions` (`src/lib/calc/portfolio.ts`) throws `Conversion <id>: source account <id> not
 * found`, and the `fillToBracket` block in `simulation-engine.ts` throws the same pair. Both run
 * inside `simulate()`, which the simulator calls during render, and there is no error boundary in
 * `src/app` — so a plan that commits such a row can never be painted again, and this dialog is inside
 * the tree that fails. The save has to be refused before the mutation, while the plan still loads.
 */
describe('the plan-bricking guard', () => {
  it('refuses a conversion whose source account no longer exists, and writes nothing', async () => {
    renderDialog([{ id: 'conversion-1', fromAccountId: 'closed-account', toAccountId: 'roth-1', year: 2031, amount: 40_000 }]);

    save();
    expect(updateConversions).not.toHaveBeenCalled();

    // A submit that bypasses native validation still cannot write the plan.
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    expect(updateConversions).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('closed-account');
    expect(alert.textContent).toContain('and this plan has no such account');
    expect(alert.textContent).toContain('source account … not found');
    // And which row it is about, so the reader knows what to change.
    expect(alert.textContent).toContain('Conversion 1');
  });

  it('refuses a conversion whose destination account no longer exists', async () => {
    renderDialog([{ id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'closed-account', year: 2031, amount: 40_000 }]);

    save();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    expect(updateConversions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('as its destination account, and this plan has no such account');
  });

  it('refuses a destination that is not a Roth account, which the engine would silently accept', async () => {
    // The engine moves the money into any account; a taxable destination would be taxed on the way in
    // and still grow as a taxable account, so nothing throws and nothing looks wrong.
    renderDialog([{ id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'brokerage-1', year: 2031, amount: 40_000 }]);

    save();
    expect(updateConversions).not.toHaveBeenCalled();

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(updateConversions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('which is a Taxable, not a Roth account');
  });

  it('names a source that is not tax-deferred rather than converting it', async () => {
    renderDialog([{ id: 'conversion-1', fromAccountId: 'brokerage-1', toAccountId: 'roth-1', year: 2031, amount: 40_000 }]);

    save();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    expect(updateConversions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('which is a Taxable, not a tax-deferred account');
  });

  it('refuses a life-expectancy row the conversion filter has no branch for', async () => {
    renderDialog([
      { id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'roth-1', timePoint: { type: 'atLifeExpectancy' }, amount: 40_000 },
    ]);

    // The stored timing is shown, labelled, so the row can be seen and changed...
    const timing = select('When') as HTMLSelectElement;
    expect(timing.value).toBe('atLifeExpectancy');
    expect(Array.from(timing.options).map((option) => option.value)).toContain('atLifeExpectancy');
    expect(timing.selectedOptions[0].textContent).toContain('not honoured');

    save();
    expect(updateConversions).not.toHaveBeenCalled();

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(updateConversions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('never honours');

    // Changing the timing to a branch the engine reads makes the same row savable.
    fireEvent.change(timing, { target: { value: 'atRetirement' } });
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));
    expect(payload().conversions[0]).toMatchObject({ timePoint: { type: 'atRetirement' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a stored bracket rate that is not a bracket, and shows the rate it holds', async () => {
    // A hand-edited plan can carry any rate. The engine does not throw on it — it fits the amount to
    // the nearest bracket — so the editor is where the substitution is refused and named.
    renderDialog([
      { id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031, fillToBracket: { targetBracketRate: 0.5 } },
    ]);

    const bracket = select('Bracket') as HTMLSelectElement;
    expect(bracket.value).toBe('0.5');
    expect(bracket.selectedOptions[0].textContent).toContain('not a bracket here');

    save();
    expect(updateConversions).not.toHaveBeenCalled();

    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(updateConversions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('there is no 50% federal bracket');
    expect(screen.getByRole('alert').textContent).toContain('the nearest bracket (37%)');
  });

  it('refuses a blank amount with the schema error rather than writing zero', async () => {
    renderDialog();

    addRow();
    fireEvent.change(field('Year'), { target: { value: '2031' } });
    save();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);

    expect(updateConversions).not.toHaveBeenCalled();
    // The union's own message is a bare "Invalid input"; the alert names the field instead.
    expect(screen.getByRole('alert').textContent).toContain('0.amount: Invalid input: expected number, received NaN');
  });

  it('says nothing about the row while it is still savable', async () => {
    renderDialog();

    addRow();
    fireEvent.change(field('Year'), { target: { value: '2031' } });
    fireEvent.change(field('Amount'), { target: { value: '40000' } });
    save();

    await waitFor(() => expect(updateConversions).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('row identity', () => {
  it('names every row, so its identically-named controls belong to a known conversion', () => {
    render(
      <Dialog open onClose={() => {}}>
        <ConversionDialog
          onClose={onClose}
          accounts={TWO_IRAS}
          conversions={[
            { id: 'conversion-1', name: 'Convert 40k', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031, amount: 40_000 },
            // No name: the account pair identifies it, which is what a blank row falls back to.
            { id: 'conversion-2', fromAccountId: 'ira-2', toAccountId: 'roth-1', year: 2031, amount: 25_000 },
          ]}
        />
      </Dialog>
    );

    const named = screen.getByRole('group', { name: 'Conversion 1 — Convert 40k' });
    const byAccounts = screen.getByRole('group', { name: 'Conversion 2 — Rollover IRA → Roth IRA' });

    for (const label of ['Name', 'From', 'To', 'When', 'Year', 'Target', 'Amount']) {
      expect(within(named).getByLabelText(label, { selector: 'input, select' })).toBeTruthy();
      expect(within(byAccounts).getByLabelText(label, { selector: 'input, select' })).toBeTruthy();
    }

    // The remove buttons are distinguishable too — they used to read "Remove conversion" apiece.
    expect(screen.getByRole('button', { name: 'Remove Conversion 1 — Convert 40k' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Conversion 2 — Rollover IRA → Roth IRA' })).toBeTruthy();
  });

  it('falls back to the position when the row has neither a name nor known accounts', () => {
    renderDialog([{ id: 'conversion-1', fromAccountId: 'closed-account', toAccountId: 'closed-account-2', year: 2031, amount: 1 }]);

    expect(screen.getByRole('group', { name: 'Conversion 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Conversion 1' })).toBeTruthy();
  });
});

describe('the dialog accessible description', () => {
  it('is not the whole help text', () => {
    renderDialog([
      { id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031, amount: 40_000 },
      { id: 'conversion-2', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2032, amount: 40_000 },
      { id: 'conversion-3', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2033, amount: 40_000 },
    ]);

    const dialog = screen.getByRole('dialog');
    const description = (dialog.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');

    // Body copy is a `<Text>`, not a `<Description>`: outside a `<Field>` Headless UI registers a
    // description into the nearest `Dialog`, which made seven SEPP hints the dialog's own description.
    expect(description).not.toContain('A Roth conversion moves money');
    expect(description).not.toContain('Fill up to a bracket');
    expect(description.length).toBeLessThan(600);
  });
});
