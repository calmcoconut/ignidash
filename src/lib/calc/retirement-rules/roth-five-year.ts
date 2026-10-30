/**
 * Roth IRA five-year clocks and the qualified-distribution test (parity plan P3-P5, pure maths).
 *
 * Two different five-year clocks live in §408A, and confusing them is the classic Roth error:
 *
 * 1. **The qualification clock** (§408A(d)(2)(B)) decides whether *earnings* come out tax-free. It
 *    starts on 1 January of the first taxable year in which the owner had any Roth IRA (a regular
 *    contribution or a conversion — a conversion starts the clock too, per Pub. 590-B), and the
 *    account is "five-year" from 1 January of the sixth year. A qualified distribution needs that
 *    clock **and** a qualifying event: age 59½, death, disability, or a first-time home purchase.
 * 2. **The conversion clock** (§408A(d)(3)(F)) is per conversion. Converted dollars are always
 *    tax-free when withdrawn (the conversion was already taxed), but a withdrawal of converted
 *    dollars within five years of the conversion and before age 59½ carries the 10 % §72(t) tax.
 *
 * Withdrawals are ordered by §408A(d)(1): contributions first, then conversions in date order,
 * then earnings. That ordering is what makes a contribution withdrawal always tax- and penalty-free
 * even in a bad year, and it is implemented here.
 *
 * The first-time-homebuyer exception (§408A(d)(2)(F)) is a **lifetime** $10,000 cap. It applies
 * only after the qualification clock has run, and this model applies it to earnings (the only part
 * that would otherwise be taxed); applying it to converted dollars as well is not modelled, because
 * the conversion clock already governs those and the interaction is rare enough to state rather
 * than approximate.
 *
 * Everything is a function of dated events and numbers: no clock is read, and the caller supplies
 * the withdrawal date and age.
 */

import { type ISODateString, formatISODate, parseISODateString } from '../clock';

/** A dated contribution or conversion into a Roth IRA. */
export interface RothEvent {
  readonly date: ISODateString;
  readonly kind: 'contribution' | 'conversion';
  readonly amount: number;
}

/** Why the money is coming out. Only these reasons can produce a qualified distribution. */
export type RothWithdrawalReason = 'retirement' | 'firstTimeHomebuyer' | 'death' | 'disability';

/** The lifetime cap on the first-time-homebuyer exception (§408A(d)(2)(F)(ii)). */
export const ROTH_FIRST_TIME_HOMEBUYER_LIMIT = 10_000;

/** The qualification clock's first calendar day: 1 January of the earliest Roth year, or null. */
export function rothFiveYearPeriodStart(events: readonly RothEvent[]): ISODateString | null {
  if (events.length === 0) return null;

  const firstYear = Math.min(...events.map((event) => parseISODateString(event.date).year));

  return `${String(firstYear).padStart(4, '0')}-01-01`;
}

/**
 * The last day of the five-taxable-year period: 31 December of the fifth year. A distribution made
 * *after* this date is past the clock; one made on it is still inside.
 */
export function rothFiveYearPeriodEnd(start: ISODateString): ISODateString {
  const { year } = parseISODateString(start);

  return `${String(year + 4).padStart(4, '0')}-12-31`;
}

/** Whether a withdrawal on `withdrawalDate` is past the qualification clock. */
export function hasMetRothFiveYearRule(events: readonly RothEvent[], withdrawalDate: ISODateString): boolean {
  const start = rothFiveYearPeriodStart(events);
  if (start === null) return false;

  return withdrawalDate > rothFiveYearPeriodEnd(start);
}

/** The split of one Roth withdrawal, with every figure a table or a tool needs to show its work. */
export interface RothWithdrawalResult {
  /** The part drawn from contributions: always tax-free and penalty-free. */
  readonly contributionPortion: number;
  /** The part drawn from converted dollars: always tax-free, penalty-exposed inside its own clock. */
  readonly conversionPortion: number;
  /** Of `conversionPortion`, how much is inside its five years and under 59½. */
  readonly unseasonedConversionPortion: number;
  /** The rest, drawn from earnings. */
  readonly earningsPortion: number;
  /** True when the qualification clock has run by the withdrawal date. */
  readonly fiveYearPeriodMet: boolean;
  /** Earnings exempted by the first-time-homebuyer exception, capped at the lifetime limit. */
  readonly homebuyerExemptEarnings: number;
  /** Earnings that are not qualified: taxable as ordinary income. */
  readonly taxableEarnings: number;
  /** The 10 % §72(t) tax on unseasoned conversions plus taxable earnings. */
  readonly penaltyAmount: number;
}

