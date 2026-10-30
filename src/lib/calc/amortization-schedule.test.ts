import { describe, expect, it } from 'vitest';

import { Debt } from './debts';
import { PhysicalAsset } from './physical-assets';
import { createDebtInput, createFinancedAssetInput } from './__tests__/test-utils';
import { estimatePayoffMonths } from '../utils/payoff-estimator-utils';
import { buildAmortizationSchedule, computeLoanPayment, monthlyInflationRate, monthlyRealRate } from './amortization-schedule';
import { TEST_TIME_BINDING_CONTEXT } from '@/lib/calc/__tests__/time-binding-context';

/**
 * Hand-worked arithmetic for P1-P5 ("schedule reconciles to the engine's payoff within $1").
 *
 * The engine's `Debt`/`PhysicalAsset` month loops are reproduced exactly as
 * `DebtsProcessor.process` / `PhysicalAssetsProcessor.process` call them, so the reconciliation
 * below runs against the real engine classes rather than a second transcription of the formula.
 */

const monthlyInflation = (annualPercent: number) => Math.pow(1 + annualPercent / 100, 1 / 12) - 1;

/** Runs the engine's `Debt` loop (same call order as `DebtsProcessor.process`). */
function engineDebt(balance: number, apr: number, monthlyPayment: number, annualInflationPercent: number, months = 1200) {
  const inflation = monthlyInflation(annualInflationPercent);
  const debt = new Debt(createDebtInput({ balance, apr, interestType: 'simple', monthlyPayment }), TEST_TIME_BINDING_CONTEXT);

  let count = 0;
  let interestTotal = 0;
  while (!debt.isPaidOff() && count < months) {
    const { monthlyPaymentDue, interest } = debt.getMonthlyPaymentInfo(inflation);
    interestTotal += interest;
    debt.applyPayment(monthlyPaymentDue, interest);
    debt.applyMonthlyInflation(inflation);
    count++;
  }

  return { months: count, interestTotal, balance: debt.getBalance() };
}

/** Runs the engine's `PhysicalAsset` loan loop (same call order as `PhysicalAssetsProcessor.process`). */
function engineAsset(loanBalance: number, apr: number, monthlyPayment: number, annualInflationPercent: number, months = 1200) {
  const inflation = monthlyInflation(annualInflationPercent);
  const asset = new PhysicalAsset(
    createFinancedAssetInput({ paymentMethod: { type: 'loan', downPayment: 80000, loanBalance, apr, monthlyPayment } }),
    TEST_TIME_BINDING_CONTEXT
  );

  let count = 0;
  let interestTotal = 0;
  while (!asset.isPaidOff() && count < months) {
    const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(inflation);
    interestTotal += interest;
    asset.applyLoanPayment(monthlyPaymentDue, interest);
    asset.applyMonthlyInflation(inflation);
    count++;
  }

  return { months: count, interestTotal, loanBalance: asset.getLoanBalance() };
}

