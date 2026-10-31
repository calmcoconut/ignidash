/**
 * Property tax as a plan expense (P1-P5, real estate II).
 *
 * A residence's `propertyTax` block is the only place a plan states what it pays the county, and
 * the engine's cash flow only funds expenses, so this module is the bridge between the two: it
 * turns one physical asset's `propertyTax` into the `ExpenseInputs` row the `ExpensesProcessor`
 * already knows how to charge. It is the missing half of `prop-13.ts` — that module answers
 * "what is the bill in year N", this one answers "how does the engine charge it".
 *
 * ## What it derives
 *
 * | `propertyTax` | year-0 amount (real dollars) |
 * | --- | --- |
 * | absent | no expense at all — today's behaviour, the plan pays no property tax through the engine |
 * | `{ ratePercent }` | `prop13AnnualTax(purchasePrice, ratePercent)` |
 * | `{ annualAmount }` | `annualAmount` (the plan knows its own bill) |
 * | `{ annualAmount, ratePercent }` | `annualAmount`; the rate is unused |
 * | `{}` (neither number stated) | no expense at all — a block with no bill in it is not a bill |
 *
 * That last row is deliberate: the mortgage dialog clears the two inputs by writing `undefined`
 * into them, and the block survives that as an empty object. Treating it as "1.1% of the price"
 * would charge a bill the user removed; treating it as "nothing stated" is what both the dialog and
 * a hand-written file mean.
 *
 * The year-0 amount is in the plan's real (today's) dollars when `amountBasis` is `real` and in
 * the purchase date's dollars when it is `nominal`, exactly like `purchasePrice` and the loan
 * amounts — both are scaled by the same factor, so a nominal purchase price and its nominal tax
 * bill stay in proportion.
 *
 * ## The growth rate, and the residency gate
 *
 * The expense grows at a single **real** annual rate, because `ExpensesProcessor` works in real
 * dollars (contract 3.1). Getting that rate right is the whole point:
 *
 * - **California (Absent residency counts as California, exactly as `taxes.ts` reads it.)**
 *   Prop 13 caps the *nominal* growth of the assessed value at 2% a year, so the nominal growth is
 *   `min(nominal appreciation, 2%)`, floored at zero (a falling market does not cut the assessment
 *   below the base-year value — `prop13AssessedValue` floors it there). That nominal growth is
 *   then deflated by the plan's inflation assumption to give the real growth the expense uses.
 *   Applying the cap straight to the plan's real appreciation rate would understate the tax, which
 *   is the one direction a projection must not err in.
 * - **Everywhere else (`stateResidency: 'none'`)** the tax tracks the home's market value, so the
 *   real growth is the plan's own real `appreciationRate` — no cap, and no floor either: a falling
 *   market does cut the bill where the law reassesses to market value.
 *
 * Prop 13 is therefore **not** applied unconditionally: it is gated on `taxSettings.stateResidency`,
 * through the same absent-is-California rule the income tax uses.
 *
 * ## What is deliberately not modelled
 *
 * - **No cash-out for a mid-year sale.** The timeframe ends at the sale date, so the year of the
 *   sale is charged only for the months the asset was owned — the same shape `housing-comparison.ts`
 *   derives, and the engine's own expense time frame does the work.
 * - **No deduction.** Property tax is not fed into itemized deductions here (P3-P3 owns that line,
 *   and it is a tax-return input the user states explicitly).
 * - **No `essential` flag.** The derived row is an ordinary expense, like the property-tax row
 *   `housing-comparison.ts` derives, so a withdrawal cap treats both housing costs the same way.
 *
 * Pure: no clock, no store, no engine state. Everything comes from the asset, the plan's inflation
 * assumption, the residency flag and the run's `TimeBindingContext` (for the real/nominal basis).
 */

import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import type { StateResidencyInputs } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { PROP_13_ASSESSED_GROWTH_CAP, prop13AnnualTax, prop13AssessedGrowth } from './prop-13';
import { TimeBinding, type TimeBindingContext } from './time-binding';

/**
 * The expense id a residence's property tax is charged under.
 *
 * Namespaced rather than random: the id is derived, not chosen, so re-running a plan produces the
 * same row, and an id a user could plausibly have typed cannot collide by accident. The engine
 * refuses a plan that already owns this id rather than overwriting a user's expense.
 */
export const propertyTaxExpenseId = (physicalAssetId: string): string => `property-tax:${physicalAssetId}`;

/** The name the derived expense appears under in every expense breakdown. */
export const PROPERTY_TAX_EXPENSE_NAME = 'Property Tax';

export interface PropertyTaxOptions {
  /** The plan's annual inflation assumption, in percent (`marketAssumptions.inflationRate`). */
  inflationRatePercent: number;
  /**
   * `taxSettings.stateResidency`. Absent reads as California, matching `taxes.ts` (`?? 'CA'`), so a
   * plan written before the flag existed keeps the California rule it was already subject to.
   */
  stateResidency?: StateResidencyInputs;
}

