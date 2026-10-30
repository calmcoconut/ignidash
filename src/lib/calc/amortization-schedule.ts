/**
 * Loan amortisation with a computed payment (P1-P5, real estate I).
 *
 * The purpose of this module is narrow: turn a term in months into the monthly payment that clears
 * the loan in exactly that many months **under the simulation engine's own loan convention**, and
 * expose the month-by-month interest/principal split that convention produces. It exists so the
 * plan does not have to store a hand-entered payment next to a term — the payment is derived.
 *
 * ## The engine's convention (and why the textbook formula would disagree)
 *
 * `Debt` (`src/lib/calc/debts.ts:236-296`) and `PhysicalAsset` (`src/lib/calc/physical-assets.ts:409-441`)
 * charge a Fisher-deflated *real* monthly rate
 *
 *     i = (1 + apr / 12) / (1 + inflation_monthly) - 1
 *
 * and, because a fixed payment loses purchasing power, **deflate the payment** after every month:
 *
 *     payment_k = payment_1 / (1 + inflation_monthly)^(k-1)
 *
 * A payment computed with the textbook **nominal** annuity formula assumes the payment is fixed in
 * nominal dollars, so it does not clear the engine's loan on the requested month — it clears early
 * (about two months early on a 30-year mortgage at 6% with 3% inflation; `amortization-schedule.test.ts`
 * pins that against the engine classes).
 *
 * So the payment here is solved for the engine's recurrence. With `g = 1 + i`, `d = 1 / (1 + inflation_monthly)`:
 *
 *     balance_n = principal * g^n - payment_1 * (g^n - d^n) / (g - d)
 *
 * which is zero when
 *
 *     payment_1 = principal * g^n * (g - d) / (g^n - d^n)
 *
 * With zero inflation (`d = 1`) this reduces to the familiar `principal * r / (1 - (1 + r)^-n)`,
 * and with zero interest and zero inflation (`g = d = 1`, a 0/0 limit) to `principal / n`.
 *
 * Pure: no clock, no store, no engine state. Money is in the plan's real dollars, matching the
 * engine's basis after `amountScale`.
 */

/** Engine-matching monthly inflation from an annual assumption in percent, as a fraction. */
export function monthlyInflationRate(annualInflationPercent: number): number {
  return Math.pow(1 + annualInflationPercent / 100, 1 / 12) - 1;
}

/**
 * The engine's Fisher-deflated monthly interest rate:
 * `(1 + apr / 12) / (1 + monthly inflation) - 1`.
 */
export function monthlyRealRate(annualRatePercent: number, annualInflationPercent: number): number {
  return (1 + annualRatePercent / 100 / 12) / (1 + monthlyInflationRate(annualInflationPercent)) - 1;
}

export interface LoanTerms {
  /** The amount borrowed, in the plan's real dollars. */
  principal: number;
  /** Nominal APR, e.g. 6.5 for 6.5%. */
  annualRatePercent: number;
  /** The number of monthly payments that should clear the loan. */
  termMonths: number;
  /** The plan's annual inflation assumption, in percent. `0` gives a nominal schedule. */
  annualInflationPercent?: number;
}

/** One month of the schedule. Amounts are real dollars; `payment` declines with inflation. */
export interface AmortizationRow {
  /** 1-based payment number. */
  month: number;
  payment: number;
  interest: number;
  /** The part of the payment that reduced principal (never negative here: payment covers interest first). */
  principal: number;
  /** Closing balance for the month. */
  balance: number;
}

export interface AmortizationSchedule {
  /** The first month's payment, in real dollars; every later payment is this deflated by inflation. */
  payment: number;
  /** The engine's monthly real rate (`monthlyRealRate`). */
  monthlyRealRate: number;
  monthlyInflationRate: number;
  rows: AmortizationRow[];
  totalInterest: number;
  totalPaid: number;
}

