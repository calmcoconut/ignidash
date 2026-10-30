# Golden corpus (P2-P1b)

`corpus.json` is the frozen reference for the simulation engine. `golden-corpus.test.ts`
re-runs `simulate()` for every fixture and fails on **any** difference — exact values, no
tolerances.

## The rule

This corpus is frozen **once** (ruling 1: freeze after P2-P0, P3-P1, P2-P1a and P2-P2, all of
which are in). Every later change is judged against it.

- A failing corpus test means a number a user sees has moved. That is the point.
- **Do not regenerate the corpus to make CI green.** A corpus diff must arrive with an
  explanation of why the number moved — in the commit message, or in the PR that ships it.
- Regenerate only when the movement is intended and explained:

  ```bash
  npm run test:golden:update     # rewrites corpus.json from simulate()
  npm test -- src/lib/calc/__tests__/golden/golden-corpus.test.ts
  ```

- The generator is deterministic: `simulate()` takes an explicit `asOf` (`GOLDEN_AS_OF`) and
  reads no clock, store or worker, so two runs on the same code write byte-identical files.
  If they do not, that is a determinism bug in the engine — report it, do not regenerate.

## What is frozen

Six runs of four plans (`fixtures.ts`), each chosen for what it can catch:

| fixture              | run(s)                                                                    | what a diff means                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `steady-saver`       | fixed, stochastic seed 1, historical seed 1 (pinned start years, no wrap) | the ordinary path — accumulation, retirement at 65, contributions, a taxable account                                                                               |
| `marginal-retiree`   | fixed                                                                     | the failing branch — shortfall, bankruptcy at 67, RMDs; `success` is false here, so the corpus is not all-green                                                    |
| `time-binding-mixed` | fixed                                                                     | the P1-P1 inputs — a mid-plan `customDate` start, an `everyNYears` cadence and a `nominal` amount                                                                  |
| `shortfall-repaid`   | fixed                                                                     | the success predicate — reaches retirement, takes a shortfall a later pension repays, ends above $0.10; `false` here, `true` under either predicate P2-P2 replaced |

Per run the corpus stores the whole `simulate()` result (`SimulationResult`), plus the
extractor views built from it: `success` / key metrics, the annual net-worth and tax table
rows, and the percentiles of that run's per-year portfolio values. `crossPlan` adds the
multi-simulation readouts over the cross-run fixture's three modes (same plan and horizon, so
the analyzer compares like with like) and the percentiles of the three original plans' final
values — that list is named (`CROSS_PLAN_FIXTURE_IDS`) so a new fixture cannot move an existing
frozen number.

## What is deliberately not frozen

- **Monte Carlo runs.** The corpus holds single runs only; `P2-P3`'s Monte Carlo path (seeds,
  retention, summary, histogram) lands after this freeze and is covered by unit tests instead.
- **Tax-year resolution.** This is the sharp edge to know about: only one ruleset
  (`tax-data/years/2026.ts`) is checked in and `getRules` falls back to the nearest prior year,
  so **every** simulated year resolves to the same object. A regression that picked the wrong
  year would leave every frozen tax row identical — the corpus cannot see it. That property is
  guarded by `src/lib/calc/tax-data/tax-year.test.ts`, not here. Do not assume corpus coverage
  for the year dimension; if a second ruleset lands, say so in the PR that adds it, because the
  corpus still will not exercise the switch until a fixture spans two rulesets.
- **Chart-specific extractor output** (`src/lib/charts/`, the Vis owner's).
- Anything requiring a store, a worker or the system clock: the corpus is single-run
  `simulate()` output only.

### The multi-simulation quirk, stated precisely

`crossPlan` _does_ call `MultiSimulationAnalyzer.analyze` and
`TableDataExtractor.extractMultiSimulationData` over three same-length runs; both iterate the
run list directly and are safe at that size.

What the corpus never calls is `ChartDataExtractor.extractMultiSimulationPhasesData` (and
`TableDataExtractor.extractMultiSimulationYearlyAggregateData`), which index the run list by
**yearly row index** and throw when a fixture has fewer runs than years. Avoiding that quirk is
the reason the corpus contains no Monte Carlo fixture — not "no multi-simulation extractor at
all".
