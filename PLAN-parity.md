# Parity plan: Ignidash → ProjectionLab

**Date:** 2026-10-30 (revision 3)
**Operating context (decided in revision 3):** one person, a California resident, self-hosting on Unraid
(the single container from `PLAN-single-container-offline.md`) and reaching it over the LAN. Every scope
call below follows from that context.
**Input:** `PARITY-assessment.md` (four read-only codebase scouts).
**Method:** five independent planners, one per section, each barred from proposing work in the other four
and required to declare cross-section dependencies rather than assume them. This document merges their
outputs, resolves the conflicts between them, and imposes one execution order.

Read `PARITY-assessment.md` first for the evidence behind each gap. This document assumes it.

### Revision 2 — what changed and why

Revision 2 checks the plan against the source. Most cited `path:line` references hold. The changes below
fix contradictions inside the plan, a dependency that ran backwards, one factual error and one broken
table.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R1  | **§0 said the first tranche includes compare. It does not.** P2-P5 is in Wave 3 and is size L, so it is not "cheap". §0 and §6.5 are corrected. Splitting P2-P1 (R3) lets compare start right after the tranche.                                                                                                                                                            | §2 Wave 3; Plan 2 P5 = L                                                                                                      |
| R2  | **The couples migration moves out of the first tranche.** The old Wave 2 ran the program's first irreversible migration while §6.1 still asks whether couples is in scope. An undecided feature should not ship an irreversible step. P1-P2 now waits on decision 1.                                                                                                       | §2 Wave 2 vs §6.1                                                                                                             |
| R3  | **P2-P1 is split** into P2-P1a (pure `simulate()`, depends only on P2-P0) and P2-P1b (freezing the golden corpus, depends on P3-P1). Before the split, purity, compare and the headless entry all waited on the XL tax harness for no technical reason.                                                                                                                       | Ruling 1 needs only the _freeze_ to wait                                                                                      |
| R4  | **Fixes that change numbers land before the freeze.** Reconciling the success definitions and fixing percentiles both change displayed numbers. The old P2-P3 said "regenerate goldens once", which breaks ruling 1 ("freeze once"). The percentile fix moves into P2-P2, and P2-P2 becomes a prerequisite of the freeze.                                                      | `stats-utils.ts:73-76`; Plan 2 Risks                                                                                          |
| R5  | **Contract 3.1 ran backwards.** P1-P1 (Wave 1) consumed an inflation index that P2-P1 (Wave 2) was meant to supply. P1-P1 now owns a pure `cumulativeInflationIndex()` helper, and P2-P1a re-exports it.                                                                                                                                                                     | §3 contract 1                                                                                                                 |
| R6  | **Wave 1 now has an order.** P5-P1 (`schemaVersion: 1`) has to land before P1-P1 and P3-P1 add plan fields, as Plan 5 itself requires. Before this, the three were listed as parallel.                                                                                                                                                                                        | Plan 5 Dependencies                                                                                                           |
| R7  | **`clonePlan` drops `glidePath` today.** This is live data loss in a one-line fix, so it moves from P5.1 into Wave 0.                                                                                                                                                                                                                                                         | `convex/plans.ts:205-232` destructures every field except `glidePath`; the schema has it at `plans.ts:170`                    |
| R8  | **`selfEmployment` stays gated until SE tax exists.** Under P1-P0, SE income would have been taxed as ordinary income with no SE tax from Wave 0 to Wave 3. That under-taxes it by about 15.3% compared with wages, which is exactly the "half-moved FICA" ruling 3 forbids. P1-P0 now enables `pension` only, and P3-P4 removes the SE gate.                                  | `income-form-schema.ts:46-54`; `incomes.ts:217`                                                                               |
| R9  | **The PWA correction was overstated.** `SELF_HOSTING.md:136-142` already documents an HTTPS reverse-proxy deployment, so a PWA is feasible on that path. It is not blocked by HTTP. It is deferred and conditional, not "not possible".                                                                                                                                      | `SELF_HOSTING.md:136-142`                                                                                                     |
| R10 | **The FICA "double counting" is a future hazard, not a current bug.** `simulation-data-extractor.ts:315-328` sums `incomes.totalFicaTax` once. It double counts only after P3-P4 also adds `TaxesData.fica`. The item is reworded as an invariant.                                                                                                                             | `simulation-data-extractor.ts:317-323`                                                                                        |
| R11 | **The success-definition fixtures are made concrete.** The three predicates differ in specific ways (listed in P2-P2), so the adversarial fixtures can target each difference.                                                                                                                                                                                                | `key-metrics-extractor.ts:69`, `table-data-extractor.ts:672`, `multi-simulation-analyzer.ts:140`                              |
| R12 | **Clock injection is tighter.** Exactly four argument-less `new Date()` calls exist in non-test `src/lib/calc` and `src/lib/schemas`. The old check, "zero `new Date()`", cannot pass, because `new Date(y, m, 1)` is legitimate. The check is now enforced by an ESLint rule. P3-P1 uses `getUTCFullYear()`.                                                                 | `simulation-engine.ts:291,418`; `timeline-form-schema.ts:72,84`                                                               |
| R13 | **Fixing the HSA needs an input.** A qualified HSA withdrawal cannot be told apart from a non-qualified one without a notion of medical spending. P3-P5 now adds an expense flag.                                                                                                                                                                                              | `taxes.ts:282-286` treats all HSA withdrawals as ordinary income                                                              |
| R14 | **The Sankey conservation identity is now explicit.** "Inflows − outflows ≈ net-worth delta" fails whenever physical assets appreciate or debt accrues interest, because neither is a flow in the listed nodes.                                                                                                                                                               | Plan 4 P4                                                                                                                     |
| R15 | **Other contradictions are reconciled.** (a) Plan 1 calls couples "the only irreversible step", while §6.1 says one of two. There are two: the couples backfill and the auth component change. (b) Plan 5 calls P5.3 "the only Convex schema change", but P5.1b, §1-P2 and §3-P1 also change validators. (c) Rule 5 ("no runtime network") conflicts with AI chat, so its scope is narrowed. | —                                                                                                                             |
| R16 | **Housekeeping.** The broken Plan 1 table is fixed (unescaped `\|` in rows 7–8 split the columns). The green bar now uses the repo's own scripts. The truncation year is no longer hard-coded. The size count is corrected to ~29 S/M items. Wave 4 now has an order.                                                                                                          | —                                                                                                                             |