/** Whether Prop 13 applies: California, including a plan that states no residency. */
export function isProp13Residency(stateResidency?: StateResidencyInputs): boolean {
  return stateResidency !== 'none';
}

const percentToRate = (percent: number): number => percent / 100;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`property-tax: ${name} must be a finite number, received ${String(value)}.`);
}

/**
 * The expense's real annual growth rate, in percent, for one residence.
 *
 * @throws if the plan's inflation assumption is at or below -100% (there is no real growth rate to
 *   convert to) or any input is not finite.
 */
export function propertyTaxAnnualGrowthPercent(asset: PhysicalAssetInputs, options: PropertyTaxOptions): number {
  requireFinite('appreciationRate', asset.appreciationRate);
  requireFinite('inflationRatePercent', options.inflationRatePercent);

  if (!isProp13Residency(options.stateResidency)) return asset.appreciationRate;

  const inflationRate = percentToRate(options.inflationRatePercent);
  if (1 + inflationRate <= 0) {
    throw new Error(`property-tax: marketAssumptions.inflationRate must be greater than -100%, received ${options.inflationRatePercent}.`);
  }

  // Prop 13 is a nominal rule and the plan's appreciation rate is real, so the house's
  // appreciation is converted to nominal, capped (and floored at zero) there, and deflated back.
  const realAppreciation = percentToRate(asset.appreciationRate);
  const nominalAppreciationPercent = ((1 + realAppreciation) * (1 + inflationRate) - 1) * 100;
  const nominalGrowth = Math.max(0, prop13AssessedGrowth(nominalAppreciationPercent, PROP_13_ASSESSED_GROWTH_CAP));

  return ((1 + nominalGrowth) / (1 + inflationRate) - 1) * 100;
}

/**
 * The annual bill in the plan's real dollars for the year of purchase — the base the growth rate
 * is applied to. `0` when the asset states no `propertyTax`, no number inside it, or a bill of zero.
 *
 * @throws if the amount is not finite or is negative, or the rate is not finite.
 */
export function propertyTaxBaseAmount(asset: PhysicalAssetInputs, context: TimeBindingContext): number {
  const propertyTax = asset.propertyTax;
  if (propertyTax === undefined) return 0;

  // A nominal amount is expressed in the dollars of the purchase date, exactly like the price it
  // is a percentage of, so both are converted with the same factor.
  const amountScale = new TimeBinding(asset.purchaseDate, undefined, context).amountScale(asset.amountBasis);

  if (propertyTax.annualAmount !== undefined) {
    requireFinite('propertyTax.annualAmount', propertyTax.annualAmount);
    if (propertyTax.annualAmount < 0) {
      throw new Error(`property-tax: propertyTax.annualAmount cannot be negative, received ${propertyTax.annualAmount}.`);
    }

    return propertyTax.annualAmount * amountScale;
  }

  // A block with neither number in it states no bill (see the table in the module header).
  if (propertyTax.ratePercent === undefined) return 0;
  requireFinite('propertyTax.ratePercent', propertyTax.ratePercent);

  return prop13AnnualTax(asset.purchasePrice * amountScale, propertyTax.ratePercent);
}

/**
 * The `ExpenseInputs` row that charges one residence's property tax, or `undefined` when the asset
 * states none (or a bill of zero, which is not worth a row).
 *
 * The time frame is the ownership period: it starts at the purchase date and ends at the sale
 * date, so the year of a sale is charged only for the months the home was owned, and an asset that
 * is never sold (`atLifeExpectancy`) is charged for the whole horizon.
 */
export function propertyTaxExpense(
  asset: PhysicalAssetInputs,
  options: PropertyTaxOptions,
  context: TimeBindingContext
): ExpenseInputs | undefined {
  const amount = propertyTaxBaseAmount(asset, context);
  if (!(amount > 0)) return undefined;

  return {
    id: propertyTaxExpenseId(asset.id),
    name: PROPERTY_TAX_EXPENSE_NAME,
    amount,
    frequency: 'yearly',
    timeframe: {
      start: { ...asset.purchaseDate },
      end: { ...(asset.saleDate ?? { type: 'atLifeExpectancy' }) },
    },
    growth: { growthRate: propertyTaxAnnualGrowthPercent(asset, options) },
  };
}

/**
 * Every property-tax expense a plan's physical assets imply, in asset order.
 *
 * A plan with no `propertyTax` anywhere returns an empty list, which is what keeps a plan written
 * before this field existed simulating exactly as it did.
 */
export function derivePropertyTaxExpenses(
  physicalAssets: readonly PhysicalAssetInputs[],
  options: PropertyTaxOptions,
  context: TimeBindingContext
): ExpenseInputs[] {
  const expenses: ExpenseInputs[] = [];
  for (const asset of physicalAssets) {
    const expense = propertyTaxExpense(asset, options, context);
    if (expense !== undefined) expenses.push(expense);
  }

  return expenses;
}
