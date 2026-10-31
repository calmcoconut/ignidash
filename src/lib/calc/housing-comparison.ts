/**
 * Rent-vs-own comparison (parity plan P1-P6, the pure half).
 *
 * The row: *"Rent-vs-own as `housing-comparison.ts`: two deterministic runs, with and without the
 * residence plus a rent expense, reporting the break-even."* This module is that, and only that:
 * it derives two plans from one, runs both through the pure entry point `simulate()`, and reports
 * the two paths' net worth year by year with the year owning overtakes renting.
 *
 * ## "Differ only in housing", enforced by construction
 *
 * A comparison that differs in two things measures neither. So this module never takes two
 * hand-built plans as its primary input: `compareHousing(base, choice, options)` derives both
 * paths from **one** `base` plan with `deriveHousingPlans()`, and that function touches exactly
 * two fields:
 *
 * | field | owning path | renting path |
 * | --- | --- | --- |
 * | `physicalAssets` | `base.physicalAssets` + the residence | `base.physicalAssets` |
 * | `expenses` | `base.expenses` + property tax + maintenance (+ interim rent) | `base.expenses` + rent |
 *
 * Every other field — `timeline`, `incomes`, `accounts`, `debts`, `contributionRules`,
 * `baseContributionRule`, `marketAssumptions`, `taxSettings`, `privacySettings`,
 * `simulationSettings`, `glidePath` — is passed through **by reference**, the same object in both
 * plans. So the incomes, the spending that is not housing, the market assumptions and the timeline
 * cannot drift between the paths: there is only one of each, and a test asserts that identity.
 * `base.expenses` and `base.physicalAssets` are also shared, so a car or a living expense is paid
 * on both sides; the caller's base plan must not already contain housing costs (documented on
 * `compareHousing`, and a duplicate id throws rather than silently overwriting).
 *
 * The one asymmetry that is *inside* housing is deliberate: if the residence is bought in the
 * future, the owning path pays rent up to and including the purchase month. Without it the owner
 * would live rent-free for the years before closing, and owning would win by an accounting
 * artefact. The entry is always present and simply inactive when the purchase is not in the
 * future, so the owning path has one shape whatever the purchase date.
 *
 * ## "Now" means the plan's first month
 *
 * The engine has no "buy today": an asset dated `now` is constructed as *already owned*, so no
 * purchase outlay is ever charged. That is right for a home the user already has (its cost is
 * baked into the balances they typed in) and wrong for a home the plan is about to buy — it would
 * hand the owning path a house for free, and the comparison would be decided by that gift before
 * it started. `compareHousing` therefore resolves `purchaseDate: { type: 'now' }` to a `customDate`
 * in the plan's first month, which the engine purchases and pays for out of the portfolio.
 * `deriveHousingPlans` has no clock, so it refuses `now` outright rather than guessing; a caller
 * that uses it directly has to date the purchase.
 *
 * ## The renter gets the same capital
 *
 * This is structural rather than a compensating adjustment, which is why it cannot be forgotten:
 * in the owning path the purchase outlay leaves the *same* portfolio the renting path invests, so
 * the down payment (or the whole price, for a cash purchase) simply stays invested in the renting
 * path. The same holds month by month for mortgage payments: the owner's payment leaves the
 * owner's portfolio while the owner accumulates equity, and the renter's portfolio keeps the money
 * it did not spend. No synthetic "invest the difference" contribution is added, because none is
 * needed — and adding one would double-count it. A test pins the direction: in the first year the
 * owning portfolio is far below the renting one, by the whole price for a cash purchase and by the
 * down payment (plus the payments since) for a financed one.
 *
 * ## The headline metric, and the second one
 *
 * Three candidates disagree, so the choice is stated rather than implied:
 *
 * 1. **Portfolio value** — the owner's home equity is invisible to it, so it is not a comparison,
 *    it is a comparison of who kept more in the market. Rejected.
 * 2. **Net worth** (`portfolio + physical-asset market value − debt`) — the engine's own definition
 *    (`netWorthOf`), the number the rest of the app shows, and the only one that counts the house
 *    and the mortgage. **This is the headline.**
 * 3. **Liquidation value** — net worth minus selling costs on the residence. It is the honest
 *    answer at the moment of sale (a 6% commission and closing costs are not optional), but it
 *    understates the owner every year they are *not* selling.
 *
 * So the report leads with net worth — break-even, final winner and every per-year delta — and
 * carries the liquidation series beside it (`liquidationValue`, `deltaLiquidationValue`,
 * `liquidationBreakEven`, `finalLiquidationWinner`), so "owning wins on paper but not if you sell
 * next year" is visible instead of hidden in a footnote. Selling costs apply only to the
 * residence, not to any other physical asset the base plan holds: those are identical on both
 * sides, so their selling costs cancel out of every delta, and charging them would make both
 * absolute series wrong.
 *
 * ## What "break-even" means, and the three states it hides
 *
 * "The year owning breaks even" is ambiguous in exactly the case this comparison usually lands in,
 * so it is defined once here and pinned by tests:
 *
 * - `firstAhead` — the first year owning is ahead at all. It can be temporary.
 * - `breakEven` — the start of the **final** run of years in which owning is ahead: the first year
 *   after which renting never leads again. `breakEven !== null` exactly when `finalWinner` is
 *   `'owning'`.
 * - `breakEven === null` — owning is behind at the end of the horizon. It is *not* "year zero" and
 *   it is *not* "owning was never ahead": a lead given back later is not a break-even, and calling
 *   it one would tell a UI to print "break-even: year 1" for a comparison the owner loses by seven
 *   figures. The lead is still reported, through `firstAhead`.
 *
 * A break-even at the first data point is `{ yearIndex: 0 }`, so a caller can always tell "ahead
 * from the start" from "never". A `firstAhead` with no `breakEven` is the third state: owning led
 * for a while and the lead did not hold.
 *
 * ## Costs, and the plan's real-dollar convention
 *
 * The engine works in today's (real) dollars, so every rate here is real, exactly like
 * `expenses.growth` and `physicalAssets.appreciationRate`:
 *
 * - **Property tax** uses `prop-13.ts` rather than a re-derivation. Prop 13 is a *nominal* law:
 *   the assessment starts at the purchase price and may rise by at most 2% a year. The plan's
 *   appreciation rate is real, so the module converts once, at the boundary — nominal appreciation
 *   is `(1 + real)(1 + inflation) − 1`, the assessed growth is `min(nominal, 2%)` floored at zero
 *   (Prop 13 never cuts below the purchase price), and that nominal growth is deflated back to a
 *   real growth rate. The result is exactly `prop13AnnualTax(prop13AssessedValue(...))` deflated by
 *   the plan's inflation path; the tests check the conversion against hand arithmetic and check the
 *   engine's per-year expense against it. Getting this backwards — applying the 2% cap directly to
 *   a real appreciation rate — would understate the tax, and understating the owner's costs is the
 *   one direction a rent-vs-own comparison must not err in.
 * - **Maintenance and insurance** is a flat percentage of the home's value (1% is the usual rule
 *   of thumb, editable) growing with the plan's appreciation assumption, because a bill that tracks
 *   the house should track the house.
 * - **Rent** is given in real monthly dollars and is flat in real terms by default: rent tracking
 *   inflation is the neutral assumption, and rising faster than inflation is a real question the
 *   caller can ask with `rentRealGrowthRatePercent` rather than one this module assumes.
 * - **Taxes** are the engine's, on each path as given. Neither path gets itemized mortgage interest
 *   or a property-tax deduction, because itemized deductions are not modelled yet (P3-P3). That
 *   omission understates the owner's advantage; it is disclosed here rather than approximated.
 *
 * ## What this module refuses, and what it discloses but does not price
 *
 * - **A residence bought at the start of the plan is a purchase, not a gift.** `purchaseDate: now`
 *   is the engine's "already owned" marker (see above), so `compareHousing` resolves it to a dated
 *   purchase in the plan's first month. A financed residence therefore needs an explicit
 *   `downPayment`: the engine charges `downPayment ?? 0` at purchase and never credits the loan
 *   balance to the portfolio, so without one the owning path would receive a house minus its
 *   mortgage for nothing. That is thrown, not defaulted.
 * - **A housing choice the plan cannot fund is refused.** If one path leaves spending unpaid that
 *   the other pays, the choice is not fundable from the plan's accounts. The engine records
 *   unfunded spending as a shortfall with no liability attached, so that path's net worth would
 *   count housing it never paid for — a house on the owning side or skipped rent on the renting
 *   side. `compareHousingPlans` throws instead of reporting a number that direction, and only when
 *   the two paths *differ*, so a base plan that is underfunded on both sides is still compared.
 * - **A sale inside the horizon is not priced for commission.** The engine sells a physical asset
 *   at full market value, and the 6% here prices a *hypothetical* sale of a house still held —
 *   which is what `liquidationValue` means. If the residence's `saleDate` falls inside the horizon,
 *   owning receives its proceeds with no selling cost and is overstated from that year on. Charging
 *   it here would mean rewriting the engine's definition of net worth, so it is disclosed instead:
 *   keep the sale date at or beyond the horizon (the default `atLifeExpectancy`) for a clean
 *   comparison.
 *
 * ## Purity
 *
 * No clock, no store, no network, no module state: the clock is `asOf` in the options, `simulate()`
 * is a pure function, and this module only reads the results. Two calls with the same arguments
 * return deep-equal reports, which the tests pin.
 */