### Revision 3 — decisions for one California resident on Unraid

| #   | Decision                                                                                                                                                                                                                                                                                                                                                       | Effect on the plan                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | **No couples, and no MFS.** One person has no use for a partner or ownership fields, and MFS needs a spouse.                                                                                                                                                                                                                                                   | Drops §1-P2 and §1-P3 and the MFS half of §3-P1 (XL becomes L). The couples backfill is gone, leaving one irreversible step (the auth change). Ruling 2 and contract 3.3's MFS example no longer apply. |
| D2  | **State tax means California, and only California, moved up to Wave 3.** A flat-tax pilot proves nothing for you. California has the highest top rate in the country and taxes capital gains as ordinary income, so it is the largest accuracy gap left for this user. | §3-P8 becomes "California" and moves from Wave 5 to Wave 3. It brings in the California conformity differences (listed in §3-P8). |
| D3  | **No optimizer, ever.** The analytics in §3-P6 (bracket fill, conversion headroom) answer the questions a single planner actually asks.                                                                                                                                                                                                                        | §2-P8 moves to "never".                                                                                                  |
| D4  | **The scope is the Wave 0–2 tranche,** with a go/no-go at the end of each wave.                                                                                                                                                                                                                                                                                 | Unchanged from revision 2.                                                                                               |
| D5  | **Compare goes first in Wave 3, and Sankey starts in Wave 1.** Sankey has no dependencies; compare needs the summary Monte Carlo path from Wave 2.                                                                                                                                                                                                                 | P4-P4 moves into Wave 1.                                                                                                 |
| D6  | **Unraid operations.** Unraid has no systemd, so scheduling runs through the User Scripts plugin's cron. Encryption at rest comes from Unraid's LUKS-encrypted array or pool. The compose healthcheck already probes both processes, and `restart: unless-stopped` is already set.                                                                              | §5-P5.4 shrinks to what is missing. §5-P5.5 names the Unraid mechanism.                                                  |
| D7  | **Auth for a single LAN user:** signup lock and log-based reset only. With one account an admin role gates nothing, and TOTP adds little while the app is reachable only on the LAN.                                                                                                                                                                             | §5-P5.3 shrinks from M to S. TOTP becomes conditional on exposing the app beyond the LAN (reverse proxy, Tailscale Funnel). |
| D8  | **Product surface trimmed for one person.** The operator is the only user, so personas and an onboarding wizard serve nobody. California has no estate tax, and a federal estate tax applies only to estates above the exemption (about $15M in 2026).                                                                                                          | Drops §4-P8 and the estate half of §3-P7b.                                                                               |
| D9  | **California real estate:** property tax follows Prop 13's assessed value (purchase price, then growth capped at 2% a year), not market value.                                                                                                                                                                                                                 | Added to §1-P5.                                                                                                          |

---

## 0. Scope reality check

Be honest about what is being proposed. After the revision 3 cuts, the five sections hold about **10 L/XL
items plus ~30 S/M items**. For one maintainer that is a multi-quarter program, before the yearly tax upkeep the
assessment already flagged. That is not a criticism of the plans. It is what ProjectionLab took years and a
team to build.

So pick a tranche, not the whole program. **Waves 0–2 below are the recommended first tranche.** They
return the most value per unit of work:

- determinism (today the engine gives different answers on different days),
- a backup you can restore from, before the first irreversible migration,
- complete export/import, which is the only migration path a self-hoster has,
- the tax-year foundation, which every later tax feature builds on, including California,
- a pure, golden-locked engine, which every later comparison and regression check depends on,
- Sankey, the most visible gap, which is cheap and needs no engine change.

**Compare is not in the tranche.** It is size L and opens Wave 3. Because purity no longer waits on the tax
harness (R3), it can start as soon as Wave 2 closes.

**Couples is out of scope entirely** (D1).

Commit to Wave 3 and beyond one wave at a time, with the option to stop after each.

## 1. Arbitration — conflicts resolved

| #   | Conflict                                                                                                                  | Ruling                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Golden baseline timing.** §2 wants a regression corpus early, but §3's year dimension changes every number.             | Freeze the corpus **once** (P2-P1b), after P2-P0, P3-P1, P2-P1a and P2-P2. California (§3-P8) moves the corpus again, deliberately, and must come with an explained diff (contract 3.5). Never baseline per branch. §1-P4 keeps `ordered` as the default strategy precisely so the numbers do not move again.                                                               |
| 2   | **MFS before couples?** §3 ships MFS as a "labelled single-person approximation", while §1 owns household structure.      | **Moot (D1).** Neither MFS nor couples is built.                                                                                                                                                                                                              |
| 3   | **Who owns FICA?** §3 moves it into the tax engine; §1 adds the `selfEmployment` income path.                             | **§1-P0 enables `pension` only. §3-P4 enables `selfEmployment` together with SE tax.** No income type may ship before the tax that applies to it (R8).                                                                                                       |
| 4   | **Does Sankey need an engine change?** The assessment implied it does; §4 shows v1 needs none.                            | **§4 is right.** Recharts 3 ships `Sankey`, and an annual ledger can be derived from `SimulationDataPoint`. Only per-month, per-account routing would need a `FlowLedger` from §2, and v1 does not need that.                                                      |
| 5   | **`schemaVersion` ownership.** §5 owns the envelope; §1 and §3 both add plan fields.                                      | The envelope (**§5-P1**) is the first item in Wave 1 and lands before any field addition (R6). See contract 3.3 for the bump rule.                                                                                                                             |
| 6   | **PWA and encryption listed as parity gaps.**                                                                             | Encryption is declined (§5-P5.5); Unraid's encrypted array covers it. PWA is deferred and works only on a TLS deployment (R9).                                                                                                                                   |
| 7   | **Purity coupled to the golden freeze.** The old P2-P1 bundled both, so compare and headless waited on the XL tax harness. | **Split** (R3). The pure entry point ships in Wave 1. The freeze waits for the tax harness.                                                                                                                                                                  |

