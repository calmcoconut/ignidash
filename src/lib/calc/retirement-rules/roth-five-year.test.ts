import { describe, expect, it } from 'vitest';

import {
  ROTH_FIRST_TIME_HOMEBUYER_LIMIT,
  hasMetRothFiveYearRule,
  rothFiveYearPeriodEnd,
  rothFiveYearPeriodStart,
  rothWithdrawalTreatment,
  type RothEvent,
} from './roth-five-year';

/**
 * Roth five-year clocks (IRC §408A(d)).
 *
 * Two clocks: the qualification clock starts 1 January of the first Roth year and ends 31 December
 * of the fifth year (so a 2015 account is "five-year" from 2020-01-01), and each conversion runs its
 * own five years for the 10 % §72(t) tax. Ordering is contributions → conversions (FIFO) → earnings.
 */

const contribution = (date: string, amount: number): RothEvent => ({ date, kind: 'contribution', amount });
const conversion = (date: string, amount: number): RothEvent => ({ date, kind: 'conversion', amount });

describe('the qualification clock', () => {
  it('starts on 1 January of the first Roth year and ends five years later', () => {
    // Earliest event 2015-01-15 → period 2015-01-01 … 2019-12-31.
    const events = [contribution('2015-01-15', 5_000)];

    expect(rothFiveYearPeriodStart(events)).toBe('2015-01-01');
    expect(rothFiveYearPeriodEnd('2015-01-01')).toBe('2019-12-31');

    // The last day of the fifth year is still inside the period; the next day is not.
    expect(hasMetRothFiveYearRule(events, '2019-12-31')).toBe(false);
    expect(hasMetRothFiveYearRule(events, '2020-01-01')).toBe(true);
  });

  it('counts a conversion as starting the clock', () => {
    // A conversion in 2019 with no contributions: the clock starts 2019-01-01, ends 2023-12-31.
    const events = [conversion('2019-11-20', 50_000)];

    expect(rothFiveYearPeriodStart(events)).toBe('2019-01-01');
    expect(hasMetRothFiveYearRule(events, '2023-12-31')).toBe(false);
    expect(hasMetRothFiveYearRule(events, '2024-01-02')).toBe(true);
  });

  it('uses the earliest year, whatever order the events arrive in', () => {
    const events = [conversion('2019-06-01', 10_000), contribution('2015-02-01', 1_000)];

    expect(rothFiveYearPeriodStart(events)).toBe('2015-01-01');
  });

  it('has no clock at all with no events', () => {
    expect(rothFiveYearPeriodStart([])).toBeNull();
    expect(hasMetRothFiveYearRule([], '2050-01-01')).toBe(false);
  });
});

describe('the ordering rule: contributions first, then conversions, then earnings', () => {
  // Contributions 2015-02-01 $30,000; conversion 2019-06-01 $20,000.
  const events = [contribution('2015-02-01', 30_000), conversion('2019-06-01', 20_000)];

  it('takes a withdrawal inside the contributions with no tax and no penalty', () => {
    // $25,000 of a $30,000 contribution base, at age 45: all of it is a return of basis.
    const result = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 45, amount: 25_000 });

    expect(result.contributionPortion).toBe(25_000);
    expect(result.conversionPortion).toBe(0);
    expect(result.earningsPortion).toBe(0);
    expect(result.taxableEarnings).toBe(0);
    expect(result.penaltyAmount).toBe(0);
  });

  it('then reaches converted dollars, which are tax-free but inside their own five years', () => {
    // $40,000 = $30,000 contributions + $10,000 of the 2019 conversion.
    // The conversion seasons on 2024-06-01, so on 2020-07-01 it is unseasoned.
    // Taxable: $0 (the conversion was already taxed). Penalty: 10 % × $10,000 = $1,000.
    const atFortyFive = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 45, amount: 40_000 });

    expect(atFortyFive.contributionPortion).toBe(30_000);
    expect(atFortyFive.conversionPortion).toBe(10_000);
    expect(atFortyFive.unseasonedConversionPortion).toBe(10_000);
    expect(atFortyFive.taxableEarnings).toBe(0);
    expect(atFortyFive.penaltyAmount).toBe(1_000);

    // At 60 the conversion clock no longer matters: no penalty on the same withdrawal.
    const atSixty = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 60, amount: 40_000 });
    expect(atSixty.penaltyAmount).toBe(0);
  });

  it('leaves a seasoned conversion alone', () => {
    // 2024-06-02 is after the 2024-06-01 seasoning date, so the converted dollars are free at 45.
    const result = rothWithdrawalTreatment({ events, withdrawalDate: '2024-06-02', age: 50, amount: 40_000 });

    expect(result.conversionPortion).toBe(10_000);
    expect(result.unseasonedConversionPortion).toBe(0);
    expect(result.penaltyAmount).toBe(0);
  });
});

