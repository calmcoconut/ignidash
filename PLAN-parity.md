# Parity plan: Ignidash → ProjectionLab

**Date:** 2026-10-30
**Input:** `PARITY-assessment.md` (four read-only codebase scouts).
**Method:** five independent planners, one per section, each barred from proposing work in the other four
and required to declare cross-section dependencies rather than assume them. This document merges their
outputs, resolves the conflicts between them, and imposes one execution order.

Read `PARITY-assessment.md` first for the evidence behind each gap. This document assumes it.

---

## 0. Scope reality check

Be honest about what is being proposed here. Summed across the five sections this is roughly **12–15
L/XL items plus ~25 S/M items**: a multi-quarter program for one maintainer, before the perpetual annual
tax upkeep the assessment already flagged. That is not a criticism of the plans — it is what ProjectionLab
took years and a team to build.

So pick a tranche, not the whole thing. **Waves 0–2 below are the recommended first tranche** and they are
the ones with outsized value per unit of work:

- determinism (the engine currently gives different answers on different days),
- a backup you can restore from, before the first irreversible migration,
- complete export/import, which is the only migration story a self-hoster has,
- the tax-year foundation, without which every later tax feature is built on sand,
- Sankey and compare — the two most visible gaps, both cheap once the engine is pure.

Everything from Wave 3 onward is real parity work but should be committed to one wave at a time, with the
option to stop.

## 1. Arbitration — conflicts resolved

The five planners overlapped in six places. These are the rulings.

| #   | Conflict                                                                                                                  | Ruling                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Golden baseline timing.** §2 wants a regression corpus early; §3's year dimension changes every number.                 | Freeze the corpus **once**, after §3-P1 lands and §2-P1 exists. Never baseline per branch. §1-P4 keeps `ordered` as the default strategy precisely so it does not move the numbers again.                |
| 2   | **MFS before couples?** §3 ships MFS as a "labelled single-person approximation"; §1 owns household structure.            | **MFS ships first** (§3-P1). It is a tax-table concern and does not need an owner field. Couples later adds real semantics. Until then the UI must label it an approximation.                            |
| 3   | **Who owns FICA?** §3 moves it into the tax engine; §1 defers SE tax to §3 while adding the `selfEmployment` income path. | Compatible, but ordered: **§1-P0 enables the income types, §3-P4 taxes them.** Neither may ship a half-moved FICA.                                                                                       |
| 4   | **Does Sankey need an engine change?** The assessment implied yes; §4 proves v1 needs none.                               | **§4 is right.** Recharts 3 ships `Sankey`; an annual ledger derives from `SimulationDataPoint`. Only per-month, per-account routing would need a `FlowLedger` from §2, and that is not required for v1. |
| 5   | **`schemaVersion` ownership.** §5 owns the envelope; §1 and §3 both add plan fields.                                      | Envelope and version (**§5-P1**) land **before** §1-P2's couples migration. Rule below in §4.                                                                                                            |
| 6   | **PWA / encryption listed as parity gaps.**                                                                               | Neither is a gap to close. See §5 corrections. §5 declines both with reasons that hold.                                                                                                                  |

## 2. Global sequencing

Waves are dependency-ordered. Items inside a wave are parallelisable across sections.

### Wave 0 — Safety and determinism (all S, ~1 week)

| Item                                             | Owner    | Why first                                                                                                     |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| P5.0 backup/restore + export-before-migrate gate | Platform | Required before any irreversible migration; also the only rollback story.                                     |
| P2-P0 clock injection                            | Engine   | Removes `new Date()`; unblocks purity, compare, goldens, milestone determinism.                               |
| P1-P0 bug floor                                  | Modeling | `selfEmployment`/`pension` rejected by `.refine`; payoff estimator disagrees with engine. Independent, cheap. |

**Gate:** no irreversible Convex migration may run until P5.0's export gate is in place and fails closed.

### Wave 1 — Foundations that change shape

| Item                                                      | Owner    | Note                                                                                    |
| --------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| P3-P1 tax ruleset harness + MFS (XL)                      | Tax      | **Critical path — start day one.** Gates every later tax phase and the golden baseline. |
| P1-P1 shared time binding + recurrence + real/nominal (M) | Modeling | Collapses five duplicated resolvers into one.                                           |
| P5-P1 export/import v1 + `clonePlan` fix (M)              | Platform | Establishes `schemaVersion: 1`.                                                         |
| P4-P1 metric registry pilot (M)                           | Viz      | Cash-flow pilot + one canary metric; old switches coexist.                              |