import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { type ISODateString, parseISODateString } from './clock';
import { netWorthOf } from './data-extractors/cash-flow-ledger';
import { PROP_13_DEFAULT_RATE_PERCENT, prop13AnnualTax, prop13AssessedGrowth, PROP_13_ASSESSED_GROWTH_CAP } from './prop-13';
import { simulate } from './simulate';
import type { SimulationDataPoint } from './simulation-engine';

/** The one sign convention, stated once: the owning path is the subject. */
export const HOUSING_DELTA_MEANING = 'owning - renting' as const;

/** Annual maintenance plus insurance as a percent of the home's value: the usual 1% rule of thumb. */
export const DEFAULT_MAINTENANCE_RATE_PERCENT = 1;

/**
 * Selling costs as a percent of the residence's market value: commission plus closing costs.
 *
 * 6% is the standard rule of thumb (5–6% commission plus ~1% closing costs), and it is an option
 * because it is a local, negotiable number rather than a law.
 */
export const DEFAULT_SELLING_COST_RATE_PERCENT = 6;

/** Real growth of the rent. Zero (rent tracks inflation) is the neutral assumption. */
export const DEFAULT_RENT_REAL_GROWTH_RATE_PERCENT = 0;

/**
 * A difference smaller than a dollar is floating-point noise from summing two runs, not an
 * advantage. It is the single tolerance behind both `breakEven` and the final winner.
 */
