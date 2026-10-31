# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ignidash is an open-source personal financial planning app (AGPL-3.0). It runs Monte Carlo simulations, historical backtesting, US tax estimation, and AI chat/insights for retirement planning.

## Tech Stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- **Backend:** Convex (serverless DB + functions)
- **Auth:** Better-Auth with Convex integration — email/password only (Google OAuth was removed)
- **State:** Zustand 5 (with Immer, persist, devtools)
- **Forms:** React Hook Form + Zod 4 validation
- **Charts:** Recharts 3

No payments, analytics or hosted AI. This fork is self-hosted and LAN-only, and Stripe, PostHog,
Vercel Analytics, Resend, Google OAuth, Azure OpenAI and Google Fonts were **deleted**, not
feature-flagged. Do not add a vendor SDK without deciding whether this fork wants it. Onboarding,
invariants and traps live in `AGENTS.md`.

## Commands

```bash
npm run dev              # Next.js dev server
npm run dev:convex       # Local Convex backend (run alongside dev)
npm run build            # Production build
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format all
npm run typecheck        # TypeScript check (tsc --noEmit)

# Testing
npm run test             # Vitest watch mode
npm run test:once        # Vitest single run
npm run test:once -- src/lib/calc/__tests__/taxes.test.ts  # Run single test file
npm run test:coverage    # Coverage report
npm run test:e2e         # Playwright e2e tests
npm run bench            # Engine benchmarks

# Schema and data
npm run schema:plan        # Regenerate the versioned plan JSON schema
npm run test:golden:update # Regenerate the frozen corpus (needs a note in golden/README.md)
npm run headless:simulate  # Run the engine from the CLI

# Self-hosting
npm run selfhost         # Deploy to the self-hosted instance (snapshots first)
npm run docker:build     # Build the single-container image
```

### Test conventions

- Node environment by default. DOM tests opt in per file with a leading `// @vitest-environment jsdom`;
  do **not** change the global environment — the Convex suites rely on their own `edge-runtime` docblock.
- Convex tests use the real `convex-test` harness.
- A test that cannot fail is worse than no test: break the code, confirm the pin goes red, restore it.

The golden corpus (`src/lib/calc/__tests__/golden/`) is the numerical net and is **frozen**. Any
movement needs a per-fixture explanation in `golden/README.md`.

## Pre-commit Hooks

Husky runs `lint-staged` on commit, which auto-runs `eslint --fix` + `prettier --write` on staged `.js/.jsx/.ts/.tsx` files and `prettier --write` on `.json/.md/.css`. Files in `convex/_generated/` are excluded.

## Path Aliases

- `@/*` → `src/*`
- `@/convex/*` → `convex/*`

## Architecture

### Routing (Next.js App Router)

- `src/app/(auth)/` — Sign in/up, password reset (public)
- `src/app/(marketing)/` — Home, pricing, about (public)
- `src/app/(legal)/` — Privacy, terms (public)
- `src/app/dashboard/` — Protected area: simulator, insights, compare
- `src/app/dashboard/simulator/[planId]/` — Main simulator view per plan
- `src/app/api/auth/` — Better-Auth API endpoints

### Convex Backend (`convex/`)

All server functions (queries, mutations, actions) live here. Key files:

- `plans.ts`, `account.ts`, `income.ts`, `expense.ts`, `debt.ts` — CRUD for financial entities
- `messages.ts`, `conversations.ts` — AI chat
- `insights.ts` — AI-generated insights
- `http.ts` — Convex HTTP router (no Stripe webhooks: billing was removed from this fork)
- `utils/auth_utils.ts` — `getUserIdOrThrow(ctx)` for auth in every query/mutation
- `utils/sys_prompt_utils.ts` — Dynamic AI system prompt from plan data
- `validators/` — Input validators for Convex functions
- `_generated/` — Auto-generated types and API (do not edit)
- `betterAuth/_generated/` — Auto-generated auth types (do not edit)

### Simulation Engine (`src/lib/calc/`)

