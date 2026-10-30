# Golden corpus (P2-P1b)

`corpus.json` is the frozen reference for the simulation engine. `golden-corpus.test.ts`
re-runs `simulate()` for every fixture and fails on **any** difference — exact values, no
tolerances.

## The rule

This corpus is frozen **once** (ruling 1: freeze after P2-P0, P3-P1, P2-P1a and P2-P2, all of
which are in). Every later change is judged against it.

- A failing corpus test means a number a user sees has moved. That is the point.
- **Do not regenerate the corpus to make CI green.** A corpus diff must arrive with an
  explanation of why the number moved — in the commit message, or in the PR that ships it.
- Regenerate only when the movement is intended and explained:

  ```bash
  npm run test:golden:update     # rewrites corpus.json from simulate()
  npm test -- src/lib/calc/__tests__/golden/golden-corpus.test.ts
  ```

- The generator is deterministic: `simulate()` takes an explicit `asOf` (`GOLDEN_AS_OF`) and
  reads no clock, store or worker, so two runs on the same code write byte-identical files.
  If they do not, that is a determinism bug in the engine — report it, do not regenerate.

## What is frozen

Six runs of four plans (`fixtures.ts`), each chosen for what it can catch:

| fixture              | run(s)                                                                    | what a diff means                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `steady-saver`       | fixed, stochastic seed 1, historical seed 1 (pinned start years, no wrap) | the ordinary path — accumulation, retirement at 65, contributions, a taxable account                                                                               |
| `marginal-retiree`   | fixed                                                                     | the failing branch — shortfall, bankruptcy at 67, RMDs; `success` is false here, so the corpus is not all-green                                                    |
| `time-binding-mixed` | fixed                                                                     | the P1-P1 inputs — a mid-plan `customDate` start, an `everyNYears` cadence and a `nominal` amount                                                                  |
| `shortfall-repaid`   | fixed                                                                     | the success predicate — reaches retirement, takes a shortfall a later pension repays, ends above $0.10; `false` here, `true` under either predicate P2-P2 replaced |

Per run the corpus stores the whole `simulate()` result (`SimulationResult`), plus the
extractor views built from it: `success` / key metrics, the annual net-worth and tax table
rows, and the percentiles of that run's per-year portfolio values. `crossPlan` adds the
multi-simulation readouts over the cross-run fixture's three modes (same plan and horizon, so
the analyzer compares like with like) and the percentiles of the three original plans' final
values — that list is named (`CROSS_PLAN_FIXTURE_IDS`) so a new fixture cannot move an existing
frozen number.

## What is deliberately not frozen

- **Monte Carlo runs.** The corpus holds single runs only; `P2-P3`'s Monte Carlo path (seeds,
  retention, summary, histogram) lands after this freeze and is covered by unit tests instead.
- **Tax-year resolution.** This is the sharp edge to know about: only one ruleset
  (`tax-data/years/2026.ts`) is checked in and `getRules` falls back to the nearest prior year,
  so **every** simulated year resolves to the same object. A regression that picked the wrong
  year would leave every frozen tax row identical — the corpus cannot see it. That property is
  guarded by `src/lib/calc/tax-data/tax-year.test.ts`, not here. Do not assume corpus coverage
  for the year dimension; if a second ruleset lands, say so in the PR that adds it, because the
  corpus still will not exercise the switch until a fixture spans two rulesets.
