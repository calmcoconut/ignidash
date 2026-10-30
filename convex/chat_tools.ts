import { type SimulatorInputs, simulatorSchema } from '../src/lib/schemas/inputs/simulator-schema';
import type { ISODateString } from '../src/lib/calc/clock';
import { comparePlans, COMPARE_DELTA_MEANING } from '../src/lib/calc/compare';
import { DEFAULT_MONTE_CARLO_TRIALS, type MonteCarloSummary } from '../src/lib/calc/monte-carlo';
import type { SimulationResult } from '../src/lib/calc/simulation-engine';
import { evaluateSuccess } from '../src/lib/calc/success';
import { SimulationDataExtractor } from '../src/lib/calc/data-extractors/simulation-data-extractor';
import { simulate } from '../src/lib/calc/simulate';
import { StatsUtils } from '../src/lib/utils/stats-utils';

/**
 * The tools the chat agent can call (§7-A1), executed against the pure engine on the server.
 *
 * Hard limits from F2, enforced here rather than described to the model:
 *
 * - at most **12 tool calls** per turn,
 * - at most **6 variants** per turn,
 * - comparisons always run in deterministic mode with a **fixed seed**,
 * - Monte Carlo runs only on request, with **500 trials** and summary retention.
 *
 * A `planPatch` is merged over the plan's own inputs, validated with `simulatorSchema`, and used
 * for that one simulation. It is **never** written to the plan: the user applies a variant through
 * the normal mutations. Nothing here touches the clock: `asOf` is passed in with the turn.
 */

/** F2: hard per-turn bounds. */
export const MAX_TOOL_CALLS_PER_TURN = 12;
export const MAX_VARIANTS_PER_TURN = 6;

/** Comparisons are deterministic and pinned, so a delta is the plan and not the sample. */
export const TOOL_SEED = 1;
export const TOOL_MONTE_CARLO_TRIALS = DEFAULT_MONTE_CARLO_TRIALS;

/** The one thing a patch may not change: the tool pins the clock, mode, seed and trial count. */
const UNPATCHABLE_KEYS = new Set(['simulationSettings']);

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const CHAT_TOOL_DEFINITIONS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'getPlanSummary',
      description:
        "Describe the baseline plan as the engine sees it: timeline, how many incomes/accounts/expenses/debts/assets it has, and the deterministic projection's headline numbers. Call this first to ground the rest of the turn.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulateVariant',
      description:
        'Run the plan with a patch applied (deep-merged over the current inputs, then validated) and return key metrics, lifetime tax lines and per-year tax lines. The patch is never saved. At most 6 variants per turn.',
      parameters: {
        type: 'object',
        properties: {
          variantId: { type: 'string', description: 'Short id you choose for this variant, e.g. "roth-20k".' },
          planPatch: {
            type: 'object',
            description:
              'Deep partial of the plan inputs to override, e.g. {"timeline":{"retirementStrategy":{"type":"fixedAge","retirementAge":67}}}. simulationSettings cannot be patched: the tool pins the clock, mode and seed.',
          },
          includeMonteCarlo: {
            type: 'boolean',
            description:
              'Also run 500 Monte Carlo trials (summary only) for a success rate and value percentiles. Off unless the user asks.',
          },
        },
        required: ['variantId', 'planPatch'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compareToBaseline',
      description:
        'Diff a variant you already simulated against the baseline plan, using the compare delta extractor. Every delta is variant minus baseline (a - b).',
      parameters: {
        type: 'object',
        properties: {
          variantId: { type: 'string', description: 'The id passed to simulateVariant.' },
        },
        required: ['variantId'],
        additionalProperties: false,
      },
    },
  },
];

export interface ChatToolkitOptions {
  /** The plan's inputs, as transformed from the database. Never mutated. */
  inputs: SimulatorInputs;
  /** The turn's clock, as an ISO date. */
  asOf: ISODateString;
  /** Fixed comparison seed; overridable only for tests. */
  seed?: number;
}

export interface ChatToolkit {
  definitions: ChatToolDefinition[];
  /** Executes one tool call; always returns JSON text (errors are results, never throws). */
  execute: (name: string, args: unknown) => string;
  /** Tool calls consumed so far this turn. */
  callCount: () => number;
  /** Variant ids created so far this turn. */
  variantIds: () => string[];
}

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isPlainObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep merge: objects merge, everything else (arrays, scalars, null) replaces. */
function deepMerge(base: Json, patch: Json): Json {
  const merged: Json = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : clone(value);
  }

  return merged;
}

interface ValidationFailure {
  issues: Array<{ path: string; message: string }>;
}

