/**
 * Shared time binding for every dated event in the simulation engine.
 *
 * Incomes, expenses, debts, physical assets and the glide path all decide *when* something
 * starts, stops or has progressed far enough by resolving a `TimePoint` (`now`,
 * `atRetirement`, `atLifeExpectancy`, `customDate`, `customAge`) against the simulation's
 * clock. Before this module each of them carried its own copy of that switch; this file is
 * the single implementation:
 *
 * | caller | what it needs |
 * | --- | --- |
 * | `incomes.ts`, `expenses.ts` | start bound reached **and** end bound not passed |
 * | `debts.ts`, `physical-assets.ts` | a start/purchase/sale bound reached |
 * | `portfolio.ts` (glide path) | how far the run has travelled toward an end point (0..1) |
 *
 * It also owns the two things that need the same calendar arithmetic:
 *
 * - **Recurrence** (`everyNYears` / `recurrenceYears`): an event on an N-year cadence is
 *   active only in its occurrence years.
 * - **Real vs nominal amounts** (`amountBasis`): a nominal amount is expressed in the
 *   dollars of the date the event takes effect, so it is converted to the plan's real
 *   (today's) dollars with `cumulativeInflationIndex`, which contract 3.1 makes the single
 *   definition of the plan's inflation path.
 *
 * Everything here is pure: it takes the clock and the plan's assumptions as arguments and
 * never reads the wall clock, a store or module state (see `clock.ts` and the determinism
 * rules in `eslint.config.mjs`).
 */

import type { MarketAssumptionsInputs } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import type { AmountBasis, TimePoint } from '@/lib/schemas/inputs/income-expenses-shared-schemas';

/**
 * A time point this module can resolve.
 *
 * `TimePoint` (every dated input) and the glide path's narrower `GlidePathTimePoint` both
 * fit, which is why the calendar branches are typed on this shape rather than on `TimePoint`
 * with its recurrence fields.
 */
export interface ResolvableTimePoint {
  readonly type: 'now' | 'atRetirement' | 'atLifeExpectancy' | 'customDate' | 'customAge';
  readonly age?: number | undefined;
  readonly month?: number | undefined;
  readonly year?: number | undefined;
}

/** The clock facts a time point is resolved against. */
export interface TimeBindingClock {
  readonly time: {
    readonly age: number;
    readonly date: Date;
    /** Years since the plan's start date, fractional (the engine's time axis). */
    readonly year: number;
  };
  readonly phase: { readonly name: string } | null;
}

/** Where a run starts. Enough to measure both calendar and age distances. */
export interface PlanStartContext {
  readonly startAge: number;
  readonly startDate: Date;
}

/** Plan-level facts a time point needs: where the run starts, and the inflation assumption. */
export interface TimeBindingContext extends PlanStartContext {
  readonly marketAssumptions: MarketAssumptionsInputs;
}

/**
 * The cumulative inflation factor from the plan's start date to `years` years later.
 *
 * `marketAssumptions.inflationRate` is a percentage (3 means 3%), so the index is
 * `(1 + rate)^years`: 1 today, 1.03 after one year at 3%, and so on. A nominal amount of
 * `x` anchored `n` years out is `x / index(n)` in the plan's real dollars.
 *
 * Pure by construction (contract 3.1): it depends only on its two arguments, so a later
 * item can re-export it from `simulate()`'s result without dragging in store or module
 * state. Negative `years` (an event dated before the plan's start) yields an index below 1,
 * which inflates the converted amount, the mirror of deflating a future one.
 */
export function cumulativeInflationIndex(assumptions: Pick<MarketAssumptionsInputs, 'inflationRate'>, years: number): number {
  return Math.pow(1 + assumptions.inflationRate / 100, years);
}

/** The first day of the calendar month a `customDate` time point names. */
export function timePointDate(timePoint: { readonly year?: number | undefined; readonly month?: number | undefined }): Date {
  // The engine's simulation dates are month starts (`monthStartAfter` in simulation-engine.ts),
  // so a day-of-month is never part of a time point and the comparison stays month-granular.
  return new Date(timePoint.year!, timePoint.month! - 1);
}

