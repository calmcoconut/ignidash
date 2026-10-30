#!/usr/bin/env tsx
/**
 * Benchmark harness (parity plan P2-P6).
 *
 *   npm run bench
 *
 * Measures, on this machine and this plan:
 *
 *   1. serial Monte Carlo throughput — one `simulate()` call, all trials in this process;
 *   2. the same trials split into chunks and run back to back (the shape the pool uses);
 *   3. the same chunks run in parallel OS processes, which is the only parallel path that can
 *      actually be executed headlessly here (see `docs/BENCHMARK.md`);
 *   4. merge overhead — `mergeMonteCarloSummaries` over the chunk summaries;
 *   5. retained heap for `retention: 'summary'` against `retention: 'full'`.
 *
 * Every timed section runs `REPEATS` times; the report carries each run, plus min/median/max and
 * the observed spread, so "reproducible within ±5%" is something a reader can check instead of
 * take on faith.
 *
 * The report is written to `bench-results/bench-latest.json`, which is gitignored: it is an
 * artifact of one machine at one moment, not something to commit.
 *
 * ## What this does NOT measure
 *
 * The browser worker pool (`src/lib/workers/*`) cannot run under Node: `simulation.worker.ts`
 * calls `Comlink.expose`, which needs a worker realm's `addEventListener`, and the pool itself
 * calls `new Worker(new URL(...))` plus `navigator.hardwareConcurrency`. A `worker_threads` thread
 * does not get `tsx`'s resolver either, so it cannot import this TypeScript module graph.
 *
 * Therefore **the pool speedup is NOT measured**. What is measured is the parallel *computational*
 * speedup of the same chunked work in separate OS processes, including process start-up. That
 * number tells you how the engine scales across cores; it is not the app's pool number, and the
 * JSON says so (`poolSpeedupMeasured: false`).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { simulatorSchema } from '../src/lib/schemas/inputs/simulator-schema';
import { simulate } from '../src/lib/calc/simulate';
import { mergeMonteCarloSummaries, runMonteCarloRange, type MonteCarloSummary } from '../src/lib/calc/monte-carlo';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_PATH = join(REPO_ROOT, 'bench-results', 'bench-latest.json');
const CHILD_SCRIPT = join(REPO_ROOT, 'scripts', 'bench-worker.ts');

const MODE = 'monteCarloStochasticReturns' as const;
const AS_OF = '2026-03-15';
const BASE_SEED = 9521;

/** Fixed so two runs measure the same work; sized so spawn overhead is not the whole story. */
const CONFIG = {
  trials: 1600,
  /** `cores - 1` (what the pool uses), capped so a small machine still shows the effect. */
  workers: Math.min(4, Math.max(1, cpus().length - 1)),
  repeats: 5,
  /**
   * Warm-up trials before anything is timed, in this process and in each child. The first
   * `simulate()` call of a fresh process is ~5× slower than the third one on this machine (V8
   * tiering, not the engine's steady state), so timing without it measures the compiler.
   */
  warmupTrials: 200,
  /** Full retention at 1600 trials would hold ~280 MB; 200 keeps the heap measurement sane. */
  heapTrials: 200,
  heapRepeats: 3,
  mergeIterations: 20,
};

/** A plan with enough moving parts to be representative of the engine's real work. */
const PLAN = simulatorSchema.parse({
  timeline: { birthMonth: 6, birthYear: 1990, lifeExpectancy: 90, retirementStrategy: { type: 'fixedAge', retirementAge: 65 } },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 90000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 20 },
      disabled: false,
    },
  },
  accounts: {
    retirement: { id: 'retirement', name: '401k', balance: 400000, type: '401k', percentBonds: 20 },
    brokerage: { id: 'brokerage', name: 'Brokerage', balance: 150000, type: 'taxableBrokerage', percentBonds: 15, costBasis: 100000 },
  },
  expenses: {
    living: {
      id: 'living',
      name: 'Living',
      amount: 45000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
      disabled: false,
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: {
    rule: { id: 'rule', accountId: 'retirement', rank: 1, contributionType: 'unlimited', disabled: false },
  },
  baseContributionRule: { type: 'save' },
  marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: BASE_SEED, simulationMode: MODE },
});

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

