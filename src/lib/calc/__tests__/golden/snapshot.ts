/**
 * Builds the golden corpus snapshot from `simulate()` and the extractors (parity plan P2-P1b).
 *
 * The snapshot is deliberately *raw engine output plus extractor output*, not a hand-picked set of
 * numbers: if a future change moves a data point, a tax row or a percentile, the diff shows exactly
 * where. Every value here is produced by the pure entry point, so the generator needs no store, no
 * worker and no clock — `GOLDEN_AS_OF` pins the only date the run may use.
 *
 * Monte Carlo runs are deliberately absent: the corpus holds single runs only (P2-P3 lands after
 * this freeze). The cross-run block *does* call two multi-simulation helpers,
 * `MultiSimulationAnalyzer.analyze` and `TableDataExtractor.extractMultiSimulationData`, over three
 * same-length runs; both iterate the run list directly and are safe at that size. What the corpus
 * never calls is `ChartDataExtractor.extractMultiSimulationPhasesData` (nor
 * `TableDataExtractor.extractMultiSimulationYearlyAggregateData`), which index the run list by
 * yearly row index and throw when there are fewer runs than years. That is the quirk the corpus
 * avoids — not "no multi-simulation extractor at all".
 *
 * Tax-year resolution is likewise *not* covered here: with one checked-in ruleset every simulated
 * year resolves to the same object, so a wrong-year regression would leave these numbers identical.
 * That property is guarded by `src/lib/calc/tax-data/tax-year.test.ts`; see README.md.
 */

import type { SimulationResult } from '../../simulation-engine';
import type { MultiSimulationTableRow } from '@/lib/schemas/tables/multi-simulation-table-schema';
import type { SingleSimulationNetWorthTableRow, SingleSimulationTaxesTableRow } from '@/lib/schemas/tables/single-simulation-table-schema';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import type { Percentiles } from '@/lib/utils/stats-utils';

import { simulate } from '../../simulate';
import { evaluateSuccess } from '../../success';
import { TableDataExtractor } from '../../data-extractors/table-data-extractor';
import { KeyMetricsExtractor } from '../../data-extractors/key-metrics-extractor';
import { MultiSimulationAnalyzer } from '../../data-analyzers/multi-simulation-analyzer';
import { StatsUtils } from '@/lib/utils/stats-utils';
import { CROSS_PLAN_FIXTURE_IDS, CROSS_RUN_FIXTURE_ID, GOLDEN_AS_OF, GOLDEN_FIXTURES, validateFixture, type GoldenMode } from './fixtures';

/** The three single-run modes, in a fixed order, as the cross-run fixture runs them. */
const CROSS_RUN_MODES = ['fixedReturns', 'stochasticReturns', 'historicalReturns'] as const;

/** One frozen run: the engine's own result plus the extractor views derived from it. */
export interface GoldenRunSnapshot {
  /** `simulate()`'s outcome, unchanged (mode tag + result). */
  simulation: unknown;
  success: boolean;
  keyMetrics: KeyMetrics;
  netWorthRows: SingleSimulationNetWorthTableRow[];
  taxRows: SingleSimulationTaxesTableRow[];
  /** Percentiles of this run's per-year portfolio values — the interpolation, frozen exactly. */
  yearlyValuePercentiles: Percentiles<number>;
}

export interface GoldenCorpus {
  /** Bumped only if the snapshot *shape* changes, never to hide a number change. */
  formatVersion: 1;
  /** The only clock the runs may use. */
  asOf: string;
  fixtures: Record<string, Partial<Record<GoldenMode, GoldenRunSnapshot>>>;
  crossPlan: {
    /** Multi-simulation readouts over the cross-run fixture's three modes (n = 3, no yearly indexing). */
    multiSimulation: {
      success: number;
      seedByPercentile: { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number };
      rows: MultiSimulationTableRow[];
    };
    /** Percentiles of the three plans' final portfolio values. */
    finalValuePercentiles: Percentiles<number>;
  };
}

const percentilesOf = (values: number[]): Percentiles<number> =>
  StatsUtils.calculatePercentilesFromValues([...values].sort((a, b) => a - b));

