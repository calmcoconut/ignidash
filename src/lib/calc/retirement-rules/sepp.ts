/**
 * Substantially equal periodic payments (SEPP) under IRC §72(t)(2)(A)(iv) — pure maths.
 *
 * §72(t)(1) adds a 10 % additional tax to an early distribution from a qualified plan or IRA. The
 * SEPP exception lets an owner take a series of "substantially equal periodic payments" for the
 * rest of the §72(t)(4) period instead. Three methods are accepted by the IRS:
 *
 * | method | annual amount | authority |
 * | --- | --- | --- |
 * | required minimum distribution | balance ÷ life-expectancy period, recomputed every year | Notice 2022-6, §III |
 * | fixed amortisation | level payment that amortises the balance over the same period | Notice 2022-6, §III |
 * | fixed annuitisation | balance ÷ an annuity-due factor over the same period | Notice 2022-6, §III |
 *
 * ## Where the period and the rate come from
 *
 * Notice 2022-6 (which replaced Rev. Rul. 2002-62 for distributions beginning on or after
 * 1 January 2022) caps the interest rate at the greater of **5 %** or **120 % of the federal
 * mid-term rate** for either of the two months before the month payments begin, and it takes the
 * distribution period from one of the §1.401(a)(9)-9 tables.
 *
 * Both are published facts, so they are vendored in `./sepp-tables`: the Single Life Table
 * (§1.401(a)(9)-9(b), Table 1) as an age → factor map, and the monthly federal mid-term rate as a
 * dated `YYYY-MM` lookup that throws rather than falling back. The arithmetic below stays a pure
 * function of numbers — `seppAnnualAmount` is the parameterised path, and it is what the tests and
 * a caller holding a Joint-and-Last-Survivor period use. `seppAnnualAmountFromTables` is the
 * callable path: it resolves the period from the owner's age, the rate cap from the month the
 * payments begin, and then calls `seppAnnualAmount`.
 *
 * The three methods give different amounts from the same balance and rate — that is expected, not
 * a bug: amortisation is an ordinary annuity, annuitisation an annuity due (one period earlier),
 * and the RMD method is a straight division by the remaining years.
 */

import { type ISODateString, addMonths, formatISODate, parseISODateString } from '../clock';
import { type SeppRateMonth, federalMidTermRate, offsetSeppRateMonth, singleLifeExpectancy } from './sepp-tables';

/** The three methods Notice 2022-6 accepts. Any other "method" is not a safe-harbour method. */
export type SeppMethod = 'rmd' | 'fixedAmortization' | 'fixedAnnuitization';

/** The facts a SEPP calculation needs. All amounts are dollars, the rate a decimal (0.05 = 5 %). */
export interface SeppInputs {
  readonly method: SeppMethod;
  /** Account balance at the start of the computation year. */
  readonly balance: number;
  /** Interest rate for the year, within the Notice 2022-6 cap. */
  readonly rate: number;
  /** Life-expectancy period in years from the applicable §1.401(a)(9)-9 table. */
  readonly distributionPeriod: number;
}

/**
 * The highest rate Notice 2022-6 allows for a given federal mid-term rate:
 * `max(5 %, 120 % of the mid-term rate)`. The 5 % floor is why a low-rate month still permits 5 %.
 */
export function maximumSeppInterestRate(federalMidTermRate: number): number {
  return Math.max(0.05, 1.2 * Math.max(0, federalMidTermRate));
}

/** Guarantees the period is a positive number of years; a zero or negative period has no meaning. */
function requirePeriod(distributionPeriod: number): number {
  if (!(distributionPeriod > 0)) {
    throw new Error(`A SEPP distribution period must be at least one year; got ${distributionPeriod}.`);
  }

  return distributionPeriod;
}

/**
 * The annual SEPP amount for one year under the chosen method.
 *
 * - `rmd`: `balance / period`. Notice 2022-6 §III.A — recomputed each year from that year's
 *   balance, so the payment moves with the account.
 * - `fixedAmortization`: `balance × r / (1 − (1 + r)^−n)`. Notice 2022-6 §III.B — an ordinary
 *   annuity's level payment, fixed once at the start.
 * - `fixedAnnuitization` (Notice 2022-6 §III.C): `balance / ä(n, r)` where
 *   `ä = (1 + r) × (1 − (1 + r)^−n) / r`, the annuity-due factor, which is the amortisation factor
 *   one period earlier.
 *
 * A zero rate degenerates every method to `balance / period` (no growth, so the balance is simply
 * spread over the years) rather than dividing by zero.
 */