/** Whole calendar months from `from` to `to`, read in the timezone both dates were built in. */
export function calendarMonthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * True once the simulation clock has reached the time point (at-or-after).
 *
 * `now` is reached from the first month. `atRetirement` follows the phase. `atLifeExpectancy`
 * is never reachable as a *start* bound, and a `customAge`/`customDate` point missing its
 * value is treated as unreachable rather than throwing.
 */
export function isTimePointReached(timePoint: ResolvableTimePoint, clock: TimeBindingClock): boolean {
  switch (timePoint.type) {
    case 'customAge':
      return timePoint.age !== undefined && clock.time.age >= timePoint.age;
    case 'customDate':
      return timePoint.year !== undefined && timePoint.month !== undefined && clock.time.date >= timePointDate(timePoint);
    case 'now':
      return true;
    case 'atRetirement':
      return clock.phase?.name === 'retirement';
    case 'atLifeExpectancy':
      return false;
  }
}

/**
 * True while the simulation clock has not passed the time point (at-or-before), i.e. the
 * end-bound test.
 *
 * The two ends of the vocabulary are deliberately asymmetric, and that asymmetry is the
 * behaviour this module preserves: an event ending `now` never has a live month left, and an
 * event ending `atLifeExpectancy` runs to the horizon. `atRetirement` as an end means "up to
 * retirement", the mirror of the start bound.
 */
export function isTimePointNotPassed(timePoint: ResolvableTimePoint, clock: TimeBindingClock): boolean {
  switch (timePoint.type) {
    case 'customAge':
      return timePoint.age !== undefined && clock.time.age <= timePoint.age;
    case 'customDate':
      return timePoint.year !== undefined && timePoint.month !== undefined && clock.time.date <= timePointDate(timePoint);
    case 'now':
      return false;
    case 'atRetirement':
      return clock.phase?.name !== 'retirement';
    case 'atLifeExpectancy':
      return true;
  }
}

/**
 * How far the run has travelled from its start toward `timePoint`, as a fraction in 0..1.
 *
 * This is the glide path's question rather than a yes/no bound: it needs to interpolate an
 * allocation, so it needs distance, not a predicate. A point that is already behind the start
 * (a zero or negative span) reports 1 — fully at the target — which is what the glide path
 * used to return directly.
 */
export function timePointProgress(timePoint: ResolvableTimePoint, clock: TimeBindingClock, start: PlanStartContext): number {
  let progress: number;

  switch (timePoint.type) {
    case 'customAge': {
      const endAge = timePoint.age!;
      const totalSpan = endAge - start.startAge;
      if (totalSpan <= 0) return 1;

      progress = (clock.time.age - start.startAge) / totalSpan;
      break;
    }
    case 'customDate': {
      const endDate = timePointDate(timePoint);
      const totalSpan = endDate.getTime() - start.startDate.getTime();
      if (totalSpan <= 0) return 1;

      progress = (clock.time.date.getTime() - start.startDate.getTime()) / totalSpan;
      break;
    }
    default:
      // The glide path's schema only allows the two calendar shapes above.
      return 1;
  }

  return Math.max(0, Math.min(1, progress));
}

/**
 * Years from the plan's start date to a time point, or `undefined` when the point has no
 * calendar location of its own (`atRetirement`, `atLifeExpectancy`, or a custom point missing
 * its value).
 */
export function yearsFromPlanStart(timePoint: ResolvableTimePoint, start: PlanStartContext): number | undefined {
  switch (timePoint.type) {
    case 'customAge':
      return timePoint.age === undefined ? undefined : timePoint.age - start.startAge;
    case 'customDate':
      return timePoint.year === undefined || timePoint.month === undefined
        ? undefined
        : calendarMonthsBetween(start.startDate, timePointDate(timePoint)) / 12;
    case 'now':
      return 0;
    case 'atRetirement':
    case 'atLifeExpectancy':
      return undefined;
  }
}