## 2. Global sequencing

Waves follow dependency order. Items in a wave can run in parallel across sections unless an order is
given.

### Wave 0 — Safety and determinism (all S, ~1 week)

| Item                                             | Owner    | Why first                                                                                                  |
| ------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| P5.0 backup/restore + export-before-migrate gate | Platform | Needed before any irreversible migration. It is also the only rollback path.                                |
| P5-P0 `clonePlan` keeps `glidePath`              | Platform | Live data loss, fixed in one line (R7). Add a clone round-trip test over every `plans` field.              |
| P2-P0 clock injection                            | Engine   | Removes the wall-clock reads. Unblocks purity, compare, goldens and milestone determinism.                 |
| P1-P0 bug floor                                  | Modeling | Enable `pension`; make the payoff estimator agree with the engine. Independent and cheap.                  |

**Gate:** no irreversible Convex migration may run until P5.0's export gate is in place and fails closed.

### Wave 1 — Foundations that change shape

Order: **P5-P1 first.** After it, the rest can run in parallel.

| Item                                                      | Owner    | Note                                                                                      |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| P5-P1 export/import v1 (M)                                | Platform | Sets `schemaVersion: 1`. Must merge before P1-P1 or P3-P1 adds fields.                    |
| P3-P1 tax ruleset harness (L)                             | Tax      | **Critical path. Start on day one,** and merge after P5-P1. Gates every later tax phase and the freeze. Its shape must hold a state ruleset (§3-P8). |
| P1-P1 shared time binding + recurrence + real/nominal (M) | Modeling | Merges five duplicated resolvers into one. Owns `cumulativeInflationIndex()` (R5).        |
| P2-P1a pure `simulate()` (M)                              | Engine   | Depends only on P2-P0.                                                                    |
| P4-P1 metric registry pilot (M)                           | Viz      | Cash-flow pilot plus one canary metric. The old switches stay alongside.                  |
| P4-P4 Sankey (M)                                          | Viz      | No dependencies (D5). The earliest visible win.                                           |

**Gate:** no golden corpus yet.

### Wave 2 — Lock the numbers

| Item                                                                      | Owner    | Depends                        |
| ------------------------------------------------------------------------- | -------- | ------------------------------ |
| P2-P2 reconcile success definitions + percentile rank (S)                 | Engine   | P2-P1a                         |
| P2-P1b golden corpus freeze (S)                                           | Engine   | P2-P0, P2-P1a, P2-P2, P3-P1    |
| P2-P3 configurable, memory-bounded Monte Carlo + histogram (L)            | Engine   | P2-P1b                         |
| P5-P2 JSON Schema + headless entry (S)                                    | Platform | P2-P1a, P5-P1                  |
| P4-P2 chart-as-table toggle (S)                                           | Viz      | P4-P1                          |

**End of recommended tranche.**

### Wave 3 — Compare, California, tax depth

Order: **P2-P5 first**, as the first visible win after the tranche (D5). **P3-P3 before P3-P8**, because
California's itemized deduction builds on the federal itemized inputs.

P2-P5 compare mode · P3-P4 FICA/SE + CA SDI (also removes the `selfEmployment` gate) · P3-P3 itemized +
SALT cap · **P3-P8 California** · P4-P3 event annotations · P4-P5 print/PDF · P5-P3 auth hardening (S).

### Wave 4 — Decumulation and retirement rules

Order: **P1-P4 before P3-P5.** P3-P5 needs injectable withdrawal order.

P1-P4 withdrawal strategies · P3-P5 retirement-account rules (XL: pro-rata, conversions, SEPP, ladders,
5-year, QCDs, HSA with California non-conformity) · P1-P5 real estate I (amortization, rental, Prop 13) ·
P3-P6 tax analytics · P1-P8 Social Security.

### Wave 5 — Long tail

P3-P7a AMT/IRMAA · P3-P7b ACA PTC · P1-P7 milestones · P4-P7 progress tracking · P4-P6 migrate remaining
charts · P2-P4 historical modes · P1-P6 real estate II · P2-P7 sensitivity · P2-P6 benchmark harness ·
P5-P4 ops · P5-P5 encryption decision.

Wave 5 is ordered by value to this user. Progress tracking ranks above chart migration, because a single
planner's actual net worth over time is more useful than internal consistency.

### Deliberately last or never

- **Optimizer** (§2-P8): never (D3).
- **Couples, household and MFS** (§1-P2, §1-P3, the MFS half of §3-P1): never for a one-person instance (D1).
  If that changes, revision 2's couples plan is in git history.
- **Onboarding wizard and personas** (§4-P8): the operator is the only user (D8).
- **Estate reporting** (half of §3-P7b): California has no estate tax and the federal exemption is far above
  a typical single-planner estate (D8).
- **States other than California**: no multi-state support and no part-year residency.
- **PWA / service worker**: not possible on the plain-HTTP LAN deployment. On Unraid, the cheapest way to
  get TLS is `tailscale serve` (Tailscale plugin) or an existing SWAG/Nginx Proxy Manager container, either
  of which makes a PWA feasible. Revisit only if the operator moves to one of those.
- **App-level field encryption / passphrase plans**: declined (§5-P5.5). The key would sit next to the
  database, and the feature would break validators, undo and AI prompts, all for a threat that host disk
  encryption already covers.
- **Multi-tenant / advisor / household roster**: permanently out of scope for a single-operator private
  instance.

## 3. Cross-section contracts (work no single plan owned)

