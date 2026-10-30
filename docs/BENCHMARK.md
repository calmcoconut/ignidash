# Benchmark harness (`npm run bench`)

Parity plan P2-P6. Prints a short table and writes `bench-results/bench-latest.json`, which is
**gitignored**: it is an artifact of one machine at one moment, not something to commit.

```
npm run bench
```

## What it measures

| Section             | Quantity                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `serial`            | one `simulate()` call, all trials in this process — trials per second                        |
| `chunkedSerial`     | the same trials split into `cores − 1` chunks and run back to back (the shape the pool uses) |
| `parallelProcesses` | the same chunks in separate OS processes, wall clock including each process's start-up       |
| `merge`             | `mergeMonteCarloSummaries` over the chunk summaries, in isolation                            |
| `retainedHeap`      | heap held by `retention: 'summary'` versus `retention: 'full'` results                       |

Every timed section runs `repeats` times (5 by default) after a warm-up, and the report carries
each sample with `minMs`, `medianMs`, `maxMs`, `spreadPct` and `trialsPerSecond`. **Quote the
minimum** when comparing machines: it is the least-contended sample. The median tells you what the
machine actually delivered during the run.

## What it does NOT measure — the pool speedup

The browser worker pool (`src/lib/workers/*`) cannot run under Node:

- `simulation.worker.ts` calls `Comlink.expose`, which needs a worker realm's `addEventListener`;
- `simulation-worker-api.ts` spawns workers with `new Worker(new URL(...), { type: 'module' })` and
  reads `navigator.hardwareConcurrency` — neither exists in Node;
- a `worker_threads` thread does **not** receive `tsx`'s resolver, so it cannot import this
  TypeScript module graph (probed: the thread falls back to Node's own resolver and fails).

So the harness runs the parallel chunks as separate **processes** (`node --import tsx`), which gets
the same compute onto several cores with a real measurement — but through a different transport
(no Comlink RPC) and with process start-up included.

The JSON says this in three places: `poolSpeedupMeasured: false`, the `limitations` array, and the
`$comment`. **No member of this repository should quote `speedupFromMinMs` as "the app is N× faster
in the browser".** It is a lower bound on how the engine's chunked work scales across cores,
measured headlessly.

## Reading the JSON

- `loadAverage.atStart` / `atEnd` — the box's 1/5/15-minute load average around the run. On a busy
  machine this dominates every timing figure; check it before believing a number.
- `equivalence` — the chunked/parallel path's merged summaries against the serial summary. It is
  byte-identical (`summaryIdenticalToSerial: true`, `maxPerYearCentsDifference: 0`) because the
  summary keeps per-year totals in integer cents precisely so chunks merge exactly. If this ever
  reads `false`, the throughput comparison is meaningless and the report should be ignored.
- `retainedHeap.retainedFullToSummaryRatio` — the number that matters for memory. `peakBytes`
  includes garbage the run has not collected yet, so it is not retention.
- `measurements.*.spreadPct` — how much the repeats disagreed. Treat a number whose spread is
  larger than the difference you are trying to show as noise.

## Reproducing

Same machine, same commit, an **idle** box. The workload is fixed (plan, seeds, trial count and
chunk split are in `scripts/bench.ts`), so two runs compute identical summaries; only the timing
varies. On a machine running other work, expect the timings to move by ~10% run to run, and the
parallel section to swing much more, because it needs `cores − 1` free cores.

## Why a process for the parallel section

`scripts/bench-worker.ts` reads its assignment as JSON from stdin and runs that trial range through
the same `runMonteCarloRange` the pool's worker calls. Each child warms up before its timed chunk
and reports `computeMs` and `warmupMs` separately, so the wall clock can be decomposed into
start-up, warm-up and compute instead of hiding all three in one number.