/**
 * True when an event that repeats every `everyNYears` years is inside an occurrence year.
 *
 * `occurrenceIndex` is the number of whole years since the event's anchor (its start), so
 * index 0 is the anchor year itself, `N` is one cadence later, `2N` two cadences later, and
 * any index that is not a multiple of `N` falls in a gap. `recurrenceYears` caps how many
 * years the cadence runs for, counted from the anchor; without it the cadence runs to the
 * event's own end bound. `everyNYears` of 1 (or an absent cadence) makes every year an
 * occurrence, which is exactly the pre-recurrence behaviour.
 */
export function isRecurrenceOccurrence(
  everyNYears: number | undefined,
  recurrenceYears: number | undefined,
  occurrenceIndex: number
): boolean {
  if (everyNYears === undefined || everyNYears <= 1) return recurrenceYears === undefined || occurrenceIndex < recurrenceYears;
  if (occurrenceIndex < 0) return false;
  if (recurrenceYears !== undefined && occurrenceIndex >= recurrenceYears) return false;

  return occurrenceIndex % everyNYears === 0;
}

/**
 * A single dated event's binding: its start point, its optional end point, and the plan
 * context that gives both meaning.
 *
 * Each entity that used to own a private copy of the switch now owns one of these instead.
 */
export class TimeBinding {
  constructor(
    private readonly start: TimePoint,
    private readonly end: TimePoint | undefined,
    private readonly context: TimeBindingContext | undefined
  ) {}

  /** True when the event carries a cadence (`everyNYears`), i.e. it only runs in occurrence years. */
  isRecurring(): boolean {
    return this.start.everyNYears !== undefined;
  }

  /** True in every month the event is live: started, not ended, and inside a recurrence year. */
  isActiveAt(clock: TimeBindingClock): boolean {
    if (!isTimePointReached(this.start, clock)) return false;
    if (this.end !== undefined && !isTimePointNotPassed(this.end, clock)) return false;

    return isRecurrenceOccurrence(this.start.everyNYears, this.start.recurrenceYears, this.occurrenceIndexAt(clock) ?? 0);
  }

  /**
   * Whole years since the event's own start, or `null` when the event does not repeat.
   *
   * Calendar-anchored points are measured against their own date or age, so a cadence is
   * anchored to the event rather than to the run. Points with no calendar location of their
   * own (`now`, `atRetirement`, `atLifeExpectancy`) follow the plan's year grid, where year 0
   * is the run's first year.
   */
  occurrenceIndexAt(clock: TimeBindingClock): number | null {
    if (this.start.everyNYears === undefined) return null;

    switch (this.start.type) {
      case 'customAge':
        return this.start.age === undefined ? null : Math.floor(Math.round((clock.time.age - this.start.age) * 12) / 12);
      case 'customDate':
        return this.start.year === undefined || this.start.month === undefined
          ? null
          : Math.floor(calendarMonthsBetween(timePointDate(this.start), clock.time.date) / 12);
      case 'now':
      case 'atRetirement':
      case 'atLifeExpectancy':
        return Math.floor(clock.time.year);
    }
  }

  /**
   * Factor that turns the entered amount into the plan's real dollars.
   *
   * Real amounts are already in today's dollars, so the factor is 1. A nominal amount is
   * divided by the cumulative inflation index from the plan's start to the date the event
   * takes effect, so `nominal = real * index` — the amount is "bought forward" to that date.
   * A binding built without a plan context (a unit test constructing one entity, say) or a
   * point with no calendar location cannot be located, so it does not scale.
   */
  amountScale(amountBasis: AmountBasis | undefined): number {
    if (amountBasis !== 'nominal' || this.context === undefined) return 1;

    const years = yearsFromPlanStart(this.start, this.context);
    if (years === undefined) return 1;

    return 1 / cumulativeInflationIndex(this.context.marketAssumptions, years);
  }
}
