/**
 * One-at-a-time sensitivity sweeps and tornado data (parity plan P2-P7).
 *
 * Each variable is perturbed on its own — returns, inflation, retirement age and spending — and
 * the plan is re-run through `simulate()` in `fixedReturns` mode, so the whole report is a pure
 * function of `(inputs, asOf)`: no wall clock, no randomness, no module state. Two calls with the
 * same arguments are byte-identical, which is what lets the result be cached, compared, or fed to
 * a chart without a "refresh" caveat.
 *
 * ## Why the metric is final portfolio value
 *
 * `finalPortfolio` is the outcome every plan is ultimately judged by, and it is defined for
 * every plan, including one that never retires or runs out of money (it then lands near zero).
 * The two alternatives were considered and left out:
 *
 * - `success` is a single bit for a deterministic run: a sweep would report "0 or 1" bars, so
 *   most perturbations would tie at zero effect and the tornado would say nothing.
 * - `portfolioAtRetirement` is decision-relevant, but it is `null` whenever retirement is never
 *   reached — which is exactly where a retirement-age sweep is most interesting — so a tornado
 *   built on it would have holes at the interesting end.
 *
 * `success` still rides along on every sample (`SensitivitySample.success`) for callers that want
 * to flag a perturbed case that fails, but the ranking uses the metric only.
 *
 * ## Deterministic runs only
 *
 * The sweeps always run `mode: 'fixedReturns'`. A stochastic or historical run would put seed
 * noise of the same order as the perturbation into every bar, so a one-at-a-time tornado over
 * them would rank noise. Monte Carlo sensitivity is a different question (a distribution per
 * variable) and is not what this module claims to answer.
 *
 * ## Ranges
 *
 * The perturbation sizes are arguments, not magic numbers: see `DEFAULT_SENSITIVITY_SWEEPS` and
 * `SensitivitySweepConfig`. Two of them need a rule, because a raw ± could leave the model's
 * domain:
 *
 * - inflation is floored at 0% (the schema's own minimum): the engine converts to real dollars by
 *   dividing by `1 + inflation`, so a negative rate would divide by zero or flip signs;
 * - a retirement age is clamped to the schema's 19–73 age range.
 *
 * A variable that has no meaning for a plan is left out rather than reported as a zero-effect bar:
 * a `swrTarget` timeline has no retirement age to move, so `retirementAge` is absent from the
 * report for such a plan.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import type { ISODateString } from './clock';
import { simulate } from './simulate';
import { KeyMetricsExtractor } from './data-extractors/key-metrics-extractor';

/** The one metric this module ranks by; see the module comment for why. */
export type SensitivityMetric = 'finalPortfolio';

/** The variables a sweep can move, in a fixed order (the report re-sorts by effect). */
export type SensitivityVariable = 'returns' | 'inflation' | 'retirementAge' | 'spending';

export const SENSITIVITY_VARIABLES: readonly SensitivityVariable[] = ['returns', 'inflation', 'retirementAge', 'spending'];

/** How far each variable is moved, in that variable's own units. */
export interface SensitivitySweepConfig {
  /** Percentage points added to and subtracted from every market return (stock, bond and cash). */
  returnDeltaPct: number;
  /** Percentage points added to and subtracted from the plan's inflation assumption. */
  inflationDeltaPct: number;
  /** Years added to and subtracted from a fixed-age retirement age. */
  retirementAgeDeltaYears: number;
  /** Percent added to and subtracted from every expense amount (10 means ±10%). */
  spendingDeltaPct: number;
}

/**
 * The defaults: ±2 points of return, ±1 point of inflation, ±2 years of retirement age, ±10%
 * of spending. Chosen to be large enough to be visible in the outcome and small enough to stay
 * plausible — a sweep is meant to show which assumption the plan is fragile to, not to explore
 * the tails (that is what the Monte Carlo path is for).
 */
export const DEFAULT_SENSITIVITY_SWEEPS: SensitivitySweepConfig = {
  returnDeltaPct: 2,
  inflationDeltaPct: 1,
  retirementAgeDeltaYears: 2,
  spendingDeltaPct: 10,
};

/** `simulate()`'s `seed` argument, unused by `fixedReturns` but required by its signature. */
const DETERMINISTIC_SEED = 1;

/** The schema's retirement-age bounds (`ageField(19, 73)`), so a sweep stays inside what the form accepts. */
const MIN_RETIREMENT_AGE = 19;
const MAX_RETIREMENT_AGE = 73;

/** One run's outcome under a given perturbation. */
export interface SensitivitySample {
  /** The metric this report ranks by, in dollars. */
  outcome: number;
  /** `evaluateSuccess`'s verdict for the same run, carried for callers that want to flag a miss. */
  success: number;
}

/** A sample plus the input value the sweep set to produce it. */
export interface SensitivityCase extends SensitivitySample {
  /**
   * The value the variable was set to: a percentage for `returns` and `inflation`, an age in
   * years for `retirementAge`, and a multiplier for `spending` (0.9 = 10% less spending).
   */
  input: number;
}

/** One variable's contribution to the outcome, ready to draw as a tornado bar. */
export interface SensitivityEntry {
  variable: SensitivityVariable;
  /** The unperturbed case, repeated per entry so a bar can be drawn without cross-referencing. */
  base: SensitivityCase;
  /** The lower input value of the pair (`base.input - delta`). */
  low: SensitivityCase;
  /** The higher input value of the pair (`base.input + delta`). */
  high: SensitivityCase;
  /** `|high.outcome - low.outcome|` — the bar length. Always ≥ 0. */
  effect: number;
}

