import { describe, expect, it } from 'vitest';

import { incomeTimeFrameForDisplay } from '../../../convex/validators/incomes_validator';
import { expenseTimeFrameForDisplay } from '../../../convex/validators/expenses_validator';

import { physicalAssetTimeFrameForDisplay, recurrenceForDisplay, timeFrameForDisplay } from './display-formatters';

/**
 * Cadence in the timeframe labels (parity plan P1-P1).
 *
 * Before this, a recurring event read exactly like a continuous one ("Age 45 → Retirement"),
 * so the only way to see a cadence was to open the dialog. The label now carries it, and the
 * un-cadenced strings are unchanged.
 */

describe('recurrenceForDisplay', () => {
  it('is null when the point does not repeat', () => {
    expect(recurrenceForDisplay({ type: 'now' })).toBeNull();
    expect(recurrenceForDisplay({ type: 'customAge', age: 45 })).toBeNull();
  });

  it('reads a cadence in years', () => {
    expect(recurrenceForDisplay({ type: 'customAge', age: 45, everyNYears: 5 })).toBe('every 5 yrs');
    expect(recurrenceForDisplay({ type: 'customAge', age: 45, everyNYears: 1 })).toBe('every year');
    expect(recurrenceForDisplay({ type: 'customDate', year: 2031, month: 9, everyNYears: 2 })).toBe('every 2 yrs');
  });
});

describe('timeFrameForDisplay', () => {
  it('leaves a continuous range unchanged', () => {
    expect(timeFrameForDisplay({ type: 'customAge', age: 45 }, { type: 'atRetirement' })).toBe('Age 45 → Retirement');
    expect(timeFrameForDisplay({ type: 'now' }, { type: 'atLifeExpectancy' })).toBe('Now → Life Expectancy');
    expect(timeFrameForDisplay({ type: 'customDate', year: 2031, month: 1 })).toBe('Jan 2031');
  });

  it('shows the cadence on the start of the range', () => {
    expect(timeFrameForDisplay({ type: 'customAge', age: 45, everyNYears: 5 }, { type: 'atRetirement' })).toBe(
      'Age 45 (every 5 yrs) → Retirement'
    );
    expect(timeFrameForDisplay({ type: 'customDate', year: 2031, month: 9, everyNYears: 2 }, { type: 'customAge', age: 60 })).toBe(
      'Sep 2031 (every 2 yrs) → Age 60'
    );
    // No end point (a debt's start date) still shows it.
    expect(timeFrameForDisplay({ type: 'customAge', age: 45, everyNYears: 10 })).toBe('Age 45 (every 10 yrs)');
  });
});

describe('physicalAssetTimeFrameForDisplay', () => {
  it('leaves a continuous asset unchanged', () => {
    expect(physicalAssetTimeFrameForDisplay({ type: 'now' }, { type: 'atLifeExpectancy' })).toBe('Already Owned → Never Sold');
  });

  it('shows the cadence on the purchase', () => {
    expect(physicalAssetTimeFrameForDisplay({ type: 'customAge', age: 50, everyNYears: 4 }, { type: 'atLifeExpectancy' })).toBe(
      'Age 50 (every 4 yrs) → Never Sold'
    );
  });
});

describe('the AI system prompt labels carry the cadence too', () => {
  it('income and expense labels match the UI wording', () => {
    expect(incomeTimeFrameForDisplay({ type: 'customAge', age: 45, everyNYears: 5 }, { type: 'atRetirement' })).toBe(
      'Age 45 (every 5 yrs) → Retirement'
    );
    expect(expenseTimeFrameForDisplay({ type: 'customDate', year: 2031, month: 9, everyNYears: 1 })).toBe('Sep 2031 (every year)');
  });

  it('leaves the un-cadenced labels unchanged', () => {
    expect(incomeTimeFrameForDisplay({ type: 'now' }, { type: 'atRetirement' })).toBe('Now → Retirement');
    expect(expenseTimeFrameForDisplay({ type: 'customAge', age: 40 })).toBe('Age 40');
  });
});