/** Merges a patch over the baseline and validates the result with the plan schema. */
function applyPatch(baseline: SimulatorInputs, patch: unknown): { inputs: SimulatorInputs } | ValidationFailure {
  if (!isPlainObject(patch)) return { issues: [{ path: '', message: 'planPatch must be an object.' }] };

  const unknownKeys = Object.keys(patch).filter((key) => !(key in simulatorSchema.shape));
  if (unknownKeys.length > 0) {
    return { issues: unknownKeys.map((key) => ({ path: key, message: `Unknown plan section "${key}".` })) };
  }

  const blockedKeys = Object.keys(patch).filter((key) => UNPATCHABLE_KEYS.has(key));
  if (blockedKeys.length > 0) {
    return {
      issues: blockedKeys.map((key) => ({
        path: key,
        message: 'simulationSettings cannot be patched: the tool pins the clock, mode and seed.',
      })),
    };
  }

  // Re-express the plan as a plain JSON record for the merge (no assertions: `fromEntries` is
  // already `Record<string, any>`), then validate the merged plan with the real schema.
  const baselineJson: Json = Object.fromEntries(Object.entries(baseline));
  const parsed = simulatorSchema.safeParse(deepMerge(baselineJson, patch));
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }

  return { inputs: parsed.data as SimulatorInputs };
}

/**
 * Deterministic projection of one plan at the turn's clock. Declared with a concrete return type so
 * the narrowed result type is established here, at the boundary.
 */
function projectFixed(inputs: SimulatorInputs, asOf: ISODateString, seed: number): SimulationResult {
  const outcome = simulate(inputs, { mode: 'fixedReturns' as const, seed, asOf });
  if (outcome.mode !== 'fixedReturns') throw new Error('chat tools: expected a fixed-returns projection');

  return outcome.result;
}

/** Summary-only Monte Carlo (F2: on request, 500 trials, no per-run results). */
function monteCarloRun(inputs: SimulatorInputs, asOf: ISODateString, seed: number): MonteCarloSummary {
  const outcome = simulate(inputs, {
    mode: 'monteCarloStochasticReturns' as const,
    seed,
    asOf,
    monteCarlo: { trials: TOOL_MONTE_CARLO_TRIALS, retention: 'summary' },
  });
  if (outcome.mode !== 'monteCarloStochasticReturns') throw new Error('chat tools: expected a Monte Carlo summary');

  return outcome.result.summary;
}

/** The projection plus the tax lines the agent reports. */
function project(inputs: SimulatorInputs, asOf: ISODateString, seed: number) {
  const result = projectFixed(inputs, asOf, seed);
  const { data, context } = result;
  const milestones = SimulationDataExtractor.getMilestonesData(data, context.startAge);
  const taxes = SimulationDataExtractor.getLifetimeTaxesAndPenalties(data);

  return {
    success: evaluateSuccess(result),
    finalPortfolioValue: data[data.length - 1].portfolio.totalValue,
    retirementAge: milestones.retirementAge,
    bankruptcyAge: milestones.bankruptcyAge,
    taxes,
    perYearTaxes: data.map((dataPoint, year) => {
      const amounts = SimulationDataExtractor.getTaxAmountsByType(dataPoint);
      const total = amounts.federalIncomeTax + amounts.capitalGainsTax + amounts.niit + amounts.earlyWithdrawalPenalties + amounts.ficaTax;

      return {
        year,
        age: Math.floor(dataPoint.age),
        federalIncomeTax: amounts.federalIncomeTax,
        ficaTax: amounts.ficaTax,
        capitalGainsTax: amounts.capitalGainsTax,
        niit: amounts.niit,
        earlyWithdrawalPenalties: amounts.earlyWithdrawalPenalties,
        total,
      };
    }),
  };
}

/** The Monte Carlo numbers the agent reports, with percentiles computed the same way the UI does. */
function monteCarloSummary(inputs: SimulatorInputs, asOf: ISODateString, seed: number) {
  const summary = monteCarloRun(inputs, asOf, seed);
  const percentiles = StatsUtils.calculatePercentilesFromValues(summary.finalValues);

  return {
    trials: summary.trials,
    seed,
    retention: 'summary' as const,
    successRate: summary.successRate,
    meanFinalValue: summary.finalValue.mean,
    p10FinalValue: percentiles.p10,
    p50FinalValue: percentiles.p50,
    p90FinalValue: percentiles.p90,
    meanRetirementAge: summary.retirementAge.mean,
    meanBankruptcyAge: summary.bankruptcyAge.mean,
  };
}

