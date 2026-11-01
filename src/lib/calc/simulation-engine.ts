/**
 * Financial simulation engine
 *
 * Core engine that runs month-by-month financial simulations with annual tax
 * reconciliation. Supports fixed returns, Monte Carlo (stochastic), and
 * historical backtest (LCG) simulation modes. Produces time-series data
 * for charts, tables, and key metrics extraction.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { HistoricalBacktestMode } from '@/lib/schemas/inputs/simulation-settings-form-schema';
import { type TimelineInputs, type RetirementStrategyInputs, calculatePreciseAge } from '@/lib/schemas/inputs/timeline-form-schema';
import {
  type Household,
  type HouseholdMemberRole,
  type Owner,
  type PropertyRegime,
  isCoupleHousehold,
  ownerOf,
  propertyRegimeOf,
  resolveHouseholdMembers,
} from '@/lib/schemas/inputs/household-schema';
import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { type CalendarDate, type Clock, type ISODateString, addMonths, formatISODate, parseISODateString, toSimulationDate } from './clock';

import type { ReturnsProvider } from './returns-providers/returns-provider';
import { StochasticReturnsProvider } from './returns-providers/stochastic-returns-provider';
import { LcgHistoricalBacktestReturnsProvider } from './returns-providers/lcg-historical-backtest-returns-provider';

import { Portfolio, type PortfolioData, PortfolioProcessor } from './portfolio';
import { getWithdrawalStrategy } from './withdrawal-strategies';
import { type AccountDataWithFlows, TaxableBrokerageAccount } from './account';
import { ContributionRules } from './contribution-rules';
import { PhaseIdentifier, type PhaseData } from './phase';
import { ReturnsProcessor, type ReturnsData } from './returns';
import { Incomes, IncomesProcessor, type IncomesData } from './incomes';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';

import { PayrollTaxProcessor, type WagePayrollTaxes } from './payroll-taxes';
import { Expenses, ExpensesProcessor, type ExpensesData } from './expenses';
import { derivePropertyTaxExpenses } from './property-tax';
import { Debts, DebtsProcessor, type DebtsData, type DebtData } from './debts';
import { PhysicalAssets, PhysicalAssetsProcessor, type PhysicalAssetsData, type PhysicalAssetData } from './physical-assets';
import { TimeBinding, type TimeBindingContext } from './time-binding';
import { PENDING_MILESTONE_LATCH, type MilestoneLatchState, type MilestoneSnapshot, tickMilestoneLatch } from './milestones';
import type { MilestoneFireDate } from './milestones';
import type { MilestoneInputs } from '@/lib/schemas/inputs/milestone-form-schema';
import { TaxProcessor, type ReturnOwnership, type TaxesData, type TaxProcessorSettings } from './taxes';
import { taxYearFor } from './tax-data';
import type { TaxYear } from './tax-data/types';
import { type AssetFlows, zeroAssetAmounts } from './asset';

/**
 * Tax convergence threshold in dollars.
 * The iterative tax reconciliation loop converges when the remaining taxes due
 * are within this threshold, leaving small residual values in cash flow calculations.
 * The loop runs at most 10 iterations before accepting the current approximation.
 */
export const TAX_CONVERGENCE_THRESHOLD = 1;

/** The first day of the calendar month reached `months` months after the run's start date. */
function monthStartAfter(start: CalendarDate, months: number): CalendarDate {
  return { ...addMonths(start, months), day: 1 };
}

/**
 * The first day of the calendar month reached `years` years after the run's start date.
 * Pure integer month arithmetic on the clock date, so it never consults a timezone.
 */
function yearStartAfter(start: CalendarDate, years: number): CalendarDate {
  return monthStartAfter(start, years * 12);
}

/** Months in one settlement period: the engine closes a year every twelfth month. */
const SETTLEMENT_PERIOD_MONTHS = 12;

/**
 * The tax year of the settlement period that begins `monthsElapsed` months into the run.
 *
 * A period is settled on the boundary that ends it, so its ruleset is the one in force on that
 * date — the year the row's own `date` carries, which is `taxYearFor(start, monthsElapsed + 12)`.
 * Payroll withholding inside the period uses this same year, so the payroll table and the
 * income-tax table of a settlement can never disagree.
 *
 * Using the run's *start* year for payroll instead left the first settlement withholding 2026's
 * SDI rate (1.3%) while its income tax already settled under 2027 (1.4%): a one-year lag that
 * corrected itself only from the second settlement on.
 */
function settlementTaxYearForPeriod(start: CalendarDate, monthsElapsed: number): TaxYear {
  return taxYearFor(start, monthsElapsed + SETTLEMENT_PERIOD_MONTHS);
}

/**
 * The filing status a run settles taxes under (P1-P3, piece 4: derived from the household).
 *
 * A household of one — and a plan written before households existed, which reads as one member —
 * keeps the status stored in `taxSettings`, so a single-member plan files exactly as it does
 * today: `single` by default, and `headOfHousehold` where the user already selected it.
 *
 * A household of two files jointly, or — when the plan says so — separately. `marriedFilingJointly`
 * is the status a couple settles under unless they have explicitly chosen
 * `marriedFilingSeparately` (P3-P1b), which is two returns and is priced by `TaxProcessor` as such.
 * Any other stored status is deliberately ignored rather than half-honoured: a two-member plan that
 * still says `single` was written before the household existed, and filing it as one person would be
 * the wrong answer.
 */
export function deriveFilingStatus(household: Household | undefined, storedFilingStatus: FilingStatus): FilingStatus {
  if (!isCoupleHousehold(household)) return storedFilingStatus;

  return storedFilingStatus === 'marriedFilingSeparately' ? 'marriedFilingSeparately' : 'marriedFilingJointly';
}

/**
 * SECURE Act 2.0: RMD age is 75 for those born 1960 or later, otherwise 73.
 *
 * A member's *own* birth year decides this for that member's accounts (P1-P3 piece 1), so two
 * members born on either side of 1960 start RMDs two years apart.
 */
export function secureActRmdAge(birthYear: number): number {
  return birthYear >= 1960 ? 75 : 73;
}

/**
 * The filing status the survivor settles under once the first member of a couple has died.
 *
 * `settlementYearEndAge` is the plan-axis age at which the settlement year ends, so the year
 * *containing* the death is still a joint return — the decedent files jointly for the year of
 * death — and the survivor files single from the next one. A null widow's exemption is not the
 * point here: qualifying surviving spouse status needs a dependent child, which this plan does
 * not model, so the survivor falls to single as soon as the year of death is closed.
 *
 * A single-member plan (no recorded first death) keeps its stored status, which is why this is
 * a no-op for every plan that is not a couple.
 */
export function survivorFilingStatus(
  baseFilingStatus: FilingStatus,
  firstDeath: { readonly age: number } | undefined,
  settlementYearEndAge: number
): FilingStatus {
  if (firstDeath === undefined) return baseFilingStatus;

  return settlementYearEndAge - 1 >= firstDeath.age ? 'single' : baseFilingStatus;
}

/**
 * The share of an account whose cost basis steps up at the first death (IRC §1014, P1-P3 piece 4).
 *
 * - Community property (a `joint` item with the California default regime) steps up **in full**:
 *   §1014(b)(6) resets both halves of community property, not just the deceased's.
 * - The deceased's half of anything else steps up: `jointTenancy` property, and the deceased's
 *   separate property, which this model treats as half the deceased's own (the conservative
 *   reading — it never overstates the step-up on a solely owned item).
 * - The survivor's separate property does not step up at all: it was never inherited.
 *
 * A member's own accounts carry `owner: 'primary'` or `'partner'`; a couple's jointly held item
 * is the only one that can be community property, because `propertyRegimeOf` only returns a
 * regime for a `joint` item.
 */
