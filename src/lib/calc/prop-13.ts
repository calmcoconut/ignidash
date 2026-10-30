/**
 * California property tax under Proposition 13 (D9, P1-P5).
 *
 * Prop 13 does not tax market value. It taxes an **assessed value** that starts at the acquisition
 * price and may rise by no more than 2% a year, so a long-held California home is taxed on a value
 * far below what it is worth. Projecting property tax from market value overstates the bill for
 * exactly the household this app is for (a California resident holding a home for decades).
 *
 * The rule implemented here, per year of ownership:
 *
 *     growth   = min(market appreciation, cap)          // cap defaults to 2%
 *     assessed = purchase price * (1 + growth)^years    // floored at the purchase price
 *     tax      = assessed * rate                         // rate defaults to 1.1%
 *
 * Three deliberate modelling calls, all pinned by tests:
 *
 * 1. **The floor is the purchase price.** A decline in the market does not reduce the assessment
 *    below its base-year value. California's Prop 8 decline-in-value reassessment (which can cut an
 *    assessment to market value, then hold it there while it recovers) is *not* modelled — this
 *    module never under-taxes a falling market, and it does not pretend to model the reassessment
 *    procedure.
 * 2. **A sale and repurchase resets the base.** Because the assessed value is a pure function of
 *    (purchase price, years owned), a new owner simply starts a new schedule: the previous
 *    assessment carries nothing forward, which is exactly what a reassessment at sale does.
 * 3. **The rate is a single configurable number.** The 1% constitutional rate plus local add-ons
 *    and bond measures is folded into one editable rate (~1.1% is a typical California total). A
 *    per-agency breakdown is not modelled; the plan does not ask for one.
 *
 * Pure: no clock, no store. `yearIndex` 0 is the year of purchase.
 */

/** Typical California total rate: the 1% constitutional rate plus local add-ons and bonds, in percent. */
export const PROP_13_DEFAULT_RATE_PERCENT = 1.1;

/** The cap on the annual increase in assessed value, as a fraction (Prop 13's 2%). */
export const PROP_13_ASSESSED_GROWTH_CAP = 0.02;

export interface Prop13Options {
  /** The property's annual market appreciation, in percent (the plan's `appreciationRate`). */
  marketAppreciationPercent: number;
  /** Liability as a percent of assessed value; defaults to 1.1%. */
  ratePercent?: number;
  /** Cap on the annual assessment increase as a fraction; defaults to 0.02. */
  assessedGrowthCap?: number;
}

/** One year of the property tax schedule. */
export interface Prop13Year {
  /** 0 is the purchase year. */
  yearIndex: number;
  assessedValue: number;
  annualTax: number;
}

function validate(purchasePrice: number, yearsOwned: number, options: Prop13Options): Required<Prop13Options> {
  const { marketAppreciationPercent } = options;
  const ratePercent = options.ratePercent ?? PROP_13_DEFAULT_RATE_PERCENT;
  const assessedGrowthCap = options.assessedGrowthCap ?? PROP_13_ASSESSED_GROWTH_CAP;

  for (const [name, value] of [
    ['purchasePrice', purchasePrice],
    ['yearsOwned', yearsOwned],
    ['marketAppreciationPercent', marketAppreciationPercent],
    ['ratePercent', ratePercent],
    ['assessedGrowthCap', assessedGrowthCap],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number, received ${String(value)}.`);
  }

  if (purchasePrice <= 0) throw new Error(`purchasePrice must be greater than zero, received ${purchasePrice}.`);
  if (!Number.isInteger(yearsOwned) || yearsOwned < 0)
    throw new Error(`yearsOwned must be a whole number of years, received ${yearsOwned}.`);
  if (ratePercent < 0) throw new Error(`ratePercent cannot be negative, received ${ratePercent}.`);
  if (assessedGrowthCap < 0) throw new Error(`assessedGrowthCap cannot be negative, received ${assessedGrowthCap}.`);
  if (marketAppreciationPercent <= -100) {
    throw new Error(`marketAppreciationPercent must be greater than -100, received ${marketAppreciationPercent}.`);
  }

  return { marketAppreciationPercent, ratePercent, assessedGrowthCap };
}

/** The annual growth actually applied to the assessed value: the lesser of appreciation and the cap. */
export function prop13AssessedGrowth(marketAppreciationPercent: number, assessedGrowthCap = PROP_13_ASSESSED_GROWTH_CAP): number {
  return Math.min(marketAppreciationPercent / 100, assessedGrowthCap);
}

/**
 * The assessed value after `yearsOwned` full years of ownership.
 *
 * Grows by `min(appreciation, cap)` a year from the purchase price, and never falls below it.
 *
 * @throws if the price is not positive, the years are not a whole number, or any input is non-finite.
 */
export function prop13AssessedValue(purchasePrice: number, yearsOwned: number, options: Prop13Options): number {
  const { marketAppreciationPercent, assessedGrowthCap } = validate(purchasePrice, yearsOwned, options);

  const growth = prop13AssessedGrowth(marketAppreciationPercent, assessedGrowthCap);
  const compounded = purchasePrice * Math.pow(1 + growth, yearsOwned);

  return Math.max(purchasePrice, compounded);
}

/** The year's liability: the assessed value times the rate (as a percent). */
export function prop13AnnualTax(assessedValue: number, ratePercent = PROP_13_DEFAULT_RATE_PERCENT): number {
  if (!Number.isFinite(assessedValue)) throw new Error(`assessedValue must be a finite number, received ${String(assessedValue)}.`);
  if (!Number.isFinite(ratePercent)) throw new Error(`ratePercent must be a finite number, received ${String(ratePercent)}.`);
  if (assessedValue < 0) throw new Error(`assessedValue cannot be negative, received ${assessedValue}.`);
  if (ratePercent < 0) throw new Error(`ratePercent cannot be negative, received ${ratePercent}.`);

  return assessedValue * (ratePercent / 100);
}

/**
 * The property tax schedule for one ownership period: one row per year, `yearsOwned + 1` rows, from
 * the purchase year (index 0) to the last year owned (index `yearsOwned`).
 *
 * A sale and repurchase is a new call with the new price and `yearsOwned` starting again at 0; see
 * the module note about the reset.
 *
 * @throws on invalid inputs (see `prop13AssessedValue`).
 */
export function buildProp13Schedule(purchasePrice: number, yearsOwned: number, options: Prop13Options): Prop13Year[] {
  const { ratePercent } = validate(purchasePrice, yearsOwned, options);

  const years: Prop13Year[] = [];
  for (let yearIndex = 0; yearIndex <= yearsOwned; yearIndex++) {
    const assessedValue = prop13AssessedValue(purchasePrice, yearIndex, options);
    years.push({ yearIndex, assessedValue, annualTax: prop13AnnualTax(assessedValue, ratePercent) });
  }

  return years;
}