export function seppAnnualAmount(inputs: SeppInputs): number {
  const balance = Math.max(0, inputs.balance);
  const period = requirePeriod(inputs.distributionPeriod);
  const rate = Math.max(0, inputs.rate);

  if (inputs.method === 'rmd' || rate === 0) return balance / period;

  const discount = 1 - Math.pow(1 + rate, -period);
  // `discount` is 0 only for a zero rate (handled above) or a non-finite period, so the division
  // is safe here.
  if (inputs.method === 'fixedAmortization') return (balance * rate) / discount;

  return balance / ((discount / rate) * (1 + rate));
}

/** The §1.401(a)(9)-9 annuity factors a fixed method needs, exposed so a caller can show its work. */
export function seppAnnuityFactors(rate: number, distributionPeriod: number): { ordinary: number; due: number } {
  const period = requirePeriod(distributionPeriod);
  const r = Math.max(0, rate);
  if (r === 0) return { ordinary: period, due: period };

  const ordinary = (1 - Math.pow(1 + r, -period)) / r;

  return { ordinary, due: ordinary * (1 + r) };
}

/**
 * One month Notice 2022-6 §3.02(c) allows, with the rate it published and the cap that rate gives.
 *
 * `maximumRate` is this month's own cap, so a caller can show that the second month was worse and
 * why the window picked the first.
 */
export interface SeppEligibleRateMonth {
  readonly month: SeppRateMonth;
  /** The §1274(d) federal mid-term rate for that month, as a decimal (0.0461 = 4.61 %). */
  readonly federalMidTermRate: number;
  /** The most this month's rate allows: `max(5 %, 120 % × mid-term rate)`. */
  readonly maximumRate: number;
}

/** The rate window Notice 2022-6 §3.02(c) gives a distribution that begins in a month. */
export interface SeppRateWindow {
  readonly distributionMonth: SeppRateMonth;
  /** The month before the distribution begins, then the month before that. */
  readonly eligibleMonths: readonly SeppEligibleRateMonth[];
  /** The highest cap either of the two months permits — the ceiling on a fixed method's rate. */
  readonly maximumRate: number;
}

/**
 * The two mid-term rates a distribution beginning in `distributionMonth` may be priced from.
 *
 * Notice 2022-6 §3.02(c) allows "the federal mid-term rate … for either of the two months
 * immediately preceding the month in which the distribution begins". The window reports both
 * months with their own caps and the greater of the two, because the taxpayer may choose either
 * month and the greater cap is therefore the most a compliant series may pay. A month with no
 * vendored rate — including either of the two — throws from `federalMidTermRate`; nothing here
 * falls back to the newest month or to a neighbouring one.
 */
export function seppRateWindow(distributionMonth: SeppRateMonth): SeppRateWindow {
  // Newest first: 1 and 2 months before the distribution begins. `offsetSeppRateMonth` validates
  // the key, so a malformed month fails before any rate is looked up.
  const eligibleMonths = [1, 2].map((monthsBefore): SeppEligibleRateMonth => {
    const month = offsetSeppRateMonth(distributionMonth, -monthsBefore);
    const rate = federalMidTermRate(month);

    return { month, federalMidTermRate: rate, maximumRate: maximumSeppInterestRate(rate) };
  });

  return {
    distributionMonth,
    eligibleMonths,
    maximumRate: Math.max(...eligibleMonths.map((entry) => entry.maximumRate)),
  };
}

/** The facts the vendored tables let a caller omit: the period and the rate. */
export interface SeppTableInputs {
  readonly method: SeppMethod;
  readonly balance: number;
  /**
   * The age attained on the owner's birthday in the first distribution year (Notice 2022-6
   * §3.02(a)), which selects the Single Life Table row. The RMD method re-reads this row from the
   * next year's age on each anniversary; the fixed methods keep the first year's period.
   */
  readonly age: number;
  /** The month the first payment is made, `YYYY-MM` (Notice 2022-6 §3.02(c)). */
  readonly firstDistributionMonth: SeppRateMonth;
  /** The rate to use, if the caller wants one below the cap; defaults to the permitted maximum. */
  readonly rate?: number | undefined;
}

/** One year's SEPP amount plus the inputs that produced it, so a UI or a report can show its work. */
export interface SeppTableResult {
  readonly annualAmount: number;
  /** The Single Life Table factor used — the same figure the RMD method re-reads each year. */
  readonly distributionPeriod: number;
  readonly rate: number;
  readonly maximumRate: number;
  readonly rateWindow: SeppRateWindow;
}