export function basisStepUpFraction(
  input: { owner?: Owner | undefined; propertyRegime?: PropertyRegime | undefined },
  deceased: HouseholdMemberRole
): number {
  const regime = propertyRegimeOf(input);
  if (regime === 'community') return 1;
  if (regime === 'jointTenancy') return 0.5;

  return ownerOf(input) === deceased ? 0.5 : 0;
}

/**
 * One milestone's outcome for a run.
 *
 * `firedAt` is the **month start at which the condition first held** — the latch's stamp, not a
 * later month that happened to satisfy it — or `null` when the milestone was never reached inside
 * the horizon. There is no "still met" flag: once fired, a milestone is met for the rest of the run
 * by construction (the latch has no reset), which is why the report can answer with one date.
 */
export interface MilestoneRunReport {
  readonly id: string;
  readonly name: string;
  readonly firedAt: MilestoneFireDate | null;
}

/** A single year's output data from the simulation */
export interface SimulationDataPoint {
  date: ISODateString;
  age: number;
  portfolio: PortfolioData;
  incomes: IncomesData | null;
  expenses: ExpensesData | null;
  debts: DebtsData | null;
  physicalAssets: PhysicalAssetsData | null;
  phase: PhaseData | null;
  taxes: TaxesData | null;
  returns: ReturnsData | null;
}

/** Complete output from a single simulation run */
export interface SimulationResult {
  data: Array<SimulationDataPoint>;
  context: {
    startAge: number;
    endAge: number;
    yearsToSimulate: number;
    startDate: ISODateString;
    endDate: ISODateString;
    retirementStrategy: RetirementStrategyInputs;
    rmdAge: number;
    historicalRanges?: Array<{ startYear: number; endYear: number }>;
    /**
     * Present only when the run ran past the last vendored year and restarted at its beginning
     * (`historicalBacktest.mode: 'looping'`). Absent on a no-wrap run, so those results keep their
     * original shape.
     */
    historicalWrapped?: boolean;
    /**
     * Present only when a `'truncate'` run needed more data than the vendored range holds: the last
     * vendored year it had, so the UI can disclose where the data ran out.
     */
    truncatedAtYear?: number;
  };
  /**
   * Each milestone's outcome, in the plan's own order (P1-P7).
   *
   * **Absent when the plan has no milestones**: the key is only present for a plan that states
   * some, so a plan without them produces exactly the result object — and therefore exactly the
   * bytes — it produced before milestones existed (the golden corpus is the witness).
   */
  milestones?: MilestoneRunReport[];
}

/** Immutable simulation parameters derived from user inputs */
export interface SimulationContext {
  readonly startAge: number;
  readonly endAge: number;
  readonly yearsToSimulate: number;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly retirementStrategy: RetirementStrategyInputs;
  /**
   * The plan-axis age at which RMDs begin for the household as a whole: the *earliest* member's,
   * so it stays "from age 73/75" for one person and reports when the first RMD of a couple is due.
   */
  readonly rmdAge: number;
  /**
   * The plan-axis age at which each owner's RMDs begin, from that member's own birth year
   * (P1-P3 piece 1). Optional so a context built without a household (a unit test, say) falls
   * back to `rmdAge` for every account, which is the pre-household behaviour.
   */
  readonly rmdAgeByOwner?: Record<Owner, number>;
  /**
   * Each owner's own age, as an offset from the plan axis (P1-P3): `planAge - offset` is that
   * owner's age, so a partner born in a different year does not read the primary's age at a gate
   * (the 59.5 qualified-withdrawal and 65 HSA thresholds, and the withdrawal-order switch).
   *
   * Optional so a context built without a household (a unit test, say) reads the plan's own age for
   * every account, which is the pre-household behaviour. `joint` follows `rmdAgeByOwner.joint`: the
   * first of its owners to reach the gate, i.e. the older member.
   */
  readonly ageOffsetByOwner?: Record<Owner, number>;
  /**
   * Each member's own birth year (P1-P3), for the Social Security claiming adjustment: the full
   * retirement age is a function of the earner's birth year, not of the plan's. Optional on the
   * same terms — absent means every owner reads as the primary's, and `joint` follows the older
   * member, as `ageOffsetByOwner` does.
   */
  readonly birthYearByOwner?: Record<Owner, number>;
  /**
   * Each member's own birth month, paired with `birthYearByOwner` for a rule measured from a birth
   * date — the §72(t)(4) 59½ date of a SEPP schedule. Same optionality and `joint` rule.
   */
  readonly birthMonthByOwner?: Record<Owner, number>;
  /** `ownerOf` for every account, keyed by account id. Absent means every account is `primary`. */
  readonly accountOwners?: Record<string, Owner>;
  /** `ownerOf` for every physical asset, keyed by asset id. Absent means every asset is `primary`. */
  readonly physicalAssetOwners?: Record<string, Owner>;
  /**
   * The first death of a two-member household, in plan-axis age, and only when a survivor
   * outlives it. Absent for one member (the run simply ends) and for a couple whose expectancies
   * are equal (no survivor window, so nothing to transition).
   */
  readonly firstDeath?: { readonly age: number; readonly owner: HouseholdMemberRole };
}

/** Mutable simulation state that evolves each month */
export interface SimulationState {
  time: { date: Date; age: number; year: number; month: number };
  portfolio: Portfolio;
  phase: PhaseData | null;
  annualData: { expenses: ExpensesData[]; debts: DebtsData[]; physicalAssets: PhysicalAssetsData[] };
}

/**
 * The month-start reading a milestone is evaluated against (P1-P7).
 *
 * Everything is read at one instant — this month's start, before any of the month's transactions —
 * so two milestones evaluated in the same month cannot disagree about what the plan looked like:
 *
 * - `age`, `portfolio` and `accounts` come from the live month-start state, so a "net worth ≥ $1M"
 *   milestone fires in the month the balance crosses, not in the January after it;
 * - `netWorth` is `portfolio + physical assets − debt`, the same definition
 *   `SimulationDataExtractor.getAssetsAndLiabilitiesData` uses for the net-worth chart (asserted in
 *   `milestones-wiring.test.ts`), with the portfolio taken live and the assets/debts from the last
 *   settled data point — the engine settles those annually, so a monthly figure for them does not
 *   exist to read;
 * - `income` and `expense` are the last settled data point's totals for the same reason: the
 *   incomes and expenses processors accumulate a period and report it at settlement. They are `0`
 *   before the first settlement (the initial data point carries no flows);
 * - `year`/`month` are the calendar values of the month start, taken with `addMonths` on the clock's
 *   ISO date so no host timezone can move the fire date.
 */
/**
 * Each traditional IRA's after-tax basis, keyed by account id, for Form 8606's pro-rata rule.
 *
 * An IRA with no stated basis is left out rather than stored as zero: `iraBasisAtStartOfYear` reads
 * an absent account as no basis, so the two spellings behave identically while the map stays small.
 * The field exists on the `ira` variant alone — a 401(k) or HSA balance follows IRC §72, not
 * §408(d)(2) — so this switch cannot silently collect a basis nothing would apportion.
 */
