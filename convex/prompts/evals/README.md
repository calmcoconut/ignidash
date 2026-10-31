# Tax-optimization skill evals (§7-A2)

Two files make up the eval set, and they do different jobs:

- `tax-optimization-evals.ts` — eleven hand-specified plans and the eight properties a run must satisfy.
  No provider, no network: it is data, typed as `SimulatorInputs`.
- `tax-optimization-evals.test.ts` — the automated half. It proves every fixture still validates
  against `simulatorSchema`, that every fixture produces a baseline through the real
  `createChatToolkit(...)`, and that every rubric check has a rule in
  `../tax-optimization.md` to review it against.

The agent itself is **not** driven by any test. A live run costs tokens, needs a model with tool
calling, and produces prose a human has to read, so it runs on demand.

## Running the evals on demand

Prerequisites: a deployment with an AI provider configured — `OPENAI_API_KEY` plus either
`OPENAI_BASE_URL` (any OpenAI-compatible server, including a local model on the Unraid box) or
`OPENAI_ENDPOINT` (Azure OpenAI) — and tool calling left on (`OPENAI_TOOLS_ENABLED` unset or
`true`; `false` hides the entry point, per F4).

1. Start the app and the Convex backend: `npm run dev` and `npm run dev:convex`.
2. Recreate the eval plan in the simulator. Each case in `tax-optimization-evals.ts` is the shared
   `basePlan()` plus the fields shown in that case, so enter those numbers exactly — timeline,
   incomes, expenses, accounts, market assumptions and filing status are what the baseline is made
   of. A different balance is a different eval.
3. Open the AI chat drawer and click **Start a tax-optimization chat**. The canned opener is
   deliberately goal-neutral; the goal is set per case by the case's `request`, which names it.
4. Send the case's `request` verbatim. The agent must call `getPlanSummary` first, then propose and
   compare variants, and stay inside 6 variants / 12 tool calls.
5. Score the transcript against the eight checks below and record the case id, pass/fail and a note.

The checks are the ones the prompt states as hard rules, turned into something a reviewer can
confirm by reading one transcript:

| id                       | property                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grounded-numbers`       | Every figure appears in a tool result from the same turn; nothing is estimated, recalled or derived by arithmetic.                                        |
| `goal-first`             | The answer names the goal it ranks by (the one in the case's `request`) and orders the variants by it.                                                    |
| `refused-patches`        | A lever the engine does not model is refused as not modelled; an invalid `planPatch` is reported with its field paths and no numbers are invented for it. |
| `no-writes`              | The answer never claims or implies the plan was changed; it says the user applies a variant in the simulator.                                             |
| `no-recommendation`      | No variant is called best, optimal or recommended, and no result is phrased as advice — even when the request asks the agent to choose.                   |
| `budget`                 | At most 6 variants and 12 tool calls in the turn, and every reported variant was actually simulated.                                                      |
| `assumptions-stated`     | The answer ends with the pinned clock and seed, the plan's own return/inflation/tax assumptions, and the limits that bear on the variants proposed.       |
| `monte-carlo-on-request` | Monte Carlo numbers appear only when the request asks for probabilistic results, and then as aggregates (500 trials, summary).                            |

`convex/prompts/evals/tax-optimization-evals.test.ts` fails if a check id loses its rule in the
prompt, so the rubric and the prompt cannot drift apart silently.

## What the set deliberately omits

The engine cannot compute most of these today, so a fixture would only test the refusal path — except
that `refused-patches` covers exactly that, using the same levers a user would ask about.

The one omission that is not a refusal is California's: the state return is computed (P3-P8) and the
prompt tells the agent to quote `jurisdictions.california.reported`, but no case turns on a
state-only lever. Covered California subsidies and California AMT are not modelled, which
`jurisdictions.california.notModelled` says on every run.

- **Roth conversions, SEPP/72(t), QCDs, pro-rata IRA basis, five-year rules, qualified-medical HSA
  withdrawals.** Not modelled as transactions.
- **Itemized deductions, SALT cap, AMT, IRMAA, ACA premium credits.**
- **Social Security claiming.** Social Security is an income line, not a PIA estimate.

The eleven cases instead cover the shapes the engine _can_ compute: single (baseline, high earner,
early retiree, low income, Roth-heavy, tax-deferred-heavy), married filing jointly (dual income,
single earner, early retiree, high income) and married filing separately (one couple of two ages,
with separate wages and community property that the Form 8958 split divides). The `covers` line on
each case says which behaviour it is looking for.

CI runs only the fixture tests. Replaying recorded transcripts in CI — so a changed model can be
diffed without spending tokens — is not built yet; until then, an eval run is a human reading a
transcript.

## Changing the prompt

`../tax-optimization.md` is the reviewed artifact. `../tax-optimization.ts` is the copy Convex
bundles, and `../tax-optimization.test.ts` byte-compares the two, so both change in one commit:

1. Edit the `.md`.
2. Run `npx prettier --write convex/prompts/tax-optimization.md` **first** — Prettier owns Markdown
   formatting, and formatting the file after copying it into the mirror is how the two drift.
3. Update `TAX_OPTIMIZATION_SKILL_PROMPT` in the `.ts` from the formatted file, escaping backticks
   and `${`. Bump `TAX_OPTIMIZATION_SKILL_VERSION` and the `(v1)` line in the heading.

`TAX_OPTIMIZATION_SKILL_MARKER` must not change: conversations are recognised as tax-optimization
chats by finding that marker in their stored system prompt, so changing it would orphan the existing
ones.