export const HOUSING_TIE_TOLERANCE = 1;

/** Id of the derived rent expense on the renting path (and of interim rent on the owning path). */
export const HOUSING_RENT_EXPENSE_ID = 'housing-comparison:rent';

/** Id of the derived property-tax expense on the owning path. */
export const housingPropertyTaxExpenseId = (residenceId: string): string => `housing-comparison:property-tax:${residenceId}`;

/** Id of the derived maintenance-and-insurance expense on the owning path. */
export const housingMaintenanceExpenseId = (residenceId: string): string => `housing-comparison:maintenance:${residenceId}`;

/** The two plans a housing choice produces, both derived from one base plan. */
export interface HousingPlans {
  owning: SimulatorInputs;
  renting: SimulatorInputs;
}

/** What the caller chooses: the residence for one path, the rent for the other, and the rates. */
export interface HousingChoice {
  /**
   * The residence as a physical asset. Its `purchasePrice` is both what the owner pays and Prop 13's
   * base-year assessed value, its `purchaseDate`/`saleDate` bound the ownership costs, and its
   * `appreciationRate` is the plan's real appreciation assumption.
   *
   * Leave `marketValue` undefined for a purchase: the engine starts the asset at `marketValue ??
   * purchasePrice`, so a market value above the price is a gain the comparison will hand the owner
   * (legitimate if the plan really does buy below value, a mistake if it is the current value of a
   * house the plan does not own yet).
   *
   * `purchaseDate: { type: 'now' }` means "at the start of the plan" and is resolved by
   * `compareHousing` to a purchase in the plan's first month; the engine itself would treat `now`
   * as "already owned", which charges nothing.
   */
  residence: PhysicalAssetInputs;
  /** Rent for the renting path, in real monthly dollars, with `frequency: 'monthly'` semantics. */
  monthlyRent: number;
  /** Property tax as a percent of the assessed value; defaults to Prop 13's ~1.1% total. */
  propertyTaxRatePercent?: number;
  /** Maintenance and insurance as a percent of the home's value per year; defaults to 1%. */
  maintenanceRatePercent?: number;
  /** Real growth of the rent, in percent; defaults to 0 (rent tracks inflation). */
  rentRealGrowthRatePercent?: number;
}

