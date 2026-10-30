/**
 * Pro-rata basis recovery for traditional-IRA distributions (parity plan P3-P5, pure maths).
 *
 * Authority: IRC §408(d)(2) and IRS Form 8606. A traditional IRA has one after-tax basis shared
 * by every traditional, SEP and SIMPLE IRA the owner holds, and every distribution carries the
 * same tax-free fraction. The fraction is
 *
 *     basis / (year-end IRA balance + distributions during the year)
 *
 * — Form 8606 lines 6 and 9 — and **not** basis / year-end balance. That "+ distributions" term
 * is the part that is easy to get wrong: the year-end balance has already had the distribution
 * taken out of it, so `year-end balance + distributions` reconstructs the balance the fraction is
 * measured against. Leaving the distribution out inflates the fraction (at the limit, above 1) and
 * understates the taxable income.
 *
 * A Roth conversion uses the same fraction: on Form 8606 the conversion sits on line 8 and joins
 * the line 9 denominator, which is why `distribution` here is the year's *total* of everything
 * that left the IRAs (line 7 plus line 8), not just one withdrawal.
 *
 * Form 8606 instructs the filer to round the fraction to at least three decimals (line 10) before
 * multiplying; `roundForm8606Ratio` does that, and the unrounded path is kept because the engine
 * should carry full precision and round only where it presents a figure.
 */

/** The three facts Form 8606 collects before it can split a distribution. */
export interface IraDistributionBasisInputs {
  /** Line 6: the total value of all traditional/SEP/SIMPLE IRAs at the END of the year. */
  readonly yearEndBalance: number;
  /** Line 2/5: aggregate after-tax basis in those IRAs at the start of the year. */
  readonly basis: number;
  /** Line 7 plus line 8: everything distributed or converted out during the year. */
  readonly distribution: number;
}

/** The split, with the intermediate figures a table or a tool needs to show its work. */
export interface IraDistributionBasisResult {
  /** Line 9: the denominator of the fraction — year-end balance plus distributions. */
  readonly denominator: number;
  /** Line 10: the tax-free share of every dollar distributed this year. */
  readonly exclusionRatio: number;
  /** Line 11: the tax-free part of `distribution`. */
  readonly nontaxableAmount: number;
  /** The rest of `distribution`. */
  readonly taxableAmount: number;
  /** Line 14: basis left for next year. */
  readonly remainingBasis: number;
}

/**
 * Splits one year's IRA distributions into their tax-free and taxable parts.
 *
 * Negative inputs are treated as zero: a negative balance, basis or distribution is not a plan
 * state this model produces, and letting one through would produce a negative "taxable" figure
 * that reads like a refund. A year with no IRA balance and no distribution yields zero everywhere
 * rather than a 0/0 NaN.
 */
export function prorateIraDistribution(inputs: IraDistributionBasisInputs): IraDistributionBasisResult {
  const yearEndBalance = Math.max(0, inputs.yearEndBalance);
  const basis = Math.max(0, inputs.basis);
  const distribution = Math.max(0, inputs.distribution);

  const denominator = yearEndBalance + distribution;

  // With nothing in the accounts the fraction is meaningless; nothing is distributed either, so
  // the split is all zeros and the basis is untouched.
  if (denominator <= 0) {
    return { denominator: 0, exclusionRatio: 0, nontaxableAmount: 0, taxableAmount: distribution, remainingBasis: basis };
  }

  // Never more than all of it: basis above the denominator (possible after market losses) makes
  // the whole distribution tax-free, not 1.5 distributions' worth of it.
  const exclusionRatio = Math.min(1, basis / denominator);
  const nontaxableAmount = Math.min(distribution, distribution * exclusionRatio);

  return {
    denominator,
    exclusionRatio,
    nontaxableAmount,
    taxableAmount: distribution - nontaxableAmount,
    remainingBasis: basis - nontaxableAmount,
  };
}

/**
 * Form 8606 line 10's rounding: the instructions say to round the fraction to at least three
 * decimal places before multiplying on line 11. The default matches the form's guidance; a caller
 * that wants more places can ask for them.
 */
export function roundForm8606Ratio(ratio: number, decimalPlaces = 3): number {
  const factor = Math.pow(10, Math.max(0, Math.floor(decimalPlaces)));

  return Math.round(ratio * factor) / factor;
}
