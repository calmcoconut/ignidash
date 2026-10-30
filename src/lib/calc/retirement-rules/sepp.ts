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
 * ## The rate and the period are inputs, not constants here
 *
 * Notice 2022-6 (which replaced Rev. Rul. 2002-62 for distributions beginning on or after
 * 1 January 2022) caps the interest rate at the greater of **5 %** or **120 % of the federal
 * mid-term rate** for either of the two months before the month payments begin, and it allows the
 * §1.401(a)(9)-9 mortality tables (single life, or the uniform table for a fixed method) as the
 * period. Both figures change with the month and the release, so this module takes them as
 * arguments and only enforces the rule the statute states about them
 * (`maximumSeppInterestRate`). Vendoring the mortality tables is deliberately left to whoever
 * wires the engine: the repo already carries the RMD uniform table, and the single-life table is
 * a separate dataset that would otherwise sit unused.
 *
 * The three methods give different amounts from the same balance and rate — that is expected, not
 * a bug: amortisation is an ordinary annuity, annuitisation an annuity due (one period earlier),
 * and the RMD method is a straight division by the remaining years.
 */

import { type ISODateString, addMonths, formatISODate, parseISODateString } from '../clock';

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
