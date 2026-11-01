# Tax-optimization skill evals (§7-A2)

Two files make up the eval set, and they do different jobs:

- `tax-optimization-evals.ts` — twelve hand-specified plans and the eight properties a run must satisfy.
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

| id                       | property                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grounded-numbers`       | Every figure appears in a tool result from the same turn; nothing is estimated, recalled or derived by arithmetic.                                                                                                                                                                                                        |
| `goal-first`             | The answer names the goal it ranks by (the one in the case's `request`) and orders the variants by it.                                                                                                                                                                                                                    |
| `refused-patches`        | A lever the engine does not model is refused as not modelled; an invalid `planPatch` is reported with its field paths and no numbers are invented for it. A lever the engine does compute — itemized deductions, the SALT cap, AMT, IRMAA, the ACA premium tax credit an opted-in plan reports — is never such a refusal. |
| `no-writes`              | The answer never claims or implies the plan was changed; it says the user applies a variant in the simulator.                                                                                                                                                                                                             |
| `no-recommendation`      | No variant is called best, optimal or recommended, and no result is phrased as advice — even when the request asks the agent to choose.                                                                                                                                                                                   |
| `budget`                 | At most 6 variants and 12 tool calls in the turn, and every reported variant was actually simulated.                                                                                                                                                                                                                      |
| `assumptions-stated`     | The answer ends with the pinned clock and seed, the plan's own return/inflation/tax assumptions, and the limits that bear on the variants proposed.                                                                                                                                                                       |
| `monte-carlo-on-request` | Monte Carlo numbers appear only when the request asks for probabilistic results, and then as aggregates (500 trials, summary).                                                                                                                                                                                            |

`convex/prompts/evals/tax-optimization-evals.test.ts` fails if a check id loses its rule in the
prompt, so the rubric and the prompt cannot drift apart silently.

## What the set deliberately omits

These differ in what a fixture could test, and both of the kinds below are gaps in this set rather
than limits of the engine. The ACA credit is one: the engine computes it for a plan that opts in, and
`taxSettings` **is** patchable — `simulationSettings` is the only key the tool pins — so a fixture
could set `taxSettings.aca.optIn` with a stated SLCSP premium and exercise `cliffs.aca.credit`. None
here does. Social Security claiming is the other: a claim age **is** modelled — an income's
`socialSecurity` block carries `claimAge`, and the engine adjusts the benefit against the full
retirement age of the birth year stored on the income's owner, so a partner born in a different year
is adjusted on their own FRA — and `incomes` is patchable too, so a `planPatch` that changes
`claimAge` returns real numbers. Calling it unmodelled would be the wrong answer, and no case here
carries a `socialSecurity` block, which is the fixture gap.

California's omission is a third kind, not a refusal either: the state return is computed (P3-P8) and
the prompt tells the agent to quote `jurisdictions.california.reported`, but no case turns on a
state-only lever. Covered California subsidies and California AMT are not modelled, which
`jurisdictions.california.notModelled` says on every run.

- **ACA premium tax credit and its cliff.** No case in this set opts in (`taxSettings.aca.optIn`
  with a stated SLCSP premium), so every plan here reports `cliffs.aca.supported` as `false` with
  its prerequisites and no case exercises the credit. That is a gap in the fixtures, not in the
  engine: an opted-in plan gets the refundable §36B credit on its settled return and
  `cliffs.aca.credit` from the analytics, so an answer that calls ACA unmodelled is wrong even on
  these plans — the right answer names the missing input.
- **Social Security claiming.** No case in this set carries a `socialSecurity` block, so no fixture
  exercises a claim-age change. That is a gap in the fixtures, not a missing feature: the engine
  adjusts the benefit for `claimAge` against the earner's own full retirement age, and `incomes` is
  patchable, so a variant that moves `claimAge` returns the numbers. What is not modelled is spousal,
  survivor and dependent benefits, and the retirement earnings test; the claim age is an input to
  simulate, never a recommendation to make.

Not on this list, because the engine computes them: **itemized deductions** (the four entered lines
under `taxSettings.itemizedDeductions`, so a `planPatch` can enter them), **the §164 SALT cap with
its MAGI phase-down**, **AMT**, **IRMAA**, **Roth conversions and ladders** (via `conversions` with
five-year clocks and Form 8606 pro-rata basis recovery), **SEPP/72(t)** (safe-harbor schedules via `sepp`), and **pro-rata IRA basis on a withdrawal** — a
traditional IRA carries `nondeductibleBasis`, and Form 8606's fraction is what decides the tax-free part.
An answer that calls any of those unmodelled is wrong,
and `refused-patches` must not be scored as a pass for one. What the analytics still cannot do is the
_marginal_ effect of an itemized deduction — `notComputed` names that, the AMT credit beyond the
simplified §53 limit, and the non-income-related Part B and Part D premiums — but the deduction
itself, the cap the return applies and both surcharges are reported figures.

The twelve cases instead cover the shapes the engine _can_ compute: single (baseline, high earner,
early retiree, low income, Roth-heavy, tax-deferred-heavy, and a Roth conversion ladder), married
filing jointly (dual income, single earner, early retiree, high income) and married filing separately
(one couple of two ages, with separate wages and community property that the Form 8958 split
divides). The `covers` line on each case says which behaviour it is looking for.

CI runs only the fixture tests. Replaying recorded transcripts in CI — so a changed model can be
diffed without spending tokens — is not built yet; until then, an eval run is a human reading a
transcript.

## The twelve cases

| id                              | what it pins                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single-baseline`               | Single filer, one wage, retiring at 65: the reference case every delta is read against.                                                                                                                                                                                                                       |
| `single-high-earner`            | Single filer at a high wage: bracket pressure and a large tax-deferred balance.                                                                                                                                                                                                                               |
| `single-early-retiree`          | Single filer retiring at 45: a taxable bridge and early-withdrawal penalties.                                                                                                                                                                                                                                 |
| `single-low-income`             | Single filer on a modest wage: the 0% long-term capital gains zone.                                                                                                                                                                                                                                           |
| `single-roth-heavy`             | Single filer whose balances are mostly tax-free: withdrawals that add no taxable income.                                                                                                                                                                                                                      |
| `single-tax-deferred-heavy`     | Single filer with a large traditional 401(k): required minimum distributions late in life.                                                                                                                                                                                                                    |
| `mfj-dual-income`               | Married filing jointly with two wages: joint brackets.                                                                                                                                                                                                                                                        |
| `mfj-single-earner`             | Married filing jointly with one wage: a non-earning spouse and a wider bracket.                                                                                                                                                                                                                               |
| `mfj-early-retiree`             | Married filing jointly retiring at 50: a long pre-59½ window and a taxable bridge.                                                                                                                                                                                                                            |
| `mfj-high-income`               | Married filing jointly at a high income: NIIT territory, with the California return.                                                                                                                                                                                                                          |
| `mfs-couple`                    | Married filing separately: two returns, a community brokerage split under Form 8958, and the California return for each spouse.                                                                                                                                                                               |
| `conversion-ladder-hand-worked` | Single filer retired at 56 with a large IRA and no other income: a three-year Roth conversion ladder at the 12% and the 22% fill. Pins the 12% fill as the best by lifetime taxes, its first-year headroom of $66,500 (standard deduction plus the 12% bracket top), and the IRMAA tier the 22% fill crosses. |

`conversion-ladder-hand-worked` is the one case whose numbers are checked by hand, not only by the
engine: `tax-optimization-evals.test.ts` carries the bracket arithmetic, and the test fails if the
ranking, the headroom or the IRMAA surcharge moves.

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