/** Arguments that fully determine both runs. `asOf` is required, exactly as `simulate()` requires it. */
export interface HousingComparisonOptions {
  /** The one clock both paths run on, as an ISO date. */
  asOf: ISODateString;
  /** The one seed both paths use (only read by the stochastic mode). */
  seed: number;
  /** Deterministic projection mode; fixed returns is the app's default projection. */
  mode?: 'fixedReturns' | 'stochasticReturns';
  /** Selling costs as a percent of the residence's value; defaults to 6%. */
  sellingCostRatePercent?: number;
  /**
   * The residence to charge selling costs on. `compareHousing` always supplies it; a direct
   * `compareHousingPlans` call that leaves it out reports liquidation value as net worth (no
   * selling costs), which is what makes the identical-plans case a zero-difference check.
   */
  residenceId?: string;
}

/** One path's value at one annual data point. */
export interface HousingPathValue {
  /** Portfolio + physical assets − debt. The headline metric. */
  netWorth: number;
  /** The liquid portfolio alone, for "who kept more invested". */
  portfolio: number;
  /** The residence's market value (0 once sold, and 0 on the renting path). */
  residenceValue: number;
  /** Net worth minus selling costs on the residence. */
  liquidationValue: number;
}

/** One year of the comparison, at the plan's own annual data points. */
export interface HousingYear {
  /** 0 is the end of the plan's first year (the opening snapshot is excluded; see `compareHousingPlans`). */
  yearIndex: number;
  /** Age on the plan's axis at that data point. */
  age: number;
  /** Calendar year of the data point. */
  calendarYear: number;
  owning: HousingPathValue;
  renting: HousingPathValue;
  /** `owning.netWorth − renting.netWorth`. */
  deltaNetWorth: number;
  /** `owning.portfolio − renting.portfolio`. */
  deltaPortfolio: number;
  /** `owning.liquidationValue − renting.liquidationValue`. */
  deltaLiquidationValue: number;
}

/** A year in the series — an index into `years`, with the labels a UI shows. */
export interface HousingBreakEven {
  yearIndex: number;
  age: number;
  calendarYear: number;
}

/** Which path is ahead of the other, within {@link HOUSING_TIE_TOLERANCE}. */
export type HousingWinner = 'owning' | 'renting' | 'tie';

export interface HousingComparisonReport {
  asOf: ISODateString;
  seed: number;
  mode: 'fixedReturns' | 'stochasticReturns';
  deltaMeaning: typeof HOUSING_DELTA_MEANING;
  years: HousingYear[];
  /**
   * The year owning gets ahead **and stays ahead**: the start of the final run of years in which
   * owning is ahead on net worth. `null` when owning is behind in the last year — that is "owning
   * never breaks even within the horizon", which is not "year zero" (owning ahead from the first
   * data point is `{ yearIndex: 0 }`) and not "owning was never ahead" (a lead given back is
   * reported through {@link firstAhead}). `breakEven !== null` exactly when `finalWinner` is
   * `'owning'`.
   */
  breakEven: HousingBreakEven | null;
  /**
   * The first year owning is ahead at all, even temporarily; `null` when owning is behind in every
   * year of the horizon. See `breakEven` for the durable one, and the module header for why the two
   * are separate fields.
   */
  firstAhead: HousingBreakEven | null;
  /**
   * The durable break-even on liquidation value (net worth minus selling costs), and only that: the
   * liquidation series is the secondary lens, so a temporary lead is not reported for it.
   */
  liquidationBreakEven: HousingBreakEven | null;
  finalDeltaNetWorth: number;
  finalDeltaLiquidationValue: number;
  /** The last year's winner on net worth (the headline). */
  finalWinner: HousingWinner;
  /** The last year's winner on liquidation value. */
  finalLiquidationWinner: HousingWinner;
}

const percentToRate = (percent: number): number => percent / 100;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`housing-comparison: ${name} must be a finite number, received ${String(value)}.`);
}

function requireNonNegative(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new Error(`housing-comparison: ${name} cannot be negative, received ${value}.`);
}