**Gate:** no golden corpus yet.

### Wave 2 — Purity and the first visible wins

| Item                                                           | Owner    | Depends                                       |
| -------------------------------------------------------------- | -------- | --------------------------------------------- |
| P2-P1 pure `simulate()` + golden corpus (M)                    | Engine   | P3-P1, P2-P0                                  |
| P2-P2 reconcile the three success definitions (S)              | Engine   | P2-P1                                         |
| P2-P3 configurable, memory-bounded Monte Carlo + histogram (L) | Engine   | P2-P1                                         |
| P1-P2 couples schema foundation (L)                            | Modeling | P5.0, P5.1 — **first irreversible migration** |
| P5-P2 JSON Schema + headless entry (S)                         | Platform | P2-P1                                         |
| P4-P2 chart-as-table toggle (S)                                | Viz      | P4-P1                                         |
| P4-P4 Sankey (M)                                               | Viz      | — (no engine change)                          |

### Wave 3 — Tax depth, household behaviour, the visible product gaps

P3-P4 FICA · P3-P3 itemized + SALT cap · P1-P3 household behaviour · P2-P5 compare mode ·
P4-P3 event annotations · P4-P5 print/PDF · P5-P3 auth hardening.

### Wave 4 — Decumulation and retirement rules

P3-P5 retirement-account rules (XL: pro-rata, conversions, SEPP, ladders, 5-year, QCDs, HSA) ·
P1-P4 withdrawal strategies · P1-P5 real estate I (amortization + rental) · P3-P6 tax analytics ·
P2-P6 benchmark harness.

### Wave 5 — Long tail

P3-P7a AMT/IRMAA · P3-P8 one state · P3-P7b ACA/estate · P1-P6 real estate II · P1-P7 milestones ·
P1-P8 Social Security · P4-P6 migrate remaining charts · P4-P7 progress tracking · P4-P8 onboarding ·
P2-P7 sensitivity · P5-P4 ops · P5-P5 encryption decision.

### Deliberately last or never

- **Optimizer** (§2-P8): deferred entirely, not scoped. Zero value until the engine is pure and measured.
- **PWA / service worker**: blocked by plain-HTTP LAN. Needs TLS, which is a deployment decision, not a feature.
- **App-level field encryption / passphrase plans**: declined (§5-P5.5). Key co-location plus breakage of
  validators, undo and AI prompts for a threat model host disk encryption already covers.
- **Multi-tenant / advisor / household roster**: out of scope forever for a single-operator private instance.

## 3. Cross-section contracts (work no single plan owned)

Five seams surfaced only when the plans were read against each other. These need an owner before the wave
that consumes them.

| #   | Contract                                                                                                                                        | Needed by    | Assigned to                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| 1   | **Cumulative inflation index exported from the engine.** §1's `amountBasis: real\|nominal` needs a per-year index; §2's plan never included it. | P1-P1        | **§2-P1** (expose it from the pure entry point)                                           |
| 2   | **`netWorthJournal` Convex table + query/mutation.** §4's progress tracking declares it as a §5 dependency; §5's plan does not contain it.      | P4-P7        | **§5, new P5.1b**                                                                         |
| 3   | **`schemaVersion` bump when plan fields are added.** §5 defines the envelope; §1 and §3 add fields.                                             | P1-P2, P3-P1 | **§1-P2 bumps to 2**; §5-P2 regenerates the JSON Schema in the same release               |
| 4   | **Compare route navigation.** §2 builds the page; nobody owned the sidebar/nav entry.                                                           | P2-P5        | **§2** (its own route)                                                                    |
| 5   | **Golden corpus stewardship.** After freeze, who may change numbers?                                                                            | P2-P1 onward | **§2 owns the corpus**; any §1/§3 change that moves it must arrive with an explained diff |

## 4. Standing rules for every phase

1. **Green bar:** `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` all clean before merge. 1244 tests
   today; new math ships with new tests, and **no failing test is ever deleted to make a phase pass**.
2. **Irreversible steps** (couples migration, auth component change) require P5.0's export first, and the
   migration must be additive, idempotent and append-only in `convex/migrations.ts`.
3. **One phase per change set.** P2-P0 and P5.0 land alone so their effects are attributable.
4. **Additive-only schema changes**, with readers defaulting (`owner ?? 'primary'`, `taxYear ?? 2026`) so old
   exports keep importing.
5. **No runtime network.** Any tax or historical data is vendored and committed; generation is a
   developer-side script whose output is reviewed as a data diff.
