/**
 * Plan comparison (parity plan P2-P5).
 *
 * Two plans run through the pure entry point — `simulate()` — on the *same* clock, the *same*
 * seed and the same Monte Carlo configuration, so a delta is a real difference between the plans
 * rather than sampling noise. Both Monte Carlo sides use summary retention (P2-P3): the
 * comparison only needs aggregates, so it never allocates two sets of full results.
 *
 * **Sign convention, stated once and honoured everywhere: `delta = A − B`.** Plan A is the subject
 * (the one being changed), plan B is the reference. A positive delta means A is larger.
 *
 * Everything here is pure: the clock is an argument, there is no `Math.random` and no module
 * state, so the same inputs produce the same report — and the same bytes — on any day.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { StatsUtils } from '@/lib/utils/stats-utils';

import { type ISODateString } from './clock';
import { DEFAULT_MONTE_CARLO_TRIALS, resolveMonteCarloConfig } from './monte-carlo';
import { SimulationDataExtractor } from './data-extractors/simulation-data-extractor';
import { evaluateSuccess } from './success';
import { simulate } from './simulate';

/** The one sign convention for every delta in this module. */
export const COMPARE_DELTA_MEANING = 'a - b' as const;

export type CompareFormat = 'currency' | 'percentage' | 'age' | 'flag';
export type CompareGroup = 'projection' | 'monteCarlo' | 'taxes';

export interface CompareMetric {
  /** Stable id for tests and UI keys. */
  id: string;
  label: string;
  group: CompareGroup;
  format: CompareFormat;
  a: number | null;
  b: number | null;
  /**
   * `a - b`. `null` when only one side has a value — a mean retirement age against "never
   * retired" is not a difference — and `0` when neither side has one, so identical plans are
   * all-zero rather than all-null.
   */
  delta: number | null;
}

export interface CompareYear {
  /** Simulation year index; both plans are aligned on it, not on the calendar. */
  year: number;
  /** Age on plan A's timeline, for the table's axis label. */
  age: number;
  a: number;
  b: number;
  delta: number;
}

export interface CompareOptions {
  /** The one clock both plans run on, as an ISO date. Required, like `simulate()`'s. */
  asOf: ISODateString;
  /** The one seed both plans (and both Monte Carlo sides) use. */
  seed: number;
  /** Monte Carlo trials per side; defaults to the app's 500 (F7). */
  trials?: number;
  /** Deterministic projection mode; fixed returns is the app's default projection. */
  projectionMode?: 'fixedReturns' | 'stochasticReturns';
}

export interface CompareReport {
  asOf: ISODateString;
  seed: number;
  trials: number;
  deltaMeaning: typeof COMPARE_DELTA_MEANING;
  metrics: CompareMetric[];
  yearly: CompareYear[];
}

const deltaOf = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return 0;
  if (a === null || b === null) return null;
  return a - b;
};

const metric = (
  id: string,
  label: string,
  group: CompareGroup,
  format: CompareFormat,
  a: number | null,
  b: number | null
): CompareMetric => ({ id, label, group, format, a, b, delta: deltaOf(a, b) });

/** Extracts the per-side numbers the comparison shows. */
function summarizeSide(inputs: SimulatorInputs, options: CompareOptions, trials: number) {
  const projectionMode = options.projectionMode ?? 'fixedReturns';

  const projection = simulate(inputs, { mode: projectionMode, seed: options.seed, asOf: options.asOf });
  if (projection.mode !== projectionMode) throw new Error(`compare: expected a ${projectionMode} projection`);

  const monteCarlo = simulate(inputs, {
    mode: 'monteCarloStochasticReturns',
    seed: options.seed,
    asOf: options.asOf,
    // Summary retention: the comparison needs aggregates only, never 2 x trials full results.
    monteCarlo: { trials, retention: 'summary' },
  });
  if (monteCarlo.mode !== 'monteCarloStochasticReturns') throw new Error('compare: expected a Monte Carlo summary');

  const { data, context } = projection.result;
  const last = data[data.length - 1];
  const milestones = SimulationDataExtractor.getMilestonesData(data, context.startAge);
  const taxes = SimulationDataExtractor.getLifetimeTaxesAndPenalties(data);
  const summary = monteCarlo.result.summary;
  const percentiles = StatsUtils.calculatePercentilesFromValues(summary.finalValues);

  return {
    data,
    lastValue: last.portfolio.totalValue,
    success: Number(evaluateSuccess(projection.result)),
    retirementAge: milestones.retirementAge,
    bankruptcyAge: milestones.bankruptcyAge,
    taxes,
    summary,
    percentiles,
  };
}

