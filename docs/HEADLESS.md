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
| `--trials <n>`         | Monte Carlo trials, positive integer, full retention (every trial's result is printed)                                              | `500` (Monte Carlo modes only; rejected otherwise; warns above 1000)          |
| `-h`, `--help`         | Usage, defaults and exit codes                                                                                                      | —                                                                             |

Both `--flag value` and `--flag=value` are accepted.

There is deliberately **no wall-clock default**: `simulate()` takes `asOf` as a required
argument, and this command adds none. Every run prints where its values came from, so nothing is
defaulted invisibly:

```
headless:simulate: plan.json
  mode=fixedReturns (from plan) seed=7 (--seed) asOf=2026-01-01 (--as-of)
```

### Monte Carlo output and cost

`--trials` runs with **full retention**: `stdout` carries every trial's complete result, because
that is this command's output contract (the UI is where a summary comes from). Retention is opt-in
on `simulate()`, so the command asks for it explicitly.

The cost grows with the trial count: one pretty-printed trial measured **~0.75 MB** on a plan with
income, expenses and a savings account, so 100 trials is about 75 MB of JSON and the 500-trial
default about 375 MB — all of it held in memory before it is printed. The command therefore warns
above **100** trials and still runs, since a large run can be deliberate; `simulate()` itself
refuses more than 5000.

If the retained results cannot be written as one JSON document (V8 caps a string at roughly 512 MB,
which a few hundred trials can reach on a realistic plan) the command exits 1 with
`the result is too large to print` and asks for fewer trials, instead of crashing.

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

Unknown fields are reported as a **warning** and ignored, at any depth: the command walks the
file against `simulatorSchema`'s shapes and names every key the schema does not define, e.g.
`incomes.income-1.disabeld`. That matters because a typo can change the answer — `disabeld`
leaves an income running that `disabled: true` stops — so the warning is there to catch it.

It stays a warning rather than a refusal because `simulatorSchema` strips unknown keys rather
than rejecting them: the app itself would run such a file, and the imported-file path (which uses
strict Convex-derived schemas) is the one that refuses. For a union the walk blames the variant
that fits best, so a `fixedAge` frame is not reported for lacking `safeWithdrawalRate`. It does
not walk inside a schema it does not recognise (leaf kinds hold no keys), and it stops after 32
levels of nesting.

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

This is **not** the export envelope (`{ "schemaVersion": 10, "kind": …, "exportedAt": …,
"plan": …, "finances": … }`). The envelope's `plan` is the stored document shape (entities as
arrays), while the engine reads the id-keyed form shape; pointing this command at an envelope is
rejected with a message that says so. Restoring an envelope is a Settings job
(see `SELF_HOSTING.md`).

## The published JSON Schema

`schema/ignidash-plan.v10.schema.json` is committed and generated, never hand-edited:

```bash
npm run schema:plan
```

It is produced by Zod 4's `z.toJSONSchema(simulatorSchema, { io: 'input' })` — the same
`simulatorSchema` the app uses, so its _shape_ comes from the same source the engine reads. Its
_rules_ are a strict subset of the app's; the next section lists what is missing. `io: 'input'`
describes what a _file_ may contain; output mode would add `additionalProperties: false` to every
object and reject files the app accepts. The result is
JSON Schema **draft 2020-12**, fully inlined (no `$ref`/`$defs`), with no remote `$id`, so a
validator never fetches anything: the whole contract is in the one file.

The version in the filename follows the export envelope's `EXPORT_SCHEMA_VERSION` (currently
**10**; it is never typed by hand — `planJsonSchemaFileName()` defaults to the constant). There is one published "plan format version" in this repo, and contract 3.3 of the
parity plan requires the PR that changes the plan shape to bump it _and_ regenerate this schema
in the same release — so a single number keeps them from drifting apart. `plan-json-schema.test.ts`
fails if the committed file differs from what the generator produces, or if an older
`ignidash-plan.v*.schema.json` is left behind.

### What it validates — and the three classes of rule it does not

`z.toJSONSchema()` emits **shape and per-field bounds only**: types, required keys, enum values
and numeric limits. It **silently drops every `.refine()` / `.superRefine()`**, so this document
is _looser_ than the app, not equal to it: it accepts files the app refuses. Three classes of rule
do not reach the file.

| Class of rule                 | One example                                                                                                            | Document | Import                                  | `headless:simulate`      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------- | ------------------------ |
| cross-field refinements       | `marketAssumptions.stockYield` above `stockReturn`; wage income with no `withholding`; `customDate` with no month/year | accepts  | rejects                                 | rejects                  |
| clock-relative timeline rules | `timeline.birthYear` giving an age outside 18–100 as of the run date                                                   | accepts  | accepts (a file must import on any day) | rejects, using `--as-of` |
| unknown-key strictness        | an unknown nested key, e.g. `incomes.income-1.disabeld`                                                                | accepts  | rejects                                 | warns, then runs         |

A fourth class, **enum-policy gates** (an enum member the document publishes and the app's refine
refuses), was retired in P3-P4: its only member was `taxes.incomeType: "selfEmployment"`, which
the app now accepts because the engine charges the self-employment tax. Should another such gate
ever exist, it belongs in `UNVALIDATED_RULE_CLASSES` and back in this table — the class is gone
because it is empty, not because the phenomenon is impossible.

Exactly which clock rules are meant:

1. `timeline.birthYear` — current age must be between 18 and 100;
2. `timeline.lifeExpectancy` — life expectancy must be greater than the current age;
3. `timeline.retirementStrategy.retirementAge` — retirement age must be between the current age
   and life expectancy.

They live in `createTimelineFormSchema(now)` because a static schema cannot consult a clock, and
JSON Schema could only express them by hard-coding a reference date — a document that would
silently go stale and then lie about what is valid.

The document says all of this in its own `$comment`, so a consumer that only has the JSON file
still reads the caveat. `plan-json-schema.test.ts` asserts that each class above is named both in
the file and in this document, so the two cannot drift apart.

### Two shape differences that run the other way

These are the only places the document is _stricter_ than import, and both are deliberate:

- `debts` and `physicalAssets` are `required` in the document but optional to import (Convex marks
  them optional and the transformer fills `{}`). The document keeps them required because
  `simulate()` throws on `undefined` — a file without them cannot run.
- `timeline: null` passes the document (inherited from `simulatorSchema`) but `simulate()` refuses
  it: `simulate(): inputs.timeline is required; a plan without a timeline has no projection.` Do
  not treat `null` as runnable.

### One rule narrowed in shape form: `asOfDate`

JSON Schema cannot express a refine, but it can express a pattern, so
`simulationSettings.asOfDate` carries `pattern: ^\d{4}-\d{2}-\d{2}$`, which rejects
`"not-a-date"`. The caveat travels with it, in `SHAPE_PATTERNS` and in the file: **shape only: it
accepts a rollover date such as 2026-02-30, which the app refuses**. The real check is the app's
`isISODateString`. This is the only narrowing the generator adds, and `plan-json-schema.test.ts`
pins it, so no undocumented rule can appear in the published file.

Nothing in the app is weakened to match the document.

## Output

`stdout` is `simulate()`'s return value, unchanged — no analyzers, no extractors, no summary:

- Single-run modes: `{ "mode": "fixedReturns", "result": <SimulationResult> }`, whose `data` is
  one entry per simulated month.
- Monte Carlo modes: `{ "mode": "monteCarloStochasticReturns", "result": { "simulations": [[seed,
<SimulationResult>], …] } }` — one entry per trial, because the command always requests full
  retention.

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
