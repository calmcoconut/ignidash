import { type SimulatorInputs, simulatorSchema } from '../src/lib/schemas/inputs/simulator-schema';
import type { ISODateString } from '../src/lib/calc/clock';
import { analyzeSimulationTaxYear } from '../src/lib/calc/tax-analytics';
import { comparePlans, COMPARE_DELTA_MEANING } from '../src/lib/calc/compare';
import { DEFAULT_MONTE_CARLO_TRIALS, type MonteCarloSummary } from '../src/lib/calc/monte-carlo';
import type { SimulationResult } from '../src/lib/calc/simulation-engine';
import { evaluateSuccess } from '../src/lib/calc/success';
import { SimulationDataExtractor } from '../src/lib/calc/data-extractors/simulation-data-extractor';
import { simulate } from '../src/lib/calc/simulate';
import { StatsUtils } from '../src/lib/utils/stats-utils';
import { oneAtATimeSensitivity } from '../src/lib/calc/sensitivity';
import { compareHousing, type HousingChoice } from '../src/lib/calc/housing-comparison';
import { computeLoanPayment } from '../src/lib/calc/amortization-schedule';
import type { PhysicalAssetInputs } from '../src/lib/schemas/inputs/physical-asset-form-schema';

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
        "Describe the baseline plan as the engine sees it: timeline, how many incomes/accounts/expenses/debts/assets/conversions it has, and the deterministic projection's headline numbers. Call this first to ground the rest of the turn.",
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
              'Deep partial of the plan inputs to override, e.g. {"timeline":{"retirementStrategy":{"type":"fixedAge","retirementAge":67}}} or {"conversions":[{"id":"c1","fromAccountId":"account-1","toAccountId":"account-2","year":2026,"fillToBracket":{"targetBracketRate":0.22,"jurisdiction":"federal"}}]}. simulationSettings cannot be patched: the tool pins the clock, mode and seed.',
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
  {
    type: 'function',
    function: {
      name: 'getTaxAnalytics',
      description:
        'The settled tax shape of one year of the baseline projection (P3-P6): what the engine charged, how full each bracket is, how much taxable income fits before the next rate, the fully loaded rate on the next dollar of each income type, and the distance to the NIIT, additional-Medicare and IRMAA cliffs. The ACA cliff comes back as not evaluated, with what it would need. Read-only: it creates no variant and never changes the plan. Call it when a conversion, withdrawal or bracket question needs a number.',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number', description: 'Calendar year to analyse, e.g. 2029, as shown in the projection.' },
        },
        required: ['year'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'runSensitivityAnalysis',
      description:
        'Run one-at-a-time sensitivity sweeps over returns, inflation, retirement age, or spending (P1-P6). Evaluates final portfolio net worth sensitivity across parameterized variations.',
      parameters: {
        type: 'object',
        properties: {
          variables: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['returns', 'inflation', 'retirementAge', 'spending'],
            },
            description: 'Which variables to sweep. If omitted or empty, sweeps all four variables.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compareHousing',
      description:
        'Run a rent-vs-own comparison from the baseline plan (P1-P6). Compares buying a residence with a mortgage vs renting, reporting the break-even year, winner, net worth deltas, and lifetime housing costs.',
      parameters: {
        type: 'object',
        properties: {
          residencePrice: { type: 'number', description: 'Purchase price of the residence.' },
          downPaymentPercent: { type: 'number', description: 'Down payment as percentage of purchase price, e.g. 20 for 20%.' },
          interestRatePercent: { type: 'number', description: 'Annual mortgage interest rate as percentage, e.g. 6.5 for 6.5%.' },
          termMonths: { type: 'number', description: 'Mortgage loan term in months (defaults to 360 for 30 years).' },
          monthlyRent: { type: 'number', description: 'Monthly rent for the rental alternative.' },
          rentRealGrowthRatePercent: { type: 'number', description: 'Annual real growth rate of rent in percent (defaults to 0).' },
          propertyTaxRatePercent: {
            type: 'number',
            description: 'Annual property tax as percentage of residence value (defaults to 1.25%).',
          },
          maintenanceRatePercent: {
            type: 'number',
            description: 'Annual maintenance and insurance as percentage of residence value (defaults to 1%).',
          },
          appreciationRatePercent: {
            type: 'number',
            description: 'Annual real appreciation rate of the home in percent (defaults to 3%).',
          },
        },
        required: ['residencePrice', 'monthlyRent'],
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

/**
 * A JSON round-trip copy, matching what crosses the tool's JSON boundary.
 *
 * The `undefined` case is guarded because `JSON.stringify(undefined)` returns `undefined` rather
 * than a string, which would make `JSON.parse` throw a SyntaxError. The remaining JSON semantics
 * are deliberate: `NaN`/`Infinity` become `null` and a `Date` becomes a string, which is exactly
 * what these values mean once they are JSON.
 */
const clone = <T>(value: T): T => {
  const json: string | undefined = JSON.stringify(value);

  // pi-lens-ignore: unchecked-throwing-call
  return json === undefined ? value : (JSON.parse(json) as T);
};

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

  return { inputs: parsed.data };
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

  /** The baseline projection's rows, computed at most once per turn: the analytics tool reads them. */
  let baselineRowsCache: SimulationResult['data'] | null = null;
  const baselineRows = () => (baselineRowsCache ??= projectFixed(baseline, asOf, seed).data);

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
          conversions: (baseline.conversions ?? []).length,
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

  /**
   * The tax analytics for one settled year (P3-P6, §7-A3).
   *
   * A read-only view of the baseline projection: it creates no variant, applies no patch and
   * never touches the plan, so it costs one tool call and no variant budget. Every number comes
   * from `analyzeSimulationTaxYear`, the same pure function the app calls — this tool only picks
   * the row by calendar year and curates what the agent needs to quote.
   */
  const getTaxAnalytics = (args: Json): string => {
    const year = args.year;
    if (typeof year !== 'number' || !Number.isInteger(year)) {
      return error('year must be a whole calendar year, e.g. 2029.');
    }

    const data = baselineRows();
    // Rows are annual today, but take the year's LAST row so a monthly projection would still answer
    // with the year's settled position rather than its first month.
    let index = -1;
    for (let row = data.length - 1; row >= 0; row--) {
      if (Number(data[row].date.slice(0, 4)) === year) {
        index = row;
        break;
      }
    }

    if (index < 0) {
      const firstYear = Number(data[0].date.slice(0, 4));
      const lastYear = Number(data[data.length - 1].date.slice(0, 4));

      return error(`The projection has no year ${year}; it covers ${firstYear} to ${lastYear}.`, { firstYear, lastYear });
    }

    // Row 0 is the plan's initial state and carries no tax result, so a projection that starts in
    // this year has no settled figures for it. Refuse rather than answer about another year.
    if (!data[index].taxes) {
      return error(`Year ${year} holds only the plan's starting state, which has no settled tax result; analyse the next year instead.`);
    }

    const analytics = analyzeSimulationTaxYear({
      data,
      index,
      filingStatus: baseline.taxSettings.filingStatus,
      // The engine prices the year in today's dollars and deflates the statute-locked thresholds;
      // the analytics must use the same assumption or its headroom figures contradict the return.
      inflationRatePercent: baseline.marketAssumptions.inflationRate,
    });

    return JSON.stringify({
      year,
      taxYear: analytics.taxYear,
      filingStatus: analytics.filingStatus,
      reported: analytics.reported,
      deductions: analytics.deductions,
      bracketFill: analytics.bracketFill,
      conversionHeadroom: analytics.conversionHeadroom,
      marginalRates: analytics.marginalRates,
      cliffs: analytics.cliffs,
      jurisdictions: analytics.jurisdictions,
      notComputed: analytics.notComputed,
    });
  };

  const runSensitivity = (args: Json): string => {
    const report = oneAtATimeSensitivity(baseline, {
      asOf,
    });

    const requestedVars = Array.isArray(args.variables) && args.variables.length > 0 ? (args.variables as string[]) : null;
    const entries = requestedVars ? report.entries.filter((entry) => requestedVars.includes(entry.variable)) : report.entries;

    return JSON.stringify({
      metric: report.metric,
      baseOutcome: report.baseOutcome,
      sweeps: report.sweeps,
      entries: entries.map((entry) => ({
        variable: entry.variable,
        effect: entry.effect,
        low: entry.low,
        high: entry.high,
      })),
    });
  };

  const runCompareHousing = (args: Json): string => {
    const residencePrice = Number(args.residencePrice);
    if (!Number.isFinite(residencePrice) || residencePrice <= 0) {
      return error('residencePrice must be a positive number.');
    }

    const monthlyRent = Number(args.monthlyRent);
    if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) {
      return error('monthlyRent must be a positive number.');
    }

    const downPaymentPercent = args.downPaymentPercent !== undefined ? Number(args.downPaymentPercent) : 20;
    const interestRatePercent = args.interestRatePercent !== undefined ? Number(args.interestRatePercent) : 6.5;
    const termMonths = args.termMonths !== undefined ? Number(args.termMonths) : 360;
    const downPayment = (downPaymentPercent / 100) * residencePrice;
    const loanBalance = Math.max(0, residencePrice - downPayment);
    const monthlyPayment =
      loanBalance > 0
        ? computeLoanPayment({
            principal: loanBalance,
            annualRatePercent: interestRatePercent,
            termMonths,
          })
        : 0;

    const residence: PhysicalAssetInputs = {
      id: 'chat-comparison-residence',
      name: 'Primary Residence',
      assetType: 'primaryResidence',
      purchaseDate: { type: 'now' },
      purchasePrice: residencePrice,
      appreciationRate: args.appreciationRatePercent !== undefined ? Number(args.appreciationRatePercent) : 3,
      paymentMethod:
        loanBalance > 0
          ? {
              type: 'loan',
              downPayment,
              loanBalance,
              apr: interestRatePercent,
              monthlyPayment,
              termMonths,
            }
          : { type: 'cash' },
      saleDate: { type: 'atLifeExpectancy' },
    };

    const choice: HousingChoice = {
      residence,
      monthlyRent,
      propertyTaxRatePercent: args.propertyTaxRatePercent !== undefined ? Number(args.propertyTaxRatePercent) : undefined,
      maintenanceRatePercent: args.maintenanceRatePercent !== undefined ? Number(args.maintenanceRatePercent) : undefined,
      rentRealGrowthRatePercent: args.rentRealGrowthRatePercent !== undefined ? Number(args.rentRealGrowthRatePercent) : undefined,
    };

    const report = compareHousing(baseline, choice, {
      asOf,
      seed,
      mode: 'fixedReturns',
    });

    return JSON.stringify({
      finalWinner: report.finalWinner,
      finalLiquidationWinner: report.finalLiquidationWinner,
      breakEven: report.breakEven,
      firstAhead: report.firstAhead,
      liquidationBreakEven: report.liquidationBreakEven,
      finalDeltaNetWorth: report.finalDeltaNetWorth,
      finalDeltaLiquidationValue: report.finalDeltaLiquidationValue,
      deltaMeaning: report.deltaMeaning,
      headlineDeltas: [5, 10, 20, 30]
        .map((y) => report.years.find((row) => row.yearIndex === y))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .map((row) => ({
          yearIndex: row.yearIndex,
          calendarYear: row.calendarYear,
          deltaNetWorth: row.deltaNetWorth,
          deltaPortfolio: row.deltaPortfolio,
          deltaLiquidationValue: row.deltaLiquidationValue,
        })),
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
        case 'getTaxAnalytics':
          return getTaxAnalytics(parsedArgs);
        case 'runSensitivityAnalysis':
          return runSensitivity(parsedArgs);
        case 'compareHousing':
          return runCompareHousing(parsedArgs);
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