6. **Math changes carry hand-worked fixtures** (Form 8606 examples, IRS SEPP examples, §86 tier edges), not
   just snapshot updates.

## 5. Corrections to `PARITY-assessment.md`

Three rows of the assessment were wrong or incomplete and are corrected here. The assessment file itself is
left as written, since it records what the scouts found.

1. **"No service worker" is not a gap.** Service workers require a secure context; this deployment is plain
   HTTP over a LAN IP, so a worker registers only on `localhost`. The feature cannot serve the operator
   without TLS. Verdict should read **N/A — blocked by the HTTP deployment decision**.
2. **Encryption at rest is a deliberate non-adoption, not an oversight.** The recommendation is host disk
   encryption (LUKS/FileVault) plus passphrase-encrypted backups. App-level field encryption would place the
   key in the same `.env.local` as the database while breaking Convex validators, snapshot/undo and
   server-side AI prompts. Keep the ABSENT verdict, add "won't fix, by decision".
3. **Sankey does not require an engine change for v1.** It needs a ledger derived from the existing annual
   `SimulationDataPoint`. Only per-month, per-account routing would need a `FlowLedger` export.

Also worth restating from the assessment, because it is the single largest correctness hazard in the whole
program: `returns.yieldAmounts` are a **tax-reporting overlay only** and never move balance — dividends and
interest are already inside `applyReturns`. Any Sankey or cash-flow aggregation that treats yields as cash
double-counts them.

---

## Plan 1 — Core modeling

**Target state**

- One household of one or two members; every plan entity carries `owner` (`primary|partner|joint`); the
  engine aggregates but reports per member.
- All dated events resolve through one time-binding resolver supporting `everyNYears` and
  `amountBasis: real|nominal`; user milestones are AND/OR expressions over simulation metrics and may drive
  event dates, validated acyclic.
- Decumulation is injected (ordered, VPW, X%-rule, Guyton-Klinger); real estate supports amortizing terms,
  rental income and offset accounts; Social Security estimates PIA→benefit with FRA/early/delayed/COLA.

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                                                      | Files                                                | Effort                                                                                                                                                                                                                                                      | Verify                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0   | **Bug floor.** Remove the `.refine` rejecting `selfEmployment`/`pension` (`income-form-schema.ts:45-53`); add pension (no FICA) and SE (ordinary income; SE tax deferred to §3) paths in `incomes.ts`. Make `payoff-estimator-utils.ts` take a real rate `(1+apr/12)/(1+infl)-1` and mirror `physical-assets.ts` unpaid-interest allocation; pass inflation into `debt-dialog.tsx`, `physical-asset-dialog.tsx`, `net-worth-section.tsx`. | income + dialogs + utils                             | S                                                                                                                                                                                                                                                           | enum tests; payoff months equal engine payoff in a loan fixture; suite green                                                  |
| 1   | **Shared time binding, recurrence, real/nominal.** New `src/lib/calc/time-binding.ts` replacing duplicated resolvers in `incomes.ts`, `expenses.ts`, `debts.ts`, `physical-assets.ts` and the glide-path duplicate. Add `everyNYears` + `recurrenceYears`, `amountBasis`; nominal amounts scale by a cumulative inflation index (contract 3.1).                                                                                           | 5 validators, `data-transformers.ts`, entity dialogs | M                                                                                                                                                                                                                                                           | table tests per TimePoint; N-year boundaries (0/N/2N); defaults preserve 1244 tests                                           |
| 2   | **Couples schema foundation.** Optional `owner` on account/income/expense/debt/physical-asset schemas, validators, Convex fields defaulting to `primary`; `household` in `timeline-form-schema.ts` + `planDataFields`. Append idempotent `backfillOwnerAndHousehold` migration; update transformers, `clonePlan`, `plan_export_utils`, templates, six dialogs, test utils. Bumps `schemaVersion` to 2.                                    | schema + convex + UI                                 | L                                                                                                                                                                                                                                                           | old JSON imports as `primary`; clone/export round-trip keeps household; per-owner totals; migration on a restored volume copy |
| 3   | **Household behaviour.** Per-owner RMD age, horizon = max life expectancy, retirement phase = last earner, couple filing status into `taxSettings`.                                                                                                                                                                                                                                                                                       | `simulation-engine.ts`, `phase.ts`, `portfolio.ts`   | L                                                                                                                                                                                                                                                           | two-person staggered-retirement fixture                                                                                       |
| 4   | **Withdrawal strategies.** `src/lib/calc/withdrawal-strategies/` exposing `{ getOrder(ctx), getAnnualCap?(ctx) }`: ordered (current), VPW, X%-rule, Guyton-Klinger. Injected via `PortfolioProcessor`; `withdrawalStrategy` in settings; `essential` flag on expenses; expose `unfundedSpending`.                                                                                                                                         | new module + settings + dialog                       | M                                                                                                                                                                                                                                                           | per-strategy goldens; cap never exceeds portfolio; **default `ordered` output byte-identical**                                |
| 5   | **Real estate I.** `paymentMethod.termMonths` with computed payment; new `amortization-schedule.ts`; `rentalIncome` flowing to cash flow and taxable income (§3).                                                                                                                                                                                                                                                                         | schema, validator, `physical-assets.ts`, dialog      | M                                                                                                                                                                                                                                                           | schedule reconciles to engine payoff within $1; rental cash flow                                                              |
| 6   | **Real estate II.** `offsetAccountId` on loans reducing the interest base, validated one-to-one against savings/taxable accounts. Rent-vs-own as `housing-comparison.ts`: two deterministic runs with/without the residence plus rent expense, reporting break-even.                                                                                                                                                                      | schema + new module                                  | L                                                                                                                                                                                                                                                           | offset interest math; comparison invariance to input order                                                                    |
| 7   | **Milestones.** `milestones` in `SimulatorInputs`; expression tree `{op:'and'                                                                                                                                                                                                                                                                                                                                                             | 'or', children                                       | {metric,operator,value}}`over age/year/portfolio/account/income/expense/net worth;`timePointSchema`gains`milestone`; `dependency-graph.ts`rejects cycles via plan-level`superRefine`; latch evaluated at month start; extractor emits dates for §4 markers. | schema + evaluator + UI                                                                                                       | L                                                                       | truth tables; cycle rejection; fires once; no wall-clock reads |
| 8   | **Social Security.** Vendored `social-security-bend-points.ts`, `fra-table.ts`; `social-security.ts` computes PIA from AIME, applies FRA reduction/credit and COLA-as-real-growth; income schema gains `socialSecurity: {mode:'manual'                                                                                                                                                                                                    | 'estimated', aime?, pia?, claimAge, colaRate?}`.     | data + module + schema                                                                                                                                                                                                                                      | M                                                                                                                             | 62/67/70 and bend-point hand calcs; COLA parity when equal to inflation |