function iraBasisByAccountFrom(accounts: Record<string, AccountInputs>): Record<string, number> {
  const basisByAccount: Record<string, number> = {};

  for (const account of Object.values(accounts)) {
    if (account.type !== 'ira') continue;
    if (account.nondeductibleBasis === undefined || account.nondeductibleBasis <= 0) continue;
    basisByAccount[account.id] = account.nondeductibleBasis;
  }

  return basisByAccount;
}

function milestoneSnapshotAt(
  simulationState: SimulationState,
  startCalendarDate: CalendarDate,
  lastSettled: SimulationDataPoint
): MilestoneSnapshot {
  const { year, month } = addMonths(startCalendarDate, simulationState.time.month);

  const portfolio = simulationState.portfolio.getTotalValue();
  const accounts = Object.fromEntries(
    simulationState.portfolio.getAccounts().map((account) => [account.getAccountID(), account.getBalance()])
  );

  const marketValue = lastSettled.physicalAssets?.totalMarketValue ?? 0;
  const securedDebt = lastSettled.physicalAssets?.totalLoanBalance ?? 0;
  const unsecuredDebt = lastSettled.debts?.totalDebtBalance ?? 0;

  return {
    age: simulationState.time.age,
    year,
    month,
    portfolio,
    income: lastSettled.incomes?.totalIncome ?? 0,
    expense: lastSettled.expenses?.totalExpenses ?? 0,
    netWorth: portfolio + marketValue - (securedDebt + unsecuredDebt),
    accounts,
  };
}

/**
 * Base simulation engine that runs a month-by-month simulation with annual tax reconciliation.
 *
 * The engine never reads the wall clock: `clock.asOf` is the only source of "today", so a run
 * is a pure function of its inputs plus that explicit date.
 */
export class FinancialSimulationEngine {
  constructor(
    protected readonly inputs: SimulatorInputs,
    protected readonly clock: Clock
  ) {}

