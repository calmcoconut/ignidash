<h1 align="center">
  <img src="public/favicon-96x96.png" width="96" height="96" alt="Ignidash"><br />
  Ignidash (self-hosted fork)
</h1>

<p align="center">
  <b>An open-source retirement planner that runs entirely on your own hardware.</b><br />
  Monte Carlo and historical simulation • US federal and California tax • Couples • Optional local AI
</p>

<h4 align="center">
  <a href="https://github.com/calmcoconut/ignidash/actions/workflows/ci.yml">
    <img src="https://github.com/calmcoconut/ignidash/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="AGPL-3.0 License" />
  </a>
</h4>

---

<p align="center">
  <a href="#gh-light-mode-only">
    <img src="public/screenshots/simulator-light.webp" alt="Ignidash Simulator">
  </a>
  <a href="#gh-dark-mode-only">
    <img src="public/screenshots/simulator-dark.webp" alt="Ignidash Simulator">
  </a>
</p>

## What this is

A fork of [schelskedevco/ignidash](https://github.com/schelskedevco/ignidash), reshaped for one
household planning on a home server. It runs as **one Docker container** (the Next.js app and the
Convex backend under one supervisor), is meant for the LAN (with Tailscale or similar for remote
access), and makes **no outbound calls at runtime**: no payments, analytics, email or hosted AI.

The scope is deliberate: one California resident, filing single, married filing jointly or married
filing separately, planning in one account.

## What it models

- **Simulation** — fixed returns, Monte Carlo (configurable trials, bounded memory) and historical
  backtesting (looping or truncated), all through one pure, deterministic engine. One definition of
  success governs every readout.
- **Taxes** — federal income tax, FICA and self-employment tax, itemized deductions with the SALT
  cap, AMT, NIIT, IRMAA, the ACA premium tax credit (opt-in), and California income tax, SDI and its
  HSA non-conformity. Rulesets are year-keyed and every figure carries its citation.
- **Couples** — per-member ages and accounts, married filing separately with California
  community-property splitting, survivor filing status after a death, and spousal and survivor
  Social Security.
- **Retirement-account rules** — Roth conversions (fixed amount or fill-to-bracket) with Form 8606
  pro-rata basis and five-year clocks, SEPP/72(t) under Notice 2022-6, QCDs, RMDs, HSA qualified
  medical withdrawals, and withdrawal strategies (ordered, VPW, fixed percentage, Guyton-Klinger).
- **Real estate and debt** — amortized loans in real dollars, offset accounts, Prop 13 property
  tax, and a rent-vs-own comparison.
- **Planning tools** — milestones with conditions, compare mode, one-at-a-time sensitivity
  (tornado), a net-worth journal overlaid on the projection, chart-or-table views, and a printable
  report.
- **AI (optional)** — chat and insights against any OpenAI-compatible endpoint (Ollama, vLLM,
  llama.cpp, LM Studio) or Azure OpenAI. A tax-optimization skill runs plan variants through the
  engine and ranks them by a goal you pick; it never recommends one, and every number it quotes
  comes from a tool result.

What it does **not** model is listed in the app under **Help → Known limitations**.

## Self-hosting

```bash
docker pull ghcr.io/calmcoconut/ignidash:latest
```

The image is linux/amd64. It is published by CI from `main` (`latest` and the commit SHA) and from
`v*` tags (`stable` and the version), and only after the test suite passes and the image has booted
with both processes healthy.

- **Docker Compose:** see [SELF_HOSTING.md](./SELF_HOSTING.md) for setup, environment variables,
  choosing the URLs, account bootstrap and break-glass password reset.
- **Unraid:** a template is in [`unraid/ignidash.xml`](./unraid/ignidash.xml); SELF_HOSTING.md
  covers importing it.
- **Backups:** `scripts/backup.sh` and `scripts/restore.sh` take and restore encrypted (`age`)
  snapshots; `npm run selfhost` snapshots before every deploy and aborts if the snapshot fails.

## Local development

Requires **Node 24** (`.nvmrc`; `engine-strict` is on).

```bash
git clone https://github.com/calmcoconut/ignidash.git
cd ignidash
npm install
cp .env.cloud.example .env.local   # then set BETTER_AUTH_SECRET: openssl rand -base64 32
```

```bash
npm run dev:convex   # terminal 1: local Convex backend
npm run dev          # terminal 2: Next.js on http://localhost:3000
```

After changing `.env.local`, push it to Convex with `npm run selfhost -- --sync-only`.

### Optional environment variables

| Variable                                     | Description                                                     |
| -------------------------------------------- | --------------------------------------------------------------- |
| `OPENAI_API_KEY`                             | Enables AI chat and insights                                    |
| `OPENAI_BASE_URL`                            | OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio) |
| `OPENAI_ENDPOINT`                            | Azure OpenAI endpoint, used when `OPENAI_BASE_URL` is unset     |
| `OPENAI_CHAT_MODEL`, `OPENAI_INSIGHTS_MODEL` | Model or deployment names                                       |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | Google OAuth; also set `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true`  |

Email and password is the default sign-in; Google OAuth stays off unless configured.

### Scripts

| Command                      | Description                                               |
| ---------------------------- | --------------------------------------------------------- |
| `npm run dev`                | Next.js dev server                                        |
| `npm run dev:convex`         | Local Convex backend                                      |
| `npm run build`              | Production build                                          |
| `npm run lint` / `lint:fix`  | ESLint                                                    |
| `npm run format`             | Prettier                                                  |
| `npm run typecheck`          | TypeScript (`tsc --noEmit`)                               |
| `npm run test:once`          | Full Vitest run (`npm run test` for watch mode)           |
| `npm run test:e2e`           | Playwright                                                |
| `npm run tax:validate`       | Validate the tax rulesets                                 |
| `npm run bench`              | Engine benchmarks                                         |
| `npm run headless:simulate`  | Run the engine from the CLI (see `docs/HEADLESS.md`)      |
| `npm run schema:plan`        | Regenerate the versioned plan JSON schema                 |
| `npm run test:golden:update` | Regenerate the frozen golden corpus (needs a README note) |
| `npm run selfhost`           | Deploy to the self-hosted instance (snapshots first)      |
| `npm run docker:build`       | Build the image with Docker Compose                       |

Before changing anything, read [AGENTS.md](./AGENTS.md) (the invariants and traps) and
[CLAUDE.md](./CLAUDE.md) (where things live). Husky runs ESLint and Prettier on commit; CI runs
format, lint, typecheck, tax validation, the full test suite and a golden-corpus hash check on every
push and pull request.

## Tech stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 · Convex · Better-Auth · Zustand ·
React Hook Form + Zod · Recharts · Vitest and Playwright.

## License

[AGPL-3.0](./LICENSE). Based on [Ignidash](https://github.com/schelskedevco/ignidash) by
SchelskeDevCo.