The core financial simulator runs month-by-month loops producing yearly `SimulationDataPoint`s:

- `simulation-engine.ts` — `FinancialSimulationEngine` orchestrates the loop
- `portfolio.ts`, `account.ts`, `incomes.ts`, `expenses.ts`, `taxes.ts`, `debts.ts` — Per-domain calculation modules
- `returns-providers/` — Strategy pattern: `FixedReturnsProvider`, `StochasticReturnsProvider`, `LcgHistoricalBacktestReturnsProvider`
- `data-extractors/` — Extract chart data, table data, key metrics from simulation results
- `__tests__/` — Unit tests for the engine
- `tax-data/` — Year-keyed tax rulesets with citations (`years/`, `states/CA/`, `salt-cap.ts`, `aca.ts`). Never invent a figure: the convention is to `throw` rather than borrow a neighbouring year.
- `retirement-rules/` — Pro-rata §408(d)(2), the three SEPP methods, both Roth clocks, QCDs, with vendored §1.401(a)(9)-9 tables
- `withdrawal-strategies/` — Ordered, VPW, fixed percentage, Guyton-Klinger behind `getOrder` / `getAnnualCap`
- `milestones/` — Condition evaluator, dependency graph, latch (wired at the engine's month-start tick)
- `historical-data/`, `data-analyzers/` — Backtest inputs and post-run analysis

### Web Workers (`src/lib/workers/`)

Heavy simulation work runs off-main-thread via Comlink:

- `simulation-worker-api.ts` — Worker pool management
- `simulation.worker.ts` — Runs individual simulations
- `merge-worker-api.ts` / `merge.worker.ts` — Aggregates multi-simulation results

### State Management (`src/lib/stores/simulator-store.ts`)

Single Zustand store (`useSimulatorStore`) with slices: `results`, `preferences`, `chat`, `insights`, `nux`, `numbers`. Uses Immer middleware for mutable updates. Only `preferences` and `nux` are persisted to localStorage.

### Data Flow Pattern

1. Convex queries fetched via hooks in `src/hooks/use-convex-data.ts` (wraps `useQuery`)
2. Data transformed from Convex documents → Zod types via `src/lib/utils/data-transformers.ts`
3. Zod-validated inputs fed into simulation engine
4. Results extracted by data extractors into chart/table/metric data
5. SWR used for derived data caching (multi-simulation analysis)

### Schemas & Validation (`src/lib/schemas/`)

- `inputs/simulator-schema.ts` — Root `SimulatorInputs` type composing all sub-schemas
- `inputs/` — Per-domain form schemas (income, account, expense, etc.)
- `finances/` — Financial object schemas
- `tables/` — Table row schemas

### Export / import (`src/lib/export/`)

`plan-envelope.ts` owns the versioned envelope. **`EXPORT_SCHEMA_VERSION` is a single-writer
resource**: one field-adding change at a time, and `npm run schema:plan` regenerates the matching
JSON schema. Add the field, bump, state what absent means, and prove the upgrade with a test that
fails if you remove it. History and rules: `AGENTS.md` §4.

### Scripts (`scripts/`)

- `selfhost.sh` — deploy; snapshots first and aborts if the snapshot fails
- `backup.sh` / `restore.sh` — encrypted (`age`) backup, 30 nightly + 12 monthly, and a guarded restore
- `headless-simulate.ts` — `npm run headless:simulate` (see `docs/HEADLESS.md`)
- `generate-plan-json-schema.ts` — what `npm run schema:plan` invokes

### Hooks (`src/hooks/`)

~25 custom hooks. Key ones:

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

`formatNumber` in `src/lib/utils.ts` is only for non-currency values (percentages, plain numbers).

## Code Style

- Prettier: single quotes, semicolons, trailing commas (ES5), 140 char width, Tailwind class sorting
- ESLint: flat config (ESLint 9), extends `next/core-web-vitals` + `next/typescript` + `prettier`
- Unused variables: underscore prefix allowed (e.g., `_unused`)
- All components are `'use client'` unless explicitly server components