  /**
   * Runs a complete financial simulation from start to end date
   * @param returnsProvider - Strategy for generating investment returns each year
   * @param timeline - User's timeline inputs (birth date, retirement, life expectancy)
   * @returns Complete simulation result with time-series data and context
   */
  runSimulation(returnsProvider: ReturnsProvider, timeline: TimelineInputs): SimulationResult {
    // Init context and state. Calendar values come from the clock's ISO string only, never
    // from host-timezone getters, so ages and date labels are identical on every host.
    const startCalendarDate = parseISODateString(this.clock.asOf);
    const simulationContext: SimulationContext = this.initSimulationContext(timeline, startCalendarDate);
    const simulationState: SimulationState = this.initSimulationState(simulationContext);

    // Every dated event binds against the same plan start and inflation assumption, so nominal
    // amounts and recurrence cadences resolve identically for every entity type.
    const timeBindingContext: TimeBindingContext = {
      startAge: simulationContext.startAge,
      startDate: simulationContext.startDate,
      marketAssumptions: this.inputs.marketAssumptions,
      ...(simulationContext.birthYearByOwner === undefined ? {} : { birthYearByOwner: simulationContext.birthYearByOwner }),
    };

    // Filing status follows the household, not the stored field alone (piece 4). Both tax
    // processors take it, so the Additional Medicare threshold and the income-tax brackets agree.
    const baseFilingStatus = deriveFilingStatus(timeline.household, this.inputs.taxSettings.filingStatus);
    // A survivor household starts single if the first death fell before the plan did.
    let filingStatus = survivorFilingStatus(baseFilingStatus, simulationContext.firstDeath, simulationContext.startAge + 1);

    // Wage income that keeps a couple in accumulation (piece 3: the joint phase starts when the
    // last earner retires). Built from the raw inputs through the shared time binding, because
    // `Incomes.getActiveIncomesByTimeFrame` carries the one-time latch and must only be asked
    // once per month, by the incomes processor itself.
    //
    // An income ending `atRetirement` is excluded: it stops *because* the phase flips, so asking
    // whether it is still active is circular and would deadlock the phase forever. Only a wage
    // with a bound of its own — a custom age or date, life expectancy, or no end at all — can
    // hold the joint phase back. For a single-member plan the list stays empty: one person's
    // phase is exactly what it was before this item.
    const workingIncomeBindings = isCoupleHousehold(timeline.household)
      ? Object.values(this.inputs.incomes)
          .filter((income) => !income.disabled && income.taxes.incomeType === 'wage' && income.timeframe.end?.type !== 'atRetirement')
          .map((income) => new TimeBinding(income.timeframe.start, income.timeframe.end, timeBindingContext))
      : [];

    // A deceased member's own income streams stop at their death (P1-P3 piece 4). A joint income
    // keeps paying: it is community income, which the survivor keeps. The death arrives as a
    // plan-axis age rather than a date so the comparison uses the same axis as the run itself.
    const memberDeaths: Partial<Record<HouseholdMemberRole, number>> =
      simulationContext.firstDeath === undefined ? {} : { [simulationContext.firstDeath.owner]: simulationContext.firstDeath.age };

    const incomes = new Incomes(Object.values(this.inputs.incomes), timeBindingContext, memberDeaths);
    // A residence's `propertyTax` is charged as an ordinary expense (P1-P5, real estate II): the
    // engine's cash flow funds expenses and nothing else, so the bill is derived into an expense
    // row here rather than added to the portfolio maths somewhere else. Absent `propertyTax`
    // anywhere means an empty list and exactly the expense set this plan had before.
    const propertyTaxExpenses = derivePropertyTaxExpenses(
      Object.values(this.inputs.physicalAssets),
      { inflationRatePercent: this.inputs.marketAssumptions.inflationRate, stateResidency: this.inputs.taxSettings.stateResidency },
      timeBindingContext
    );
    for (const expense of propertyTaxExpenses) {
      // The derived id is namespaced (`property-tax:<asset id>`), so a collision means the plan
      // already has an expense under an id this engine owns: refuse rather than overwrite it.
      if (this.inputs.expenses[expense.id] !== undefined) {
        throw new Error(
          `A plan expense already uses the derived property-tax id "${expense.id}"; rename or remove that expense before simulating.`
        );
      }
    }
    const expenses = new Expenses([...Object.values(this.inputs.expenses), ...propertyTaxExpenses], timeBindingContext);
    const debts = new Debts(Object.values(this.inputs.debts), timeBindingContext);
    const physicalAssets = new PhysicalAssets(Object.values(this.inputs.physicalAssets), timeBindingContext);
    const contributionRules = new ContributionRules(Object.values(this.inputs.contributionRules), this.inputs.baseContributionRule);

    const resultData: Array<SimulationDataPoint> = [this.initSimulationDataPoint(simulationState, debts, physicalAssets)];

    const returnsProcessor = new ReturnsProcessor(simulationState, returnsProvider);
    // Payroll withholding has its own state (year-to-date wages, so the OASDI wage base can stop
    // mid-year), so it is created once and shared: the incomes processor applies each paycheque's
    // withholding and the tax processor reports the same year's total.
    // Its tax year is the *settlement* year of the period being accumulated, not the year the run
    // starts in: see `settlementTaxYearForPeriod`. Both processors therefore price one year.
    // The plan's inflation assumption travels with it: a statute-locked threshold is deflated to
    // today's dollars, and a 0% plan is byte-identical to the pre-deflation engine.
    let payrollTaxProcessor = new PayrollTaxProcessor(
      settlementTaxYearForPeriod(startCalendarDate, 0),
      filingStatus,
      this.inputs.marketAssumptions.inflationRate
    );
    // The per-owner totals exist only for a separate-return year (P3-P1b): they are what the two
    // returns are divided from. A one-return household — one member, or a couple filing jointly —
    // keeps the income data it always had, which is why the frozen corpus does not move.
    let incomesProcessor = new IncomesProcessor(simulationState, incomes, payrollTaxProcessor, filingStatus === 'marriedFilingSeparately');
    const expensesProcessor = new ExpensesProcessor(simulationState, expenses);
    const debtsProcessor = new DebtsProcessor(simulationState, debts);
    const physicalAssetsProcessor = new PhysicalAssetsProcessor(simulationState, physicalAssets);
    const portfolioProcessor = new PortfolioProcessor(
      simulationState,
      simulationContext,
      contributionRules,
      this.inputs.glidePath,
      // The plan's withdrawal strategy (P1-P4). Absent means `ordered`: the pre-strategy sequence
      // with no annual ceiling, so a plan that never chose one simulates exactly as it did before.
      getWithdrawalStrategy(this.inputs.simulationSettings.withdrawalStrategy)
    );
    // The tax year is explicit: the ruleset (bracket thresholds, deductions, §86 tiers) is resolved
    // for the year being settled, never from a module-level constant. The year comes from the same
    // timezone-free calendar arithmetic as the result dates, not from a Date getter (a locally built
    // Jan 1 is still Dec 31 in UTC, so `getUTCFullYear()` would pick the prior year's ruleset in a
    // UTC+ zone). It is re-resolved below for every year.
    // The plan's deduction settings travel with the processor: the itemized lines, and the spouse-65
    // flag for the senior deduction. Without this argument the tax layer computes itemized
    // deductions nobody enters — see the `simulate()` test that asserts the difference.
    // Who owns what travels with them (P3-P1b): a separate return is priced per owner, and
    // `ownerOf`'s absent-means-`primary` default is applied here, once, so the split helpers do not
    // each restate it. A household filing one return never reads the block.
    const taxProcessorSettings: TaxProcessorSettings = {
      ...this.inputs.taxSettings,
      // The tax tables are nominal; the engine is in today's dollars. `TaxProcessor` needs the
      // assumption to deflate the tables that are fixed by statute (see `tax-data/real-dollars.ts`).
      inflationRatePercent: this.inputs.marketAssumptions.inflationRate,
      // Form 8606 apportions one aggregate basis across every traditional IRA the owner holds
      // (IRC §408(d)(2)), so the tax layer needs each account's after-tax money. An account that
      // states none is absent from the map, which reads as no basis; the schema does not offer the
      // field on a 401(k)/403(b)/HSA, because those follow §72 rather than §408(d)(2).
      iraBasisByAccount: iraBasisByAccountFrom(this.inputs.accounts),
      // The early-withdrawal gates read the account owner's age, not the primary's (P1-P3): the
      // engine already charges per-member RMD ages from the same offsets.
      ...(simulationContext.ageOffsetByOwner === undefined ? {} : { ageOffsetByOwner: simulationContext.ageOffsetByOwner }),
      ownership: {
        accounts: simulationContext.accountOwners ?? {},
        physicalAssets: simulationContext.physicalAssetOwners ?? {},
      } satisfies ReturnOwnership,
    };
    let taxProcessor = new TaxProcessor(
      simulationState,
      filingStatus,
      settlementTaxYearForPeriod(startCalendarDate, 0),
      undefined,
      taxProcessorSettings
    );

    // Init phase identifier
    const phaseIdentifier = new PhaseIdentifier(simulationState, timeline, workingIncomeBindings);
    simulationState.phase = phaseIdentifier.getCurrentPhase();

    // The basis step-up happens once, at the first death (P1-P3 piece 4).
    let survivorBasisSteppedUp = false;

    // One latch per milestone (P1-P7), carried across every month start, in plan order. The latch is
    // what makes a milestone an *event*: it fires once, in the first month its condition holds, and
    // never un-fires. `PENDING_MILESTONE_LATCH` is shared and frozen, and each tick returns the
    // state to carry into the next month — no boolean the engine could reset.
    const planMilestones: MilestoneInputs[] = this.inputs.milestones ?? [];
    let milestoneLatches: MilestoneLatchState[] = planMilestones.map(() => PENDING_MILESTONE_LATCH);
    const executedConversionIds = new Set<string>();

    while (simulationState.time.date < simulationContext.endDate) {
      this.incrementSimulationTime(simulationState, startCalendarDate, simulationContext.startAge);

      // Milestones are evaluated on the month-start tick (P1-P7): here, immediately after the clock
      // advances into this month and before any of the month's transactions — the same boundary the
      // RMD check below keys off. That placement is what makes a milestone dated to a month fire in
      // *that* month's start rather than at the end of the previous one, and it means every milestone
      // sees the identical reading, which is why `references` never has to order an evaluation.
      if (planMilestones.length > 0) {
        const snapshot = milestoneSnapshotAt(simulationState, startCalendarDate, resultData[resultData.length - 1]);
        milestoneLatches = planMilestones.map(
          (milestone, index) => tickMilestoneLatch(milestoneLatches[index], milestone.condition, snapshot).state
        );
      }

      if (
        simulationContext.firstDeath !== undefined &&
        !survivorBasisSteppedUp &&
        simulationState.time.age >= simulationContext.firstDeath.age
      ) {
        this.applySurvivorBasisStepUp(simulationState, simulationContext.firstDeath.owner);
        survivorBasisSteppedUp = true;
      }

      // Process RMDs at the start of each year before other transactions
      if (simulationState.time.age >= simulationContext.rmdAge && simulationState.time.month % 12 === 1)
        portfolioProcessor.processRequiredMinimumDistributions();

      // Process SEPP distributions at month 1 of each year
      if (simulationState.time.month % 12 === 1 && this.inputs.sepp && this.inputs.sepp.length > 0) {
        const currentYear = startCalendarDate.year + Math.floor((simulationState.time.month - 1) / 12);
        // Each schedule's age and 59½ date come from its account's owner inside the processor.
        portfolioProcessor.processSeppDistributions(this.inputs.sepp, currentYear, {
          year: timeline.birthYear,
          month: timeline.birthMonth,
        });
      }

      // Process conversions at month 1 of each year after RMDs
      if (simulationState.time.month % 12 === 1 && this.inputs.conversions && this.inputs.conversions.length > 0) {
        const currentYear = startCalendarDate.year + Math.floor((simulationState.time.month - 1) / 12);
        const activeConversions = this.inputs.conversions.filter((conv) => {
          if (executedConversionIds.has(conv.id)) return false;
          if ('fillToBracket' in conv && conv.fillToBracket !== undefined) return false;
          if (conv.year !== undefined) return conv.year === currentYear;
          if (conv.timePoint !== undefined) {
            if (conv.timePoint.type === 'customDate') return conv.timePoint.year === currentYear;
            if (conv.timePoint.type === 'customAge') return Math.floor(simulationState.time.age) === conv.timePoint.age;
            if (conv.timePoint.type === 'atRetirement') return simulationState.phase?.name === 'retirement';
            if (conv.timePoint.type === 'now') return currentYear === startCalendarDate.year;
          }
          return false;
        });

        if (activeConversions.length > 0) {
          const currentDate = formatISODate({ year: currentYear, month: 1, day: 1 });
          portfolioProcessor.processConversions(activeConversions, currentDate);
          for (const conv of activeConversions) {
            executedConversionIds.add(conv.id);
          }
        }
      }

      const { inflationRate: monthlyInflationRate } = returnsProcessor.process();
      const incomesData = incomesProcessor.process();
      const expensesData = expensesProcessor.process();
      // A mortgage offset account's balance reduces that loan's interest, and the portfolio is the
      // only place balances live, so the processor is handed the lookup rather than the numbers.
      const physicalAssetsData = physicalAssetsProcessor.process(monthlyInflationRate, (accountId) =>
        simulationState.portfolio.getAccountBalance(accountId)
      );
      const debtsData = debtsProcessor.process(monthlyInflationRate);

      const { discretionaryExpense: monthlyDiscretionaryExpense } = portfolioProcessor.processContributionsAndWithdrawals(
        incomesData,
        expensesData,
        debtsData,
        physicalAssetsData,
        // Spending the plan marks essential (P1-P4) is funded first: a strategy's annual cap may
        // only trim the rest. Zero when no expense is marked essential, so a plan that never used
        // the flag withdraws exactly what it did before the strategies existed.
        expensesProcessor.getMonthlyEssentialExpenses()
      );
      if (monthlyDiscretionaryExpense) expensesProcessor.processDiscretionaryExpense(monthlyDiscretionaryExpense);

      if (simulationState.time.month % 12 === 0) {
        // Settle the year that just closed under its own ruleset, not the run's first year's.
        const settlementYear = taxYearFor(startCalendarDate, simulationState.time.month);
        taxProcessor.setTaxYear(settlementYear);

        // The period withheld payroll under this same year (the period that began twelve months
        // earlier resolves `settlementTaxYearForPeriod(start, month - 12)`, which is this one), so
        // the two tables a settlement reports always agree. Guard the wiring, not the arithmetic:
        // silently mixing years is the bug this replaced.
        if (payrollTaxProcessor.getTaxYear() !== settlementYear) {
          throw new Error(
            `Payroll tax year ${payrollTaxProcessor.getTaxYear()} does not match the ${settlementYear} settlement it is reported in`
          );
        }

        // Process fillToBracket conversions right before settling taxes at month 12
        if (this.inputs.conversions && this.inputs.conversions.length > 0) {
          const conversionYear = startCalendarDate.year + Math.floor((simulationState.time.month - 1) / 12);
          const activeFillConversions = this.inputs.conversions.filter((conv) => {
            if (executedConversionIds.has(conv.id)) return false;
            if (!('fillToBracket' in conv) || conv.fillToBracket === undefined) return false;
            if (conv.year !== undefined) return conv.year === conversionYear;
            if (conv.timePoint !== undefined) {
              if (conv.timePoint.type === 'customDate') return conv.timePoint.year === conversionYear;
              if (conv.timePoint.type === 'customAge') return Math.floor(simulationState.time.age) === conv.timePoint.age;
              if (conv.timePoint.type === 'atRetirement') return simulationState.phase?.name === 'retirement';
              if (conv.timePoint.type === 'now') return conversionYear === startCalendarDate.year;
            }
            return false;
          });

          for (const conv of activeFillConversions) {
            const fromAccount = simulationState.portfolio.getAccountById(conv.fromAccountId);
            if (!fromAccount) throw new Error(`Conversion ${conv.id}: source account ${conv.fromAccountId} not found`);
            const toAccount = simulationState.portfolio.getAccountById(conv.toAccountId);
            if (!toAccount) throw new Error(`Conversion ${conv.id}: destination account ${conv.toAccountId} not found`);

            const currentPortfolioData = portfolioProcessor.getAnnualData();
            const amount = taxProcessor.calculateFillToBracketAmount(
              conv,
              fromAccount.getBalance(),
              currentPortfolioData,
              incomesProcessor.getAnnualData(),
              returnsProcessor.getAnnualData(),
              physicalAssetsProcessor.getAnnualData(),
              payrollTaxProcessor.getAnnualData()
            );

            if (amount > 0) {
              const currentDate = formatISODate({ year: conversionYear, month: 1, day: 1 });
              fromAccount.applyConversionOut(amount);
              toAccount.applyConversionIn(amount, currentDate);
              portfolioProcessor.recordConversion(conv.fromAccountId, conv.toAccountId, amount);
            }
            executedConversionIds.add(conv.id);
          }
        }

        const annualPortfolioDataBeforeTaxes = portfolioProcessor.getAnnualData();
        const annualIncomesData = incomesProcessor.getAnnualData();
        const annualReturnsData = returnsProcessor.getAnnualData();

        const annualDebtsData = debtsProcessor.getAnnualData();
        simulationState.annualData.debts.push(annualDebtsData);

        const annualPhysicalAssetsData = physicalAssetsProcessor.getAnnualData();
        simulationState.annualData.physicalAssets.push(annualPhysicalAssetsData);

        // Process taxes with iterative convergence (withdrawals to pay taxes can generate additional taxable income)
        const {
          taxesData: annualTaxesData,
          portfolioData: annualPortfolioDataAfterTaxes,
          discretionaryExpense: annualDiscretionaryExpense,
        } = this.settleTaxes(
          taxProcessor,
          portfolioProcessor,
          annualPortfolioDataBeforeTaxes,
          annualIncomesData,
          annualReturnsData,
          annualPhysicalAssetsData,
          payrollTaxProcessor.getAnnualData(),
          expensesProcessor.getAnnualQualifiedMedicalExpenses(),
          expensesProcessor.getAnnualQcdExpenses()
        );

        // Process expenses last to account for discretionary expenses from tax refunds
        if (annualDiscretionaryExpense) expensesProcessor.processDiscretionaryExpense(annualDiscretionaryExpense);
        const annualExpensesData = expensesProcessor.getAnnualData();

        simulationState.annualData.expenses.push(annualExpensesData);
        simulationState.phase = phaseIdentifier.getCurrentPhase();

        resultData.push({
          date: formatISODate(monthStartAfter(startCalendarDate, simulationState.time.month)),
          age: simulationState.time.age,
          portfolio: annualPortfolioDataAfterTaxes,
          incomes: annualIncomesData,
          expenses: annualExpensesData,
          debts: annualDebtsData,
          physicalAssets: annualPhysicalAssetsData,
          phase: { ...simulationState.phase },
          taxes: annualTaxesData,
          returns: annualReturnsData,
        });

        // Reset monthly data for next iteration. The payroll year advances to the *next* period's
        // settlement year, which is the rolling 12-month year this engine settles taxes on, so the
        // OASDI wage base and the SDI rate reset here rather than on January 1. A plan whose year
        // straddles a calendar boundary therefore applies one year's payroll table to the whole
        // settlement year, exactly as it applies one year's income-tax brackets.
        returnsProcessor.resetMonthlyData();
        incomesProcessor.resetMonthlyData();
        expensesProcessor.resetMonthlyData();
        debtsProcessor.resetMonthlyData();
        physicalAssetsProcessor.resetMonthlyData();
        portfolioProcessor.resetMonthlyData();
        payrollTaxProcessor.startNewYear(settlementTaxYearForPeriod(startCalendarDate, simulationState.time.month));

        // Survivor transition (P1-P3 piece 4): the joint return covers the year the death falls in,
        // and the survivor files single from the next settlement year. Both processors take the
        // status in their constructor, so a change means new ones — and the next period's payroll
        // year is being reset here anyway, so the payroll swap costs nothing. The one thing the
        // swap costs is the closing TaxProcessor's capital-loss carryover, which has no public
        // accessor to carry across.
        const nextPeriodFilingStatus = survivorFilingStatus(baseFilingStatus, simulationContext.firstDeath, simulationState.time.age + 1);
        if (nextPeriodFilingStatus !== filingStatus) {
          filingStatus = nextPeriodFilingStatus;
          // The replacement must carry the same deduction settings as the processor it replaces:
          // a survivor who itemizes keeps itemizing, and the senior-deduction flag survives too.
          taxProcessor = new TaxProcessor(
            simulationState,
            filingStatus,
            settlementTaxYearForPeriod(startCalendarDate, simulationState.time.month),
            undefined,
            taxProcessorSettings
          );
          payrollTaxProcessor = new PayrollTaxProcessor(
            settlementTaxYearForPeriod(startCalendarDate, simulationState.time.month),
            filingStatus,
            this.inputs.marketAssumptions.inflationRate
          );
          incomesProcessor = new IncomesProcessor(
            simulationState,
            incomes,
            payrollTaxProcessor,
            filingStatus === 'marriedFilingSeparately'
          );
        }
      }
    }

    const context = {
      startAge: simulationContext.startAge,
      endAge: simulationContext.endAge,
      yearsToSimulate: simulationContext.yearsToSimulate,
      startDate: formatISODate(startCalendarDate),
      endDate: formatISODate(yearStartAfter(startCalendarDate, simulationContext.yearsToSimulate)),
      retirementStrategy: simulationContext.retirementStrategy,
      rmdAge: simulationContext.rmdAge,
    };

    return {
      data: resultData,
      context,
      // Absent — not `[]` — when the plan states no milestones, so a plan without them returns the
      // same object it returned before this field existed and the golden corpus does not move.
      ...(planMilestones.length === 0
        ? {}
        : {
            milestones: planMilestones.map((milestone, index): MilestoneRunReport => {
              const latch = milestoneLatches[index];
              return { id: milestone.id, name: milestone.name, firedAt: latch.status === 'fired' ? latch.firedAt : null };
            }),
          }),
    };
  }