| #   | Contract                                                                                                                                           | Needed by    | Assigned to                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Cumulative inflation index.** §1's `amountBasis: real\|nominal` needs a per-year index.                                                           | P1-P1        | **§1-P1** owns a pure `cumulativeInflationIndex(marketAssumptions, years)`; **§2-P1a** re-exports it from `simulate()`'s result (R5)                                          |
| 2   | **`netWorthJournal` Convex table + query/mutation.** §4's progress tracking depends on it; §5's plan did not include it.                            | P4-P7        | **§5, P5.1b**                                                                                                                                                                |
| 3   | **`schemaVersion` bump rule.** §5 defines the envelope; §1 and §3 add fields.                                                                      | P1-P1, P3-P8 | **Any change that lets a newer build write a file an older build would reject bumps the version**, enum widening and new state settings included. The PR that changes the shape bumps it, and P5-P2 regenerates the JSON Schema in the same release. |
| 4   | **Compare route navigation.** §2 builds the page; nobody owned the sidebar/nav entry.                                                              | P2-P5        | **§2** (its own route)                                                                                                                                                       |
| 5   | **Golden corpus stewardship.** After the freeze, who may change numbers?                                                                            | P2-P1b on    | **§2 owns the corpus.** Any §1 or §3 change that moves it must arrive with an explained diff.                                                                                |

## 4. Standing rules for every phase

1. **Green bar:** `npm run typecheck`, `npm run lint` and `npm run test:once` all pass before merge. That is
   roughly 1,240 tests today, including `convex/*.test.ts`; re-count at each wave boundary. New math ships
   with new tests, and **no failing test is ever deleted to make a phase pass**.
2. **Irreversible steps** (now only the auth component change, after D1) require P5.0's export first. Each migration must be additive, idempotent and appended to
   `convex/migrations.ts`.
3. **One phase per change set.** P2-P0, P5-P0 and P5.0 land alone so their effects can be attributed.
4. **Schema changes are additive only**, and readers apply defaults (`stateResidency ?? 'CA'`,
   `taxYear ?? 2026`) so old exports keep importing.
5. **No runtime network for engine inputs.** Tax tables and historical data are vendored and committed.
   Generation is a developer-side script whose output is reviewed as a data diff. (AI chat/insights stays
   a configured runtime call, per `PLAN-single-container-offline.md` B8, and is out of scope for this rule.)
6. **Math changes carry hand-worked fixtures** (Form 8606 examples, IRS SEPP examples, §86 tier edges), not
   just snapshot updates.

## 5. Corrections to `PARITY-assessment.md`

Three rows of the assessment were wrong or incomplete. They are corrected here and the assessment file is
left as written, since it records what the scouts found.

1. **"No service worker" depends on the deployment.** Service workers need a secure context. On the
   plain-HTTP LAN deployment a worker registers only on `localhost`. Behind the HTTPS reverse proxy that
   `SELF_HOSTING.md:136-142` documents, it would work. The verdict should read **N/A on HTTP LAN; deferred
   on TLS deployments**.
2. **Encryption at rest is a deliberate choice, not an oversight.** The recommendation is host disk
   encryption (LUKS/FileVault) plus passphrase-encrypted backups. App-level field encryption would put the
   key in the same `.env.local` as the database, and it would break Convex validators, snapshot/undo and
   server-side AI prompts. Keep the ABSENT verdict and add "won't fix, by decision".
3. **Sankey v1 needs no engine change.** It needs a ledger derived from the existing annual
   `SimulationDataPoint`. Only per-month, per-account routing would need a `FlowLedger` export.

Also restated from the assessment, because it is the largest correctness hazard in the program:
`returns.yieldAmounts` are a **tax-reporting overlay only** and never move a balance. Dividends and interest
are already inside `applyReturns`. Any Sankey or cash-flow aggregation that treats yields as cash counts
them twice.

---

## Plan 1 — Core modeling

**Target state**

- One person (D1). No ownership fields.
- Every dated event resolves through one time-binding resolver that supports `everyNYears` and
  `amountBasis: real|nominal`. User milestones are AND/OR expressions over simulation metrics, can drive
  event dates, and are validated to be acyclic.
- Decumulation is injected (ordered, VPW, X%-rule, Guyton-Klinger). Real estate supports amortizing terms,
  rental income and offset accounts. Social Security estimates PIA→benefit with FRA, early, delayed and
  COLA.

| #   | Work | Files | Effort | Verify |
| --- | ---- | ----- | ------ | ------ |
| 0   | **Bug floor.** Narrow the `.refine` at `income-form-schema.ts:46-54` so only `selfEmployment` is rejected. `selfEmployment` stays gated until §3-P4 (R8). Add a pension path in `incomes.ts` (ordinary income, no FICA). Make `payoff-estimator-utils.ts` use the real rate `(1+apr/12)/(1+infl)-1` and mirror the unpaid-interest allocation in `physical-assets.ts`. Pass inflation into `debt-dialog.tsx`, `physical-asset-dialog.tsx` and `net-worth-section.tsx`. | income schema, `incomes.ts`, dialogs, utils | S | enum tests; payoff months equal the engine's payoff in a loan fixture; suite green |
| 1   | **Shared time binding, recurrence, real/nominal.** New `src/lib/calc/time-binding.ts` replaces the duplicated resolvers in `incomes.ts`, `expenses.ts`, `debts.ts`, `physical-assets.ts` and the glide-path copy. Add `everyNYears` + `recurrenceYears` and `amountBasis`. Owns `cumulativeInflationIndex()` (contract 3.1). Nominal amounts scale by that index. Bumps `schemaVersion` (contract 3.3). | 5 validators, `data-transformers.ts`, entity dialogs | M | table tests per TimePoint; N-year boundaries (0/N/2N); defaults keep the existing suite green |
| 2   | ~~Couples schema foundation~~ — **dropped (D1).** | — | — | — |
| 3   | ~~Household behaviour~~ — **dropped (D1).** | — | — | — |
| 4   | **Withdrawal strategies.** `src/lib/calc/withdrawal-strategies/` exposing `{ getOrder(ctx), getAnnualCap?(ctx) }`: ordered (current), VPW, X%-rule, Guyton-Klinger. Injected via `PortfolioProcessor`. `withdrawalStrategy` in settings; `essential` flag on expenses; expose `unfundedSpending`. | new module + settings + dialog | M | per-strategy goldens; the cap never exceeds the portfolio; **default `ordered` output byte-identical to the frozen corpus** |
| 5   | **Real estate I.** `paymentMethod.termMonths` with a computed payment; new `amortization-schedule.ts`; `rentalIncome` flows into cash flow and taxable income (§3). **Prop 13 property tax (D9):** an optional `propertyTax: { rate, assessedValue, assessedGrowthCap: 0.02 }` charged on the assessed value, not the market value. The default rate is about 1.1% (1% base plus typical local add-ons, editable). | schema, validator, `physical-assets.ts`, dialog | M | schedule reconciles to the engine's payoff within $1; rental cash flow; assessed value grows at min(appreciation, 2%) and resets on purchase |
| 6   | **Real estate II.** `offsetAccountId` on loans reduces the interest base, validated one-to-one against savings/taxable accounts. Rent-vs-own as `housing-comparison.ts`: two deterministic runs, with and without the residence plus a rent expense, reporting the break-even. | schema + new module | L | offset interest math; comparison does not depend on input order |
| 7   | **Milestones.** `milestones` in `SimulatorInputs`; an expression tree `{ op: 'and' \| 'or', children \| { metric, operator, value } }` over age, year, portfolio, account, income, expense and net worth. `timePointSchema` gains `milestone`. `dependency-graph.ts` rejects cycles via a plan-level `superRefine`. The latch is evaluated at month start, and the extractor emits dates for §4's markers. | schema + evaluator + UI | L | truth tables; cycle rejection; fires once; no wall-clock reads |
| 8   | **Social Security.** Vendored `social-security-bend-points.ts` and `fra-table.ts`. `social-security.ts` computes PIA from AIME and applies the FRA reduction/credit and COLA-as-real-growth. The income schema gains `socialSecurity: { mode: 'manual' \| 'estimated', aime?, pia?, claimAge, colaRate? }`. | data + module + schema | M | hand calculations at 62/67/70 and at the bend points; COLA parity when COLA equals inflation |