/** The owner's real growth rate for the assessed value, converted once from Prop 13's nominal rule. */
function realPropertyTaxGrowthPercent(residence: PhysicalAssetInputs, inflationRatePercent: number): number {
  const inflationRate = percentToRate(inflationRatePercent);
  if (1 + inflationRate <= 0) {
    throw new Error(`housing-comparison: marketAssumptions.inflationRate must be greater than -100%, received ${inflationRatePercent}.`);
  }

  // Prop 13 is a nominal rule; the plan's appreciation assumption is real. Convert the house's
  // real appreciation to nominal, apply the rule, then deflate the result by the plan's inflation.
  const realAppreciation = percentToRate(residence.appreciationRate);
  const nominalAppreciationPercent = ((1 + realAppreciation) * (1 + inflationRate) - 1) * 100;

  // Floored at zero: a falling market does not cut the assessment below the purchase price, which
  // is Prop 13's own floor (`prop13AssessedValue` applies it with `Math.max`).
  const nominalGrowth = Math.max(0, prop13AssessedGrowth(nominalAppreciationPercent, PROP_13_ASSESSED_GROWTH_CAP));

  return ((1 + nominalGrowth) / (1 + inflationRate) - 1) * 100;
}

/**
 * The residence with a `now` purchase date resolved to the plan's first month.
 *
 * `now` is the engine's "already owned" marker, not "buy this month": an asset dated `now` is
 * constructed as owned, so no purchase outlay is ever charged and the owning path would start with
 * a house the plan never paid for (the account balances are the user's *current* ones, which a
 * past purchase is already reflected in). For the comparison, "buy now" means "buy at the start of
 * the projection", which is a dated purchase in the plan's first month — the month the engine's
 * loop processes first. See the module header.
 */
function withPlanStartPurchaseDate(residence: PhysicalAssetInputs, asOf: ISODateString): PhysicalAssetInputs {
  if (residence.purchaseDate.type !== 'now') return residence;

  // A conversion turns "already owned" into "bought in month 1", which is a cash purchase the plan
  // must pay for. An already-owned mortgage has no `downPayment` (its equity is already in the
  // balances the user typed in), so the engine would charge `downPayment ?? 0` and hand the owning
  // path the house minus its mortgage for free. Guessing `purchasePrice - loanBalance` would invent
  // a number the caller never gave, so the conversion is refused instead.
  if (residence.paymentMethod.type === 'loan' && residence.paymentMethod.downPayment === undefined) {
    throw new Error(
      `housing-comparison: residence "${residence.id}" is dated "now" and financed without a downPayment. "now" is the engine's already-owned marker, so compareHousing() converts it to a purchase in the plan's first month; that purchase needs an explicit downPayment (purchasePrice - loanBalance) or the owning path would be given ${residence.purchasePrice - residence.paymentMethod.loanBalance} of equity it never paid for. Set paymentMethod.downPayment, or compare a residence that is already owned with a dated purchase date.`
    );
  }

  const { year, month } = parseISODateString(asOf);
  return { ...residence, purchaseDate: { type: 'customDate', year, month } };
}

/**
 * Derive the owning and renting plans from one base plan plus the housing choice.
 *
 * Pure, and the place where "differ only in housing" is true by construction: only `expenses` and
 * `physicalAssets` are rebuilt, and every other field is shared with `base` by reference.
 *
 * The residence must carry a **dated** purchase: a `now` purchase is the engine's "already owned"
 * marker and would charge nothing (see `withPlanStartPurchaseDate`). `compareHousing` resolves
 * `now` to the plan's first month before calling this, so the convenience API still accepts it;
 * a direct caller has to date the purchase.
 *
 * @throws if the residence's purchase date is `now`, if its id is already a physical asset on the
 *   base plan, if a derived expense id collides with an existing expense, if the rent is not
 *   positive, or if a rate is negative or non-finite. Each of those would otherwise corrupt the
 *   comparison silently.
 */