  private incrementSimulationTime(simulationState: SimulationState, startCalendarDate: CalendarDate, startAge: number): void {
    simulationState.time.month += 1;

    const monthsElapsed = simulationState.time.month;

    simulationState.time.date = toSimulationDate(monthStartAfter(startCalendarDate, monthsElapsed));

    simulationState.time.age = startAge + monthsElapsed / 12;
    simulationState.time.year = monthsElapsed / 12;
  }

  /**
   * Settles annual taxes with iterative convergence.
   *
   * Withdrawals to pay taxes can generate additional taxable income, which increases
   * tax liability, requiring further withdrawals. The loop converges when remaining
   * taxes due fall within TAX_CONVERGENCE_THRESHOLD, or after 10 iterations.
   */
  private settleTaxes(
    taxProcessor: TaxProcessor,
    portfolioProcessor: PortfolioProcessor,
    portfolioDataBeforeTaxes: PortfolioData,
    incomesData: IncomesData,
    returnsData: ReturnsData,
    physicalAssetsData: PhysicalAssetsData,
    wagePayrollTaxes: WagePayrollTaxes,
    qualifiedMedicalExpenses = 0,
    qcdExpenses = 0
  ): {
    taxesData: TaxesData;
    portfolioData: PortfolioData;
    discretionaryExpense: number;
  } {
    taxProcessor.saveCarryoverSnapshot();

    const initialTaxesData = taxProcessor.process(
      portfolioDataBeforeTaxes,
      incomesData,
      returnsData,
      physicalAssetsData,
      wagePayrollTaxes,
      qualifiedMedicalExpenses,
      qcdExpenses
    );
    const { totalTaxesDue, totalTaxesRefund } = initialTaxesData;

    const { portfolioData: initialPortfolioData, discretionaryExpense } = portfolioProcessor.processTaxes(portfolioDataBeforeTaxes, {
      totalTaxesDue,
      totalTaxesRefund,
    });

    let taxesData = initialTaxesData;
    let portfolioData = initialPortfolioData;

    if (totalTaxesDue > 0) {
      let totalTaxesPaid = totalTaxesDue;
      for (let i = 0; i < 10; i++) {
        taxProcessor.restoreCarryoverSnapshot();

        taxesData = taxProcessor.process(
          portfolioData,
          incomesData,
          returnsData,
          physicalAssetsData,
          wagePayrollTaxes,
          qualifiedMedicalExpenses,
          qcdExpenses
        );

        const remainingTaxesDue = taxesData.totalTaxesDue - totalTaxesPaid;
        if (Math.abs(remainingTaxesDue) < TAX_CONVERGENCE_THRESHOLD) break;

        ({ portfolioData } = portfolioProcessor.processTaxes(portfolioData, {
          totalTaxesDue: remainingTaxesDue,
          totalTaxesRefund: 0,
        }));

        totalTaxesPaid = taxesData.totalTaxesDue;
      }
    }

    return { taxesData, portfolioData, discretionaryExpense };
  }

