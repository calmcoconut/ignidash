export type InterestType = 'simple' | 'compound';
export type CompoundingFrequency = 'daily' | 'monthly';

export interface PayoffEstimateParams {
  balance: number;
  monthlyPayment: number;
  apr: number;
  interestType: InterestType;
  compoundingFrequency?: CompoundingFrequency;
  /**
   * Plan inflation assumption in percent (e.g. 3 for 3%; pass `0` for a nominal estimate).
   * Required so that no call site can silently fall back to a nominal estimate: pass the plan's
   * `marketAssumptions.inflationRate` so the estimate matches the simulation engine.
   */
  annualInflationRate: number;
}

/**
 * Estimates months to pay off a debt using simulation.
 *
 * Mirrors the engine's loan maths exactly (see `Debt` in `src/lib/calc/debts.ts` and
 * `PhysicalAsset` in `src/lib/calc/physical-assets.ts`): interest is the Fisher-deflated real rate
 * `(1 + apr / periodsPerYear) / (1 + periodicInflation) - 1`, the payment is deflated by monthly
 * inflation after being applied, a payment covers current interest first, then unpaid prior
 * interest, then principal (simple interest), and unpaid interest capitalises (compound interest).
 *
 * Returns null for invalid inputs, Infinity if payment doesn't cover interest.
 */
export function estimatePayoffMonths(params: PayoffEstimateParams): number | null {
  const { balance, monthlyPayment, apr, interestType, annualInflationRate } = params;
  const compoundingFrequency = params.compoundingFrequency ?? 'monthly';

  if (balance <= 0 || monthlyPayment <= 0) return null;

  const annualRate = apr / 100;
  // The engine converts the annual inflation assumption to a monthly rate geometrically.
  const monthlyInflationRate = Math.pow(1 + annualInflationRate / 100, 1 / 12) - 1;

  if (annualRate === 0 && monthlyInflationRate === 0) return Math.ceil(balance / monthlyPayment);

  let principal = balance;
  let currentBalance = balance;
  let deflatedPayment = monthlyPayment;
  let months = 0;
  const maxMonths = 1200;

  while (currentBalance > 0 && months < maxMonths) {
    const interest = calculateMonthlyInterest({
      balance: currentBalance,
      principal,
      annualRate,
      interestType,
      compoundingFrequency,
      monthlyInflationRate,
    });

    if (months === 0 && deflatedPayment <= interest) return Infinity;

    const payment = Math.min(deflatedPayment, currentBalance + interest);

    if (interestType === 'simple') {
      // Simple interest: current interest, then unpaid prior interest, then principal
      const unpaidPrevInterest = Math.max(0, currentBalance - principal);
      let remainingPayment = payment;

      const paidCurrInterest = Math.min(remainingPayment, interest);
      remainingPayment -= paidCurrInterest;
      const unpaidCurrInterest = interest - paidCurrInterest;

      const paidPrevInterest = Math.min(remainingPayment, unpaidPrevInterest);
      remainingPayment -= paidPrevInterest;

      principal = Math.max(0, principal - remainingPayment);
      currentBalance = principal + (unpaidPrevInterest - paidPrevInterest) + unpaidCurrInterest;
    } else if (payment >= interest) {
      // Compound interest: unpaid interest capitalises into the balance
      currentBalance = Math.max(0, currentBalance - (payment - interest));
      principal = currentBalance;
    } else {
      currentBalance += interest - payment;
      principal = currentBalance;
    }

    deflatedPayment /= 1 + monthlyInflationRate;
    months++;
  }

  return months >= maxMonths ? Infinity : months;
}

/** Real (inflation-adjusted) monthly interest, matching the engine's `calculateMonthlyInterest`. */
function calculateMonthlyInterest({
  balance,
  principal,
  annualRate,
  interestType,
  compoundingFrequency,
  monthlyInflationRate,
}: {
  balance: number;
  principal: number;
  annualRate: number;
  interestType: InterestType;
  compoundingFrequency: CompoundingFrequency;
  monthlyInflationRate: number;
}): number {
  if (interestType === 'simple') return principal * ((1 + annualRate / 12) / (1 + monthlyInflationRate) - 1);

  const periodsPerYear = compoundingFrequency === 'daily' ? 365 : 12;
  const periodsPerMonth = periodsPerYear / 12;
  const periodicInflationRate = Math.pow(1 + monthlyInflationRate, 1 / periodsPerMonth) - 1;
  const periodicRate = (1 + annualRate / periodsPerYear) / (1 + periodicInflationRate) - 1;

  const endBalance = balance * Math.pow(1 + periodicRate, periodsPerMonth);
  return endBalance - balance;
}

export function formatPayoffEstimate(months: number): string {
  if (!isFinite(months)) return 'Never (payment too low)';

  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;

  if (years === 0) return `${remainingMonths} month${remainingMonths !== 1 ? 's' : ''}`;
  if (remainingMonths === 0) return `${years} year${years !== 1 ? 's' : ''}`;
  return `${years} yr${years !== 1 ? 's' : ''}, ${remainingMonths} mo`;
}