interface TimingRuns {
  label: string;
  runsMs: number[];
  minMs: number;
  medianMs: number;
  maxMs: number;
  /** `(max − min) / min`, as a percentage: the run-to-run variance a reader should expect. */
  spreadPct: number;
  trialsPerSecond: number;
}

function summarise(label: string, runsMs: number[], trials: number): TimingRuns {
  const sorted = [...runsMs].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const medianMs = sorted[Math.floor(sorted.length / 2)];

  return {
    label,
    runsMs,
    minMs,
    medianMs,
    maxMs,
    spreadPct: minMs === 0 ? 0 : ((maxMs - minMs) / minMs) * 100,
    trialsPerSecond: (trials / medianMs) * 1000,
  };
}

/** Splits `trials` into `chunks` contiguous ranges, as the pool does. */
function splitRanges(trials: number, chunks: number): Array<{ startIndex: number; count: number }> {
  const base = Math.floor(trials / chunks);
  const remainder = trials % chunks;

  return Array.from({ length: chunks }, (_, index) => {
    const count = base + (index < remainder ? 1 : 0);
    const startIndex = index * base + Math.min(index, remainder);
    return { startIndex, count };
  });
}

const gc = (globalThis as { gc?: () => void }).gc;

function collectGarbage(): void {
  if (!gc) return;
  gc();
  gc();
}

function heapUsedBytes(): number {
  return process.memoryUsage().heapUsed;
}

interface ChildResult {
  computeMs: number;
  warmupMs: number;
  wallMs: number;
  summary: MonteCarloSummary;
}

/** Runs one chunk in a separate process, exactly as `scripts/bench-worker.ts` describes. */
function runChildProcess(startIndex: number, count: number): Promise<ChildResult> {
  const started = performance.now();

  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD_SCRIPT], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`bench worker exited with code ${code}`));
        return;
      }
      const { computeMs, warmupMs, summary } = JSON.parse(stdout) as { computeMs: number; warmupMs: number; summary: MonteCarloSummary };
      resolve({ computeMs, warmupMs, wallMs: performance.now() - started, summary });
    });

    child.stdin.end(
      JSON.stringify({
        inputs: PLAN,
        asOf: AS_OF,
        mode: MODE,
        baseSeed: BASE_SEED,
        startIndex,
        count,
        retention: 'summary',
        warmupTrials: CONFIG.warmupTrials,
      })
    );
  });
}

