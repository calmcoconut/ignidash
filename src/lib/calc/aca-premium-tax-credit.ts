/**
 * ACA premium tax credit (PTC) — the pure computation (parity plan P3-P7b, core).
 *
 * IRC §36B gives a refundable credit for health insurance bought through a marketplace. For a
 * household between the eligibility bounds, the annual credit is:
 *
 *     required contribution = applicable percentage × household income
 *     credit                = SLCSP premium − required contribution        (floored at zero)
 *     credit                = min(credit, premium of the plan actually held) (§36B(b)(2))
 *
 * where the applicable percentage is read off the year's schedule at the household's income as a
 * share of the federal poverty line, interpolated linearly inside a band, and the SLCSP is the
 * second-lowest-cost silver plan premium for that household.
 *
 * ## What this module does and does not decide
 *
 * The *rules* live in `./tax-data/aca` (FPL, the percentage schedule, the eligibility bounds, each
 * with its citation). This file only does arithmetic over them, so a new year is a data change.
 *
 * The subsidy structure is **monthly** in the statute, and modelled here as an annual amount: the
 * caller passes annual premiums and annual income, and receives an annual credit with no rounding.
 * Every intermediate stays at full precision so a caller can round once, at the cent, where it
 * presents the number.
 *
 * `SLCSP` is an input, not a setting: the plan does not know what a silver plan costs in the
 * household's rating area, and inventing a premium would be worse than requiring one. The caller
 * supplies it — `TaxProcessor.process` reads it from `taxSettings.aca` — and nothing here reads a
 * plan field, a clock or the network.
 *
 * The wiring lives elsewhere, and it has shipped: the opt-in flag and the SLCSP / household-size /
 * live-premium inputs are plan fields (`taxSettings.aca`), the settled return carries this result as
 * `TaxesData.aca` and folds the credit into `totalTaxesRefund`/`totalTaxesDue` (it is refundable, so
 * it is not a liability line), and the tax-settings drawer renders the controls. What is still not
 * modelled — and must be said wherever the credit is shown — is Covered California's state subsidy
 * on top of the federal credit.
 */

import {
  type AcaApplicablePercentageBand,
  type AcaYearTable,
  federalPovertyLinePercent,
  getAcaTable,
  povertyLineForSize,
} from './tax-data/aca';

/** The facts a PTC calculation needs. Every amount is annual and in dollars. */
export interface AcaPremiumTaxCreditInputs {
  /** Household income for §36B purposes (MAGI), annual. */
  readonly householdIncome: number;
  /** People in the tax family; drives the poverty line. */
  readonly householdSize: number;
  /** The tax year whose FPL, schedule and bounds apply. */
  readonly taxYear: number;
  /** Second-lowest-cost silver plan premium for the household, annual. */
  readonly slcspPremium: number;
  /** The premium actually paid for the plan held, if the caller knows it (§36B(b)(2) cap). */
  readonly actualPremium?: number | undefined;
}

/** The yearly credit, with the intermediate figures a table or a tool needs to show its work. */
export interface AcaPremiumTaxCreditResult {
  readonly eligible: boolean;
  /**
   * The coverage year whose law priced this result. Equal to the requested tax year whenever the
   * module has that year's table, and older than it when the request ran past the last vendored
   * row — `getAcaTable` resolves the nearest prior year, and this field is how a consumer discloses
   * that instead of implying later law applies (see `cliffs.aca.resolvedYear`).
   */
  readonly resolvedYear: number;
  readonly householdIncome: number;
  readonly povertyLine: number;
  readonly fplPercent: number;
  /** Share of income the household is expected to contribute, at `fplPercent`. */
  readonly applicablePercentage: number;
  readonly requiredContribution: number;
  readonly slcspPremium: number;
  /** The credit before the actual-premium cap, floored at zero. */
  readonly creditBeforePremiumCap: number;
  /** The credit after the actual-premium cap. Zero when the household is ineligible. */
  readonly credit: number;
  /** True when §36B(b)(2) bound the credit to the premium actually paid. */
  readonly cappedByActualPremium: boolean;
  /**
   * The share of the year the household was on marketplace cover, as member-months not on Medicare
   * over member-months alive (`taxes.ts`): Medicare is minimum essential coverage, so a member on it
   * has no premium tax credit (IRC §36B(c)(2)(B)). Present only when it is below 1; the federal and
   * state amounts above are already multiplied by it.
   */
  readonly marketplaceShare?: number;
  /**
   * California state premium assistance (Covered California), annual, after the marketplace share
   * and the premium cap (v20). The operator enters it from their Covered California eligibility
   * notice; the state's own schedule is not vendored. Absent when none is stated or applicable.
   */
  readonly stateSubsidy?: number;
}

/**
 * The applicable percentage at a point on the FPL scale: linear inside a band, flat outside the
 * schedule. The bands are contiguous by construction (each one's `endRate` is the next one's
 * `startRate`), so a household at a band boundary gets the same share from either side.
 */
export function applicablePercentageAt(bands: readonly AcaApplicablePercentageBand[], fplPercent: number): number {
  if (bands.length === 0) return 0;

  const first = bands[0];
  const last = bands[bands.length - 1];

  if (fplPercent <= first.minFplPercent) return first.startRate;
  if (fplPercent >= last.maxFplPercent) return last.endRate;

  for (const band of bands) {
    if (fplPercent < band.minFplPercent || fplPercent > band.maxFplPercent) continue;

    const span = band.maxFplPercent - band.minFplPercent;
    const progress = span > 0 ? (fplPercent - band.minFplPercent) / span : 0;

    return band.startRate + progress * (band.endRate - band.startRate);
  }

  return last.endRate;
}

/**
 * The premium assistance credit for one household-year.
 *
 * @param inputs - Income, household size, year, and the two premiums.
 * @param ruleset - Test-only override of the year table (the same escape hatch `TaxProcessor` has).
 *   Production callers resolve through `getAcaTable(inputs.taxYear)`, which falls back to the
 *   nearest prior coverage year and reports that year back as `resolvedYear`.
 */
export function calculatePremiumTaxCredit(inputs: AcaPremiumTaxCreditInputs, ruleset?: AcaYearTable): AcaPremiumTaxCreditResult {
  const table = ruleset ?? getAcaTable(inputs.taxYear);

  const householdIncome = Math.max(0, inputs.householdIncome);
  const slcspPremium = Math.max(0, inputs.slcspPremium);
  const povertyLine = povertyLineForSize(table.povertyGuideline.values, inputs.householdSize);
  const fplPercent = federalPovertyLinePercent(householdIncome, povertyLine);

  const { minFplPercent, maxFplPercent } = table.eligibility.values;
  const eligible = fplPercent >= minFplPercent && (maxFplPercent === null || fplPercent <= maxFplPercent);

  const applicablePercentage = applicablePercentageAt(table.applicablePercentages.values, fplPercent);
  const requiredContribution = applicablePercentage * householdIncome;

  const creditBeforePremiumCap = eligible ? Math.max(0, slcspPremium - requiredContribution) : 0;
  const actualPremium = inputs.actualPremium === undefined ? undefined : Math.max(0, inputs.actualPremium);
  const cappedByActualPremium = actualPremium !== undefined && creditBeforePremiumCap > actualPremium;

  return {
    eligible,
    resolvedYear: table.year,
    householdIncome,
    povertyLine,
    fplPercent,
    applicablePercentage,
    requiredContribution,
    slcspPremium,
    creditBeforePremiumCap,
    credit: cappedByActualPremium ? actualPremium : creditBeforePremiumCap,
    cappedByActualPremium,
  };
}