/** Runs one fixture in one mode and collects everything the corpus freezes for it. */
export function snapshotRun(fixtureId: string, mode: GoldenMode, seed: number, inputs: Parameters<typeof simulate>[0]): GoldenRunSnapshot {
  const outcome = simulate(validateFixture(inputs), { mode, seed, asOf: GOLDEN_AS_OF });
  if (outcome.mode !== mode) throw new Error(`simulate() returned ${outcome.mode} for a ${mode} run of ${fixtureId}`);

  const result = outcome.result;

  return {
    simulation: outcome,
    success: evaluateSuccess(result),
    keyMetrics: KeyMetricsExtractor.extractSingleSimulationMetrics(result),
    netWorthRows: TableDataExtractor.extractSingleSimulationNetWorthData(result),
    taxRows: TableDataExtractor.extractSingleSimulationTaxesData(result),
    yearlyValuePercentiles: percentilesOf(result.data.map((dataPoint) => dataPoint.portfolio.totalValue)),
  };
}

/** Builds the whole corpus. Deterministic: same code, same bytes. */
export function buildCorpus(): GoldenCorpus {
  const fixtures: GoldenCorpus['fixtures'] = {};

  for (const fixture of GOLDEN_FIXTURES) {
    const runs: Partial<Record<GoldenMode, GoldenRunSnapshot>> = {};
    for (const run of fixture.runs) runs[run.mode] = snapshotRun(fixture.id, run.mode, run.seed, fixture.inputs);
    fixtures[fixture.id] = runs;
  }

  const crossRuns = CROSS_RUN_MODES.map((mode) => {
    const snapshot = fixtures[CROSS_RUN_FIXTURE_ID][mode];
    if (!snapshot) throw new Error(`Golden corpus needs a ${mode} snapshot for ${CROSS_RUN_FIXTURE_ID}`);
    return (snapshot.simulation as { result: SimulationResult }).result;
  });

  const multi = { simulations: crossRuns.map((result, index): [number, SimulationResult] => [index + 1, result]) };
  const analysis = MultiSimulationAnalyzer.analyze(multi, 'finalPortfolioValue');

  return {
    formatVersion: 1,
    asOf: GOLDEN_AS_OF,
    fixtures,
    crossPlan: {
      multiSimulation: {
        success: analysis.success,
        seedByPercentile: {
          p5: analysis.results.p5.seed,
          p10: analysis.results.p10.seed,
          p25: analysis.results.p25.seed,
          p50: analysis.results.p50.seed,
          p75: analysis.results.p75.seed,
          p90: analysis.results.p90.seed,
          p95: analysis.results.p95.seed,
        },
        rows: TableDataExtractor.extractMultiSimulationData(multi),
      },
      // Deliberately over the named original trio (not every fixture), so adding a fixture cannot
      // move an already-frozen cross-plan number.
      finalValuePercentiles: percentilesOf(
        CROSS_PLAN_FIXTURE_IDS.map((fixtureId) => {
          const snapshot = fixtures[fixtureId].fixedReturns;
          if (!snapshot) throw new Error(`Golden corpus needs a fixedReturns snapshot for ${fixtureId}`);
          const result = (snapshot.simulation as { result: SimulationResult }).result;
          return result.data[result.data.length - 1].portfolio.totalValue;
        })
      ),
    },
  };
}

const NON_FINITE_PREFIX = '__nonFinite:';

/**
 * JSON cannot carry `Infinity`, and the engine uses it for the unbounded top tax bracket
 * (`federalIncomeTaxBrackets[...].max = Infinity`). Encoding it instead of letting
 * `JSON.stringify` write `null` keeps the corpus faithful: a bracket that later becomes finite
 * shows up as a diff rather than as `null -> number`.
 */
function encodeNonFinite(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? `${NON_FINITE_PREFIX}${String(value)}` : value;
}

function decodeNonFinite(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(NON_FINITE_PREFIX)) return value;
  return Number(value.slice(NON_FINITE_PREFIX.length));
}

/** The corpus exactly as it is written to disk: non-finite numbers encoded, two-space indent, trailing newline. */
export function serializeCorpus(corpus: GoldenCorpus): string {
  return `${JSON.stringify(corpus, encodeNonFinite, 2)}\n`;
}

/** Reads a corpus file back into the shape the generator produced, `Infinity` included. */
export function parseCorpus(text: string): GoldenCorpus {
  return JSON.parse(text, decodeNonFinite) as GoldenCorpus;
}