describe('amortization schedule: the payments', () => {
  it('computes the 30-year payment and the first month by hand', () => {
    // $400,000 at 6.00% APR over 360 months, no inflation.
    //   monthly rate  r = 0.06 / 12 = 0.005
    //   payment      P = 400,000 × 0.005 / (1 − 1.005^−360)
    //                  = 2,000 / (1 − 0.16604129...)
    //                  = 2,000 / 0.83395871...
    //                  = 2,398.2021...
    //   month 1: interest = 400,000 × 0.005 = 2,000.00
    //            principal = 2,398.2021 − 2,000.00 = 398.2021
    //            balance   = 400,000 − 398.2021 = 399,601.7979
    const schedule = buildAmortizationSchedule({ principal: 400000, annualRatePercent: 6, termMonths: 360 });

    expect(schedule.payment).toBeCloseTo(2398.2021, 3);
    expect(monthlyRealRate(6, 0)).toBeCloseTo(0.005, 12);

    expect(schedule.rows).toHaveLength(360);
    expect(schedule.rows[0].payment).toBeCloseTo(2398.2021, 3);
    expect(schedule.rows[0].interest).toBeCloseTo(2000, 6);
    expect(schedule.rows[0].principal).toBeCloseTo(398.2021, 3);
    expect(schedule.rows[0].balance).toBeCloseTo(399601.7979, 3);

    // The last month's interest is on the last sliver of balance, so it is small.
    expect(schedule.rows[359].interest).toBeCloseTo(11.93, 2);
    expect(schedule.rows[359].balance).toBe(0);

    // 2,398.2021 × 360 = 863,352.76 paid, of which 463,352.76 is interest.
    expect(schedule.totalPaid).toBeCloseTo(863352.76, 1);
    expect(schedule.totalInterest).toBeCloseTo(463352.76, 1);

    // Nothing is lost: the principal repaid over the schedule is the loan.
    const principalRepaid = schedule.rows.reduce((sum, row) => sum + row.principal, 0);
    expect(principalRepaid).toBeCloseTo(400000, 6);
  });

  it('pays a zero-rate loan down in equal steps', () => {
    // $12,000 at 0% APR over 24 months: 12,000 / 24 = 500.00 a month, no interest at all.
    const schedule = buildAmortizationSchedule({ principal: 12000, annualRatePercent: 0, termMonths: 24 });

    expect(schedule.payment).toBe(500);
    expect(schedule.rows).toHaveLength(24);
    for (const row of schedule.rows) {
      expect(row.payment).toBe(500);
      expect(row.interest).toBe(0);
      expect(row.principal).toBe(500);
      expect(row.balance).toBe(12000 - 500 * row.month);
    }
    expect(schedule.rows[23].balance).toBe(0);
    expect(schedule.totalInterest).toBe(0);
    expect(schedule.totalPaid).toBe(12000);
  });

  it('handles a 0% APR with inflation, where the real rate is negative', () => {
    // With no interest but 3% inflation, the balance loses real value on its own:
    //   monthly inflation = 1.03^(1/12) − 1 = 0.0024663...
    //   real rate i = 1 / 1.0024663 − 1 = −0.0024602...
    //   payment = 12,000 × (1 + i) / 24 = 498.7699 (a little under 12,000 / 24)
    const schedule = buildAmortizationSchedule({ principal: 12000, annualRatePercent: 0, termMonths: 24, annualInflationPercent: 3 });

    expect(schedule.payment).toBeCloseTo(498.7699, 4);
    expect(schedule.rows).toHaveLength(24);
    expect(schedule.rows[23].balance).toBe(0);
    expect(schedule.totalInterest).toBeLessThan(0);
    expect(schedule.totalPaid).toBeLessThan(12000);
  });

  it('deflates the payment when inflation is above zero', () => {
    // Same loan with the plan's 3% inflation assumption: the engine charges the real rate
    //   i = (1 + 0.005) / 1.0024663 − 1 = 0.0025275
    // and deflates the payment every month, so the month-1 payment is 1,913.84 (a nominal payment
    // of 1,918.56 would clear the engine's loan early — see the reconciliation block).
    const schedule = buildAmortizationSchedule({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 3 });

    expect(schedule.payment).toBeCloseTo(1913.8416, 3);
    expect(schedule.monthlyRealRate).toBeCloseTo(0.0025275, 6);
    expect(schedule.rows[0].interest).toBeCloseTo(808.7989, 3); // 320,000 × 0.0025275
    expect(schedule.rows[1].payment).toBeCloseTo(schedule.payment / (1 + monthlyInflationRate(3)), 6);
    expect(schedule.rows[359].payment).toBeCloseTo(790.422, 3);
    expect(schedule.rows[359].balance).toBe(0);
  });

  it('rejects terms that are not a usable loan', () => {
    expect(() => buildAmortizationSchedule({ principal: 0, annualRatePercent: 6, termMonths: 360 })).toThrow(
      /principal must be greater than zero/
    );
    expect(() => computeLoanPayment({ principal: -5, annualRatePercent: 6, termMonths: 360 })).toThrow(
      /principal must be greater than zero/
    );
    expect(() => computeLoanPayment({ principal: 100000, annualRatePercent: -1, termMonths: 360 })).toThrow(/cannot be negative/);
    expect(() => computeLoanPayment({ principal: 100000, annualRatePercent: 6, termMonths: 0 })).toThrow(/positive whole number/);
    expect(() => computeLoanPayment({ principal: 100000, annualRatePercent: 6, termMonths: 12.5 })).toThrow(/positive whole number/);
    expect(() => computeLoanPayment({ principal: Number.NaN, annualRatePercent: 6, termMonths: 12 })).toThrow(/finite/);
    expect(() => computeLoanPayment({ principal: 100000, annualRatePercent: 6, termMonths: 12, annualInflationPercent: -100 })).toThrow(
      /greater than -100/
    );
  });
});

describe('amortization schedule: reconciliation with the engine', () => {
  it('clears the engine’s loan in exactly the term, within $1', () => {
    // The payment the schedule derives for a 30-year $320,000 loan at 6.00% with 3% inflation.
    const payment = computeLoanPayment({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 3 });
    const schedule = buildAmortizationSchedule({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 3 });

    const asset = engineAsset(320000, 6, payment, 3);
    const debt = engineDebt(320000, 6, payment, 3);

    // Both engine classes run the same number of months as the schedule has rows.
    expect(asset.months).toBe(360);
    expect(debt.months).toBe(360);
    expect(schedule.rows).toHaveLength(360);
    expect(asset.loanBalance).toBe(0);
    expect(debt.balance).toBe(0);

    // The row's tolerance: the loan is not cleared a month early, and is cleared by the last month.
    const afterOneMonthShort = engineAsset(320000, 6, payment, 3, 359);
    expect(afterOneMonthShort.loanBalance).toBeCloseTo(788.43, 2);
    expect(afterOneMonthShort.loanBalance).toBeGreaterThan(1);
    expect(engineAsset(320000, 6, payment, 3, 360).loanBalance).toBeLessThan(1);

    // And the interest the engine charges over the term is the schedule's interest.
    expect(Math.abs(asset.interestTotal - schedule.totalInterest)).toBeLessThan(1);
    expect(Math.abs(debt.interestTotal - schedule.totalInterest)).toBeLessThan(1);

    // The shipped payoff mirror used by the UI draws the same conclusion.
    expect(estimatePayoffMonths({ balance: 320000, monthlyPayment: payment, apr: 6, interestType: 'simple', annualInflationRate: 3 })).toBe(
      360
    );
  });

  it('shows why the textbook nominal payment does not reconcile', () => {
    // The familiar nominal payment for $320,000 at 6.00% over 30 years is 1,918.56. It assumes a
    // payment fixed in *nominal* dollars, but the engine deflates the payment it is given, so the
    // engine sees a slightly larger real payment and clears the loan early — 358 months, not 360.
    expect(engineAsset(320000, 6, 1918.56, 3).months).toBe(358);

    // With no inflation the two conventions coincide, and the schedule's payment is that payment.
    const payment = computeLoanPayment({ principal: 320000, annualRatePercent: 6, termMonths: 360, annualInflationPercent: 0 });
    expect(payment).toBeCloseTo(1918.5617, 3);
    expect(engineAsset(320000, 6, payment, 0).months).toBeLessThanOrEqual(361);
    expect(engineAsset(320000, 6, payment, 0, 360).loanBalance).toBeLessThan(1);
  });
});
