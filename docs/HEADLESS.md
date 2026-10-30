# Headless simulation

Run a plan through the engine from the command line, with no browser, store or worker:

```bash
npm install
npm run headless:simulate -- plan.json --as-of 2026-01-01
```

`stdout` is the raw result of `simulate()` (JSON). `stderr` carries the resolved run inputs and
any diagnostics. npm prints its own script banner to `stdout`; add `--silent` when you pipe the
result, or call the script directly:

```bash
npm run --silent headless:simulate -- plan.json --as-of 2026-01-01 > result.json
npx tsx scripts/headless-simulate.ts plan.json --as-of 2026-01-01 > result.json
```

## Command line

| Flag                   | Meaning                                                                                                                             | Default                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `--mode <mode>`        | Engine path: `fixedReturns`, `stochasticReturns`, `historicalReturns`, `monteCarloStochasticReturns`, `monteCarloHistoricalReturns` | the plan's `simulationSettings.simulationMode`                                |
| `--seed <n>`           | Run seed, a positive integer                                                                                                        | the plan's `simulationSettings.simulationSeed`                                |
| `--as-of <YYYY-MM-DD>` | The run's clock                                                                                                                     | the plan's `simulationSettings.asOfDate`; **if neither is set the run fails** |
| `--trials <n>`         | Monte Carlo trials, positive integer                                                                                                | `500` (Monte Carlo modes only; rejected otherwise)                            |
| `-h`, `--help`         | Usage, defaults and exit codes                                                                                                      | —                                                                             |

Both `--flag value` and `--flag=value` are accepted.

There is deliberately **no wall-clock default**: `simulate()` takes `asOf` as a required
argument, and this command adds none. Every run prints where its values came from, so nothing is
defaulted invisibly:

```
headless:simulate: plan.json
  mode=fixedReturns (from plan) seed=7 (--seed) asOf=2026-01-01 (--as-of)
```

### Exit codes

| Code | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | The simulation ran; `stdout` holds the result                                                             |
| `1`  | The plan is not valid (field paths are printed), JSON is malformed, or the engine refused the run         |
| `2`  | Usage error: unknown flag, missing value, unreadable file, no as-of date, `--trials` on a single-run mode |

Validation failures are reported as `path: message` lines — the same format the app's import
path uses — never as a stack trace:

```
headless:simulate: plan.json is not a valid plan
  incomes.income-1.amount: Must be a valid number
  taxSettings.filingStatus: Invalid option: expected one of "single"|"marriedFilingJointly"|"headOfHousehold"
```

Unknown **top-level** fields are reported as a warning and ignored. Unknown nested fields are
ignored silently, because `simulatorSchema` is a plain Zod object: the JSON Schema below is the
contract to check a file against.

## Input: the simulator input, not the export envelope

The file is the object the engine reads — the same shape the simulator's own form state holds,
described by `simulatorSchema` in `src/lib/schemas/inputs/simulator-schema.ts`. Entity
collections are objects keyed by entity id:

```jsonc
{
  "timeline": {
    "birthMonth": 1,
    "birthYear": 1990,
    "lifeExpectancy": 87,
    "retirementStrategy": { "type": "fixedAge", "retirementAge": 65 },
  },
  "incomes": { "income-1": { "id": "income-1", "name": "Salary", "amount": 87500, "frequency": "yearly", "...": "..." } },
  "accounts": { "savings-1": { "id": "savings-1", "type": "savings", "name": "Savings", "balance": 10000 } },
  "expenses": {},
  "debts": {},
  "physicalAssets": {},
  "contributionRules": {},
  "baseContributionRule": { "type": "save" },
  "marketAssumptions": { "stockReturn": 9, "stockYield": 2, "bondReturn": 4, "bondYield": 3.5, "cashReturn": 3, "inflationRate": 3 },
  "taxSettings": { "filingStatus": "single" },
  "privacySettings": { "isPrivate": true },
  "simulationSettings": { "simulationSeed": 12345, "simulationMode": "fixedReturns", "asOfDate": "2026-01-01" },
}
```

This is **not** the export envelope (`{ "schemaVersion": 2, "kind": …, "exportedAt": …,
"plan": …, "finances": … }`). The envelope's `plan` is the stored document shape (entities as
arrays), while the engine reads the id-keyed form shape; pointing this command at an envelope is
rejected with a message that says so. Restoring an envelope is a Settings job
(see `SELF_HOSTING.md`).

