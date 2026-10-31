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

### P3-P7a: the AMT and the Medicare IRMAA surcharge

Regenerated once, deliberately. Two lines the engine never charged are now in `TaxesData`:
`amt` (the alternative minimum tax) and `irmaa` (the Part B + Part D income-related surcharge), and
`totalTaxLiability` is the sum of seven lines instead of five.

**The numeric movement is entirely IRMAA, in one fixture.** A surcharge is charged on the return of
the year it is paid, from the MAGI of two years earlier, so a plan only pays it once it has two
settled years and its MAGI has crossed $109,000 (individual). `time-binding-mixed` is the only
fixture that gets there.

| fixture              | does it charge AMT or IRMAA? | lifetime tax                            | final portfolio                             | what moved                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steady-saver`       | neither                      | unchanged (all three modes)             | unchanged                                   | Nothing numerically; only the two added fields per row. MAGI stays under the first IRMAA tier and the AMT is shadowed.                                                                                                                                                                                                                                                                                                                                     |
| `marginal-retiree`   | neither                      | unchanged                               | unchanged (0.00, bankrupt)                  | As above.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `time-binding-mixed` | **IRMAA**, six years         | 600,150.86 → **608,656.83** (+8,505.97) | 2,823,363.46 → **2,814,857.49** (−8,505.97) | Rows 37-41 are billed at tier 1 ($1,148.40/yr, from the MAGI of 2061-2065) and row 42 at tier 2 ($2,884.80, from 2066): **$8,626.80** of surcharge. It is funded by withdrawals, so the cash balance and its interest fall (−$512.05 of taxable interest over five rows), which _reduces_ federal income tax by $120.83; 8,626.80 − 120.83 = 8,505.97. One row also gains a `capitalLossDeduction` because the realized-gain path shifts by a few dollars. |
| `shortfall-repaid`   | neither                      | unchanged                               | unchanged                                   | Pension only: MAGI never reaches the first tier, and the AMT cannot bite without preference items.                                                                                                                                                                                                                                                                                                                                                         |

`crossPlan.finalValuePercentiles` moves because `time-binding-mixed` is the **middle** of the three
frozen final values: each point moves by its interpolation weight on that value — p50 by the whole
$8,505.97, p25/p75 by half, p10/p90 by a fifth, p5/p95 by a tenth. `crossPlan.multiSimulation` (the
three `steady-saver` modes) is unchanged.

**AMT is not exercised by this freeze, and cannot be yet.** The engine applies the standard deduction
only, so AMT taxable income is simply AGI and the tentative minimum tax is 26%/28% of
(AGI − exemption). At every income that is below the regular tax — checked at $150,000 ($15,574 vs
$24,734), $600,000 and $1,000,000 ($276,500 vs $320,000) in `taxes.test.ts` — so `amt.applied` is
`'regular'` and `amt.netCharge` is zero in all six runs. AMT bites in reality through preference
items the model does not have yet: the SALT and miscellaneous itemized deductions (P3-P3), ISO
exercises, private-activity-bond interest. The zero in the corpus is therefore a _shadowed_ AMT, not
a missing one; `taxes.test.ts` exercises the charged path with a ruleset override and pins the credit
carryforward.

Cross-check run before regenerating: every data point's numeric leaves other than the IRMAA chain are
identical, `taxes.amt` is zero everywhere, and the only newly present optional key is the
`capitalLossDeduction` noted above.

### P3-P3: itemized deductions, the SALT cap and the senior deduction

Regenerated once, deliberately. `TaxesData` gains `deduction` — which deduction the return took, the
itemized lines after the statutory caps, the SALT cap that applied and the §151(d)(5)(C) senior
deduction — and `deductions.seniorDeduction`. **No fixture itemizes** (none carries
`taxSettings.itemizedDeductions`), so the itemized half of this change is shape only.

One fixture moves numerically: **`shortfall-repaid`**, whose primary is 66 at the plan start. The
senior deduction ($6,000 per individual aged 65 or older, tax years 2025-2028) applies to its 2027
and 2028 settlements and then sunsets:

| row | age    | senior deduction | taxable ordinary income | federal income tax | what moved                                                                                |
| --- | ------ | ---------------- | ----------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| 1   | 66.75  | $6,000           | 4,132.58 → **0.00**     | 413.26 → **0.00**  | The deduction exceeds the year's taxable income, so the whole federal tax disappears.     |
| 2   | 67.75  | $6,000           | 0.00 → 0.00             | 0.00 → 0.00        | Taxable income was already zero; only the intermediate AMT figures move (see below).      |
| 3+  | 68.75+ | $0               | unchanged               | unchanged          | The statute ends the deduction after 2028, and the table's `lastTaxYear` is what says so. |

Lifetime taxes **−$378.34** (213,823.37 → 213,445.03) and the final portfolio **+$378.34**: the tax
saved in 2027 is invested, and its later returns and taxes account for the difference between the
$413.26 saved and the lifetime figure.

The other five runs are numerically unchanged: their primaries are under 65 in 2027-2028 and none of
them itemizes. Two _intermediate_ AMT figures do move in every run — `amt.amtIncome` and
`amt.addbacks` — because the addback is now scaled by the share of the deduction the year's income
could actually use. Before, a year whose income was below the standard deduction added the whole
nominal deduction back into AMTI, which overstated it (AMTI should be AGI, not AGI plus a deduction
the return never got to take). `amt.netCharge` stays zero everywhere, so no tax moves.

Cross-check run before regenerating: `taxes.deduction` is the only added field, `deduction.type` is
`standard` in every frozen row, `deduction.seniorDeduction` is non-zero only in `shortfall-repaid`
rows 1-2, and the only numeric changes outside `amt.amtIncome`/`amt.addbacks` are that fixture's
income tax and its compounding.

### P3-P8: California

Regenerated once, deliberately. `TaxesData` gains `state` — the California return's own income,
standard-versus-itemized choice, bracket tax, Behavioral Health Services Tax and exemption credits,
with its `total` joining `totalTaxLiability` as another line — and the federal SALT line now includes
the computed California income tax, which closes the loop with P3-P3.

**Every fixture now pays California tax in every settled year**, because the residency flag defaults
on and no fixture opts out. The ruleset is the FTB's 2025 schedule (the latest published), so each
2026-and-later settlement resolves 2025 by the nearest-prior rule.

| fixture              | CA years | sum of CA tax | row-1 CA tax (on CA income) | lifetime tax                              | final portfolio                               |
| -------------------- | -------- | ------------- | --------------------------- | ----------------------------------------- | --------------------------------------------- |
| `steady-saver` fixed | 30       | $175,124.04   | $6,263.05 on $112,989.99    | 570,090.08 → **750,191.57** (+180,101.48) | 3,978,617.21 → **3,612,855.90** (−365,761.31) |
| `steady-saver` stoch | 30       | $175,840.50   | $6,376.94 on $114,214.58    | 572,238.42 → **751,720.19** (+179,481.77) | 4,516,173.43 → **4,137,645.60** (−378,527.83) |
| `steady-saver` hist  | 30       | $180,204.20   | $6,531.56 on $115,877.19    | 582,111.08 → **767,332.24** (+185,221.15) | 3,839,002.87 → **3,512,387.39** (−326,615.48) |
| `marginal-retiree`   | 30       | $25,839.24    | $4,466.73 on $93,674.70     | 90,731.80 → **121,386.23** (+30,654.44)   | 0.00 → 0.00 (bankrupt either way)             |
| `time-binding-mixed` | 42       | $183,893.82   | $4,764.48 on $96,876.31     | 608,656.83 → **745,153.12** (+136,496.29) | 2,814,857.49 → **2,409,407.30** (−405,450.19) |
| `shortfall-repaid`   | 25       | $77,871.20    | $26.74 on $20,232.58        | 213,445.03 → **287,211.77** (+73,766.73)  | 306,787.54 → **233,020.81** (−73,766.73)      |

**Why the movement is exactly this, and nothing else.** Across every frozen row the change in
`totalTaxLiability` sums to $785,721.87, which is the $818,773.00 of California tax less the
$183,641.73 of federal income tax that falls because the smaller portfolio earns less taxable
interest. The lifetime-tax deltas are the California tax plus that offset, and each final-portfolio
delta is the same amount — the tax is paid out of the portfolio and stops compounding there. Three
further consequences are visible and expected: `deduction.itemized.stateAndLocalTaxes` rises by the
California tax in every row (the federal SALT line now deducts it, though these fixtures still take
the standard deduction); one row of the synthetic "extra savings" account disappears where the
surplus is now zero; and one asset allocation is `null` where the portfolio is empty.

Two smaller numbers worth a reader's attention: `shortfall-repaid`'s first year pays only $26.74 of
California tax (its income is a small pension, and the standard deduction and exemption credit absorb
almost all of it), and `marginal-retiree` still ends at zero — the extra tax deepens a shortfall that
was already total, so its final value cannot move.

Cross-check run before regenerating: every fixture's `state.jurisdiction` is `'CA'` with
`resolvedYear` 2025 in every settled row, the per-year `state.total` sums to the tax above, and the
only numeric changes outside the state block are that tax and its compounding.

### R2: statute-locked thresholds are deflated to today's dollars

Regenerated once, deliberately. The engine works in today's dollars, but nothing applied
`TableMeta.indexing` to a table's _values_: a `fixed` table's amounts were read as though they kept
their purchasing power forever. At 3% inflation the §86 base amount is worth about 40% of its
nominal value after 31 years, so Social Security, the NIIT, the Additional Medicare Tax, the senior
deduction, the §121 exclusion and the SALT cap were all under-taxed by an amount that grows with the
horizon. `tax-data/real-dollars.ts` now divides a `fixed` table's declared dollar fields by the
cumulative index over `simYear − rulesetYear`, and every reader in `taxes.ts`, `payroll-taxes.ts`,
`tax-analytics.ts` and `salt-cap.ts` goes through it. `indexed` tables are returned unchanged, which
is why the federal and California bracket breakpoints do not move.

**The control that says the plumbing is inert until inflation is nonzero.** Re-running this corpus
with every fixture's `inflationRate` forced to 0 produced `sha256 082efeff…bf727` and 1,636,975 bytes
before this change and the same hash and byte count after it. Only the 3% runs move.

| fixture / run                | Σ `totalTaxLiability`                   | final portfolio                             |
| ---------------------------- | --------------------------------------- | ------------------------------------------- |
| `steady-saver` / fixed       | 750,191.57 → **750,740.93** (+549.36)   | 3,612,855.90 → **3,612,273.00** (−582.90)   |
| `steady-saver` / stochastic  | 751,720.19 → **753,148.29** (+1,428.10) | 4,137,645.60 → **4,136,268.20** (−1,377.40) |
| `steady-saver` / historical  | 767,332.24 → **767,944.99** (+612.75)   | 3,512,387.39 → **3,511,580.07** (−807.32)   |
| `time-binding-mixed` / fixed | 745,153.12 → **751,744.07** (+6,590.95) | 2,409,407.30 → **2,402,816.36** (−6,590.94) |
| `marginal-retiree` / fixed   | 121,386.23 → **121,386.23** (0)         | 0.00 → **0.00** (0)                         |
| `shortfall-repaid` / fixed   | 287,211.77 → **287,211.77** (0)         | 233,020.81 → **233,020.81** (0)             |

Corpus `a946a8dc…f801241` → **`1e002e8a…b4570fe`**.

**Why the movement is exactly this, and nothing else.** Three deflated amounts appear in these plans'
rows, and the year each one first binds explains the shape of each diff:

- `steady-saver` itemizes in some years, and its `deduction.saltCap.allowed` falls by $5,424.78
  across the run as the cap is deflated. From year 21 its $110,000 of wages exceed the deflated
  $200,000 Additional Medicare threshold, so `fica.wages.additionalMedicare` turns on (+$385.79
  across the run) — and the withholding that leaves the paycheque also shrinks the pre-tax
  contribution the plan's `save` rule makes from the surplus, which is why
  `incomeSources.taxDeductibleContributions` falls by the same $385.79 and taxable ordinary income
  rises by it. `niit.niitAmount` first becomes non-zero in year 25 ($78.70), when the deflated
  $200,000 base amount drops below the portfolio's investment income plus MAGI.
- `time-binding-mixed` has the largest taxable account of the four, so the deflated NIIT base binds
  much earlier — its `niit.threshold` falls from $200,000 to $177,697 by year 4 — and the run pays
  $6,590.95 more.
- `marginal-retiree` moves by exactly zero, and the reason is structural rather than lucky: it has
  **no** Social Security income and its `niit.netInvestmentIncome` is zero in every row, so no
  deflated threshold is ever compared against a non-zero amount. Its SALT and senior-deduction
  lines do not move either (it never itemizes, and its returns are all below the senior deduction's
  phase-down).
- `shortfall-repaid` also moves by exactly zero, verified the same way: it has no Social Security
  income, and although it holds investment income from year 13, its MAGI never exceeds the
  _deflated_ base amount in any of those years (max MAGI $90,899), so the NIIT line stays zero.

Each final-portfolio delta is slightly larger in magnitude than the tax delta because the tax is paid
out of the portfolio and stops compounding there — the same mechanism documented under P3-P8.
`success` is unchanged for every fixture, including the two that are `false` by design.
