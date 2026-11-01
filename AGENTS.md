# AGENTS.md — onboarding

Read this first, then `CLAUDE.md` for the structural map (routing, file layout, every
directory explained). This document is the _why_ and the _don't_-s: context that costs a new
engineer days to acquire and can't be inferred from the code.

`CLAUDE.md` tells you where things are. This tells you what will break.

---

## 1. First hour

```bash
npm install
npm run dev:convex      # local Convex backend — must run alongside the app
npm run dev             # Next.js on :3000
```

Then, before touching anything:

```bash
npm run typecheck                       # expect clean
npm run lint                            # expect clean
npm run test:once                       # expect ~146 files, ~2875 tests, all passing
npm run tax:validate                    # validate registered tax rulesets
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json | cut -c1-16
                                        # compare with src/lib/calc/__tests__/golden/README.md
```

That last command is the most valuable habit in this repository. The expected hash is recorded
in `golden/README.md` rather than here, because a legitimate corpus move changes it; if yours
differs from the recorded value and you did not mean to move a fixture, something changed a
number. See §4.

**Node 24 (active LTS) is required.** `.nvmrc` is set to `24`, `.npmrc` enforces `engine-strict=true`,
and `package.json` specifies `"node": "^22.22.2 || ^24.15.0 || >=26.0.0"`. `jsdom` 30 rejects older Node.
The Docker build (`Dockerfile`) pins `node:24-bookworm-slim` by SHA256 digest.

**This is a fork.** `origin` is `calmcoconut/ignidash` (public), `upstream` is
`schelskedevco/ignidash`. It is deliberately self-hosted: one container, LAN-only, plain
HTTP over an IP. PostHog, Stripe and Resend were **deleted**, not feature-flagged — no
dependency and no call site remain. Two vendor integrations are kept, both inert until
configured: Google OAuth, only when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set
(`convex/auth.ts`) **and** `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true` was baked into the client
bundle at build time (`docker-compose.yml`); and the AI client — the `openai` SDK pointed at
an OpenAI-compatible `OPENAI_BASE_URL` or at Azure OpenAI via `OPENAI_ENDPOINT`, hidden until
`OPENAI_API_KEY` plus one of those two is set (`convex/utils/ai_utils.ts`). Everything else
should reach nothing. If you find yourself adding a vendor SDK, stop and ask whether this
fork wants it.

---

## 2. The mental model

Five layers, and almost every bug lives at a boundary between two of them.

```text
Convex documents (database layer)
   │  src/hooks/use-convex-data.ts      (queries)
   ▼
Zod-validated inputs (app layer)        src/lib/schemas/inputs/
   │  src/lib/utils/data-transformers.ts (bi-directional mapping)
   ▼
Simulation engine (month-by-month)      src/lib/calc/
   │  via Web Worker pool (Comlink)     src/lib/workers/
   ▼
Raw results (SimulationDataPoint[])
   │  src/lib/calc/data-extractors/
   ▼
Chart / table / metric data             → components & Zustand store
```

**The engine is the only place numbers are produced.** Everything downstream extracts or
formats. If a displayed figure is wrong, the bug is almost always in `src/lib/calc/` — or in
the extractor that picked the wrong field. Resist fixing it in a component.

**The engine runs in a Web Worker** via Comlink (`src/lib/workers/`). Anything crossing that
boundary must be plain data — no class instances, no functions, no `Date` objects. This is
why `asOf` is a string.

**There are multiple return providers** (fixed, stochastic, historical backtest) behind one
interface (`src/lib/calc/returns-providers/`). A change to the engine loop affects all three; check each.

### Real dollars and statutory threshold deflation

The engine models all finances in **today's dollars** (real purchasing power). Investment returns
are Fisher-deflated, and nominal inputs are deflated to the plan's starting anchor date.
For taxes (`src/lib/calc/tax-data/real-dollars.ts`):

- Tables with `indexing: 'indexed'` (e.g. federal tax brackets, standard deduction) rise with
  inflation in the real world, so they remain constant in today's dollars.
- Tables with `indexing: 'fixed'` (e.g. NIIT $200k/$250k thresholds, §86 Social Security base amounts
  $25k/$32k, Additional Medicare $200k/$250k, §121 $250k/$500k exclusion, and the SALT cap schedule)
  erode with inflation. They are deflated by dividing their `dollarFields` by
  `cumulativeInflationIndex(simYear - rulesetYear)`.