const ONE_CENT = 1e-6;

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number, received ${String(value)}.`);
}

function validate(terms: LoanTerms): Required<LoanTerms> {
  const { principal, annualRatePercent, termMonths } = terms;
  const annualInflationPercent = terms.annualInflationPercent ?? 0;

  assertFinite('principal', principal);
  assertFinite('annualRatePercent', annualRatePercent);
  assertFinite('termMonths', termMonths);
  assertFinite('annualInflationPercent', annualInflationPercent);

  if (principal <= 0) throw new Error(`principal must be greater than zero, received ${principal}.`);
  if (annualRatePercent < 0) throw new Error(`annualRatePercent cannot be negative, received ${annualRatePercent}.`);
  if (annualInflationPercent <= -100)
    throw new Error(`annualInflationPercent must be greater than -100, received ${annualInflationPercent}.`);
  if (!Number.isInteger(termMonths) || termMonths <= 0)
    throw new Error(`termMonths must be a positive whole number, received ${termMonths}.`);

  return { principal, annualRatePercent, termMonths, annualInflationPercent };
}

/**
 * The first month's payment (real dollars) that clears `principal` in exactly `termMonths` under
 * the engine's loan convention. Later payments are this deflated by the monthly inflation rate.
 *
 * @throws if the terms are not a usable loan (non-finite, non-positive principal, negative rate,
 * non-positive or fractional term, inflation at or below -100%).
 */
export function computeLoanPayment(terms: LoanTerms): number {
  const { principal, annualRatePercent, termMonths, annualInflationPercent } = validate(terms);

  const inflation = monthlyInflationRate(annualInflationPercent);
  const g = 1 + monthlyRealRate(annualRatePercent, annualInflationPercent);
  const d = 1 / (1 + inflation);

  // Both 0/0 limits: nothing grows and nothing deflates, or the real rate exactly cancels deflation
  // (a 0% APR with inflation > 0, where g === d).
  if (Math.abs(g - 1) < ONE_CENT && Math.abs(d - 1) < ONE_CENT) return principal / termMonths;
  if (Math.abs(g - d) < ONE_CENT) {
    const payment = (principal * Math.pow(g, termMonths - 1) * (g - d)) / (Math.pow(g, termMonths) - Math.pow(d, termMonths));

    // Near the limit the quotient is the derivative form principal * g / n; use it when the two
    // powers are numerically indistinguishable.
    return Number.isFinite(payment) ? payment : (principal * g) / termMonths;
  }

  const payment = (principal * Math.pow(g, termMonths) * (g - d)) / (Math.pow(g, termMonths) - Math.pow(d, termMonths));
  if (!Number.isFinite(payment) || payment <= 0) {
    throw new Error(`No payment clears principal ${principal} in ${termMonths} months at ${annualRatePercent}% APR.`);
  }

  return payment;
}

/**
 * The month-by-month schedule: closing balance, interest and principal for every payment, computed
 * with the engine's own recurrence (interest first, then principal; payment capped at the remaining
 * balance plus that month's interest, so the last payment is exact).
 *
 * @throws on invalid terms (see `computeLoanPayment`).
 */
export function buildAmortizationSchedule(terms: LoanTerms): AmortizationSchedule {
  const { termMonths } = validate(terms);

  const payment = computeLoanPayment(terms);
  const inflation = monthlyInflationRate(terms.annualInflationPercent ?? 0);
  const realRate = monthlyRealRate(terms.annualRatePercent, terms.annualInflationPercent ?? 0);

  let balance = terms.principal;
  let paymentThisMonth = payment;
  let totalInterest = 0;
  let totalPaid = 0;

  const rows: AmortizationRow[] = [];
  for (let month = 1; month <= termMonths && balance > 0; month++) {
    const interest = balance * realRate;
    // The engine never collects more than the remaining balance plus this month's interest.
    const due = Math.min(paymentThisMonth, balance + interest);
    const principalPaid = due - interest;
    const remaining = balance - principalPaid;
    // The closed-form payment leaves float noise (a millionth of a dollar or less) in the last
    // month; the schedule's promise is that the term clears the loan, so it is written off here.
    const closing = remaining <= ONE_CENT ? 0 : remaining;

    rows.push({ month, payment: due, interest, principal: principalPaid, balance: closing });
    totalInterest += interest;
    totalPaid += due;

    balance = closing;
    paymentThisMonth /= 1 + inflation;
  }

  return { payment, monthlyRealRate: realRate, monthlyInflationRate: inflation, rows, totalInterest, totalPaid };
}
