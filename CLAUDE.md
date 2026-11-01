# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ignidash is an open-source personal financial planning app (AGPL-3.0). It runs Monte Carlo simulations, historical backtesting, US tax estimation, and AI chat/insights for retirement planning.

## Tech Stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- **Backend:** Convex (serverless DB + functions)
- **Auth:** Better-Auth with Convex integration — email/password is the default and only enabled path; Google OAuth is present but off unless `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` are set
- **State:** Zustand 5 (with Immer, persist, devtools)
- **Forms:** React Hook Form + Zod 4 validation
- **Charts:** Recharts 3

No payments, analytics or hosted AI is required. This fork is self-hosted and LAN-only, and Stripe,
PostHog, Vercel Analytics and Resend were **deleted**, not feature-flagged. Three vendor surfaces
were kept instead: Google OAuth (off unless `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and
`NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` are set — see `convex/auth.ts`), Azure OpenAI (off unless
`OPENAI_ENDPOINT` is set; `convex/ai_chat.ts` still constructs the `AzureOpenAI` client) and Google
Fonts (`next/font/google` in `src/app/layout.tsx`, fetched at build time, never at runtime). Do not
add a vendor SDK without deciding whether this fork wants it. Onboarding, invariants and traps live
in `AGENTS.md`.

## Commands

```bash
npm run dev              # Next.js dev server
npm run dev:convex       # Local Convex backend (run alongside dev)
npm run build            # Production build
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format all
npm run typecheck        # TypeScript check (tsc --noEmit)

# Testing & Verification
npm run test             # Vitest watch mode
npm run test:once        # Vitest single run (all ~146 files, ~2875 tests)
npm run test:once -- src/lib/calc/taxes.test.ts  # Run single test file
npm run test:coverage    # Coverage report
npm run test:e2e         # Playwright e2e tests
npm run bench            # Engine benchmarks (allocation & execution throughput)
npm run tax:validate     # Validate registered tax rulesets against statutory rules

# Schema and data
npm run schema:plan        # Regenerate the versioned plan JSON schema (bump EXPORT_SCHEMA_VERSION)
npm run test:golden:update # Regenerate the frozen corpus (needs a note in golden/README.md)
npm run headless:simulate  # Run the engine from the CLI (see docs/HEADLESS.md)

# Self-hosting
npm run selfhost         # Deploy to the self-hosted instance (snapshots first)
npm run docker:build     # Build the single-container image
```

### Test conventions

- Node 24 required (`^22.22.2 || ^24.15.0 || >=26.0.0`); `.npmrc` enforces `engine-strict=true`.
- Node environment by default. DOM tests opt in per file with a leading `// @vitest-environment jsdom`;
  do **not** change the global environment — the Convex suites rely on their own `edge-runtime` docblock.
- Convex tests use the real `convex-test` harness.
- A test that cannot fail is worse than no test: break the code, confirm the pin goes red, restore it.

The golden corpus (`src/lib/calc/__tests__/golden/`) is the numerical net and is **frozen** at
`1e002e8ab28549a44b6f819866dcbe91db6354442e8419c703c0cd724b4570fe`. Any movement needs a
per-fixture explanation in `golden/README.md`.

## Pre-commit Hooks

Husky runs `lint-staged` on commit, which auto-runs `eslint --fix` + `prettier --write` on staged `.js/.jsx/.ts/.tsx` files and `prettier --write` on `.json/.md/.css`. Files in `convex/_generated/` are excluded.

## Path Aliases

- `@/*` → `src/*`
- `@/convex/*` → `convex/*`

## Architecture

### Routing (Next.js App Router)

- `src/app/(auth)/` — Sign in/up, password reset (public)
- `src/app/help/` — In-app help and documentation
- `src/app/settings/` — Account and data settings (profile, password, export/import, backup)
- `src/app/dashboard/` — Protected area: simulator, insights, compare
- `src/app/dashboard/simulator/[planId]/` — Main simulator view per plan:
  - `components/outputs/sections/sensitivity-section.tsx`: One-at-a-time (OAT) parameter sensitivity sweep
  - `components/outputs/sections/net-worth-overlay-section.tsx`: Historical journal snapshot overlay on simulated trajectories
  - `components/outputs/drawers/net-worth-journal-drawer.tsx`: Manual net worth snapshots ledger
  - `components/inputs/drawers/tax-settings-drawer.tsx`: Tax filing status, CA residency, ACA PTC opt-in and benchmark SLCSP
  - `components/inputs/dialogs/conversion-dialog.tsx`: Roth conversions (fixed amount or fill-to-bracket bisection)
  - `components/inputs/dialogs/sepp-dialog.tsx`: SEPP schedules (RMD, amortization, annuitization under Notice 2022-6)
  - `components/inputs/dialogs/expense-dialog.tsx`: Qualified medical expenses (tax-free HSA) and QCD satisfaction
- `src/app/api/auth/` — Better-Auth API endpoints

The `(marketing)` and `(legal)` route groups named by earlier versions of this file **do not
exist in this fork** — they went with the billing and marketing surfaces. Verify with
`ls -d src/app/\(*\)` before trusting any route claim here.

### Convex Backend (`convex/`)

All server functions (queries, mutations, actions) live here. Key files:

- `plans.ts`, `account.ts`, `income.ts`, `expense.ts`, `debt.ts`, `physical_asset.ts`, `contribution_rule.ts` — CRUD for financial entities
- `conversion.ts` — Roth conversion schedule queries and mutations
- `sepp.ts` — Substantially Equal Periodic Payments (SEPP) queries and mutations
- `net_worth_journal.ts` — Net-worth journal manual history snapshot entries
- `milestones.ts` — Milestone triggers and event conditions
- `messages.ts`, `conversations.ts` — AI chat persistence
- `insights.ts` — AI-generated insights
- `ai_chat.ts` — The streaming chat/insights action. Provider-agnostic: `OPENAI_BASE_URL` points the `openai` SDK at any OpenAI-compatible server (Ollama, vLLM, llama.cpp); `OPENAI_ENDPOINT` selects `AzureOpenAI`.
- `chat_tools.ts` — Deterministic financial calculation tools for AI chat (`runSensitivityAnalysis`, `compareHousing`, `calculateRothLadder`, `previewRetirementPatch`). Imports directly from `../src/lib/calc/`.
- `prompts/tax-optimization.ts` & `prompts/tax-optimization.md` — Synchronized system prompts reflecting the engine's capabilities.
- `prompts/evals/tax-optimization-evals.test.ts` — 39 eval tests scoring prompt accuracy.
- `http.ts` — Convex HTTP router (no external payment webhooks)
- `utils/auth_utils.ts` — `getUserIdOrThrow(ctx)` for top-level queries; `utils/plan_utils.ts` — `getPlanForCurrentUserOrThrow(ctx, planId)`
- `utils/sys_prompt_utils.ts` — Dynamic AI system prompt generation from plan data
- `validators/` — Convex schema validators (mirrors Zod schemas)
- `api_dts_drift.test.ts` — Verifies every module exporting a Convex function is declared in `api.d.ts` under its module path key
- `_generated/` — Codegen'd types and API. Treat `api.d.ts` as hand-maintained (see `AGENTS.md` §8.1)
- `betterAuth/_generated/` — Auto-generated auth types (do not edit)

### Simulation Engine (`src/lib/calc/`)

The core financial simulator runs month-by-month loops producing yearly `SimulationDataPoint`s:

- `simulation-engine.ts` — `FinancialSimulationEngine` orchestrates the loop
- `portfolio.ts`, `account.ts`, `incomes.ts`, `expenses.ts`, `taxes.ts`, `debts.ts` — Per-domain calculation modules
- `returns-providers/` — Strategy pattern: `FixedReturnsProvider`, `StochasticReturnsProvider`, `LcgHistoricalBacktestReturnsProvider`
- `data-extractors/` — Extract chart data, table data, key metrics from simulation results
- `tax-data/` — Year-keyed tax rulesets with citations (`years/`, `states/CA/`, `salt-cap.ts`, `aca.ts`, `real-dollars.ts`).
  - `real-dollars.ts`: Deflates fixed statutory dollar thresholds (`indexing: 'fixed'`) via `cumulativeInflationIndex(simYear - rulesetYear)`, keeping indexed tables and percentage rates constant in today's dollars.
  - `salt-cap.ts`: Statutory SALT cap schedule and phase-down under P.L. 119-21.
  - `aca.ts`: Vendored statutory ACA guidelines and benchmark percentage tables.
- `aca-premium-tax-credit.ts` — IRC §36B ACA premium tax credit calculation and 400% FPL cliff for opted-in plans.
- `retirement-rules/` — Specialized retirement distribution and rollover rules:
  - `ira-basis.ts`: Form 8606 pro-rata recovery of nondeductible traditional IRA basis.
  - `roth-five-year.ts`: 5-year clock tracking per conversion & 10% penalty on early converted withdrawals.
  - `sepp.ts` & `sepp-tables.ts`: IRC §72(t)(2)(A)(iv) Notice 2022-6 SEPP methods (RMD, amortization, annuitization) & §72(t)(4) recapture penalty.
  - `qcd.ts`: Qualified Charitable Distributions for age 70½+, offsetting RMDs.
- `sensitivity.ts` — One-at-a-time (OAT) parameter sensitivity sweeps across investment returns, inflation, retirement age, and spending.
- `housing-comparison.ts` — Deterministic dual-path comparison of renting vs owning.
- `withdrawal-strategies/` — Ordered, VPW, fixed percentage, Guyton-Klinger behind `getOrder` / `getAnnualCap`
- `milestones/` — Condition evaluator, dependency graph, latch (wired at the engine's month-start tick)
- `historical-data/`, `data-analyzers/` — Backtest inputs and post-run analysis
- `__tests__/` — Golden corpus and cross-cutting engine tests; per-module tests sit beside their module (`*.test.ts`)

### Web Workers (`src/lib/workers/`)

Heavy simulation work runs off-main-thread via Comlink:

- `simulation-worker-api.ts` — Worker pool management
- `simulation.worker.ts` — Runs individual simulations
- `merge-worker-api.ts` / `merge.worker.ts` — Aggregates multi-simulation results

### State Management (`src/lib/stores/simulator-store.ts`)

Single Zustand store (`useSimulatorStore`) with slices: `results`, `preferences`, `chat`, `insights`, `nux`, `numbers`. Uses Immer middleware for mutable updates. Only `preferences` and `nux` are persisted to localStorage.

### Data Flow Pattern

1. Convex queries fetched via hooks in `src/hooks/use-convex-data.ts` (wraps `useQuery`)
2. Data transformed from Convex documents ↔ Zod types via `src/lib/utils/data-transformers.ts` (symmetric `*FromConvex` and `*ToConvex` for accounts, expenses, incomes, debts, physical assets, contribution rules, milestones, conversions, sepp, tax settings, and journal snapshots)
3. Zod-validated inputs fed into simulation engine (`SimulatorInputs`)
4. Results extracted by data extractors into chart/table/metric data
5. SWR used for derived data caching (multi-simulation analysis)
6. State managed in Zustand (`src/lib/stores/simulator-store.ts`)

### Schemas & Validation (`src/lib/schemas/`)

- `inputs/simulator-schema.ts` — Root `SimulatorInputs` type composing all sub-schemas
- `inputs/` — Per-domain form schemas (income, account, expense, debt, physical asset, contribution, timeline, tax settings, simulation settings, milestones, conversions, sepp, journal)
- `finances/` — Financial object schemas
- `tables/` — Table row schemas

### Export / import (`src/lib/export/`)

`plan-envelope.ts` owns the versioned envelope. **`EXPORT_SCHEMA_VERSION` is a single-writer
resource**: currently at **19**. One field-adding change at a time, and `npm run schema:plan`
regenerates the matching JSON schema (`schema/ignidash-plan.v19.schema.json`). Add the field,
bump, state what absent means in the history table, and prove the upgrade with a non-vacuous
test that fails if you remove it. History and rules: `AGENTS.md` §4.

### Scripts (`scripts/`)

- `selfhost.sh` — deploy; snapshots first and aborts if the snapshot fails
- `backup.sh` / `restore.sh` — encrypted (`age`) backup, 30 nightly + 12 monthly, and a guarded restore
- `headless-simulate.ts` — `npm run headless:simulate` (see `docs/HEADLESS.md`)
- `generate-plan-json-schema.ts` — what `npm run schema:plan` invokes
- `validate-tax-rules.ts` — what `npm run tax:validate` invokes (validates statutory and conforming rulesets)
- `bench.ts` — what `npm run bench` invokes (engine allocation & speed benchmarks)

### Hooks (`src/hooks/`)

~28 hook modules (about 60 `use*` exports). Key ones:

- `use-convex-data.ts` — All Convex query hooks (`usePlanData`, `useIncomesData`, etc.)
- `use-results-state.ts` — Simulation results state
- `use-regen-simulation.ts` — Trigger simulation re-runs
- `use-chart-*.ts` — Chart data extraction hooks

### Components

- `src/components/ui/` — shadcn/ui components
- `src/components/catalyst/` — Catalyst UI library (custom form/table components)
- `src/components/layout/sidebar/` — Desktop and mobile sidebars
- `src/components/providers/` — Theme provider

### Currency Formatting

Centralized in `src/lib/utils/number-formatters.ts`:

- `formatCurrency(amount, {cents?})` — Full display ($1,234,567)
- `formatCompactCurrency(amount, digits)` — Compact ($1.5M, $200k)
- `getCurrencySymbol()` — Returns '$'
- `formatCurrencyPlaceholder(amount)` — Form placeholders

Percentages go through `formatPercentage(value, fractionDigits?)` in `src/lib/utils/number-formatters.ts`. `src/lib/utils.ts` exports only `cn` and `formatChartString` — there is no `formatNumber` in `src/`; the one in `convex/utils/sys_prompt_utils.ts` is a separate server-side helper.

## Code Style

- Prettier: single quotes, semicolons, trailing commas (ES5), 140 char width, Tailwind class sorting
- ESLint: flat config (ESLint 9), extends `next/core-web-vitals` + `next/typescript` + `prettier`
- Unused variables: underscore prefix allowed (e.g., `_unused`)
- All components are `'use client'` unless explicitly server components