- **Dimensionless numbers** (tax rates, phase-down rates, percentages) are never deflated.

### Retirement rules and special tax mechanisms

Complex tax rules are isolated in pure sub-modules:

- `src/lib/calc/retirement-rules/ira-basis.ts`: Form 8606 pro-rata recovery of nondeductible traditional IRA basis.
- `src/lib/calc/retirement-rules/roth-five-year.ts`: Per-conversion 5-year clock tracking and 10% penalty on early withdrawal of converted principal.
- `src/lib/calc/retirement-rules/sepp.ts` & `sepp-tables.ts`: Substantially Equal Periodic Payments (IRC §72(t)(2)(A)(iv), Notice 2022-6 RMD, amortization, annuitization, and §72(t)(4) recapture penalty).
- `src/lib/calc/retirement-rules/qcd.ts`: Qualified Charitable Distributions from IRAs for age 70½+, offsetting RMDs.
- `src/lib/calc/hsa-wiring.test.ts` & `taxes.ts`: HSA qualified medical withdrawals (tax-free) and California non-conformity (add-back, annual earnings tax, basis exclusion, FTB 3805P penalty exemption).
- `src/lib/calc/aca-premium-tax-credit.ts`: IRC §36B Affordable Care Act premium tax credit and 400% FPL cliff for opted-in plans.

### AI chat tools layer (`convex/chat_tools.ts`)

The AI assistant executes deterministic financial calculations by importing `src/lib/calc/*` directly
into Convex Node actions (proven by the Convex bundler). It provides:

- `runSensitivityAnalysis`: One-at-a-time (OAT) parameter sweeps over returns, inflation, retirement age, spending (`src/lib/calc/sensitivity.ts`).
- `compareHousing`: Deterministic dual-path comparison of renting vs owning (`src/lib/calc/housing-comparison.ts`).
- `getPlanSummary`, `simulateVariant` and `compareToBaseline`: the baseline, a validated `planPatch` run
  as a variant (never written to the plan), and its delta against the baseline. A Roth ladder is a
  `conversions` patch evaluated this way.
- `getTaxAnalytics`: marginal rates, bracket headroom and the IRMAA/ACA cliffs for one year (`src/lib/calc/tax-analytics.ts`).

### The two things that make results trustworthy

1. **`simulate(inputs, {mode, seed, asOf, …})` is pure.** Same input + same `asOf` + same
   seed ⇒ byte-identical output. Reach for it directly in tests instead of driving the UI.
2. **No wall clock inside `src/lib/calc` or `src/lib/schemas`.** `Clock` / `fixedClock` /
   `systemClock` are injected; ESLint bans argument-less `new Date()` / `Date.now()` and bans
   importing the system clock into those directories. This is enforced, not advisory. If you
   need "now", take it as a parameter.

---

## 3. How to make a typical change

### Add a plan field

This is the most common change and it has the most steps. A plan field that only exists in
the UI is invisible to export, import and backup.

1. **Zod schema** — `src/lib/schemas/inputs/` (a sub-schema, composed into `SimulatorInputs`).
2. **Make it optional** unless it is genuinely required. Absent must mean today's behaviour.
3. **Convex validator** — `convex/validators/`, mirroring the Zod shape.
4. **Transformers** — `src/lib/utils/data-transformers.ts`, both directions.
5. **Catalogue it** — `planDataFields` (a guard test compares the catalogue against the
   schema; adding a field without it fails).
6. **Convex persistence** — the module that stores it (see `convex/*.ts`).
7. **Bump `EXPORT_SCHEMA_VERSION`** and regenerate the JSON schema:
   ```bash
   npm run schema:plan      # writes schema/ignidash-plan.vN.schema.json, removes vN-1
   ```
   Write a history entry in `src/lib/export/plan-envelope.ts` stating **what absent means**.
8. **Prove the upgrade is non-vacuous.** Add a test with the previous fixture and a field
   count before/after the strip. If you delete your upgrade code and the test still passes,
   the test is worthless.
9. **Tests**: round-trip through the transformers, round-trip through Convex, absent →
   byte-identical run, and the hand-worked number if it affects the simulation.

### Change a tax number

`src/lib/calc/tax-data/` is organised as **rulesets keyed by year**, with citations. Every
figure carries its source (`P.L.`, `Rev. Rul.`, `FTB 540`, `T.D.`, IRC section). If you
cannot cite it, **do not invent it** — the codebase's convention is to `throw` with an
instruction rather than borrow a neighbouring year's number. `getRules(year)` resolves the
nearest prior year, so a later year silently inherits an earlier ruleset: check
`resolvedYear` when that matters.