**Risks.** The couples migration is the only irreversible step: export first, migrate additively, read with
`owner ?? 'primary'`, and ship every writer (`simulatorToConvex`, `clonePlan`, `plan_export_utils`,
templates) in the same release — old writers rebuild plan docs and will silently drop new fields.
Strategies can move headline results; keep `ordered` default and lock goldens. Milestone `atRetirement` is
ambiguous for couples: define it as last-earner retirement and document.

---

## Plan 2 — Simulation engine

**Target state**
Every run is a pure function of `(inputs, mode, seed, clock)` — same bytes on any day, host or timezone.
Monte Carlo is configurable, memory-bounded and aggregates incrementally; one exported success predicate
governs every readout. Historical modes disclose wrapping; compare, benchmarks and sensitivity reuse the
same pure core. The optimizer is deferred.

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                   | Effort | Verify                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| P0  | **Clock injection.** `Clock` interface resolved at the store boundary; explicit `asOf` ISO date into the engine; `calculatePreciseAge(…, now)`; replace `new Date()` at `simulation-engine.ts:291,418` and `timeline-form-schema.ts:71-92`; UTC getters so labels are timezone-stable. Schema: optional `simulationSettings.asOfDate`.                                                 | S      | zero `new Date()` under `src/lib/calc`; freeze-clock test asserts identical ages across two clocks         |
| P1  | **Pure entry point.** `simulate(inputs, {mode, seed, asOf, trials?})` with no store/worker/module state. Golden corpus: fixed-clock full result for fixed returns, stochastic seed 1, historical no-wrap, plus extractor snapshots. Also **exposes the cumulative inflation index** (contract 3.1).                                                                                    | M      | two invocations deep-equal; stable across simulated date change                                            |
| P2  | **Reconcile success.** One exported `evaluateSuccess(sim)` = reached retirement ∧ final > $0.10 ∧ no shortfall; route `key-metrics-extractor.ts:73-107`, `multi-simulation-analyzer.ts:139-141`, `table-data-extractor.ts:672` through it.                                                                                                                                             | S      | adversarial fixtures where the three old definitions disagreed now agree; headline % equals per-row column |
| P3  | **Configurable, bounded Monte Carlo.** `monteCarlo: { trials: 100–5000, retention: 'summary'\|'full' }`; seed mapping independent of chunking. Streaming summary aggregator (final value, success, retirement/bankruptcy age, per-year totals) with full results only for retained seeds. Histogram bins; percentiles p5–p95 fixing the biased `floor` rank at `stats-utils.ts:73-85`. | L      | same seeds → identical success rate as legacy; bins sum to trials; peak heap ≤ bound                       |
| P4  | **Historical modes.** `historicalBacktest: { mode: 'looping' \| 'truncate' }`; provider returns `wrapped` + ranges; truncate halts at 2024 and records `truncatedAtYear`.                                                                                                                                                                                                              | M      | no-wrap horizon byte-identical to P1 baseline; wrap/truncate fixtures                                      |
| P5  | **Compare mode.** Both plans through `simulate` and the MC summary path with identical seeds; delta extractor for key metrics, yearly portfolio, tax totals. Replace placeholder route; plan picker + side-by-side + delta table/overlay. Includes nav entry (contract 3.4).                                                                                                           | L      | identical plan → all deltas zero; sign tests; identical across clock override                              |
| P6  | **Benchmark harness.** `npm run bench` measuring serial vs pool throughput, trials/sec, merge overhead, retained heap; JSON report.                                                                                                                                                                                                                                                    | S      | reproducible ±5%; speedup documented, not inferred                                                         |
| P7  | **Sensitivity.** One-at-a-time sweeps (returns ±, inflation, retirement age, spending) over deterministic runs; tornado data.                                                                                                                                                                                                                                                          | M      | sweep determinism; monotonicity cases; runtime budget                                                      |
| P8  | **Optimizer: deferred entirely.** No search, no Roth solver. Prerequisites are P1, P6 and §1's injectable withdrawal order.                                                                                                                                                                                                                                                            | —      | —                                                                                                          |