**Risks.** Old writers (`simulatorToConvex`, `clonePlan`, `plan_export_utils`, templates) rebuild plan
docs and silently drop new fields; P5-P0's `glidePath` bug is a live example. Every field addition ships
with all writers updated in the same release. Strategies can move
headline results, so keep `ordered` as the default and lock the goldens. 

---

## Plan 2 — Simulation engine

**Target state**
Every run is a pure function of `(inputs, mode, seed, clock)` and produces the same bytes on any day, host
or timezone. Monte Carlo is configurable, memory-bounded and aggregates incrementally. One exported success
predicate governs every readout. Historical modes disclose wrapping. Compare, benchmarks and sensitivity
reuse the same pure core. The optimizer is deferred.

| #   | Work | Effort | Verify |
| --- | ---- | ------ | ------ |
| P0  | **Clock injection.** A `Clock` interface resolved at the store boundary passes an explicit `asOf` ISO date into the engine. `calculatePreciseAge(…, now)`. Replace the four argument-less reads at `simulation-engine.ts:291,418` and `timeline-form-schema.ts:72,84`. Use UTC getters so labels do not depend on the timezone. Schema: optional `simulationSettings.asOfDate`. Add an ESLint `no-restricted-syntax` rule that bans argument-less `new Date()` and `Date.now()` under `src/lib/calc` and `src/lib/schemas` (tests excepted). | S | the lint rule passes; a frozen-clock test gets identical ages under two clocks and two `TZ` values |
| P1a | **Pure entry point.** `simulate(inputs, { mode, seed, asOf, trials? })` with no store, worker or module state. Re-exports `cumulativeInflationIndex` (contract 3.1). | M | two invocations are deep-equal; output is stable across a simulated date change |
| P1b | **Golden corpus freeze.** Fixed-clock full results for fixed returns, stochastic seed 1 and historical no-wrap, plus extractor snapshots. Runs after P3-P1 and P2-P2 (ruling 1). | S | corpus checked in; CI fails on any unexplained diff |
| P2  | **Reconcile success + percentiles.** One exported `evaluateSuccess(sim)` = reached retirement ∧ final > $0.10 ∧ no shortfall. Today the three predicates differ: `key-metrics-extractor.ts:69` checks all three; `table-data-extractor.ts:672` omits shortfall; `multi-simulation-analyzer.ts:140` uses `phase === 'retirement'` instead of `retirementAge !== null` and also omits shortfall. Route all three through the new function. Also replace the `Math.floor(p·n)` rank at `stats-utils.ts:73-76`, which is biased upward, with linear interpolation, and add p5/p95. | S | one fixture per difference above (shortfall-then-recovery; retirement reached but final phase not retirement); the headline % equals the per-row column; percentile tests against known distributions |
| P3  | **Configurable, bounded Monte Carlo.** `monteCarlo: { trials: 100–5000, retention: 'summary'\|'full' }`; the seed mapping does not depend on chunking. A streaming summary aggregator (final value, success, retirement/bankruptcy age, per-year totals) keeps full results only for retained seeds. Histogram bins. | L | same seeds give the same success rate as the frozen corpus; bins sum to trials; peak heap ≤ bound |
| P4  | **Historical modes.** `historicalBacktest: { mode: 'looping' \| 'truncate' }`. The provider returns `wrapped` + ranges. Truncate stops at the last vendored year (currently 2024, `nyu-returns.ts`) and records `truncatedAtYear`. | M | a no-wrap horizon is byte-identical to the corpus; wrap/truncate fixtures |
| P5  | **Compare mode.** Both plans run through `simulate` and the MC summary path with identical seeds. A delta extractor covers key metrics, yearly portfolio and tax totals. Replace the placeholder route with a plan picker, a side-by-side view and a delta table/overlay. Includes the nav entry (contract 3.4). | L | identical plans give all-zero deltas; sign tests; identical across clock overrides |
| P6  | **Benchmark harness.** `npm run bench` measures serial vs pool throughput, trials/sec, merge overhead and retained heap, and writes a JSON report. | S | reproducible within ±5%; the speedup is measured, not inferred |
| P7  | **Sensitivity.** One-at-a-time sweeps (returns ±, inflation, retirement age, spending) over deterministic runs; tornado data. | M | sweeps are deterministic; monotonicity cases; runtime budget |
| P8  | **Optimizer: deferred entirely.** No search, no Roth solver. Prerequisites are P1a, P6 and §1-P4's injectable withdrawal order. | — | — |