If a change moves a golden-corpus fixture, add a per-fixture explanation to
`src/lib/calc/__tests__/golden/README.md`. That is not optional.

### Add a chart

Use the metric registry (`P4-P1`/`P4-P2`) rather than wiring a chart ad hoc: a series
resolves through `resolveSeries`, and the frozen key/colour fingerprints will fail loudly if
you collide. Add the table view at the same time — `resolveChartCardBody` gates it, and
charts without one are an accessibility regression.

---

## 4. The invariant that will bite you: the version constant

**`EXPORT_SCHEMA_VERSION` in `src/lib/export/plan-envelope.ts` is a single-writer resource.**
It is currently **19**. Its history and what absence means:

| v   | Change                                                 | What absent means                                          |
| --- | ------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | export/import envelope                                 | unversioned initial schema                                 |
| 2   | time binding                                           | customDate starts at plan start; nominal deflated          |
| 3   | couples                                                | single-person household                                    |
| 4   | historical backtest mode                               | stochastic Monte Carlo mode                                |
| 5   | Social Security                                        | no Social Security claiming logic                          |
| 6   | household member ages                                  | primary age only                                           |
| 7   | itemized deductions                                    | standard deduction taken                                   |
| 8   | California residency                                   | federal-only simulation                                    |
| 9   | MFS                                                    | single or MFJ                                              |
| 10  | withdrawal strategies                                  | ordered withdrawal strategy                                |
| 11  | real estate (term, property tax, offset)               | simple physical asset                                      |
| 12  | milestones                                             | no event triggers or dynamic shifts                        |
| 13  | IRA after-tax basis (Form 8606 pro-rata)               | no nondeductible basis (traditional distributions taxable) |
| 14  | Roth conversions schedule (conversions)                | no conversions executed                                    |
| 15  | HSA qualified medical withdrawals & CA non-conformity  | ordinary income tax on HSA withdrawals (no medical flag)   |
| 16  | Qualified Charitable Distributions (QCDs from IRAs)    | no QCD satisfaction from IRA                               |
| 17  | Substantially Equal Periodic Payments (SEPP)           | standard 10% penalty applies (no SEPP schedules)           |
| 18  | ACA Premium Tax Credit opt-in & 2026 statutory table   | ACA modeling disabled (`optIn: false`)                     |
| 19  | Net-worth journal history in portable plan JSON export | no recorded manual journal snapshots in export             |

Two people adding fields in parallel will produce a version number that claims to describe a
shape it does not. **One field-adding change at a time.** If you need parallelism, batch by
domain so one person adds all of a domain's fields and takes one bump.

Trap: the non-vacuous "strip" in an upgrade test is sometimes a **value substitution**, not a
key deletion. Counting keys is not always enough — assert the _meaning_ after the upgrade.

---

## 5. Tests: proof, not decoration

**A test that cannot fail is worse than no test**, because it buys false confidence. Real
examples found in this codebase:

- A Social Security growth test used COLA = inflation, so real growth was `1^N` and the test
  passed whether the engine used a simulation year or a calendar year.
- An assertion that `JSON.stringify(obj)` never contains a duplicated key — structurally
  impossible.
- A DOM test asserting a `<select>` shows its first option, which it does even if the
  component's fallback logic is deleted.

**The rule: break the code and watch the pin go red.** Then restore it. Several changes in
this repo were landed only after doing exactly that, and it is now the expected standard.

### Mechanics

- **Vitest.** `npm run test:once` for one pass. Node environment by default.
- **DOM tests** are opt-in per file, first line:
  ```ts
  // @vitest-environment jsdom
  ```
  Do **not** flip the global environment — of the ~146 test files, 16 opt into an
  `edge-runtime` docblock, 15 into `jsdom` and one names `node`; the rest (~114) run on the node
  default. Counts move with every commit, so treat the totals as a snapshot from a full
  `npx vitest run` rather than a fixed number. There is no global setup file, so call
  `afterEach(cleanup)` yourself.
- **Convex tests** use the real `convex-test` harness. Mock the module boundary, not the
  behaviour.
- **Golden corpus** (`src/lib/calc/__tests__/golden/`) is the numerical regression net:
  4 plans, 6 runs, `Infinity` codec, determinism pinned at ×2 identical sha256. Both sides of the
  comparison are rounded to 12 significant digits, so the corpus is reproducible across JavaScript
  engines while staying exact within one engine: a difference larger than that tolerance is a real
  numerical change, not a V8 difference, and it owes the `golden/README.md` entry.