/** The federal additional tax rate the conversion clock applies. */
const EARLY_DISTRIBUTION_PENALTY_RATE = 0.1;

/** The date five years after a conversion, after which its dollars are seasoned. */
function conversionSeasonsOn(date: ISODateString): ISODateString {
  const { year, month, day } = parseISODateString(date);

  return formatISODate({ year: year + 5, month, day });
}

/**
 * Splits a Roth withdrawal under the ordering rules and decides what is taxable and penalised.
 *
 * @param inputs.age - Attained age at the withdrawal; 59½ or better exempts both the earnings and
 *   the conversion clock.
 * @param inputs.reason - Defaults to `retirement`. `death` and `disability` are qualifying events
 *   at any age; `firstTimeHomebuyer` is qualifying only once the five-year clock has run and only
 *   up to the lifetime cap.
 * @param inputs.homebuyerLifetimeUsed - How much of the $10,000 lifetime cap earlier withdrawals
 *   have used, so a second homebuyer withdrawal does not restart it.
 */
export function rothWithdrawalTreatment(inputs: {
  events: readonly RothEvent[];
  withdrawalDate: ISODateString;
  age: number;
  amount: number;
  reason?: RothWithdrawalReason | undefined;
  homebuyerLifetimeUsed?: number | undefined;
}): RothWithdrawalResult {
  const amount = Math.max(0, inputs.amount);
  const reason = inputs.reason ?? 'retirement';
  const age = inputs.age;

  const contributions = inputs.events
    .filter((event) => event.kind === 'contribution')
    .reduce((total, event) => total + Math.max(0, event.amount), 0);

  // The ordering rule: contributions first, then conversions in date order, then earnings.
  const contributionPortion = Math.min(amount, contributions);
  let remaining = amount - contributionPortion;

  let conversionPortion = 0;
  let unseasonedConversionPortion = 0;

  const conversions = inputs.events
    .filter((event) => event.kind === 'conversion')
    .slice()
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  for (const conversion of conversions) {
    if (remaining <= 0) break;

    const taken = Math.min(remaining, Math.max(0, conversion.amount));
    if (taken <= 0) continue;

    conversionPortion += taken;
    remaining -= taken;

    // Each conversion runs its own five-year clock; only the part still inside it is exposed.
    if (inputs.withdrawalDate <= conversionSeasonsOn(conversion.date)) unseasonedConversionPortion += taken;
  }

  const earningsPortion = remaining;
  const fiveYearPeriodMet = hasMetRothFiveYearRule(inputs.events, inputs.withdrawalDate);

  const earningsQualifiedByAgeOrEvent = fiveYearPeriodMet && (age >= 59.5 || reason === 'death' || reason === 'disability');
  const homebuyerLifetimeUsed = Math.max(0, inputs.homebuyerLifetimeUsed ?? 0);
  const homebuyerRoom = Math.max(0, ROTH_FIRST_TIME_HOMEBUYER_LIMIT - homebuyerLifetimeUsed);
  const homebuyerExemptEarnings =
    fiveYearPeriodMet && reason === 'firstTimeHomebuyer' && !earningsQualifiedByAgeOrEvent ? Math.min(earningsPortion, homebuyerRoom) : 0;

  const taxableEarnings = earningsQualifiedByAgeOrEvent ? 0 : earningsPortion - homebuyerExemptEarnings;

  // Age, death and disability lift the conversion clock as well as the earnings tax; a first-time
  // home purchase does not exempt converted dollars in this model (see the module note).
  const conversionClockExcepted = age >= 59.5 || reason === 'death' || reason === 'disability';
  const penaltyBase = (conversionClockExcepted ? 0 : unseasonedConversionPortion) + taxableEarnings;

  return {
    contributionPortion,
    conversionPortion,
    unseasonedConversionPortion,
    earningsPortion,
    fiveYearPeriodMet,
    homebuyerExemptEarnings,
    taxableEarnings,
    penaltyAmount: penaltyBase * EARLY_DISTRIBUTION_PENALTY_RATE,
  };
}