/** The whole report: the base case plus every variable, largest effect first. */
export interface SensitivityReport {
  metric: SensitivityMetric;
  /** The clock the sweeps ran under, echoed so a stored report explains itself. */
  asOf: ISODateString;
  /** The sweep sizes actually used, after defaults were applied. */
  sweeps: SensitivitySweepConfig;
  /** The unperturbed outcome, equal to a direct `simulate()` run of `inputs`. */
  baseOutcome: number;
  /** Ordered by `effect` descending, ties broken by variable name so the order is stable. */
  entries: SensitivityEntry[];
}

export interface SensitivityOptions {
  /** The run's clock as an ISO calendar date. Never defaulted from the host clock. */
  asOf: ISODateString;
  /** Sweep sizes; anything omitted takes its value from `DEFAULT_SENSITIVITY_SWEEPS`. */
  sweeps?: Partial<SensitivitySweepConfig>;
}

/** Runs one plan through `simulate()` and reads the chosen metric off it. */
function sample(inputs: SimulatorInputs, asOf: ISODateString): SensitivitySample {
  const { result } = simulate(inputs, { mode: 'fixedReturns', seed: DETERMINISTIC_SEED, asOf });
  const metrics = KeyMetricsExtractor.extractSingleSimulationMetrics(result);

  return { outcome: metrics.finalPortfolio, success: metrics.success };
}

/** A perturbed copy of the plan, plus the input value the perturbation set. */
interface Perturbation {
  inputs: SimulatorInputs;
  input: number;
}

/**
 * Applies one variable's perturbation to a copy of the plan.
 *
 * `direction` is −1 for the low case and +1 for the high case. Returns `undefined` when the
 * variable does not apply to this plan (a `swrTarget` timeline has no retirement age).
 */
function perturb(
  inputs: SimulatorInputs,
  variable: SensitivityVariable,
  direction: -1 | 1,
  sweeps: SensitivitySweepConfig
): Perturbation | undefined {
  switch (variable) {
    case 'returns': {
      const delta = direction * sweeps.returnDeltaPct;
      const market = inputs.marketAssumptions;
      const marketAssumptions = {
        ...market,
        stockReturn: market.stockReturn + delta,
        bondReturn: market.bondReturn + delta,
        cashReturn: market.cashReturn + delta,
      };

      return { inputs: { ...inputs, marketAssumptions }, input: marketAssumptions.stockReturn };
    }

    case 'inflation': {
      const market = inputs.marketAssumptions;
      // Floored at the schema's 0%: the engine divides by `1 + inflation` to deflate, so a
      // negative assumption is not a sensitivity case, it is a division by zero or a sign flip.
      const inflationRate = Math.max(0, market.inflationRate + direction * sweeps.inflationDeltaPct);

      return { inputs: { ...inputs, marketAssumptions: { ...market, inflationRate } }, input: inflationRate };
    }

    case 'retirementAge': {
      const timeline = inputs.timeline;
      if (!timeline || timeline.retirementStrategy.type !== 'fixedAge') return undefined;

      const retirementAge = Math.min(
        MAX_RETIREMENT_AGE,
        Math.max(MIN_RETIREMENT_AGE, timeline.retirementStrategy.retirementAge + direction * sweeps.retirementAgeDeltaYears)
      );

      return {
        inputs: { ...inputs, timeline: { ...timeline, retirementStrategy: { type: 'fixedAge', retirementAge } } },
        input: retirementAge,
      };
    }

    case 'spending': {
      const factor = Math.max(0, 1 + (direction * sweeps.spendingDeltaPct) / 100);
      const expenses = Object.fromEntries(
        Object.entries(inputs.expenses).map(([id, expense]) => [id, { ...expense, amount: expense.amount * factor }])
      );

      return { inputs: { ...inputs, expenses }, input: factor };
    }
  }
}

/**
 * Runs the one-at-a-time sweeps for a plan and returns tornado data.
 *
 * The caller's `inputs` is never mutated: every perturbation is built as a copy.
 */
export function oneAtATimeSensitivity(inputs: SimulatorInputs, options: SensitivityOptions): SensitivityReport {
  const sweeps: SensitivitySweepConfig = { ...DEFAULT_SENSITIVITY_SWEEPS, ...options.sweeps };
  const baseSample = sample(inputs, options.asOf);
  const entries: SensitivityEntry[] = [];

  for (const variable of SENSITIVITY_VARIABLES) {
    const low = perturb(inputs, variable, -1, sweeps);
    const high = perturb(inputs, variable, 1, sweeps);
    if (!low || !high) continue;

    const lowSample = sample(low.inputs, options.asOf);
    const highSample = sample(high.inputs, options.asOf);
    const base: SensitivityCase = { input: 0, ...baseSample };

    entries.push({
      variable,
      base,
      low: { input: low.input, ...lowSample },
      high: { input: high.input, ...highSample },
      effect: Math.abs(highSample.outcome - lowSample.outcome),
    });
  }

  // Largest effect first, so a chart renders `entries` in order. Ties break on the variable name
  // with a plain comparison (never `localeCompare`, whose result depends on the host locale).
  entries.sort((a, b) => (b.effect === a.effect ? (a.variable < b.variable ? -1 : 1) : b.effect - a.effect));

  return {
    metric: 'finalPortfolio',
    asOf: options.asOf,
    sweeps,
    baseOutcome: baseSample.outcome,
    entries,
  };
}