export function deriveHousingPlans(base: SimulatorInputs, choice: HousingChoice): HousingPlans {
  const { residence, monthlyRent } = choice;
  const propertyTaxRatePercent = choice.propertyTaxRatePercent ?? PROP_13_DEFAULT_RATE_PERCENT;
  const maintenanceRatePercent = choice.maintenanceRatePercent ?? DEFAULT_MAINTENANCE_RATE_PERCENT;
  const rentRealGrowthRatePercent = choice.rentRealGrowthRatePercent ?? DEFAULT_RENT_REAL_GROWTH_RATE_PERCENT;

  requireFinite('monthlyRent', monthlyRent);
  if (monthlyRent <= 0) throw new Error(`housing-comparison: monthlyRent must be greater than zero, received ${monthlyRent}.`);
  requireNonNegative('propertyTaxRatePercent', propertyTaxRatePercent);
  requireNonNegative('maintenanceRatePercent', maintenanceRatePercent);
  requireFinite('rentRealGrowthRatePercent', rentRealGrowthRatePercent);

  if (residence.purchaseDate.type === 'now') {
    throw new Error(
      'housing-comparison: the residence must be purchased on a date, not at "now". The engine treats a `now` asset as already owned and already paid for, so the owning path would receive the house for free; use compareHousing() to resolve "now" to the plan\'s first month.'
    );
  }

  if (base.physicalAssets[residence.id] !== undefined) {
    throw new Error(
      `housing-comparison: the base plan already has a physical asset with id "${residence.id}"; the residence must be the only difference between the paths.`
    );
  }

  const propertyTaxId = housingPropertyTaxExpenseId(residence.id);
  const maintenanceId = housingMaintenanceExpenseId(residence.id);
  for (const id of [HOUSING_RENT_EXPENSE_ID, propertyTaxId, maintenanceId]) {
    if (base.expenses[id] !== undefined) {
      throw new Error(
        `housing-comparison: the base plan already has an expense with id "${id}"; the comparison owns that id and will not overwrite an entry it did not create.`
      );
    }
  }

  // The home's value at purchase: `marketValue` when the plan carries a current value, else the
  // purchase price (the engine's own default when no separate market value is given).
  const valueBasis = residence.marketValue ?? residence.purchasePrice;
  const housingTimeframe = { start: { ...residence.purchaseDate }, end: { ...residence.saleDate } };

  const propertyTax: ExpenseInputs = {
    id: propertyTaxId,
    name: 'Property Tax',
    // Year 0: the purchase price times the rate, straight from `prop-13.ts`.
    amount: prop13AnnualTax(residence.purchasePrice, propertyTaxRatePercent),
    frequency: 'yearly',
    timeframe: housingTimeframe,
    // Real growth, converted once from the nominal rule; the plan's inflation assumption is the
    // same one the engine uses for every other real/nominal conversion.
    growth: { growthRate: realPropertyTaxGrowthPercent(residence, base.marketAssumptions.inflationRate) },
  };

  const maintenance: ExpenseInputs = {
    id: maintenanceId,
    name: 'Maintenance & Insurance',
    amount: valueBasis * percentToRate(maintenanceRatePercent),
    frequency: 'yearly',
    timeframe: housingTimeframe,
    // A bill that tracks the house tracks the house: real growth equals the appreciation rate.
    growth: { growthRate: residence.appreciationRate },
  };

  const rent: ExpenseInputs = {
    id: HOUSING_RENT_EXPENSE_ID,
    name: 'Rent',
    amount: monthlyRent,
    frequency: 'monthly',
    timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    growth: { growthRate: rentRealGrowthRatePercent },
  };

  // The owner needs somewhere to live before closing too. The bound is the purchase date, so the
  // expense is live up to and including the month of closing — for a purchase at the plan's first
  // month it is present but never active (the first month the engine processes is the one after
  // `asOf`), which keeps the owning path's shape independent of the purchase date and leaves one
  // code path instead of two.
  const interimRent: ExpenseInputs = {
    id: HOUSING_RENT_EXPENSE_ID,
    name: 'Rent',
    amount: monthlyRent,
    frequency: 'monthly',
    timeframe: { start: { type: 'now' }, end: { ...residence.purchaseDate } },
    growth: { growthRate: rentRealGrowthRatePercent },
  };

  return {
    owning: {
      ...base,
      physicalAssets: { ...base.physicalAssets, [residence.id]: residence },
      expenses: {
        ...base.expenses,
        [propertyTax.id]: propertyTax,
        [maintenance.id]: maintenance,
        [interimRent.id]: interimRent,
      },
    },
    renting: {
      ...base,
      expenses: { ...base.expenses, [rent.id]: rent },
    },
  };
}

const ahead = (delta: number): boolean => delta > HOUSING_TIE_TOLERANCE;

const winnerOf = (delta: number): HousingWinner => {
  if (ahead(delta)) return 'owning';
  if (delta < -HOUSING_TIE_TOLERANCE) return 'renting';
  return 'tie';
};

