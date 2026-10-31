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
import { PayrollTaxProcessor, type WagePayrollTaxes } from './payroll-taxes';
import { Expenses, ExpensesProcessor, type ExpensesData } from './expenses';
import { Debts, DebtsProcessor, type DebtsData, type DebtData } from './debts';
import { PhysicalAssets, PhysicalAssetsProcessor, type PhysicalAssetsData, type PhysicalAssetData } from './physical-assets';
import { TimeBinding, type TimeBindingContext } from './time-binding';
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
    const expenses = new Expenses(Object.values(this.inputs.expenses), timeBindingContext);
    const debts = new Debts(Object.values(this.inputs.debts), timeBindingContext);
    const physicalAssets = new PhysicalAssets(Object.values(this.inputs.physicalAssets), timeBindingContext);
    const contributionRules = new ContributionRules(Object.values(this.inputs.contributionRules), this.inputs.baseContributionRule);

    const resultData: Array<SimulationDataPoint> = [this.initSimulationDataPoint(simulationState, debts, physicalAssets)];

    // Init simulation processors
    const returnsProcessor = new ReturnsProcessor(simulationState, returnsProvider);
    // Payroll withholding has its own state (year-to-date wages, so the OASDI wage base can stop
    // mid-year), so it is created once and shared: the incomes processor applies each paycheque's
    // withholding and the tax processor reports the same year's total.
    // Its tax year is the *settlement* year of the period being accumulated, not the year the run
    // starts in: see `settlementTaxYearForPeriod`. Both processors therefore price one year.
    let payrollTaxProcessor = new PayrollTaxProcessor(settlementTaxYearForPeriod(startCalendarDate, 0), filingStatus);
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

    while (simulationState.time.date < simulationContext.endDate) {
      this.incrementSimulationTime(simulationState, startCalendarDate, simulationContext.startAge);

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

      // Process one month of simulation
      const { inflationRate: monthlyInflationRate } = returnsProcessor.process();
      const incomesData = incomesProcessor.process();
      const expensesData = expensesProcessor.process();
      const physicalAssetsData = physicalAssetsProcessor.process(monthlyInflationRate);
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

        // Get annual data from processors
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
          payrollTaxProcessor.getAnnualData()
        );

        // Process expenses last to account for discretionary expenses from tax refunds
        if (annualDiscretionaryExpense) expensesProcessor.processDiscretionaryExpense(annualDiscretionaryExpense);
        const annualExpensesData = expensesProcessor.getAnnualData();

        // Update simulation state
        simulationState.annualData.expenses.push(annualExpensesData);
        simulationState.phase = phaseIdentifier.getCurrentPhase();

        // Store annual data in results
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
            filingStatus
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

    return { data: resultData, context };
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
    wagePayrollTaxes: WagePayrollTaxes
  ): {
    taxesData: TaxesData;
    portfolioData: PortfolioData;
    discretionaryExpense: number;
  } {
    taxProcessor.saveCarryoverSnapshot();

    const initialTaxesData = taxProcessor.process(portfolioDataBeforeTaxes, incomesData, returnsData, physicalAssetsData, wagePayrollTaxes);
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

        taxesData = taxProcessor.process(portfolioData, incomesData, returnsData, physicalAssetsData, wagePayrollTaxes);

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

      return { role: member.role, deathAge: offset + member.lifeExpectancy, rmdStartAge: offset + secureActRmdAge(member.birthYear) };
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