**Dependencies.** §1 for stable input shapes and injectable withdrawal order (P8 only). §3-P1 before P1b.
§4 to render the histogram, tornado, compare view and wrap disclosure. §5 for route wiring, plan-JSON
mirroring of new settings, and the bench runner.

**Risks.** Clock injection changes date labels and snapshots. The change is mechanical and reversible, and
it lands alone. P2 visibly moves the success rate and p10/p90. That is why it lands _before_ the freeze, and
the release notes must say so. Summary-only MC removes per-trial drill-down except for retained seeds;
`retention: 'full'` is the escape hatch. Truncated backtests visibly shorten horizons, so the default stays
`looping`.

**Not doing.** Multi-dimensional/global sensitivity; block bootstrap; monthly output retention; a timestep
change; nominal/real leaks and HSA/RMD bugs (handed to §1/§3); state tax; couples; GPU workers; persisted
result caching; any optimizer implementation.

---

## Plan 3 — Tax engine

**Target state**

1. Every calculation takes an explicit `taxYear`. Rules live in checked-in, versioned rulesets
   (`tax-data/years/<year>.ts`), resolved by falling back to the nearest prior year. Each table carries
   `indexing: 'indexed' | 'fixed'` plus a source citation, so indexed and statutory tables can never be
   confused again.
2. `FilingStatus` stays `single | marriedFilingJointly | headOfHousehold` (`tax-settings-form-schema.ts:3`);
   MFS is dropped (D1). The `taxablePercentage` field in the dataset, which is never read today, replaces
   the hardcoded 0.5/0.85.
3. One `TaxProcessor` emits one reconciled liability object (federal, FICA, state, credits, penalties,
   IRMAA) and one marginal-rate API used by analytics and charts. `incomes.ts` no longer owns FICA math.
4. A state layer with the same ruleset shape, populated for California only (D2).

| #   | Work | Effort | Unblocks |
| --- | ---- | ------ | -------- |
| 1   | **Ruleset harness.** `tax-data/types.ts` (`TaxRuleset`, `TableMeta`), `tax-data/index.ts` (`getRules(year)`), and `years/2026.ts` consolidating the six existing tables. Pass `simulationState.time.date.getUTCFullYear()` into `TaxProcessor`. Wire up `taxablePercentage`. Keep the legacy named exports as thin 2026 aliases. Design `TaxRuleset` so a `jurisdiction: 'federal' \| 'CA'` ruleset fits without rework. MFS is not built (D1). | **L** | Every later phase; accurate indexing |
| 2   | **Annual-update pipeline.** `scripts/vendor-tax-rules.ts` reads a pinned PolicyEngine parameter commit (hash in the header) and emits `years/<year>.ts` plus `states/CA/<year>.ts` (PolicyEngine-US models California). `tax-data/SOURCE.md` records provenance. CI regenerates the files and fails on drift. Add `docs/tax-year-update.md` and a "January drill" test. Developer-side only; the generated TS is committed and reviewed as a data diff. | M | Cheap annual maintenance; legislative toggles |
| 3   | **Itemized deductions + SALT cap.** Itemized inputs (mortgage interest, charitable, state/local, medical); a per-year SALT cap with the indexed flag. Current law sets the cap at $40k for 2025, rising 1% a year through 2029, phased down above $500k MAGI, and back to $10k in 2030; verify against the vendored source. The senior deduction; standard-vs-itemized selection. For a California resident the SALT cap is the deciding input, since state income tax plus property tax usually exceeds $10k. | L | California's SALT input; AMT addback |
| 4   | **FICA/SE tax in the engine.** Move FICA out of `incomes.ts:217`. Indexed SS wage base, Additional Medicare 0.9%, SE tax (92.35% base, half deduction). **California SDI** as a payroll line: an employee rate with no wage cap since 2024 (1.3% in 2026; verify against EDD), not charged on SE income. **Remove the `selfEmployment` gate here** (R8). Add `TaxesData.fica` and `totalTaxLiability`. Switch `simulation-data-extractor.ts:315-328` to read `TaxesData.fica` _instead of_ `incomes.totalFicaTax`, never both (R10). | M | Honest total liability; SE income |
| 5   | **Retirement-account rules.** Pro-rata §408(d)(2) basis (Form 8606); conversion events/schedule; SEPP/72(t); Roth ladder; 5-year clocks; QCDs. Qualified HSA: `taxes.ts:282-286` taxes every HSA withdrawal as ordinary income. Add a `qualifiedMedical` flag on expenses and treat HSA withdrawals up to that amount as tax-free (R13). **California does not recognise HSAs.** Contributions are not deductible on the CA return, and earnings are taxable to California every year, so the HSA needs a CA basis and a yearly CA tax line on its returns. The CA early-distribution penalty is 2.5% on top of the federal 10%. New `retirement-rules.ts`. Needs §1-P4 merged first. | **XL** | Optimizer; conversion analytics; correct HSA |
| 6   | **Tax analytics.** Marginal rate by income type, next-dollar decomposition, bracket fill, conversion headroom, IRMAA/ACA cliffs. | M | §4 views; conversion UI |
| 7a  | **AMT + IRMAA.** Exemption/phase-out, 26/28% rates, itemized addback, simplified credit. IRMAA as a liability line using the two-year MAGI lookback. | L | High-income realism |
| 7b  | **ACA PTC.** Federal PTC only (FPL %, applicable percentage, SLCSP input), opt-in. Covered California's state subsidies are out of scope; the UI says so. Estate dropped (D8). | S | Pre-65 planning for an early retiree |
| 8   | **California (D2).** `tax-data/states/CA/<year>.ts` with the same `TaxRuleset` shape. The CA rules that differ from federal and must be encoded as ruleset flags, not `if`s: progressive brackets 1%–12.3% indexed every year, plus the 1% Mental Health Services Tax above $1M; **capital gains and qualified dividends taxed as ordinary income**; **Social Security fully excluded**; the CA standard deduction and personal exemption credit (small, separate from federal); CA itemized deductions (no deduction for state income tax; property tax deductible without a cap; a CA high-income phase-out); HSA non-conformity and the 2.5% early-distribution penalty (both consumed by phase 5). CA tax feeds the federal SALT line. A CA residency flag in `taxSettings`, defaulting on for this instance; no other state, no part-year residency. | L | Credible total tax burden; correct SALT; honest Roth-conversion and capital-gains comparisons |