// ---------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ranges = splitRanges(CONFIG.trials, CONFIG.workers);
  const loadAtStart = loadavg().map((value) => Math.round(value * 100) / 100);

  // Warm-up: module loading and V8 tiering happen once, before anything is timed. Same call
  // shape as the serial section, so the warm-up and the measurement exercise one code path.
  const warmupStarted = performance.now();
  simulate(PLAN, { mode: MODE, seed: BASE_SEED, asOf: AS_OF, monteCarlo: { trials: CONFIG.warmupTrials, retention: 'summary' } });
  const warmupMs = performance.now() - warmupStarted;

  const serialRuns: number[] = [];
  let serialSummary: MonteCarloSummary | undefined;

  for (let run = 0; run < CONFIG.repeats; run += 1) {
    const started = performance.now();
    const outcome = simulate(PLAN, {
      mode: MODE,
      seed: BASE_SEED,
      asOf: AS_OF,
      monteCarlo: { trials: CONFIG.trials, retention: 'summary' },
    });
    serialRuns.push(performance.now() - started);
    serialSummary = outcome.result.summary;
  }

  const chunkedRuns: number[] = [];

  for (let run = 0; run < CONFIG.repeats; run += 1) {
    const started = performance.now();
    for (const range of ranges) {
      runMonteCarloRange(PLAN, { mode: MODE, baseSeed: BASE_SEED, asOf: AS_OF, config: { retention: 'summary' }, ...range });
    }
    chunkedRuns.push(performance.now() - started);
  }

  const parallelWalls: number[] = [];
  let children: ChildResult[] = [];

  for (let run = 0; run < CONFIG.repeats; run += 1) {
    const started = performance.now();
    children = await Promise.all(ranges.map((range) => runChildProcess(range.startIndex, range.count)));
    parallelWalls.push(performance.now() - started);
  }

  // Equivalence: the chunked/parallel path must have done the same work as the serial run, or the
  // throughput comparison would be meaningless.
  const merged = mergeMonteCarloSummaries(children.map((child) => child.summary));
  const equivalence = {
    trialsMatch: merged.trials === serialSummary?.trials,
    mergedLargerTrials: merged.trials,
    summaryIdenticalToSerial: JSON.stringify(merged) === JSON.stringify(serialSummary),
    successRate: merged.successRate,
    serialSuccessRate: serialSummary?.successRate,
    maxPerYearCentsDifference: Math.max(
      0,
      ...merged.perYear.map((year, index) => Math.abs(year.totalCents - (serialSummary?.perYear[index]?.totalCents ?? 0)))
    ),
  };

  // Merge overhead, measured in isolation over the same chunk summaries.
  const mergeRuns: number[] = [];
  for (let iteration = 0; iteration < CONFIG.mergeIterations; iteration += 1) {
    const started = performance.now();
    mergeMonteCarloSummaries(children.map((child) => child.summary));
    mergeRuns.push(performance.now() - started);
  }

  // Retained heap: summary vs full retention, measured after the run (peak) and after dropping
  // the result and collecting (retained).
  /** Holds the measured result until its heap delta has been read, so V8 cannot free it early. */
  const heapSink: { value: MonteCarloSummary | undefined } = { value: undefined };

  /**
   * Heap is measured `CONFIG.heapRepeats` times and the **largest** retained delta is kept: a
   * collection can free garbage the earlier run left behind, so a single sample can read as
   * zero. Retention is a lower bound per sample, so the maximum is the honest estimate.
   */
  const measureHeap = (retention: 'summary' | 'full') => {
    const peaks: number[] = [];
    const retained: number[] = [];
    let trials = 0;

    for (let repeat = 0; repeat < CONFIG.heapRepeats; repeat += 1) {
      collectGarbage();
      const before = heapUsedBytes();
      heapSink.value = simulate(PLAN, {
        mode: MODE,
        seed: BASE_SEED,
        asOf: AS_OF,
        monteCarlo: { trials: CONFIG.heapTrials, retention },
      }).result.summary;
      peaks.push(heapUsedBytes() - before);
      trials = heapSink.value.trials;
      heapSink.value = undefined;
      collectGarbage();
      retained.push(Math.max(0, heapUsedBytes() - before));
    }

    return { trials, peakBytes: Math.max(...peaks), retainedBytes: Math.max(...retained) };
  };

  const summaryHeap = measureHeap('summary');
  const fullHeap = measureHeap('full');
  const summaryPeak = summaryHeap.peakBytes;
  const summaryRetained = summaryHeap.retainedBytes;
  const fullPeak = fullHeap.peakBytes;
  const fullRetained = fullHeap.retainedBytes;

  const loadAtEnd = loadavg().map((value) => Math.round(value * 100) / 100);

  const serial = summarise('serial: one simulate() call', serialRuns, CONFIG.trials);
  const chunked = summarise('chunked serial: the same trials in chunks', chunkedRuns, CONFIG.trials);
  const parallel = summarise('parallel: chunks in separate processes, start-up included', parallelWalls, CONFIG.trials);

  const report = {
    $comment:
      'Artifact of one machine at one moment. Not for commit. The browser worker pool speedup is NOT measured — see limitations and docs/BENCHMARK.md.',
    generatedAt: new Date().toISOString(),
    poolSpeedupMeasured: false,
    /**
     * The box's 1/5/15-minute load average before and after. A benchmark run on a busy machine
     * measures the machine's contention, not the code: keep these next to the numbers.
     */
    loadAverage: { atStart: loadAtStart, atEnd: loadAtEnd },
    machine: {
      platform: platform(),
      arch: arch(),
      cores: cpus().length,
      totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      nodeVersion: process.version,
      workers: CONFIG.workers,
    },
    workload: {
      mode: MODE,
      asOf: AS_OF,
      baseSeed: BASE_SEED,
      trials: CONFIG.trials,
      chunks: ranges,
      retention: 'summary',
      repeats: CONFIG.repeats,
      warmupTrials: CONFIG.warmupTrials,
      heapTrials: CONFIG.heapTrials,
    },
    measurements: {
      serial,
      chunkedSerial: chunked,
      parallelProcesses: parallel,
      /** Parallel speedup of the *measurable* path; not the app's pool. */
      /** Min-of-N: the least-contended sample, which is what a re-run on an idle box should see. */
      speedupFromMinMs: serial.minMs / parallel.minMs,
      speedupFromMedianMs: serial.medianMs / parallel.medianMs,
      chunkedOverheadPct: (chunked.medianMs / serial.medianMs - 1) * 100,
      childComputeMsPerRun: children.map((child) => Math.round(child.computeMs)),
      childWallMsPerRun: children.map((child) => Math.round(child.wallMs)),
      childWarmupMsPerRun: children.map((child) => Math.round(child.warmupMs)),
      spawnOverheadMsApprox: Math.round(
        children.reduce((total, child) => total + child.wallMs - child.computeMs - child.warmupMs, 0) / children.length
      ),
      /** Warm-up cost paid once per timed section; the first-run penalty is much larger. */
      parentWarmupMs: warmupMs,
      merge: { iterations: CONFIG.mergeIterations, medianMs: summarise('merge', mergeRuns, CONFIG.trials).medianMs, runsMs: mergeRuns },
      retainedHeap: {
        trials: CONFIG.heapTrials,
        repeats: CONFIG.heapRepeats,
        summary: summaryHeap,
        full: fullHeap,
        /** The meaningful ratio: what each retention mode still holds once the run is collected. */
        retainedFullToSummaryRatio: summaryRetained === 0 ? null : fullRetained / summaryRetained,
        /** Peak includes unreclaimed garbage from the run itself, so it is not retention. */
        peakFullToSummaryRatio: summaryPeak === 0 ? null : fullPeak / summaryPeak,
        note: 'peak = heapUsed delta right after the run (includes garbage); retained = after dropping the result and two collections (needs --expose-gc). Read retained as memory held by the results.',
      },
    },
    equivalence,
    limitations: [
      'The browser worker pool (src/lib/workers) cannot run under Node: Comlink.expose needs a worker realm, and the pool uses new Worker(new URL(...)) plus navigator.hardwareConcurrency.',
      "A worker_threads thread does not receive tsx's resolver, so it cannot import this TypeScript module graph; parallel chunks therefore run in separate OS processes.",
      "The parallel figure includes process start-up (~one node + tsx boot per worker); it is a lower bound on the engine's scaling, not the browser pool's speedup.",
      'Numbers are wall-clock on one machine with other work running; use the spread of the repeats, not a single run, and re-measure on the machine you care about.',
    ],
    outputPath: 'bench-results/bench-latest.json (gitignored)',
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `bench: ${CONFIG.trials} trials × ${CONFIG.repeats}, ${CONFIG.workers} workers, ${platform()}/${arch()}, node ${process.version}`
  );
  console.log(
    `  serial           ${serial.medianMs.toFixed(0)} ms  (${serial.trialsPerSecond.toFixed(0)} trials/s, spread ${serial.spreadPct.toFixed(1)}%)`
  );
  console.log(
    `  chunked serial   ${chunked.medianMs.toFixed(0)} ms  (${chunked.trialsPerSecond.toFixed(0)} trials/s, spread ${chunked.spreadPct.toFixed(1)}%)`
  );
  console.log(
    `  parallel procs   ${parallel.medianMs.toFixed(0)} ms  (${parallel.trialsPerSecond.toFixed(0)} trials/s, spread ${parallel.spreadPct.toFixed(1)}%)`
  );
  console.log(
    `  measured speedup ${(serial.minMs / parallel.minMs).toFixed(2)}× from min / ${(serial.medianMs / parallel.medianMs).toFixed(2)}× from median (processes, not the browser pool)`
  );
  console.log(`  load average     ${loadAtStart.join(' / ')} -> ${loadAtEnd.join(' / ')} (1 / 5 / 15 min)`);
  console.log(
    `  merge            ${report.measurements.merge.medianMs.toFixed(2)} ms over ${CONFIG.workers} summaries; retained heap summary ${Math.round(summaryRetained / 1024)} KB vs full ${(fullRetained / 1024 ** 2).toFixed(1)} MB`
  );
  console.log(`  wrote ${report.outputPath}`);
}

// No top-level `await`: tsx compiles this file as CJS (the package has no `"type": "module"`).
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