  private initSimulationContext(timeline: TimelineInputs, startCalendarDate: CalendarDate): SimulationContext {
    // The plan-level ages are the primary member's own; every member without stored ages inherits
    // them (see `resolveHouseholdMember`), so a household of one holding no member ages resolves
    // to exactly the plan's values and nothing about a single-member run moves.
    const planAges = { birthMonth: timeline.birthMonth, birthYear: timeline.birthYear, lifeExpectancy: timeline.lifeExpectancy };
    const startAge = calculatePreciseAge(planAges.birthMonth, planAges.birthYear, this.clock.asOf);

    /**
     * Every age below is expressed on the plan's axis: the primary's age, which is the axis
     * `simulationState.time.age` runs on. A member who shares the plan's birth date is on that axis
     * already (offset exactly 0, so no floating-point drift can move a single-member run); anyone
     * else is offset by the age difference at the plan's start.
     */
    const memberFacts = resolveHouseholdMembers(timeline.household, planAges).map((member) => {
      const sharesPlanBirthDate = member.birthMonth === planAges.birthMonth && member.birthYear === planAges.birthYear;
      const offset = sharesPlanBirthDate ? 0 : startAge - calculatePreciseAge(member.birthMonth, member.birthYear, this.clock.asOf);

      return {
        role: member.role,
        birthYear: member.birthYear,
        birthMonth: member.birthMonth,
        ageOffset: offset,
        deathAge: offset + member.lifeExpectancy,
        rmdStartAge: offset + secureActRmdAge(member.birthYear),
      };
    });

    // The run lasts until the longest-lived member dies (P1-P3 piece 2). `Math.max` over one
    // member returns that member's expectancy bit for bit, which is where single-member identity
    // is won.
    const endAge = Math.max(...memberFacts.map((member) => member.deathAge));

    const yearsToSimulate = Math.ceil(endAge - startAge);

    const startDate = toSimulationDate(startCalendarDate);
    const endDate = toSimulationDate(yearStartAfter(startCalendarDate, yearsToSimulate));

    const retirementStrategy = timeline.retirementStrategy;

    // Each member's own birth year decides that member's RMD age (P1-P3 piece 1). A joint item is
    // one balance the engine cannot split, so it starts distributions when the *first* of its
    // owners is required to; for one person that is that person's own age, as before.
    const rmdStartAgeByRole = new Map(memberFacts.map((member) => [member.role, member.rmdStartAge]));
    const primaryRmdAge = rmdStartAgeByRole.get('primary') ?? secureActRmdAge(planAges.birthYear);
    const partnerRmdAge = rmdStartAgeByRole.get('partner') ?? primaryRmdAge;
    const rmdAgeByOwner: Record<Owner, number> = {
      primary: primaryRmdAge,
      partner: partnerRmdAge,
      joint: Math.min(primaryRmdAge, partnerRmdAge),
    };
    const rmdAge = rmdAgeByOwner.joint;

    // And the same for the members' *ages* (P1-P3): `simulationState.time.age` runs on the primary's
    // axis, so an owner of a different age is `planAge - offset` (read by `ownerAge` in taxes.ts and
    // `ageForAccount` in portfolio.ts). A joint item is read at the first member to reach a gate —
    // the older one — which is the rule `rmdAgeByOwner.joint` already follows by taking the smaller
    // plan-axis age.
    const ageOffsetByRole = new Map(memberFacts.map((member) => [member.role, member.ageOffset]));
    const primaryAgeOffset = ageOffsetByRole.get('primary') ?? 0;
    const partnerAgeOffset = ageOffsetByRole.get('partner') ?? primaryAgeOffset;
    const ageOffsetByOwner: Record<Owner, number> = {
      primary: primaryAgeOffset,
      partner: partnerAgeOffset,
      joint: Math.min(primaryAgeOffset, partnerAgeOffset),
    };

    // The birth years the claiming adjustment is read from, on the same joint rule: an item the
    // engine cannot split is read at the older member, not at a second convention.
    const birthYearByRole = new Map(memberFacts.map((member) => [member.role, member.birthYear]));
    const primaryBirthYear = birthYearByRole.get('primary') ?? planAges.birthYear;
    const partnerBirthYear = birthYearByRole.get('partner') ?? primaryBirthYear;
    const birthYearByOwner: Record<Owner, number> = {
      primary: primaryBirthYear,
      partner: partnerBirthYear,
      // `min` because the smaller offset is the older member, whose own gate opens first.
      joint: primaryAgeOffset <= partnerAgeOffset ? primaryBirthYear : partnerBirthYear,
    };
    const birthMonthByRole = new Map(memberFacts.map((member) => [member.role, member.birthMonth]));
    const primaryBirthMonth = birthMonthByRole.get('primary') ?? planAges.birthMonth;
    const partnerBirthMonth = birthMonthByRole.get('partner') ?? primaryBirthMonth;
    const birthMonthByOwner: Record<Owner, number> = {
      primary: primaryBirthMonth,
      partner: partnerBirthMonth,
      joint: primaryAgeOffset <= partnerAgeOffset ? primaryBirthMonth : partnerBirthMonth,
    };

    const accountOwners: Record<string, Owner> = Object.fromEntries(
      Object.values(this.inputs.accounts).map((account) => [account.id, ownerOf(account)])
    );
    // The same map for physical assets, for the separate-return split (P3-P1b): a residence sold
    // during the year puts its §121 gain and exclusion on its owner's return.
    const physicalAssetOwners: Record<string, Owner> = Object.fromEntries(
      Object.values(this.inputs.physicalAssets).map((asset) => [asset.id, ownerOf(asset)])
    );

    // The survivor window exists only when a couple's two death ages differ: equal expectancies
    // mean there is no survivor to transition, which is also what a couple with no stored member
    // ages looks like (both resolve to the plan's values).
    const [firstMember, secondMember] = memberFacts;
    const firstDeath =
      firstMember !== undefined && secondMember !== undefined && firstMember.deathAge !== secondMember.deathAge
        ? firstMember.deathAge < secondMember.deathAge
          ? { age: firstMember.deathAge, owner: firstMember.role }
          : { age: secondMember.deathAge, owner: secondMember.role }
        : undefined;

    return {
      startAge,
      endAge,
      yearsToSimulate,
      startDate,
      endDate,
      retirementStrategy,
      rmdAge,
      rmdAgeByOwner,
      ageOffsetByOwner,
      birthYearByOwner,
      birthMonthByOwner,
      accountOwners,
      physicalAssetOwners,
      firstDeath,
    };
  }