---

## 6. Accessibility: observe, don't infer

Four dialogs shipped with a wrong screen-reader name and **no test noticed**, because the
JSX looked correct. Cause: Headless UI's `<Field>` keeps a label registry, and `Input` /
`Select` write the **entire registry** into `aria-labelledby`, overriding their own `htmlFor`.
Two `<Label>`s inside one `<Field>` name both controls.

**Rule: one `<Field>` per control.** And when an accessible-name bug is reported, dump the
computed `aria-labelledby` from a rendered component — do not reason about the props. A probe
answers this in seconds; reading JSX gets it wrong, including for experienced reviewers.

---

## 7. Conventions that are enforced

- **TypeScript strict**, and the repo is 100% TS. No `any` without a comment.
- **Prettier**: single quotes, semicolons, trailing commas (ES5), 140 cols. `npm run format`.
- **ESLint 9 flat config**; unused vars must be `_underscore`-prefixed.
- **Husky + lint-staged** runs `eslint --fix` and `prettier --write` on commit. A commit that
  reformats unrelated lines means you skipped `npm run format`.
- **Currency** goes through `formatCurrency` / `formatCompactCurrency` /
  `getCurrencySymbol` in `src/lib/utils/number-formatters.ts`, and percentages through
  `formatPercentage` there. `formatNumber` (`convex/utils/sys_prompt_utils.ts`) is the compact
  formatter for AI prompt text, not a UI currency helper.
- **Components are `'use client'`** unless deliberately a server component.

---

## 8. Traps, in the order you will hit them

1. **`convex/_generated/api.d.ts` is hand-maintained** (`npx convex codegen` needs a live
   deployment). A new Convex module needs its two lines added by hand, in the labelled block.
   Keys are **module paths**: `api.net_worth_journal.list`, not `api.netWorthJournal.list`.
   The camelCase form compiles today and breaks the moment codegen runs.
2. **The engine's loan maths is Fisher-deflated.** A nominal amortisation formula will clear a
   30-year mortgage in 358 months. Use `amortization-schedule.ts`; do not re-derive.
3. **Empty groups are never met.** `[].every()` is `true`, so a naive milestone or condition
   implementation fires everything in month one and the latch never resets.
4. **Absent ≠ zero.** For optional plan fields, absent means "the old behaviour", which is
   usually different from a stated zero (`propertyTax: {}` charges nothing; it is not 0%).
5. **The Comlink boundary strips richness.** Functions, class instances and `Date` do not
   survive it.
6. **`gh repo view` resolves to upstream in this directory.** Always pass the repo explicitly
   to `gh api`.
7. **Two surfaces can disagree about the same number.** Success was once defined three
   different ways, and chance-of-retirement contradicted success on the same page. If you add
   a derived metric, find the existing definition first.
8. **Do not deflate rates or percentages.** In `tax-data/real-dollars.ts`, fixed tables require an explicit
   `dollarFields` list. Dimensionless quantities (tax brackets %, FICA rates, phase-down rates) must NEVER
   be deflated. Deflating a percentage rate corrupts the tax calculation over the horizon.
9. **Sub-cent rounding in fill-to-bracket conversions.** `calculateFillToBracketAmount` must be clamped
   to the available traditional IRA account balance. Rounding up past the account balance (e.g. `$100,000.008`
   -> `$100,000.01`) will throw `Insufficient funds for conversion` inside the simulation run.
10. **Household member ages are per-person.** Never read the primary member's age for a partner's penalty
    gates (age 59½, age 65) or Social Security FRA. Member ages are resolved per-person from member facts.
11. **California HSA non-conformity.** California does not conform to IRC §223. Contributions are added back
    to CA income, annual earnings are taxed, return of basis is subtracted, and HSAs are exempt from the
    2.5% FTB 3805P early withdrawal penalty.

---

## 9. Before you open a PR

```bash
npm run typecheck && npm run lint && npm run tax:validate && npm run test:once
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json   # must match golden/README.md's hash, unless explained
```

If the corpus moved, you owe `golden/README.md` an entry. If a test you added cannot fail,
it isn't finished. If a doc comment or commit message describes behaviour you did not verify,
it is a future bug — that failure mode is the single most common defect in this repository's
history: **sound code, false description.**