/** Read one path's four numbers off an annual data point. */
function valueOf(dataPoint: SimulationDataPoint, residenceValue: number, sellingCostRatePercent: number): HousingPathValue {
  const netWorth = netWorthOf(dataPoint);
  return {
    netWorth,
    portfolio: dataPoint.portfolio.totalValue,
    residenceValue,
    liquidationValue: netWorth - residenceValue * percentToRate(sellingCostRatePercent),
  };
}

/** The residence's market value at one data point; 0 once sold, absent, or never bought. */
function residenceValueOf(dataPoint: SimulationDataPoint, residenceId: string | undefined): number {
  if (residenceId === undefined) return 0;
  return dataPoint.physicalAssets?.perAssetData[residenceId]?.marketValue ?? 0;
}

/**
 * Run two plans and compare them. The primary API is `compareHousing()`, which derives the pair;
 * this entry point exists for a caller that already has both plans (and for tests that must prove
 * identical plans compare to exactly zero).
 *
 * Both sides run on the same `asOf`, `seed` and `mode`, so the only difference left is the plans.
 *
 * The series starts at the plan's **first annual data point**, not at `simulate()`'s opening
 * snapshot. `data[0]` predates the simulation loop: it carries opening balances and no flows, so it
 * is a row with no time in it (the cash-flow ledger makes the same distinction). A residence dated
 * on a calendar date is still `pending` at that snapshot — `deriveHousingPlans` accepts nothing
 * else — so both paths report the same starting net worth there and the row would be a constant
 * zero dressed up as "year 1", with a break-even at `yearIndex: 0` that means nothing. So
 * `yearIndex: 0` is the end of the plan's first year: every row is an annual data point with twelve
 * months of transactions behind it.
 *
 * @throws if a run does not produce the requested mode, if the two timelines differ in length, if a
 *   selling-cost rate is negative or non-finite, if the plans produce no annual data points, or if
 *   one path cannot fund the housing the other pays for (see `assertHousingIsFunded`).
 */
export function compareHousingPlans(
  owning: SimulatorInputs,
  renting: SimulatorInputs,
  options: HousingComparisonOptions
): HousingComparisonReport {
  const mode = options.mode ?? 'fixedReturns';
  const sellingCostRatePercent = options.sellingCostRatePercent ?? DEFAULT_SELLING_COST_RATE_PERCENT;
  requireNonNegative('sellingCostRatePercent', sellingCostRatePercent);

  const runOptions = { mode, seed: options.seed, asOf: options.asOf } as const;
  const owningRun = simulate(owning, runOptions);
  const rentingRun = simulate(renting, runOptions);
  if (owningRun.mode !== mode) throw new Error(`housing-comparison: expected a ${mode} run for the owning path`);
  if (rentingRun.mode !== mode) throw new Error(`housing-comparison: expected a ${mode} run for the renting path`);

  // `slice(1)`: drop the opening snapshot — see the note above on why it is not a year.
  const owningData = owningRun.result.data.slice(1);
  const rentingData = rentingRun.result.data.slice(1);
  if (owningData.length !== rentingData.length) {
    throw new Error(
      `housing-comparison: the two paths have different horizons (${owningData.length} vs ${rentingData.length} annual data points); they must share the timeline.`
    );
  }

  const years: HousingYear[] = owningData.map((owningPoint, index) => {
    const rentingPoint = rentingData[index];
    const owningValue = valueOf(owningPoint, residenceValueOf(owningPoint, options.residenceId), sellingCostRatePercent);
    const rentingValue = valueOf(rentingPoint, 0, sellingCostRatePercent);

    return {
      yearIndex: index,
      age: owningPoint.age,
      calendarYear: Number(owningPoint.date.slice(0, 4)),
      owning: owningValue,
      renting: rentingValue,
      deltaNetWorth: owningValue.netWorth - rentingValue.netWorth,
      deltaPortfolio: owningValue.portfolio - rentingValue.portfolio,
      deltaLiquidationValue: owningValue.liquidationValue - rentingValue.liquidationValue,
    };
  });

  const last = years[years.length - 1];
  if (last === undefined) {
    throw new Error('housing-comparison: the plans produced no annual data points, so there is nothing to compare.');
  }

  // A purchase the plan cannot pay for is not a comparison: see `assertHousingIsFunded`.
  assertHousingIsFunded(owningData, rentingData);

  const labelOf = (year: HousingYear): HousingBreakEven => ({
    yearIndex: year.yearIndex,
    age: year.age,
    calendarYear: year.calendarYear,
  });

  /** The first year owning is ahead, even if the lead does not hold. */
  const firstAheadOf = (deltaOf: (year: HousingYear) => number): HousingBreakEven | null => {
    const found = years.find((year) => ahead(deltaOf(year)));
    return found === undefined ? null : labelOf(found);
  };

  /**
   * The start of the final run of years in which owning is ahead: scan back from the last year while
   * owning leads. A lead that is later given back is not a break-even, which is why this is not
   * `firstAheadOf` — see the module header.
   */
  const durableBreakEvenOf = (deltaOf: (year: HousingYear) => number): HousingBreakEven | null => {
    let index = years.length - 1;
    if (!ahead(deltaOf(years[index]))) return null;
    while (index > 0 && ahead(deltaOf(years[index - 1]))) index -= 1;
    return labelOf(years[index]);
  };

  return {
    asOf: options.asOf,
    seed: options.seed,
    mode,
    deltaMeaning: HOUSING_DELTA_MEANING,
    years,
    breakEven: durableBreakEvenOf((year) => year.deltaNetWorth),
    firstAhead: firstAheadOf((year) => year.deltaNetWorth),
    liquidationBreakEven: durableBreakEvenOf((year) => year.deltaLiquidationValue),
    finalDeltaNetWorth: last.deltaNetWorth,
    finalDeltaLiquidationValue: last.deltaLiquidationValue,
    finalWinner: winnerOf(last.deltaNetWorth),
    finalLiquidationWinner: winnerOf(last.deltaLiquidationValue),
  };
}