export function createChatToolkit({ inputs, asOf, seed = TOOL_SEED }: ChatToolkitOptions): ChatToolkit {
  const baseline = clone(inputs);
  const variants = new Map<string, SimulatorInputs>();
  let calls = 0;

  const error = (message: string, extra: Json = {}): string => JSON.stringify({ error: message, ...extra });

  const getPlanSummary = (): string => {
    const projection = project(baseline, asOf, seed);

    return JSON.stringify({
      plan: {
        asOf,
        seed,
        mode: 'fixedReturns',
        timeline: baseline.timeline,
        counts: {
          incomes: Object.keys(baseline.incomes).length,
          accounts: Object.keys(baseline.accounts).length,
          expenses: Object.keys(baseline.expenses).length,
          debts: Object.keys(baseline.debts).length,
          physicalAssets: Object.keys(baseline.physicalAssets).length,
          contributionRules: Object.keys(baseline.contributionRules).length,
        },
      },
      baseline: {
        success: projection.success,
        finalPortfolioValue: projection.finalPortfolioValue,
        retirementAge: projection.retirementAge,
        bankruptcyAge: projection.bankruptcyAge,
        lifetimeTaxesAndPenalties: projection.taxes.lifetimeTaxesAndPenalties,
        lifetimeFederalIncomeTax: projection.taxes.lifetimeFederalIncomeTax,
        lifetimeCapitalGainsTax: projection.taxes.lifetimeCapitalGainsTax,
      },
    });
  };

  const simulateVariant = (args: Json): string => {
    const variantId = args.variantId;
    if (typeof variantId !== 'string' || variantId.trim() === '') return error('variantId must be a non-empty string.');

    const isNew = !variants.has(variantId);
    if (isNew && variants.size >= MAX_VARIANTS_PER_TURN) {
      return error(`Variant budget exhausted: at most ${MAX_VARIANTS_PER_TURN} variants per turn.`, {
        variants: [...variants.keys()],
      });
    }

    const applied = applyPatch(baseline, args.planPatch);
    if ('issues' in applied) return error('The plan patch did not validate; nothing was simulated.', { issues: applied.issues });

    variants.set(variantId, applied.inputs);
    const projection = project(applied.inputs, asOf, seed);
    const includeMonteCarlo = args.includeMonteCarlo === true;

    return JSON.stringify({
      variantId,
      patchApplied: !('issues' in applied),
      success: projection.success,
      finalPortfolioValue: projection.finalPortfolioValue,
      retirementAge: projection.retirementAge,
      bankruptcyAge: projection.bankruptcyAge,
      lifetimeTaxes: {
        total: projection.taxes.lifetimeTaxesAndPenalties,
        federalIncomeTax: projection.taxes.lifetimeFederalIncomeTax,
        ficaTax: projection.taxes.lifetimeFicaTax,
        capitalGainsTax: projection.taxes.lifetimeCapitalGainsTax,
        niit: projection.taxes.lifetimeNiit,
        earlyWithdrawalPenalties: projection.taxes.lifetimeEarlyWithdrawalPenalties,
      },
      perYearTaxes: projection.perYearTaxes,
      monteCarlo: includeMonteCarlo ? monteCarloSummary(applied.inputs, asOf, seed) : null,
      variantsUsed: variants.size,
    });
  };

  const compareToBaseline = (args: Json): string => {
    const variantId = args.variantId;
    if (typeof variantId !== 'string') return error('variantId must be a string.');

    const variant = variants.get(variantId);
    if (!variant) return error(`Unknown variant "${variantId}"; call simulateVariant first.`, { variants: [...variants.keys()] });

    const report = comparePlans(variant, baseline, { asOf, seed, trials: TOOL_MONTE_CARLO_TRIALS });

    return JSON.stringify({
      variantId,
      deltaMeaning: COMPARE_DELTA_MEANING,
      asOf: report.asOf,
      seed: report.seed,
      trials: report.trials,
      metrics: report.metrics,
      yearly: report.yearly,
    });
  };

  const execute = (name: string, args: unknown): string => {
    if (calls >= MAX_TOOL_CALLS_PER_TURN) {
      return error(`Tool budget exhausted: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn. Call nothing further and answer.`);
    }
    calls += 1;

    const parsedArgs = isPlainObject(args) ? args : {};

    try {
      switch (name) {
        case 'getPlanSummary':
          return getPlanSummary();
        case 'simulateVariant':
          return simulateVariant(parsedArgs);
        case 'compareToBaseline':
          return compareToBaseline(parsedArgs);
        default:
          return error(`Unknown tool "${name}".`);
      }
    } catch (caught) {
      return error(caught instanceof Error ? caught.message : 'Tool execution failed.');
    }
  };

  return {
    definitions: CHAT_TOOL_DEFINITIONS,
    execute,
    callCount: () => calls,
    variantIds: () => [...variants.keys()],
  };
}