**Dependencies.** §1 for stable input shapes and injectable withdrawal order (P8 only). §3-P1 before the
golden freeze. §4 for rendering histogram/tornado/compare/wrap disclosure. §5 for route wiring, plan-JSON
mirroring of new settings, and the bench runner.

**Risks.** Clock injection changes date labels and snapshots — mechanical, reversible, lands alone.
Percentile rank fix shifts displayed p10/p90; regenerate goldens once and flag it. Summary-only MC removes
per-trial drill-down except retained seeds; `retention: 'full'` is the escape hatch. Truncated backtests
visibly shorten horizons; default stays `looping`.

**Not doing.** Multi-dimensional/global sensitivity; block bootstrap; monthly output retention; timestep
change; nominal/real leaks and HSA/RMD bugs (handed to §1/§3); state tax; couples; GPU workers; persisted
result caching; any optimizer implementation.

---

## Plan 3 — Tax engine

**Target state**

1. Every calculation takes an explicit `taxYear`; rules live in checked-in versioned rulesets
   (`tax-data/years/<year>.ts`) resolved by nearest-prior-year fallback. Each table carries
   `indexing: 'indexed' | 'fixed'` plus a source citation, so indexed and statutory tables can never be
   confused again.
2. `FilingStatus` includes `marriedFilingSeparately` end-to-end, with §86's 85%-from-dollar-one encoded as a
   ruleset flag, not an `if` in `taxes.ts`.
