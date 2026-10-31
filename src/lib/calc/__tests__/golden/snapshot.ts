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

/**
 * Significant digits the cross-engine comparison keeps — about 1e-12 of relative tolerance.
 *
 * `simulate()` is exact *within* one JavaScript engine: the determinism test in
 * `golden-corpus.test.ts` still requires two builds to serialise byte-identically. It is not
 * exact *across* engines, because ECMAScript leaves `Math.pow` implementation-approximated and
 * V8 changed it. Measured on this tree: `Math.pow(1.03, 12)` is `1.4257608868461795204` on V8
 * 12.4 (Node 22.23.4) and `1.4257608868461792984` on V8 13.6 (Node 24.22.2) — 1 ulp. The
 * difference enters through `time-binding.ts`'s `Math.pow(1 + rate/100, years)`, is turned into
 * an integer year span by `tax-data/real-dollars.ts`, and `salt-cap.ts`'s
 * `phaseDown = cap - allowed` cancelling subtraction amplifies it to 32 ulp: 38 leaves differ,
 * worst case 5.2e-15 relative, all in the deflation chain (`niit.threshold`,
 * `saltCap.{phaseDown,allowed}`, the itemized SALT line and its total). No portfolio value, wage
 * or percentile moves.
 *
 * Twelve digits put the rounding step at ~1e-12 of the value — two orders of magnitude above the
 * measured 5.2e-15 spread, and no coarser. A 1e-9 window (the number the handover suggested)
 * would be 200,000x looser than any observed difference and would hide real defects. What the
 * corpus gives up: a change below ~1e-12 relative is invisible here, so the last few bits of a
 * float are no longer pinned. The corpus still pins every number a reader sees.
 */
export const COMPARISON_PRECISION = 12;

/**
 * The comparison's single rounding rule, exported so a test can name the precision it relies on.
 * Every finite number becomes its 12-significant-digit value; nothing else is touched, so
 * structure, key order and `Infinity` all survive the traversal that uses this.
 */
export function canonicalizeNumber(value: number): number {
  return Number(value.toPrecision(COMPARISON_PRECISION));
}

function canonicalizeValue(value: unknown): unknown {
  // A number, finite or not. Non-finite has to be decided *here*, before the rounding: `Infinity`
  // is a real engine value (the top tax bracket's unbounded `max`) and must survive untouched,
  // and the `__nonFinite:` codec below only ever runs on the way to disk, never on these values.
  if (typeof value === 'number') return Number.isFinite(value) ? canonicalizeNumber(value) : value;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value !== 'object' || value === null) return value;

  const canonical: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) canonical[key] = canonicalizeValue(child);
  return canonical;
}

/**
 * A copy of the corpus as the harness compares it: every finite number rounded to
 * `COMPARISON_PRECISION`, everything else identical. Both comparisons — the per-fixture value
 * walk and the whole-file byte comparison — apply this to *both* sides, so a rounded value and a
 * full-precision value are compared after the same normalisation.
 *
 * The frozen file is deliberately not touched: rounding `corpus.json` itself would rewrite 19,895
 * of its 31,504 non-zero finite numbers (63% of the non-zero ones, 27% of all 72,963) for no gain
 * over normalising both sides of the comparison.
 */
export function canonicalizeCorpus(corpus: GoldenCorpus): GoldenCorpus {
  return canonicalizeValue(corpus) as GoldenCorpus;
}

/** The text two corpora are compared as: `serializeCorpus` after `canonicalizeCorpus`. */
export function serializeCanonicalCorpus(corpus: GoldenCorpus): string {
  return serializeCorpus(canonicalizeCorpus(corpus));
}