**Dependencies.** Phase 1 gates everything. Phase 3 before phase 8. §1-P4 injectable order and §2 purity
before phase 5.

**Risks.** Test churn: keep the 2026 aliases and migrate assertions incrementally. Year fallback can hide
gaps, so fail loudly in tests and warn in the UI. The FICA move must swap the extractor's source in the same
PR, enforced by one reconciliation invariant (`totalTaxLiability` equals the sum of its lines). Pro-rata
conversion is the riskiest math: put it behind a feature flag and ship it only with Form 8606 fixtures.
Vendored data needs a pinned commit, committed output, and a human cross-check against the IRS release, and
for California against the FTB's published rate schedules. Phase 8 moves almost every golden number for this
user: land it alone, with fixtures hand-worked from the FTB 540 instructions.

**Not doing.** No runtime fetch or PolicyEngine at runtime; no per-user editable brackets. No filing or
e-file, tax advice, states other than California, part-year residency, city taxes, CA muni-bond exemption, Covered California subsidies, K-1/S-corp/partnership, trust
returns, or full credit stack (EITC/CTC/education/foreign). No full AMT credit machinery; ACA is
federal-only; no estate reporting. Never: a general tax-rule DSL, per-plan custom rulesets,
pre-2020 tax years, or in-app forecasting of future law.

---

## Plan 4 — Visualization & UX

**Target state**
One declarative `METRIC_REGISTRY` owns series keys, labels, colours, stacking, formatting, table columns and
annotation slots. Adding a metric means one registry entry plus an optional extractor field. Every chart has
a table and a print equivalent. Net-worth and cash-flow views carry event markers, and a Sankey labels
reinvested returns honestly. Actuals overlay projections from a persisted journal. Onboarding offers
personas (dropped in revision 3, D8).

| #   | Work | Effort | Verify |
| --- | ---- | ------ | ------ |
| 1   | **Registry core + cash-flow pilot.** `metric-registry.ts` and `plot-types.ts`: `MetricDefinition { id, category, chartKinds, series[], table, annotations? }`, a pure `resolveSeries()`, and renderer adapters for line/area/bar/pie. Keep `chart-data-views.ts` as explicit re-exports so persisted `dataViews` stay stable. Port cash flow and add one canary metric (`realNetWorth`, display-only). | M | registry test (unique ids, every `dataView` resolves, key/colour parity against frozen arrays); suite green; manual chart diff |
| 2   | **Chart-as-table toggle.** A view toggle in `chart-card.tsx` renders registry columns through the existing `tables/table.tsx`. | S | every metric has a table accessor/formatter; table tests unchanged |
| 3   | **Event annotations.** `annotations-extractor.ts` derives events from `SimulationDataPoint`: retirement phase change, RMD start, first/last active income and expense, debt payoff, asset purchase/sale. Rendered via `ReferenceLine`/`ReferenceDot`. | M | fixture tests for event ages; legible on mobile |
| 4   | **Sankey.** Uses Recharts 3's built-in `Sankey`, with a ledger built from the annual `SimulationDataPoint`. Inflows: incomes, asset-sale proceeds, portfolio withdrawals. Outflows: expenses, taxes/penalties, debt payments, purchases, contributions. **Returns render as a separate "reinvested" node, never as cash.** | M | **cash conservation:** inflows − outflows = Δcash for each year; a separate **net-worth reconciliation** Δnet worth = cash net + returns + physical-asset appreciation − debt interest accrued, within $1 (R14); a test that yields never appear as cash |
| 5   | **Print/PDF.** `@media print`/`@page` in `globals.css`; a print-friendly report route; hide chrome and force page breaks. Browser print-to-PDF, with no server rendering. | S | build/typecheck; A4/Letter preview; print CSS hides nav and chat |
| 6   | **Migrate remaining charts.** Cash flow is done; then taxes, returns, contributions, withdrawals, and net worth last. Each PR replaces only the series `switch` and keeps the Recharts shell, the `custom` per-account escape hatch and the tax reference-line modes. | L | per-category parity checklist for keys, colours and stacking; delete each old switch only after sign-off |
| 7   | **Progress tracking.** A manual actuals journal (date, per-account balances, note), a net-worth overlay and a deviation band. Persistence belongs to §5 (contract 3.2). | M | alignment tests for partial dates; Convex CRUD once §5 lands |
| 8   | ~~Onboarding wizard + personas~~ — **dropped (D8).** | — | — |

**Dependencies.** §2 for a deterministic clock (print axes, actuals alignment) and for an exact flow ledger
if a per-month Sankey is ever wanted. §5 for journal persistence and a versioned export. §1 for milestones
(annotation v2) and stable `planData`. §3 for tax-year overlays.

**Risks.** The registry covers series and metadata only. Do **not** unify the chart shells, because
line/area/bar/pie semantics differ. Migration is gradual: new metrics use the registry immediately, and old
switches remain until each category is verified. Each category can be reverted until all switches are
deleted; after that, a revert conflicts with newly written registry metrics. Colours, sign stacking and
custom per-account series are encoded in the charts, so freeze the key and colour arrays in tests and
require a manual diff per category. Changing the `dataViews` unions can reset persisted preferences; prefer
id mapping plus a version bump. Sankey's main hazard is counting yields twice, so enforce the conservation
tests.

**Not doing.** Compare mode (belongs to §2); server-side PDF; a new chart library or CDN; a generic chart
engine replacing Recharts; a plugin surface; the milestone evaluator (§1); bank sync; PWA caching; a mobile
redesign; state-tax overlays before §3.

---

## Plan 5 — Platform

**Target state**

1. A plan is a versioned, human-readable JSON file that round-trips completely — all plan data _and_
   user-level finances — through a real download and upload, with actionable errors.
2. The operator can lock the instance down through configuration: signup off after bootstrap, TOTP MFA, and
   password recovery that works with no mail transport.