3. One `TaxProcessor` emits one reconciled liability object (federal, FICA, state, credits, penalties,
   IRMAA) and one marginal-rate API consumed by analytics and charts; `incomes.ts` stops owning FICA math.

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                                | Effort | Unblocks                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| 1   | **Ruleset harness + MFS.** `tax-data/types.ts` (`TaxRuleset`, `TableMeta`), `tax-data/index.ts` (`getRules(year)`), `years/2026.ts` consolidating the six existing tables. Pass `simulationState.time.date.getFullYear()` into `TaxProcessor`. Add MFS to Zod, Convex validator, transformers, sys-prompt, drawer; add MFS tables and the §86 flag. Keep legacy named exports as thin 2026 aliases. | **XL** | Every later phase; accurate indexing; MFS planning |
| 2   | **Annual-update pipeline.** `scripts/vendor-tax-rules.ts` reads a pinned PolicyEngine parameter commit (hash in header) and emits `years/<year>.ts`; `tax-data/SOURCE.md` records provenance; CI regenerates and fails on drift; `docs/tax-year-update.md`; a "January drill" test. Developer-side only; generated TS committed and reviewed as a data diff.                                        | M      | Cheap annual maintenance; legislative toggles      |
| 3   | **Itemized deductions + SALT cap.** Itemized inputs (mortgage interest, charitable, state/local, medical); per-year SALT cap with indexed flag, senior deduction, standard-vs-itemized selection.                                                                                                                                                                                                   | L      | State SALT input; AMT addback                      |
| 4   | **FICA/SE tax in the engine.** Move FICA out of `incomes.ts:216-219`; indexed SS wage base, Additional Medicare 0.9%, SE tax (92.35% base, half deduction); add `TaxesData.fica` and `totalTaxLiability`; fix double counting in `simulation-data-extractor.ts:315-328`.                                                                                                                            | M      | Honest total liability; SE income                  |
| 5   | **Retirement-account rules.** Pro-rata §408(d)(2) basis (Form 8606); conversion events/schedule; SEPP/72(t); Roth ladder; 5-year clocks; QCDs; qualified-HSA fix (`taxes.ts:282-286`). New `retirement-rules.ts`.                                                                                                                                                                                   | **XL** | Optimizer; conversion analytics; correct HSA       |
| 6   | **Tax analytics.** Marginal rate by income type, next-dollar decomposition, bracket-fill, conversion headroom, IRMAA/ACA cliffs.                                                                                                                                                                                                                                                                    | M      | §4 views; conversion UI                            |
| 7a  | **AMT + IRMAA.** Exemption/phase-out, 26/28%, itemized addback, simplified credit; IRMAA two-year MAGI lookback as a liability line.                                                                                                                                                                                                                                                                | L      | High-income realism                                |
| 7b  | **ACA PTC + estate.** Federal PTC only (FPL %, applicable percentage, SLCSP input), opt-in; simplified estate exemption/portability and terminal step-up report.                                                                                                                                                                                                                                    | M      | Pre-65 planning; estate reporting                  |
| 8   | **One state.** Flat-tax state first, same `TaxRuleset` shape under `tax-data/states/`; state tax feeds SALT; local-tax slot in schema, no locals.                                                                                                                                                                                                                                                   | L      | Real SALT; credible total burden                   |

**Dependencies.** Phase 1 gates everything. §1 couples for genuine MFS semantics (ship MFS early as a
labelled approximation). §1-P0 for `selfEmployment` before phase 4. §2 purity and §1-P4 injectable order
before phase 5.

**Risks.** Test churn — keep 2026 aliases and migrate assertions incrementally. Year fallback can hide gaps:
fail loudly in tests, warn in UI. FICA refactor can double count because incomes already nets it — one
reconciliation invariant, cash-flow path untouched. Pro-rata conversion is the highest-risk math: feature
flag it, ship only with Form 8606 fixtures. Vendored data needs a pinned commit, committed output, and a
human cross-check against the IRS release.

**Not doing.** No runtime fetch or PolicyEngine at runtime; no per-user editable brackets. No filing/e-file,
tax advice, multi-state apportionment, city taxes (schema slot only), K-1/S-corp/partnership, trust returns,
or full credit stack (EITC/CTC/education/foreign). No full AMT credit machinery; ACA federal-only; estate is
terminal-value reporting. Deliberately never: a general tax-rule DSL, per-plan custom rulesets, pre-2020 tax
years, or in-app "what the law will be" forecasting.

---

## Plan 4 — Visualization & UX

**Target state**
One declarative `METRIC_REGISTRY` owns series keys, labels, colours, stacking, formatting, table columns and
annotation slots; adding a metric is one registry entry plus an optional extractor field. Every chart has a
table and print equivalent; net-worth and cash-flow views carry event markers and a Sankey that labels
reinvested returns honestly. Actuals overlay projections from a persisted journal; onboarding offers
personas through a registry rather than a hardcoded template union.