- **Chart-specific extractor output** (`src/lib/charts/`, the Vis owner's).
- Anything requiring a store, a worker or the system clock: the corpus is single-run
  `simulate()` output only.

### The multi-simulation quirk, stated precisely

`crossPlan` _does_ call `MultiSimulationAnalyzer.analyze` and
`TableDataExtractor.extractMultiSimulationData` over three same-length runs; both iterate the
run list directly and are safe at that size.

What the corpus never calls is `ChartDataExtractor.extractMultiSimulationPhasesData` (and
`TableDataExtractor.extractMultiSimulationYearlyAggregateData`), which index the run list by
**yearly row index** and throw when a fixture has fewer runs than years. Avoiding that quirk is
the reason the corpus contains no Monte Carlo fixture — not "no multi-simulation extractor at
all".

## Change log — regenerations, with the reason

### P3-P4: FICA/SE tax moved into the tax layer; California SDI added

Regenerated once, deliberately. **Every wage-earning fixture moves, and only because payroll
tax now includes California SDI** (1.3% of wages in the first simulated year, which settles under
2026's rate; 1.4% in later years, which settle under the published 2027 row). FICA did not change
for these plans — all wages stay under the $184,500 OASDI wage base and under the $200,000
Additional Medicare threshold — and none of them has self-employment income.

What a diff in this direction means: take-home pay falls by 1.3%-1.4% of wages. That reduces the
401(k) employee contribution, which raises AGI by the same amount and the federal income tax by
roughly 22% of it; the year-end refund falls by that tax; the rest of the portfolio cascade is
that smaller contribution compounding. Nothing else may move: the year-end bill changes by the
income tax only, because the payroll tax was already withheld from the paycheque (the P3-P4
invariant, asserted in `taxes.test.ts`).

| fixture              | lifetime FICA                 | lifetime tax                            | final portfolio                         | why                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `steady-saver`       | +$38,390.00 (all three modes) | +$46,844.74 / +$46,200.80 / +$47,109.57 | −$90,590.74 / −$89,956.55 / −$66,567.36 | Wages of $110,000 for 25 simulated years: SDI is $1,430 in the first year and $1,540 after. The tax delta is larger than the SDI delta because each year's 401(k) contribution falls by the SDI, raising AGI by the same amount.                 |
| `marginal-retiree`   | +$4,140.00                    | +$4,568.35                              | unchanged (0.00, bankrupt)              | Wages of $60,000 for five working years: $780 in the first year and $840 after. The extra payroll cost deepens the shortfall, so the plan still ends at zero — it cannot end lower.                                                              |
| `time-binding-mixed` | +$27,835.00                   | +$20,029.77                             | −$103,855.44                            | Wages of $95,000 for 21 simulated years: $1,235 in the first year and $1,330 after. Lifetime tax moves less than lifetime FICA here because the smaller portfolio also means less taxable interest in retirement.                                |
| `shortfall-repaid`   | 0.00                          | 0.00                                    | 0.00                                    | Pension income only: no wages, no self-employment income, so no payroll tax and no SDI. The snapshot changes only by the added fields (`taxes.fica`, `taxes.totalTaxLiability`, `incomes.totalWageIncome`, `incomes.totalSelfEmploymentIncome`). |

A cross-check that ran before regenerating (and is cheap to repeat): at all 187 frozen annual data
points, `incomes.totalFicaTax` equals `taxes.fica.wages.total`, `taxes.totalTaxLiability` equals the
sum of its lines, and the year-end settlement moves by the income-tax difference alone.

### Alignment fix: a settlement's payroll and income tax now use the same year

Regenerated once, deliberately. The bug: the payroll processor was created with the run's **start**
year, so the first settlement withheld 2026's SDI rate (1.3%) while the income tax for that same
settlement already resolved 2027's ruleset (1.4%) — the 1.3% figures in the P3-P4 entry above are
what this fix replaces. A settlement is one period closed on one date, so every table it applies
comes from that date's year: the engine now derives that year once (`settlementTaxYearForPeriod`) and
both processors use it, with a runtime guard that throws if they ever disagree.

Only the **first** settlement changes, and only its **SDI** line: +0.1% of that year's wages
(1.3% → 1.4%). OASDI, Medicare, the Additional Medicare Tax, gross income and income-tax withholding
are byte-identical; every later settlement already withheld 1.4% and is unchanged at the source. The
lifetime and portfolio deltas below are the first year's extra payroll and its compounding.

| fixture              | row-1 SDI               | row-1 federal income tax | lifetime tax                   | final portfolio                | why                                                                                                                                           |
| -------------------- | ----------------------- | ------------------------ | ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `steady-saver`       | $1,430 → $1,540 (+$110) | +$24.20                  | +$131.02 / +$125.31 / +$131.29 | −$326.90 / −$324.39 / −$212.50 | $110,000 × 0.1%. The extra payroll comes out of the 401(k) contribution, so AGI rises by $110 and the tax by 22% of it.                       |
| `marginal-retiree`   | $780 → $840 (+$60)      | +$16.93                  | +$65.40                        | unchanged (0.00, bankrupt)     | $60,000 × 0.1%. Funded by a withdrawal rather than a contribution, so AGI rises by $60 plus the extra tax on it; the plan still ends at zero. |
| `time-binding-mixed` | $1,235 → $1,330 (+$95)  | +$20.90                  | +$50.88                        | −$436.41                       | $95,000 × 0.1%.                                                                                                                               |
| `shortfall-repaid`   | $0 → $0                 | $0                       | 0.00                           | 0.00                           | Pension only: no wages, so no payroll line and nothing to align.                                                                              |

Cross-check run before regenerating: at every frozen row the SDI rate the settlement used equals the
rate published for that row's own year; rows from the second settlement on kept the same rate before
and after; take-home fell by exactly the SDI delta; and gross income and income-tax withholding were
unchanged everywhere. `simulation-engine.test.ts` pins the invariant for the first two settlements:
each settlement's payroll lines equal `computeWagePayrollTaxes({ …, taxYear: rowYear })`.