3. Operations are boring and recoverable: automated encrypted backups, per-process health checks, a
   versioned public schema and a documented headless run of the engine.

Ordering principle: the safety net comes first, because P5.3 touches the auth component and every later
phase mutates state.

| #     | Work | Effort | Verify |
| ----- | ---- | ------ | ------ |
| P5.0  | **Backup/restore safety net.** `scripts/backup.sh` exports through the admin key to a timestamped zip (optional `age` encryption, keeps the last N). `scripts/restore.sh`. `scripts/selfhost.sh` exports **before** `deploy`/`run_migrations` and aborts on failure. Turn the manual `npx convex export` step in `SELF_HOSTING.md` "Updating" into this script, and document a restore drill. **Unraid:** write exports to an array share (not the cache pool that holds the `convex-data` appdata), and schedule nightly runs through the User Scripts plugin. | S | export→wipe→import into a scratch instance; idempotent; `shellcheck` |
| P5-P0 | **`clonePlan` drops `glidePath`.** Add `glidePath` to the destructure/clone at `convex/plans.ts:205-232`. Add a test asserting that every optional field in the `plans` validator survives a clone, so the next new field cannot be dropped silently. | S | the new test fails before the fix and passes after it |
| P5.1  | **Export/import v1.** Envelope `{ schemaVersion: 1, kind, exportedAt, plan, finances }`. Download via `Blob` + `<a download>` (the File System Access API needs a secure context, which the HTTP LAN deployment lacks). Import via a file input. A full `path: message` error list replaces the 250-char truncation. Importing finances requires explicit confirmation and first auto-downloads a pre-import snapshot. Bulk export. | M | round-trip test including `glidePath` and finances; a malformed file shows field paths |
| P5.1b | **`netWorthJournal` table** (contract 3.2): a Convex table, query/mutation, ownership checks and plan-JSON mirroring. | S | Convex CRUD tests; export/import includes the entries |
| P5.2  | **JSON Schema + headless entry.** `z.toJSONSchema` (Zod 4) over `simulatorSchema` → a checked-in `schema/ignidash-plan.v<N>.schema.json`; `npm run headless:simulate -- plan.json`; `docs/HEADLESS.md`. | S | schema snapshot test; a fixed seed produces byte-identical output |
| P5.3  | **Auth hardening (single LAN user, D7).** `disableSignUp = process.env.ALLOW_SIGNUP !== 'true'`, enforced on the server; hide `/signup` when disabled; document bootstrap as create-then-lock. Recovery **without email**: the reset URL is written to container stderr (`docker logs ignidash` from the Unraid console); `/forgot-password` + `/reset-password`; a 15-minute single-use token. No admin role, since there is only one account. **TOTP only if the app is exposed beyond the LAN** (reverse proxy or Tailscale Funnel); if it ever is, add the `twoFactor()` plugin with backup codes. | S | signup rejected when disabled; reset from logs works end to end; import guard tests |
| P5.4  | **Operational gaps (Unraid, D6).** Already done: the compose healthcheck probes the backend (`:3210/version`) and the app (`/api/health`), and `restart: unless-stopped` is set. Missing: `/api/health` returns only `{status:'ok'}`, so add the build version and uptime. Ship the Unraid template (`PLAN-single-container-offline.md` A9) with the healthcheck, so the Docker tab shows health. Add a User Scripts backup entry. Codify the migration policy: append-only, idempotent, expand/contract, never remove `runAll` entries. | S | health payload carries the version; the scheduled export produces a restorable artifact |
| P5.5  | **Encryption decision.** Rely on Unraid's encrypted array/pool (LUKS, `xfs-encrypted`/`btrfs-encrypted`/ZFS) for the appdata and backup shares, plus passphrase-encrypted backups. Note that an encrypted array requires the passphrase or a keyfile at array start. **Do not** build app-level field encryption or passphrase plans. Document the residual risks and make backup encryption the default. | S | restore without the key fails; with the key it succeeds |
| P5.6  | **PWA: deferred, conditional.** Service workers need a secure context, which the HTTP LAN deployment lacks. `tailscale serve` or a SWAG/NPM container on Unraid would provide one. Scope this only if the operator commits to that deployment. | — | — |

**Dependencies.** P5.1 before any §1/§3 field addition (contract 3.3). P5.2 after §2-P1a. P5.0 before
P5.3's auth schema change.

**Risks.** §5's own schema changes are P5.1b's new table (additive) and P5.3's auth component. The
component change is the program's only remaining irreversible step. Every deploy runs `migrations:runAll`, so
P5.0's export is mandatory and must fail closed. Rollback means restoring the pre-upgrade export into the
pinned previous image, not downgrading the schema. Signup-off can lock the operator out if they lose their
password; the logged reset path is the break-glass procedure, so test it before turning signup off. The reset URL in
the logs is a credential, so give it a short TTL, make it single-use, and note log rotation. Destructive
finances import requires confirmation plus an auto-downloaded pre-import export. The
encryption decision changes no schema and is reversible. App-level crypto would need a one-way plaintext
backfill, which is another reason to reject it.

**Not doing.** App-level field encryption or passphrase plans; a PWA offline shell on HTTP; advisor roster,
multi-tenant or branded reports; email delivery; named plan versions or branching; local-first IndexedDB
sync; bulk import beyond the 10-plan cap.

---

## 6. Decisions (resolved in revision 3)

The open questions from revision 2 are decided for one California resident on Unraid. The reasons are in
the revision 3 table at the top.

| Question                         | Decision                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Couples in scope?                | **No.** MFS goes too (D1).                                                                        |
| State tax?                       | **California only**, in Wave 3 (D2).                                                              |
| Optimizer?                       | **Never** (D3).                                                                                   |
| Full parity or the tranche?      | **Waves 0–2**, with a go/no-go after each wave (D4).                                              |
| Compare and Sankey timing?       | **Sankey in Wave 1; compare opens Wave 3** (D5).                                                  |

**If the context changes:** a second person makes couples worth revisiting (the revision 2 plan is in
git), and exposing the app outside the LAN brings TOTP back into P5.3.