/**
 * Compares two plans. Both sides run on `asOf`, with `seed` and `trials` held equal, so the
 * report isolates the plans themselves.
 *
 * @throws if the trial count is outside the supported Monte Carlo range, or if a plan has no
 * timeline (the same rule `simulate()` applies).
 */
export function comparePlans(a: SimulatorInputs, b: SimulatorInputs, options: CompareOptions): CompareReport {
  const trials = options.trials ?? DEFAULT_MONTE_CARLO_TRIALS;
  // Validated here so a comparison cannot quietly run an unsupported trial count.
  resolveMonteCarloConfig({ trials });

  const sideA = summarizeSide(a, options, trials);
  const sideB = summarizeSide(b, options, trials);

  const metrics: CompareMetric[] = [
    metric('finalPortfolioValue', 'Final portfolio value', 'projection', 'currency', sideA.lastValue, sideB.lastValue),
    metric('success', 'Success', 'projection', 'flag', sideA.success, sideB.success),
    metric('retirementAge', 'Retirement age', 'projection', 'age', sideA.retirementAge, sideB.retirementAge),
    metric('bankruptcyAge', 'Bankruptcy age', 'projection', 'age', sideA.bankruptcyAge, sideB.bankruptcyAge),
    metric(
      'lifetimeTaxesAndPenalties',
      'Lifetime taxes and penalties',
      'taxes',
      'currency',
      sideA.taxes.lifetimeTaxesAndPenalties,
      sideB.taxes.lifetimeTaxesAndPenalties
    ),
    metric(
      'lifetimeFederalIncomeTax',
      'Federal income tax',
      'taxes',
      'currency',
      sideA.taxes.lifetimeFederalIncomeTax,
      sideB.taxes.lifetimeFederalIncomeTax
    ),
    metric('lifetimeFicaTax', 'FICA tax', 'taxes', 'currency', sideA.taxes.lifetimeFicaTax, sideB.taxes.lifetimeFicaTax),
    metric(
      'lifetimeCapitalGainsTax',
      'Capital gains tax',
      'taxes',
      'currency',
      sideA.taxes.lifetimeCapitalGainsTax,
      sideB.taxes.lifetimeCapitalGainsTax
    ),
    metric('lifetimeNiit', 'Net investment income tax', 'taxes', 'currency', sideA.taxes.lifetimeNiit, sideB.taxes.lifetimeNiit),
    metric(
      'lifetimeEarlyWithdrawalPenalties',
      'Early withdrawal penalties',
      'taxes',
      'currency',
      sideA.taxes.lifetimeEarlyWithdrawalPenalties,
      sideB.taxes.lifetimeEarlyWithdrawalPenalties
    ),
    metric(
      'monteCarloSuccessRate',
      'Monte Carlo success rate',
      'monteCarlo',
      'percentage',
      sideA.summary.successRate,
      sideB.summary.successRate
    ),
    metric(
      'monteCarloMeanFinalValue',
      'Mean final value',
      'monteCarlo',
      'currency',
      sideA.summary.finalValue.mean,
      sideB.summary.finalValue.mean
    ),
    metric('monteCarloP10FinalValue', 'P10 final value', 'monteCarlo', 'currency', sideA.percentiles.p10, sideB.percentiles.p10),
    metric('monteCarloP50FinalValue', 'P50 final value', 'monteCarlo', 'currency', sideA.percentiles.p50, sideB.percentiles.p50),
    metric('monteCarloP90FinalValue', 'P90 final value', 'monteCarlo', 'currency', sideA.percentiles.p90, sideB.percentiles.p90),
    metric(
      'monteCarloRetirementAge',
      'Mean retirement age',
      'monteCarlo',
      'age',
      sideA.summary.retirementAge.mean,
      sideB.summary.retirementAge.mean
    ),
    metric(
      'monteCarloBankruptcyAge',
      'Mean bankruptcy age',
      'monteCarlo',
      'age',
      sideA.summary.bankruptcyAge.mean,
      sideB.summary.bankruptcyAge.mean
    ),
  ];

  const years = Math.min(sideA.data.length, sideB.data.length);
  const yearly: CompareYear[] = Array.from({ length: years }, (_, year) => {
    const aValue = sideA.data[year].portfolio.totalValue;
    const bValue = sideB.data[year].portfolio.totalValue;

    return { year, age: Math.floor(sideA.data[year].age), a: aValue, b: bValue, delta: aValue - bValue };
  });

  return {
    asOf: options.asOf,
    seed: options.seed,
    trials,
    deltaMeaning: COMPARE_DELTA_MEANING,
    metrics,
    yearly,
  };
}