describe('earnings and the qualified-distribution test', () => {
  // One $10,000 contribution in 2015: clock met from 2020-01-01, $0 of conversions.
  const events = [contribution('2015-02-01', 10_000)];

  it('taxes and penalises earnings before 59½', () => {
    // $25,000 = $10,000 contributions + $15,000 earnings, age 45, clock met but no qualifying event
    // → earnings taxable $15,000 → 10 % penalty = $1,500.
    const result = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 45, amount: 25_000 });

    expect(result.earningsPortion).toBe(15_000);
    expect(result.fiveYearPeriodMet).toBe(true);
    expect(result.taxableEarnings).toBe(15_000);
    expect(result.penaltyAmount).toBe(1_500);
  });

  it('makes earnings free at 59½, on death, and on disability', () => {
    const atSixty = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 60, amount: 25_000 });
    expect(atSixty.taxableEarnings).toBe(0);
    expect(atSixty.penaltyAmount).toBe(0);

    for (const reason of ['death', 'disability'] as const) {
      const result = rothWithdrawalTreatment({ events, withdrawalDate: '2020-07-01', age: 45, amount: 25_000, reason });
      expect(result.taxableEarnings).toBe(0);
      expect(result.penaltyAmount).toBe(0);
    }
  });

  it('taxes earnings before the clock has run, whatever the reason', () => {
    // Contribution 2022-02-01 → clock ends 2026-12-31; a 2024 withdrawal is inside it.
    const young = [contribution('2022-02-01', 10_000)];
    const result = rothWithdrawalTreatment({ events: young, withdrawalDate: '2024-07-01', age: 60, amount: 25_000 });

    expect(result.fiveYearPeriodMet).toBe(false);
    expect(result.taxableEarnings).toBe(15_000);
    expect(result.penaltyAmount).toBe(1_500);
  });
});

describe('the first-time-homebuyer exception', () => {
  const events = [contribution('2015-02-01', 10_000)];

  it('exempts up to $10,000 of earnings once the clock has run', () => {
    // $25,000 = $10,000 contributions + $15,000 earnings; the lifetime cap exempts $10,000,
    // leaving $5,000 taxable and a $500 penalty.
    const result = rothWithdrawalTreatment({
      events,
      withdrawalDate: '2020-07-01',
      age: 35,
      amount: 25_000,
      reason: 'firstTimeHomebuyer',
    });

    expect(ROTH_FIRST_TIME_HOMEBUYER_LIMIT).toBe(10_000);
    expect(result.homebuyerExemptEarnings).toBe(10_000);
    expect(result.taxableEarnings).toBe(5_000);
    expect(result.penaltyAmount).toBe(500);
  });

  it('shares one lifetime cap across withdrawals', () => {
    // $4,000 already used leaves $6,000 of room: earnings $15,000 − $6,000 = $9,000 taxable.
    const partlyUsed = rothWithdrawalTreatment({
      events,
      withdrawalDate: '2020-07-01',
      age: 35,
      amount: 25_000,
      reason: 'firstTimeHomebuyer',
      homebuyerLifetimeUsed: 4_000,
    });
    expect(partlyUsed.homebuyerExemptEarnings).toBe(6_000);
    expect(partlyUsed.taxableEarnings).toBe(9_000);
    expect(partlyUsed.penaltyAmount).toBe(900);

    // Fully used: no exemption left, so the whole $15,000 of earnings is taxable.
    const exhausted = rothWithdrawalTreatment({
      events,
      withdrawalDate: '2020-07-01',
      age: 35,
      amount: 25_000,
      reason: 'firstTimeHomebuyer',
      homebuyerLifetimeUsed: 10_000,
    });
    expect(exhausted.homebuyerExemptEarnings).toBe(0);
    expect(exhausted.taxableEarnings).toBe(15_000);
    expect(exhausted.penaltyAmount).toBe(1_500);
  });

  it('does not apply before the five-year clock has run', () => {
    const young = [contribution('2022-02-01', 10_000)];
    const result = rothWithdrawalTreatment({
      events: young,
      withdrawalDate: '2024-07-01',
      age: 35,
      amount: 25_000,
      reason: 'firstTimeHomebuyer',
    });

    expect(result.homebuyerExemptEarnings).toBe(0);
    expect(result.taxableEarnings).toBe(15_000);
    expect(result.penaltyAmount).toBe(1_500);
  });
});
