/**
 * Qualified charitable distributions (QCDs) from an IRA (parity plan P3-P5, pure maths).
 *
 * Authority: IRC §408(d)(8), added by the Pension Protection Act of 2006 and made permanent by
 * the PATH Act of 2015. A QCD is paid directly by the IRA trustee to a qualifying charity; the
 * amount is **excluded from gross income** rather than deducted, does not count as a charitable
 * contribution for itemising (§408(d)(8): the owner may not also deduct it), and counts toward
 * that year's required minimum distribution.
 *
 * Three rules are modelled:
 *
 * 1. **Age**: the owner must have attained age 70½ on the date of the distribution.
 * 2. **Annual limit**: $100,000 per individual, indexed for inflation in $1,000 steps after 2023
 *    (SECURE 2.0 Act §307). The indexed amounts are vendored below by year.
 * 3. **RMD interaction**: a QCD satisfies the year's RMD dollar-for-dollar up to the RMD
 *    (`rmdSatisfied`), and the remainder of the RMD still has to be distributed.
 *
 * Not modelled: the one-time $50,000 split-interest-entity election (SECURE 2.0 §307), QCDs from
 * an employer plan (not permitted), and the "no deduction" rule beyond documenting it — there is no
 * deduction in this model to suppress.
 */

import type { TaxYear } from '../tax-data/types';

/** The statutory age: 70½, not 70 and not 72. */
export const QCD_MINIMUM_AGE = 70.5;

/** The un-indexed limit for the years before indexation began. */
export const QCD_BASE_LIMIT = 100_000;

/**
 * The per-individual limit, by year.
 *
 * 2013–2023 are the flat $100,000 the statute set; 2024 and 2025 are the IRS's indexed amounts from
 * the annual inflation-adjustment revenue procedures. The tax-data convention applies: the numbers
 * are a data diff, reviewed against the published release on every annual update, and a year with
 * no vendored amount is refused rather than approximated.
 */
const QCD_LIMITS: Record<number, number> = {
  2013: 100_000,
  2024: 105_000,
  2025: 108_000,
};

/** The years this module can cite: the flat-limit era and the two indexed years it carries. */
export const QCD_LIMIT_YEARS: readonly TaxYear[] = [2013, 2024, 2025];

/**
 * The QCD limit for a year.
 *
 * Every year from 2013 (when the QCD became permanent) through 2023 used the flat $100,000; those
 * years resolve to the base limit without a table entry each. A year outside the covered range
 * throws: a 2026 QCD limit is an indexed amount this build does not carry.
 */
export function qcdAnnualLimit(year: TaxYear): number {
  if (year >= 2013 && year <= 2023) return QCD_BASE_LIMIT;

  const limit = QCD_LIMITS[year];
  if (limit !== undefined) return limit;

  throw new Error(
    `No QCD limit for ${year}. Covered: 2013–2023 (flat $100,000) and ${QCD_LIMIT_YEARS.filter((covered) => covered > 2023).join(', ')}. ` +
      'Add the year from the IRS inflation-adjustment revenue procedure; do not carry an adjacent year forward.'
  );
}

/** One year's QCD, split into what is excluded, what is still taxable, and what is left of the RMD. */
export interface QcdResult {
  /** The part excluded from gross income: the QCD. */
  readonly excludedAmount: number;
  /** The rest of the distribution, taxable as an ordinary IRA distribution. */
  readonly taxableAmount: number;
  /** How much of the year's RMD the QCD satisfied. */
  readonly rmdSatisfied: number;
  /** The RMD still to be distributed. */
  readonly rmdRemaining: number;
  /** The year's per-individual limit, for a UI or a table. */
  readonly limit: number;
}

/**
 * Applies the QCD rules to one year's charitable distribution from an IRA.
 *
 * @param inputs.age - Attained age at the distribution; below 70½ nothing qualifies.
 * @param inputs.distribution - The amount paid directly from the IRA to the charity this year.
 * @param inputs.rmdRequired - The year's required minimum distribution before the QCD.
 * @param inputs.year - The tax year, which resolves the limit.
 *
 * A distribution larger than the limit keeps the excess as an ordinary taxable distribution — the
 * QCD does not become a deduction for the excess.
 */
export function qualifiedCharitableDistribution(inputs: {
  year: TaxYear;
  age: number;
  distribution: number;
  rmdRequired?: number | undefined;
}): QcdResult {
  const limit = qcdAnnualLimit(inputs.year);
  const distribution = Math.max(0, inputs.distribution);
  const rmdRequired = Math.max(0, inputs.rmdRequired ?? 0);

  const eligible = inputs.age >= QCD_MINIMUM_AGE;
  const excludedAmount = eligible ? Math.min(distribution, limit) : 0;
  const rmdSatisfied = Math.min(excludedAmount, rmdRequired);

  return {
    excludedAmount,
    taxableAmount: distribution - excludedAmount,
    rmdSatisfied,
    rmdRemaining: rmdRequired - rmdSatisfied,
    limit,
  };
}