/**
 * The annual SEPP amount, priced from the vendored tables: age → distribution period
 * (§1.401(a)(9)-9(b) Table 1), first distribution month → the Notice 2022-6 §3.02(c) rate cap.
 *
 * The rate defaults to the cap, which is the highest amount a compliant series may take. A rate
 * above the cap is refused rather than computed: understating the interest rate is permitted,
 * overstating it is a §72(t) modification, so an out-of-cap rate is not a number to return.
 */
export function seppAnnualAmountFromTables(inputs: SeppTableInputs): SeppTableResult {
  const distributionPeriod = singleLifeExpectancy(inputs.age);
  const rateWindow = seppRateWindow(inputs.firstDistributionMonth);
  const rate = inputs.rate ?? rateWindow.maximumRate;

  if (rate > rateWindow.maximumRate) {
    const allowed = rateWindow.eligibleMonths.map((entry) => `${entry.month} allows ${entry.maximumRate * 100} %`).join('; ');

    throw new Error(
      `A SEPP rate of ${rate * 100} % exceeds the Notice 2022-6 §3.02(c) maximum of ` +
        `${rateWindow.maximumRate * 100} % for a distribution beginning in ${inputs.firstDistributionMonth} ` +
        `(greater of 5 % or 120 % of the federal mid-term rate for either preceding month — ${allowed}).`
    );
  }

  return {
    annualAmount: seppAnnualAmount({ method: inputs.method, balance: inputs.balance, rate, distributionPeriod }),
    distributionPeriod,
    rate,
    maximumRate: rateWindow.maximumRate,
    rateWindow,
  };
}

/**
 * How long the payments must continue: the later of five years from the first payment and the date
 * the owner attains age 59½ (§72(t)(4)(A)). Stopping earlier is a "modification" that retroactively
 * applies the 10 % tax (plus interest) to every payment already taken.
 *
 * Both inputs are calendar values: `startDate` is the first distribution date and `birthDate` the
 * owner's date of birth. Nothing here consults the clock.
 */
export function seppMustContinueUntil(inputs: { startDate: ISODateString; birthDate: ISODateString }): ISODateString {
  const start = parseISODateString(inputs.startDate);
  const birth = parseISODateString(inputs.birthDate);

  const fiveYears = addMonths(start, 5 * 12);
  const ageFiftyNineAndAHalf = addMonths(birth, 59 * 12 + 6);

  const fiveYearsIso = formatISODate(fiveYears);
  const attainedIso = formatISODate(ageFiftyNineAndAHalf);

  return fiveYearsIso >= attainedIso ? fiveYearsIso : attainedIso;
}

/**
 * The §72(t)(2) exceptions this model knows about. The list is deliberately short: each entry is a
 * statutory exception that can be decided from dates and ages alone.
 *
 * Not modelled (they need facts a plan does not carry): medical expenses above the AGI floor
 * (§72(t)(2)(B)), health-insurance premiums while unemployed (§72(t)(2)(D)), higher-education
 * expenses (§72(t)(2)(E)), a qualified domestic-relations order, an IRS levy, and the $5,000
 * birth/adoption allowance (§72(t)(2)(H)).
 */
export type EarlyDistributionException =
  | 'none'
  /** Age 59½ or older (§72(t)(2)(A)(i)). */
  | 'ageFiftyNineAndAHalf'
  | 'death'
  | 'disability'
  /** A compliant SEPP series in progress (§72(t)(2)(A)(iv)). */
  | 'sepp'
  /** Roth IRA first-time homebuyer, up to the §408A(d)(2)(F) lifetime cap. */
  | 'rothFirstTimeHomebuyer';

/** The federal additional tax on early distributions. California's extra 2.5 % is out of scope. */
export const EARLY_DISTRIBUTION_PENALTY_RATE = 0.1;

/**
 * Whether the 10 % additional tax applies to a taxable early distribution, and how much it is.
 *
 * @param inputs.age - Attained age at the distribution.
 * @param inputs.exception - The exception claimed, if any. `ageFiftyNineAndAHalf` is accepted even
 *   when `age` is below 59.5 only if the caller says so — the caller is the one that knows the
 *   exact date of attainment, and a 59.5 threshold computed from a rounded age would be wrong at
 *   the boundary.
 */
export function earlyDistributionPenalty(inputs: {
  taxableAmount: number;
  age: number;
  exception?: EarlyDistributionException | undefined;
}): { applies: boolean; amount: number } {
  const taxableAmount = Math.max(0, inputs.taxableAmount);
  const excepted = inputs.age >= 59.5 || (inputs.exception !== undefined && inputs.exception !== 'none') || taxableAmount === 0;

  return { applies: !excepted, amount: excepted ? 0 : taxableAmount * EARLY_DISTRIBUTION_PENALTY_RATE };
}