| #   | Work                                                                                                                                                                                                                                                                                                                                                                                          | Effort | Verify                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Registry core + cash-flow pilot.** `metric-registry.ts` and `plot-types.ts`: `MetricDefinition { id, category, chartKinds, series[], table, annotations? }`, pure `resolveSeries()`, renderer adapters for line/area/bar/pie. Keep `chart-data-views.ts` as explicit re-exports so persisted `dataViews` stay stable. Port cash flow; add one canary metric (`realNetWorth`, display-only). | M      | registry test (unique ids, every `dataView` resolves, key/colour parity against frozen arrays); 1244 green; manual chart diff |
| 2   | **Chart-as-table toggle.** View toggle in `chart-card.tsx`; render registry columns through existing `tables/table.tsx`.                                                                                                                                                                                                                                                                      | S      | every metric has a table accessor/formatter; table tests unchanged                                                            |
| 3   | **Event annotations.** `annotations-extractor.ts` deriving events from `SimulationDataPoint`: retirement phase change, RMD start, first/last active income and expense, debt payoff, asset purchase/sale. Render via `ReferenceLine`/`ReferenceDot`.                                                                                                                                          | M      | fixture tests for event ages; mobile legibility                                                                               |
| 4   | **Sankey.** Recharts 3 built-in. Ledger from annual `SimulationDataPoint`: inflows = incomes, asset-sale proceeds, return amounts; outflows = expenses, taxes/penalties, debt payments, purchases, contributions. **Returns render as a "reinvested" node, never as cash.**                                                                                                                   | M      | conservation test (inflows − outflows ≈ net-worth delta); no yield-as-cash case                                               |
| 5   | **Print/PDF.** `@media print`/`@page` in `globals.css`; print-friendly report route; hide chrome, force page breaks. Browser print-to-PDF, no server rendering.                                                                                                                                                                                                                               | S      | build/typecheck; A4/Letter preview; print CSS excludes nav/chat                                                               |
| 6   | **Migrate remaining charts.** Cash flow done, then taxes, returns, contributions, withdrawals, net worth last. Each PR replaces only the series `switch`, keeping the Recharts shell, `custom` per-account escape hatch and tax reference-line modes.                                                                                                                                         | L      | per-category key/colour/stacking parity checklist; delete old switch only after sign-off                                      |
| 7   | **Progress tracking.** Manual actuals journal (date, per-account balances, note), net-worth overlay, deviation band. Persistence is §5's (contract 3.2).                                                                                                                                                                                                                                      | M      | alignment tests for partial dates; Convex CRUD once §5 lands                                                                  |
| 8   | **Onboarding wizard + personas.** Multi-step wizard around existing forms; expand the 2 templates into `convex/templates/index.ts` and replace the literal union in `plans.ts:189-205` with a registry token; persona cards.                                                                                                                                                                  | M      | Convex clone tests per persona; wizard step validation                                                                        |

**Dependencies.** §2 for a deterministic clock (print axes, actuals alignment) and for an exact flow ledger
if per-month Sankey is ever wanted. §5 for journal persistence and a versioned export. §1 for milestones
(annotation v2), ownership (per-person nodes) and stable `planData`. §3 for tax-year overlays.

**Risks.** The registry is scoped to series/metadata only — do **not** unify chart shells; line/area/bar/pie
semantics differ. Migration is gradual with coexistence: new metrics use the registry immediately, old
switches remain until each category is verified; reversible per category until all switches are deleted, after
which revert conflicts with newly authored registry metrics. Colours, sign stacking and custom per-account
series are encoded in charts — freeze key/colour arrays in tests and require a manual diff per category.
Changing `dataViews` unions can reset persisted preferences; prefer id mapping plus a version bump. Sankey's
main hazard is yield double-counting — enforce the conservation contract test.

**Not doing.** Compare mode (belongs to §2); server-side PDF; a new chart library or CDN; a generic chart
engine replacing Recharts; plugin surface; the milestone evaluator (§1); bank sync; PWA caching; mobile
redesign; state-tax overlays before §3.

---

## Plan 5 — Platform

**Target state**

1. A plan is a versioned, human-readable JSON file that round-trips completely — all plan data _and_
   user-level finances — through real download/upload with actionable errors.
2. The operator can lock the instance down by configuration: signup off after bootstrap, TOTP MFA, and
   password recovery that works with no mail transport.
3. Operations are boring and recoverable: automated encrypted backups, per-process health, and a versioned
   public schema plus a documented headless run of the engine.

Ordering principle: safety net first, because P5.3 touches the auth component and every later phase mutates
state.