  /**
   * Steps up the cost basis of every taxable account the deceased owned a share of (P1-P3 piece 4).
   *
   * The share comes from `basisStepUpFraction`: community property in full, the deceased's half of
   * separate or joint-tenancy property, and nothing for the survivor's own separate property. Only
   * taxable brokerage accounts carry a basis — retirement accounts are IRD, with no §1014 step-up,
   * and savings accounts have no unrealized gain to reset.
   */
  private applySurvivorBasisStepUp(simulationState: SimulationState, deceased: HouseholdMemberRole): void {
    for (const account of simulationState.portfolio.getAccounts()) {
      if (!(account instanceof TaxableBrokerageAccount)) continue;

      const input = Object.values(this.inputs.accounts).find((candidate) => candidate.id === account.getAccountID());
      const fraction = basisStepUpFraction(input ?? {}, deceased);
      if (fraction > 0) account.applyBasisStepUp(fraction);
    }
  }

  private initSimulationState(simulationContext: SimulationContext): SimulationState {
    const { startDate, startAge: age } = simulationContext;

    return {
      time: { date: new Date(startDate), age, year: 0, month: 0 },
      portfolio: new Portfolio(Object.values(this.inputs.accounts)),
      phase: null,
      annualData: { expenses: [], debts: [], physicalAssets: [] },
    };
  }

