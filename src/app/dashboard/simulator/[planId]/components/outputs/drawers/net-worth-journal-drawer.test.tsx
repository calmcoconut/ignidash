// @vitest-environment jsdom
/**
 * The net-worth journal recording form (P4-P7).
 *
 * The date field takes a year, a year-month or a full date and resolves each to the END of the
 * period it names, so the entry says which day it covers. One field carries one precision: the
 * payload is exactly one of `2026`, `2026-09` or `2026-12-31` — never a year *and* a day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { createEntry, setOpen } = vi.hoisted(() => ({ createEntry: vi.fn(), setOpen: vi.fn() }));

vi.mock('convex/react', () => ({ useMutation: () => createEntry }));
vi.mock('@/hooks/use-selected-plan-id', () => ({ useSelectedPlanId: () => 'plan-1' }));
vi.mock('@/hooks/use-convex-data', () => ({
  useAccountsData: () => ({
    data: {
      savings: { id: 'savings', name: 'Savings', balance: 25_000 },
      brokerage: { id: 'brokerage', name: 'Brokerage', balance: 100_000 },
    },
    isLoading: false,
  }),
}));

import NetWorthJournalDrawer from './net-worth-journal-drawer';

const dateInput = () => screen.getByLabelText('Date', { selector: 'input' });
const balanceInput = (accountId: string) => screen.getByLabelText(accountId === 'savings' ? 'Savings' : 'Brokerage', { selector: 'input' });

const record = async (date: string, balances: Record<string, string> = { savings: '125000' }) => {
  fireEvent.change(dateInput(), { target: { value: date } });
  for (const [accountId, amount] of Object.entries(balances)) {
    fireEvent.change(balanceInput(accountId), { target: { value: amount } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Record entry' }));
};

beforeEach(() => {
  createEntry.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the date field', () => {
  it('resolves a year to 31 December and says so before saving', () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(dateInput(), { target: { value: '2026' } });

    expect(screen.getByText('Recorded as the end of that period: 2026-12-31.')).toBeTruthy();
  });

  it('resolves a year and month to that month`s last day', () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(dateInput(), { target: { value: '2026-09' } });

    expect(screen.getByText('Recorded as the end of that period: 2026-09-30.')).toBeTruthy();
  });

  it('keeps a full date as typed', () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(dateInput(), { target: { value: '2026-12-31' } });

    expect(screen.getByText('Recorded as the end of that period: 2026-12-31.')).toBeTruthy();
  });

  it('reports an impossible date instead of resolving it', () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(dateInput(), { target: { value: '2026-02-30' } });

    expect(screen.getByText(/not a real calendar date/)).toBeTruthy();
    expect(screen.queryByText(/Recorded as the end of that period/)).toBeNull();
  });
});

describe('the entry it submits', () => {
  it('stores a year at year precision', async () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    await record('2026');

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry).toHaveBeenCalledWith({ planId: 'plan-1', entry: { date: '2026', balances: { savings: 125_000 } } });
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it('stores a full date at day precision', async () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    await record('2026-12-31', { savings: '$125,000' });

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry).toHaveBeenCalledWith({ planId: 'plan-1', entry: { date: '2026-12-31', balances: { savings: 125_000 } } });
  });

  it('holds one precision at a time: typing a full date replaces the year, it does not merge with it', async () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(dateInput(), { target: { value: '2026' } });
    await record('2026-12-31');

    expect(dateInput()).toHaveProperty('value', '2026-12-31');
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    const { entry } = createEntry.mock.calls[0][0];
    expect(entry.date).toBe('2026-12-31');
    // `2026` and `2026-12-31` never travel together.
    expect(JSON.stringify(entry)).not.toContain('"date":"2026-12-31","date"');
  });

  it('omits an account left blank and keeps the one note it was given', async () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'after the bonus' } });
    await record('2026-09', { savings: '25000', brokerage: '' });

    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(createEntry.mock.calls[0][0].entry).toStrictEqual({ date: '2026-09', balances: { savings: 25000 }, note: 'after the bonus' });
  });
});

describe('when the entry cannot be recorded', () => {
  it('shows the problems and saves nothing', async () => {
    render(<NetWorthJournalDrawer setOpen={setOpen} />);

    await record('2026-02-30', { savings: '', brokerage: '' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not a real calendar date');
    expect(alert.textContent).toContain('Record a balance for at least one account.');
    expect(createEntry).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  });
});