| #     | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Effort | Verify                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| P5.0  | **Backup/restore safety net.** `scripts/backup.sh` (export via admin key to timestamped zip, `age`-encrypt optional, retain N); `scripts/restore.sh`; `selfhost.sh` exports **before** `deploy`/`run_migrations` and aborts on failure; restore drill documented.                                                                                                                                                                                                                              | S      | export→wipe→import into scratch; idempotent; `shellcheck`                                                      |
| P5.1  | **Export/import v1.** Envelope `{ schemaVersion: 1, kind, exportedAt, plan, finances }`; `Blob` + `<a download>` (File System Access is secure-context-only, unusable on HTTP LAN); import via file input; full `path: message` error list replacing the 250-char truncation; finances import behind explicit confirmation with auto-downloaded pre-import snapshot; bulk export; **fix `clonePlan` dropping `glidePath`**.                                                                    | M      | round-trip test incl. `glidePath` and finances; malformed file shows field paths                               |
| P5.1b | **`netWorthJournal` table** (contract 3.2): Convex table, query/mutation, ownership checks, plan-JSON mirroring.                                                                                                                                                                                                                                                                                                                                                                               | S      | Convex CRUD tests; export/import includes entries                                                              |
| P5.2  | **JSON Schema + headless entry.** `z.toJSONSchema` over `simulatorSchema` → checked-in `schema/ignidash-plan.v1.schema.json`; `npm run headless:simulate -- plan.json`; `docs/HEADLESS.md`.                                                                                                                                                                                                                                                                                                    | S      | schema snapshot test; fixed seed → byte-identical output                                                       |
| P5.3  | **Auth hardening.** `disableSignUp = process.env.ALLOW_SIGNUP !== 'true'`, server-enforced; hide `/signup` when disabled; bootstrap documented as create-then-lock. `twoFactor()` plugin with TOTP enrolment, backup codes, session revocation. Recovery **without email**: reset URL written to container stderr, `/forgot-password` + `/reset-password`, 15-minute single-use token, operator greps logs. Set `role='admin'` on the bootstrap user and gate destructive restore/bulk-import. | M      | admin gate and import guard tests; manual TOTP enrol/challenge; reset from logs; signup rejected when disabled |
| P5.4  | **Operational gaps.** `/api/health` reporting build version, uptime and backend probe (503 when down); `restart` policy documentation; host systemd timer or compose `backup` profile; migration policy codified (append-only, idempotent, expand/contract; never remove `runAll` entries).                                                                                                                                                                                                    | M      | 503 with backend stopped, 200 healthy; timer produces restorable artifact                                      |
| P5.5  | **Encryption decision.** Rely on host disk encryption plus passphrase-encrypted backups. **Do not** build app-level field encryption or passphrase plans. Document residual risks and make backup encryption the default.                                                                                                                                                                                                                                                                      | S      | restore without key fails; with key succeeds                                                                   |
| P5.6  | **PWA: deferred, not possible.** Service workers need a secure context; plain-HTTP LAN fails it. Requires TLS, a separate deployment decision.                                                                                                                                                                                                                                                                                                                                                 | —      | —                                                                                                              |

**Dependencies.** P5.1 before any §1/§3 field additions (contract 3.3). P5.2 after §2 purity. P5.0 before
P5.3's auth schema change and before §1-P2's couples migration.

**Risks.** The only Convex schema change is P5.3's auth component (additive table/field) — every deploy runs
`migrations:runAll`, so P5.0's export is mandatory and must fail closed; rollback means restoring the
pre-upgrade export into the pinned previous image, not a schema downgrade. MFA plus signup-off can strand the
operator: mitigate with offline backup codes, the logged reset path and a documented break-glass. The reset
URL in logs is a credential — short TTL, single use, log rotation noted. Destructive finances import requires
confirmation plus an auto-downloaded pre-import export, admin-gated. The encryption decision changes no schema
and is reversible; app-level crypto would need a one-way plaintext backfill, another reason to reject it.

**Not doing.** App-level field encryption / passphrase plans; PWA offline shell (needs TLS); advisor roster,
multi-tenant, branded reports; email delivery; named plan versions/branching; local-first IndexedDB sync;
bulk import beyond the 10-plan cap.

---

## 6. Open decisions for you

These are scope calls the plans cannot make. Each changes the shape of the program, not just its length.

1. **Is couples in scope at all?** It is the single largest data-model ripple and one of only two
   irreversible migrations. Without it, MFS ships as an approximation and half of PL's household modelling
   stays out of reach. With it, every schema, validation path and dialog changes.
2. **State tax: one state, several, or none?** This is where annual upkeep compounds without limit. The plan
   proposes exactly one flat-tax state to prove the shape. More states is a maintenance decision, not a
   feature decision.
3. **Optimizer: defer permanently?** All five plans converge on "not before purity and measured speed". The
   honest answer may be never for a single-operator instance.
4. **Target: full parity, or the Wave 0–2 tranche?** My recommendation is Wave 0–2, chosen at the end of each
   wave. It fixes determinism, gives you a restorable backup and complete export, and lands Sankey plus
   compare — the gaps a user actually notices — without committing to state tax, AMT/IRMAA or an optimizer.
5. **Priority between the two visible wins.** Sankey and compare are both cheap and both high-visibility.
   Compare needs §2's purity; Sankey does not. If you want something working quickly, Sankey can ship
   earlier than its wave position.