/**
 * Refuse to compare a housing choice the plan cannot pay for.
 *
 * The engine pays expenses out of the portfolio and, when every account is empty, records the
 * remainder as `portfolio.outstandingShortfall` — an unfunded bill, not a liability. `netWorthOf`
 * does not see it, so a path that cannot pay still shows the house it bought (or the years of rent
 * it skipped) while the other path shows only what it actually paid. The result is a large, fake
 * advantage, in either direction.
 *
 * Only the *difference* is fatal: a base plan that is underfunded on both sides is a different (and
 * legitimate) question, and the housing difference is still measured on it. Peak, not final,
 * because a shortfall that is repaid later still leaves the years in between overstated.
 *
 * @throws when one path's peak outstanding shortfall exceeds the other's by more than
 *   {@link HOUSING_TIE_TOLERANCE}, naming the path whose numbers cannot be trusted.
 */
function assertHousingIsFunded(owningData: SimulationDataPoint[], rentingData: SimulationDataPoint[]): void {
  const peakShortfall = (data: SimulationDataPoint[]): number =>
    data.reduce((peak, point) => Math.max(peak, point.portfolio.outstandingShortfall), 0);

  const owning = peakShortfall(owningData);
  const renting = peakShortfall(rentingData);
  if (Math.abs(owning - renting) <= HOUSING_TIE_TOLERANCE) return;

  const [unfunded, funded] = owning > renting ? (['owning', renting] as const) : (['renting', owning] as const);
  const peak = unfunded === 'owning' ? owning : renting;

  throw new Error(
    `housing-comparison: the ${unfunded} path leaves up to ${Math.round(peak)} of spending unfunded while the other path leaves ${Math.round(funded)}. The housing difference is not fundable from the plan's accounts, and the engine records unfunded spending without a liability, so the ${unfunded} path's net worth counts housing it never paid for. Fund the choice from the plan's accounts, or compare a cheaper residence or a lower rent.`
  );
}

/**
 * Compare renting with owning the given residence, derived from one base plan.
 *
 * `base` is the plan *without* the housing decision: same incomes, same non-housing spending, same
 * portfolio. It must not already contain rent or ownership costs, or those costs would be paid on
 * both paths and the difference would be diluted rather than measured.
 *
 * A residence dated `now` is resolved to a purchase in the plan's first month, which is what "buy
 * now" means for a projection (see `withPlanStartPurchaseDate`); any other purchase date is used
 * as given, and the owning path pays rent until that date.
 */
export function compareHousing(base: SimulatorInputs, choice: HousingChoice, options: HousingComparisonOptions): HousingComparisonReport {
  const resolved: HousingChoice = { ...choice, residence: withPlanStartPurchaseDate(choice.residence, options.asOf) };
  const plans = deriveHousingPlans(base, resolved);
  return compareHousingPlans(plans.owning, plans.renting, { ...options, residenceId: resolved.residence.id });
}