## The published JSON Schema

`schema/ignidash-plan.v2.schema.json` is committed and generated, never hand-edited:

```bash
npm run schema:plan
```

It is produced by Zod 4's `z.toJSONSchema(simulatorSchema, { io: 'input' })` — the same
`simulatorSchema` the app uses, so the document cannot describe a shape the engine does not
read. `io: 'input'` describes what a _file_ may contain; output mode would add
`additionalProperties: false` to every object and reject files the app accepts. The result is
JSON Schema **draft 2020-12**, fully inlined (no `$ref`/`$defs`), with no remote `$id`, so a
validator never fetches anything: the whole contract is in the one file.

The version in the filename follows the export envelope's `EXPORT_SCHEMA_VERSION` (currently
**2**). There is one published "plan format version" in this repo, and contract 3.3 of the
parity plan requires the PR that changes the plan shape to bump it _and_ regenerate this schema
in the same release — so a single number keeps them from drifting apart. `plan-json-schema.test.ts`
fails if the committed file differs from what the generator produces, or if an older
`ignidash-plan.v*.schema.json` is left behind.

### Shape-only, and the three rules it cannot carry

`simulatorSchema` uses `timelineBaseSchema`, which holds the timeline's field shapes and
per-field bounds (`birthMonth` 1–12, `birthYear` 1925–2025, `lifeExpectancy` 50–110,
`retirementAge` 19–73, …) but none of the three rules that compare the plan against _today_:

1. `timeline.birthYear` — current age must be between 18 and 100;
2. `timeline.lifeExpectancy` — life expectancy must be greater than the current age;
3. `timeline.retirementStrategy.retirementAge` — retirement age must be between the current age
   and life expectancy.

They live in `createTimelineFormSchema(now)` because a static schema cannot consult a clock, and
JSON Schema could only express them by hard-coding a reference date — a document that would
silently go stale and then lie about what is valid. The schema therefore publishes exactly what
the app's own file import validates (`src/lib/export/plan-envelope.ts` checks the same
`timelineBaseSchema`), and the document says so in its own `$comment`.

Where each caller stands:

| Caller                                            | Enforces the three rules?                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Simulator forms                                   | Yes, with `now` from the UI boundary                                                                |
| Export/import (`src/lib/export/plan-envelope.ts`) | No, on purpose: a file must stay importable on any day                                              |
| `npm run headless:simulate`                       | **Yes**, with its explicit `--as-of` — a run is pinned to a date, so the same date decides validity |

This command runs `createTimelineFormSchema(asOf)` after the structural check, so a plan the app
would reject for its age is rejected here too — with the same field paths:

```
headless:simulate: plan.json is not a valid plan as of 2030-01-01
  timeline.birthYear: You must be between 18 and 100 years old
```

## Output

`stdout` is `simulate()`'s return value, unchanged — no analyzers, no extractors, no summary:

- Single-run modes: `{ "mode": "fixedReturns", "result": <SimulationResult> }`, whose `data` is
  one entry per simulated month.
- Monte Carlo modes: `{ "mode": "monteCarloStochasticReturns", "result": { "simulations": [[seed,
<SimulationResult>], …] } }`.

A deterministic run of a small plan is a few hundred kilobytes of JSON. Use
`jq`/`node -e`/your own script to pull out what you need; the extractors in
`src/lib/calc/data-extractors/` are what the UI uses and are not wired in here.

## Determinism

Two runs with the same plan, mode, seed and as-of date print byte-identical `stdout` (asserted in
`simulate-cli.test.ts`). The engine never reads the wall clock, the host timezone, or any module
state; `--as-of` is the only clock. Monte Carlo seed-to-trial mapping is the one the store's
worker pool uses today, so a headless Monte Carlo run agrees seed-for-seed with the app.

Interpreting results is still your job: the engine reports what the inputs imply, not whether
the plan is good.

## Not in scope here

- Re-running the analyzers, extractors or reports (the UI does that).
- Reading export envelopes or restoring data (Settings → Backup & restore).
- Any network access: no fetches, no CDN, no remote schema.
