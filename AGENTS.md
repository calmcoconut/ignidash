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
npm run test:once                       # expect ~128 files, ~2627 tests, all passing
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json | cut -c1-16
                                        # expect a946a8dc86555c66
```

That last command is the most valuable habit in this repository. If a number changed, it
will tell you in one second. See §4.

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
Convex documents
   │  src/hooks/use-convex-data.ts      (queries)
   ▼
Zod-validated inputs                   src/lib/schemas/inputs/
   │  src/lib/utils/data-transformers.ts
   ▼
Simulation engine                      src/lib/calc/
   │  FinancialSimulationEngine, month by month
   ▼
Raw results (SimulationDataPoint[])
   │  src/lib/calc/data-extractors/
   ▼
Chart / table / metric data            → components
```

**The engine is the only place numbers are produced.** Everything downstream extracts or
formats. If a displayed figure is wrong, the bug is almost always in `src/lib/calc/` — or in
the extractor that picked the wrong field. Resist fixing it in a component.

**The engine runs in a Web Worker** via Comlink (`src/lib/workers/`). Anything crossing that
boundary must be plain data — no class instances, no functions, no `Date` objects. This is
why `asOf` is a string.

**There are multiple return providers** (fixed, stochastic, historical backtest) behind one
interface. A change to the engine loop affects all three; check each.

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
It is currently **14**. Its history:

| v   | Change                                   |
| --- | ---------------------------------------- |
| 1   | export/import envelope                   |
| 2   | time binding                             |
| 3   | couples                                  |
| 4   | historical backtest mode                 |
| 5   | Social Security                          |
| 6   | household member ages                    |
| 7   | itemized deductions                      |
| 8   | California residency                     |
| 9   | MFS                                      |
| 10  | withdrawal strategies                    |
| 11  | real estate (term, property tax, offset) |
| 12  | milestones                               |
| 13  | IRA after-tax basis (Form 8606 pro-rata) |
| 14  | Roth conversions schedule (conversions)  |

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
  Do **not** flip the global environment — 104 of the 128 test files run on the node default;
  14 opt into an `edge-runtime` docblock and 10 into `jsdom`. There is no global setup file, so call
  `afterEach(cleanup)` yourself.
- **Convex tests** use the real `convex-test` harness. Mock the module boundary, not the
  behaviour.
- **Golden corpus** (`src/lib/calc/__tests__/golden/`) is the numerical regression net:
  4 plans, 6 runs, `Infinity` codec, determinism pinned at ×2 identical sha256.

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

---

## 9. Before you open a PR

```bash
npm run typecheck && npm run lint && npm run test:once
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json   # a946a8dc… unless explained
```

If the corpus moved, you owe `golden/README.md` an entry. If a test you added cannot fail,
it isn't finished. If a doc comment or commit message describes behaviour you did not verify,
it is a future bug — that failure mode is the single most common defect in this repository's
history: **sound code, false description.**