  private initSimulationDataPoint(
    initialSimulationState: SimulationState,
    debts: Debts,
    physicalAssets: PhysicalAssets
  ): SimulationDataPoint {
    const totalPortfolioValue = initialSimulationState.portfolio.getTotalValue();
    const assetAllocation = initialSimulationState.portfolio.getWeightedAssetAllocation();

    const defaultAssetFlows = zeroAssetAmounts<AssetFlows>();

    const defaultFlowsData = {
      contributions: { ...defaultAssetFlows },
      employerMatch: 0,
      withdrawals: { ...defaultAssetFlows },
      realizedGains: 0,
      earningsWithdrawn: 0,
      rmds: 0,
    };

    const perAccountData: Record<string, AccountDataWithFlows> = Object.fromEntries(
      initialSimulationState.portfolio
        .getAccounts()
        .map((account) => [account.getAccountID(), { ...account.getAccountData(), ...defaultFlowsData }])
    );

    const activeDebts = debts.getActiveDebts(initialSimulationState);
    const perDebtData: Record<string, DebtData> = Object.fromEntries(
      activeDebts.map((debt) => [
        debt.getId(),
        {
          id: debt.getId(),
          name: debt.getName(),
          balance: debt.getBalance(),
          payment: 0,
          interest: 0,
          principalPaid: 0,
          unpaidInterest: 0,
          debtPaydown: 0,
          isPaidOff: debt.isPaidOff(),
        },
      ])
    );

    const debtsData: DebtsData = {
      totalDebtBalance: debts.getTotalBalance(),
      totalPayment: 0,
      totalInterest: 0,
      totalPrincipalPaid: 0,
      totalUnpaidInterest: 0,
      totalDebtPaydown: 0,
      totalUnsecuredDebtIncurred: 0,
      perDebtData,
    };

    const ownedAssets = physicalAssets.getOwnedAssets();
    const perAssetData: Record<string, PhysicalAssetData> = Object.fromEntries(
      ownedAssets.map((asset) => [
        asset.getId(),
        {
          id: asset.getId(),
          name: asset.getName(),
          assetType: asset.getAssetType(),
          marketValue: asset.getMarketValue(),
          loanBalance: asset.getLoanBalance(),
          equity: asset.getEquity(),
          paymentType: asset.getPaymentType(),
          appreciation: 0,
          loanPayment: 0,
          purchaseOutlay: 0,
          purchaseMarketValue: 0,
          saleProceeds: 0,
          saleMarketValue: 0,
          realizedGains: 0,
          interest: 0,
          principalPaid: 0,
          unpaidInterest: 0,
          debtPaydown: 0,
          securedDebtIncurred: 0,
          debtPayoff: 0,
          isSold: asset.isSold(),
        },
      ])
    );

    const physicalAssetsData: PhysicalAssetsData = {
      totalMarketValue: physicalAssets.getTotalMarketValue(),
      totalLoanBalance: physicalAssets.getTotalLoanBalance(),
      totalEquity: physicalAssets.getTotalEquity(),
      totalAppreciation: 0,
      totalLoanPayment: 0,
      totalPurchaseOutlay: 0,
      totalPurchaseMarketValue: 0,
      totalSaleProceeds: 0,
      totalSaleMarketValue: 0,
      totalRealizedGains: 0,
      totalInterest: 0,
      totalPrincipalPaid: 0,
      totalUnpaidInterest: 0,
      totalDebtPaydown: 0,
      totalSecuredDebtIncurred: 0,
      totalDebtPayoff: 0,
      perAssetData,
    };

    return {
      date: this.clock.asOf,
      age: initialSimulationState.time.age,
      portfolio: {
        totalValue: totalPortfolioValue,
        cumulativeContributions: { ...defaultAssetFlows },
        cumulativeEmployerMatch: 0,
        cumulativeWithdrawals: { ...defaultAssetFlows },
        cumulativeRealizedGains: 0,
        cumulativeEarningsWithdrawn: 0,
        cumulativeRmds: 0,
        outstandingShortfall: 0,
        contributions: { ...defaultAssetFlows },
        employerMatch: 0,
        withdrawals: { ...defaultAssetFlows },
        realizedGains: 0,
        earningsWithdrawn: 0,
        rmds: 0,
        shortfall: 0,
        shortfallRepaid: 0,
        perAccountData,
        assetAllocation,
      },
      incomes: null,
      expenses: null,
      debts: debtsData,
      physicalAssets: physicalAssetsData,
      phase: null,
      taxes: null,
      returns: null,
    };
  }
}

/** Result set from running multiple simulations (Monte Carlo or historical backtest) */
export interface MultiSimulationResult {
  simulations: Array<[number /* seed */, SimulationResult]>;
}

/** Runs multiple simulations with stochastic (randomly generated) returns */
export class MonteCarloSimulationEngine extends FinancialSimulationEngine {
  constructor(
    inputs: SimulatorInputs,
    private baseSeed: number,
    clock: Clock
  ) {
    super(inputs, clock);
  }

  runSingleSimulation(seed: number): SimulationResult {
    const returnsProvider = new StochasticReturnsProvider(this.inputs, seed);

    const timeline = this.inputs.timeline;
    if (!timeline) throw new Error('Must have timeline data for simulation');

    return this.runSimulation(returnsProvider, timeline);
  }

  /**
   * Runs N simulations with different random seeds for Monte Carlo analysis
   * @param numSimulations - Number of simulation runs
   * @param onProgress - Optional callback invoked after each simulation completes
   * @returns Collection of all simulation results keyed by seed
   */
  runMonteCarloSimulation(numSimulations: number, onProgress?: () => void): MultiSimulationResult {
    const timeline = this.inputs.timeline;
    if (!timeline) throw new Error('Must have timeline data for simulation');

    const simulations: Array<[number, SimulationResult]> = [];
    for (let i = 0; i < numSimulations; i++) {
      const simulationSeed = this.baseSeed + i * 1009; // Prime spacing avoids seed correlation between simulations
      const returnsProvider = new StochasticReturnsProvider(this.inputs, simulationSeed);

      const result = this.runSimulation(returnsProvider, timeline);
      simulations.push([simulationSeed, result]);

      if (onProgress) onProgress();
    }

    return { simulations };
  }
}

/** Runs multiple simulations using historical market data with LCG-seeded random start years */
export class LcgHistoricalBacktestSimulationEngine extends FinancialSimulationEngine {
  constructor(
    inputs: SimulatorInputs,
    private baseSeed: number,
    clock: Clock
  ) {
    super(inputs, clock);
  }

  runSingleSimulation(
    seed: number,
    startYearOverride: number | undefined,
    retirementStartYearOverride: number | undefined
  ): SimulationResult {
    const returnsProvider = new LcgHistoricalBacktestReturnsProvider(
      seed,
      startYearOverride,
      retirementStartYearOverride,
      this.historicalBacktestMode()
    );

    const timeline = this.inputs.timeline;
    if (!timeline) throw new Error('Must have timeline data for simulation');

    const result = this.runSimulation(returnsProvider, timeline);

    return {
      ...result,
      context: {
        ...result.context,
        ...this.historicalBacktestContext(returnsProvider),
      },
    };
  }

  /** The plan's historical-backtest mode; absent means the pre-P2-P4 behaviour (`'looping'`). */
  private historicalBacktestMode(): HistoricalBacktestMode {
    return this.inputs.simulationSettings.historicalBacktest?.mode ?? 'looping';
  }

  /**
   * The historical context a result carries: always the ranges walked, plus the disclosure fields
   * only when they apply. A no-wrap run therefore keeps exactly the context shape it had before
   * P2-P4 (the frozen corpus depends on that).
   */
  private historicalBacktestContext(returnsProvider: LcgHistoricalBacktestReturnsProvider): {
    historicalRanges: Array<{ startYear: number; endYear: number }>;
    historicalWrapped?: boolean;
    truncatedAtYear?: number;
  } {
    const report = returnsProvider.getHistoricalReport();

    return {
      historicalRanges: report.ranges,
      ...(report.wrapped ? { historicalWrapped: true as const } : {}),
      ...(report.truncatedAtYear !== null ? { truncatedAtYear: report.truncatedAtYear } : {}),
    };
  }

  /**
   * Runs N simulations with different historical start years for backtesting
   * @param numSimulations - Number of simulation runs
   * @param onProgress - Optional callback invoked after each simulation completes
   * @returns Collection of all simulation results with historical year ranges
   */
  runLcgHistoricalBacktest(numSimulations: number, onProgress?: () => void): MultiSimulationResult {
    const timeline = this.inputs.timeline;
    if (!timeline) throw new Error('Must have timeline data for simulation');

    const simulations: Array<[number, SimulationResult]> = [];
    for (let i = 0; i < numSimulations; i++) {
      const simulationSeed = this.baseSeed + i * 1009; // Prime spacing avoids seed correlation between simulations
      const returnsProvider = new LcgHistoricalBacktestReturnsProvider(simulationSeed, undefined, undefined, this.historicalBacktestMode());

      const result = this.runSimulation(returnsProvider, timeline);
      simulations.push([
        simulationSeed,
        {
          ...result,
          context: {
            ...result.context,
            ...this.historicalBacktestContext(returnsProvider),
          },
        },
      ]);

      if (onProgress) onProgress();
    }

    return { simulations };
  }
}
