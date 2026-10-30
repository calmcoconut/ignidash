#!/usr/bin/env tsx
/**
 * One benchmark worker (parity plan P2-P6).
 *
 * Spawned by `scripts/bench.ts` as a separate OS process, so the benchmark can measure the
 * chunked Monte Carlo work running on several cores at once on the same machine. It reads its
 * assignment as JSON from stdin, runs exactly the trial range it was given through the same
 * `runMonteCarloRange` the browser pool's worker calls, and prints one JSON line:
 *
 *   { "computeMs": number, "summary": MonteCarloSummary }
 *
 * Why a process and not a `worker_threads` thread: see `docs/BENCHMARK.md`. In short, a worker
 * thread does not get `tsx`'s resolver, so it cannot import this TypeScript module graph, and the
 * browser pool's `Comlink` endpoint does not exist in Node at all. A process gets both.
 */

import type { SimulatorInputs } from '../src/lib/schemas/inputs/simulator-schema';
import type { ISODateString } from '../src/lib/calc/clock';
import { runMonteCarloRange, type MonteCarloRetention } from '../src/lib/calc/monte-carlo';

interface Assignment {
  inputs: SimulatorInputs;
  asOf: ISODateString;
  mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns';
  baseSeed: number;
  startIndex: number;
  count: number;
  retention: MonteCarloRetention;
  /** Trials run before the timed chunk, so V8 has tiered up. Reported, not hidden. */
  warmupTrials: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const assignment = JSON.parse(await readStdin()) as Assignment;

  // Each process pays its own first-run cost (module load, V8 tiering). Warming here keeps the
  // timed chunk comparable to the parent's warm serial run; the cost is reported as `warmupMs`
  // and is included in the wall clock the parent measures.
  const warmupStarted = performance.now();
  runMonteCarloRange(assignment.inputs, {
    mode: assignment.mode,
    baseSeed: assignment.baseSeed,
    asOf: assignment.asOf,
    config: { retention: 'summary' },
    startIndex: 0,
    count: assignment.warmupTrials,
  });
  const warmupMs = performance.now() - warmupStarted;

  const started = performance.now();
  const { summary } = runMonteCarloRange(assignment.inputs, {
    mode: assignment.mode,
    baseSeed: assignment.baseSeed,
    asOf: assignment.asOf,
    config: { retention: assignment.retention },
    startIndex: assignment.startIndex,
    count: assignment.count,
  });

  process.stdout.write(JSON.stringify({ computeMs: performance.now() - started, warmupMs, summary }));
}

// No top-level `await`: tsx compiles this file as CJS (the package has no `"type": "module"`).
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
