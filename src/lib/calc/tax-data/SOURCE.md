# Tax Data Sources and Citations

This directory houses the deterministic rulesets used by the simulation engine (`src/lib/calc/taxes.ts`).

---

## Federal Sources & Authorities

All federal tables live under `years/<year>.ts` (currently `years/2026.ts`). Fourteen tables live
there — `FederalTaxTables` in `types.ts` — and every one is documented below. Two tables the same
engine reads live in their own modules and are documented here too: the SALT cap (`salt-cap.ts`,
§ 7) and the ACA premium-tax-credit table (`aca.ts`, § 8).

### 1. Income Tax Brackets & Standard Deduction

- **Statutory Authority**: IRC § 1(j), IRC § 63(c).
- **IRS Guidance**: IRS Rev. Proc. 2024-40 (tax year 2025 adjustments); IRS 2026 inflation adjustments (including OBBBA amendments).
- **Indexing**: `'indexed'`. Indexed annually by Chained CPI-U (C-CPI-U).

### 2. Net Investment Income Tax (NIIT)

- **Statutory Authority**: IRC § 1411 (added by ACA § 1402).
- **Thresholds**: $200,000 (single), $250,000 (MFJ), $125,000 (MFS).
- **Indexing**: `'fixed'`. Fixed by statute without cost-of-living adjustments. Fisher-deflated to real dollars over projection horizons via `tax-data/real-dollars.ts`.

### 3. Additional Medicare Tax & FICA

- **Statutory Authority**: IRC § 3101(b)(2) (0.9% Additional Medicare), IRC § 3101(a) (6.2% OASDI), IRC § 3101(b)(1) (1.45% Medicare HI).
- **OASDI Wage Base**: $184,500 (2026 determination, 90 FR 49047, Nov 3, 2025).
- **Self-Employment Tax**: IRC § 1402 (92.35% net earnings base, half deductible under § 164(f)).
- **Thresholds**: $200,000 (single), $250,000 (MFJ), $125,000 (MFS).
- **Indexing**: OASDI wage base is indexed; Additional Medicare thresholds are `'fixed'`.

### 4. Social Security Benefit Taxation (§ 86)

- **Statutory Authority**: IRC § 86.
- **Base Amounts**:
  - Single: Tier 1 = $25,000 (50%), Tier 2 = $34,000 (85%).
  - MFJ: Tier 1 = $32,000 (50%), Tier 2 = $44,000 (85%).
  - MFS: $0 base amount (85% taxable from dollar 1 per § 86(c)(1)(C)).
- **Indexing**: `'fixed'`. Never adjusted for inflation by statute.

### 5. Alternative Minimum Tax (AMT)

- **Statutory Authority**: IRC §§ 55, 56.
- **Guidance**: IRS 2026 inflation adjustments. Exemption amounts: $90,100 (single), $140,200 (MFJ), $70,100 (MFS). Phase-out begins at $500,000 (single, head of household and MFS) and $1,000,000 (MFJ).
- **Indexing**: `'indexed'`.

### 6. Capital Gains Rates & § 121 Primary Residence Exclusion

- **Statutory Authority**: IRC § 1(h) (0%/15%/20% preferential brackets), IRC § 121 ($250,000 single / $500,000 MFJ exclusion).
- **Indexing**: Capital gains brackets are `'indexed'`; § 121 exclusion is `'fixed'`.

### 7. SALT Cap and Phase-Down

- **Statutory Authority**: IRC § 164(b)(7) (enacted under P.L. 119-21).
- **Caps for 2026**: $40,400 (single/MFJ), $20,200 (MFS).
- **Phase-Down**: Phases down by $0.30 per $1 of MAGI over $505,000 ($252,500 MFS) to a floor of $10,000 for every filing status — the floor is deliberately **not** halved for a separate return (only the cap and the phase-down threshold are; see `salt-cap.ts`).

### 8. ACA Premium Tax Credit (IRC § 36B)

- **Statutory Authority**: IRC § 36B.
- **What is vendored**: `aca.ts` carries one applicable-percentage schedule per coverage year it
  prices — 2024 through 2027 — together with the poverty line that coverage year uses. Each coverage
  year has its own row; nothing is one table copied forward.
- **Guidance (percentages only)**: coverage years 2024 and 2025 use the ARPA-enhanced schedule
  (§ 36B(b)(3)(A) as amended by the American Rescue Plan Act § 9661, plus the 8.5%-above-400 % rule
  of § 36B(i)), which is statutory and not indexed. From 2026 the schedule is the pre-ARPA one,
  indexed for the coverage year by § 36B(b)(3)(B) and published in that year's revenue procedure:
  Rev. Proc. 2025-25 (2025-32 I.R.B. 311) § 3.01 is the tax-year-2026 table (2.10% / 3.14% / 4.19% /
  6.60% / 8.44% / 9.96%, ceiling 400% FPL) with § 3.02's 9.96% required contribution percentage, and
  Rev. Proc. 2026-26 is the tax-year-2027 table: § 3.01's bands are 2.15 / 3.23–4.30 / 4.30–6.78 /
  6.78–8.66 / 8.66–10.22 / 10.22 %, with § 3.02's required contribution percentage 10.22%. A revenue
  procedure carries percentages only, **never** poverty lines.
- **Poverty lines**: the HHS annual poverty guidelines, published in the Federal Register, and one
  guidelines year behind its coverage year (IRC § 36B(d)(3)(B)): 88 FR 3424 (2023 guidelines) for
  coverage 2024, 89 FR 2961 (2024 guidelines) for coverage 2025, 90 FR 5917 (2025 guidelines, $15,650
  for the 48 contiguous states plus $5,500 for each additional person) for coverage 2026, and
  91 FR 1797 (2026 guidelines) for coverage 2027.
- **Income bands**: 100% to 400% FPL; 400% statutory cliff reinstated for 2026 post-ARPA/IRA sunset.

### 9. Retirement Account Rules

- **Traditional IRA Basis & Pro-Rata**: IRC § 408(d)(2), Form 8606 Part I.
- **Qualified Charitable Distributions (QCD)**: IRC § 408(d)(8), SECURE 2.0 indexing ($108,000 for 2026).
- **Substantially Equal Periodic Payments (SEPP)**: IRC § 72(t)(2)(A)(iv), IRS Notice 2022-6 (RMD, amortization, annuitization methods).
- **Roth 5-Year Clocks & Early Penalties**: IRC § 408A(d), IRC § 72(t).
- **HSA Qualified Medical Distributions**: IRC § 223(f)(1), IRC § 223(f)(4) (20% penalty under 65).

### 10. Medicare IRMAA (Parts B and D)

- **Statutory Authority**: 42 U.S.C. § 1395r(i).
- **Guidance**: CMS, "2026 Medicare Parts A & B Premiums and Deductibles" (Nov 14, 2025): a $202.90/month standard Part B premium, with income-related Part B adjustments of $0.00 / $81.20 / $202.90 / $324.60 / $446.30 / $487.00 and Part D adjustments of $0.00 / $14.50 / $37.50 / $60.40 / $83.30 / $91.00 per month.
- **Tier boundaries**: the columns are **not** one doubled and halved — the top boundary is $750,000 joint, not 2 × $500,000, so only the first four boundaries double or halve:

  | filing status                      | boundaries                                           |
  | ---------------------------------- | ---------------------------------------------------- |
  | individual (and head of household) | $109,000 / $137,000 / $171,000 / $205,000 / $500,000 |
  | joint return                       | $218,000 / $274,000 / $342,000 / $410,000 / $750,000 |
  | separate return                    | $109,000 / $137,000 / $171,000 / $205,000 / $375,000 |

  The same six monthly adjustment amounts apply in all three columns (see the comment above `medicareIrmaa` in `years/2026.ts`, and 42 U.S.C. § 1395r(i)(3), which halves the joint thresholds for a separate return).

- **Lookback**: the tier is set from the return filed two years earlier (`lookbackYears: 2`).
- **Indexing**: `'indexed'`.

### 11. Senior Deduction (temporary, IRC § 151(d)(5)(C))

- **Statutory Authority**: IRC § 151(d)(5)(C), added by P.L. 119-21 § 70103.
- **Amount**: $6,000 for each qualified individual aged 65+, reduced by 6% of MAGI over $75,000 ($150,000 joint, $75,000 separate), for taxable years beginning before January 1, 2029. A separate return is declared ineligible: the paragraph denies the deduction where the individual's spouse also claims it, which a pair of separate returns cannot be checked for.
- **Indexing**: `'fixed'`.

### 12. Medical-Expense Floor (IRC § 213(a))

- **Statutory Authority**: IRC § 213(a): the medical-expense deduction is limited to expenses above 7.5% of adjusted gross income.
- **Indexing**: `'fixed'`. The 7.5% is a rate — a share of AGI, not a dollar amount — so inflation never touches it.

### 13. Capital-Loss Deduction Limit (IRC § 1211(b))

- **Statutory Authority**: IRC § 1211(b): a net capital loss is deductible against ordinary income up
  to $3,000 a year generally and $1,500 on a married-filing-separately return; any excess carries
  forward to later years.
- **Amounts**: $3,000 (single, joint, head of household) and $1,500 (separate).
- **Indexing**: `'fixed'`, with `dollarFields: ['$']` — the values themselves are the
  filing-status-keyed dollar amounts. Fixed by statute, so the engine deflates it into today's
  dollars for a simulation year past 2026, the way every `fixed` table is deflated: by 2057
  (2057 is 31 years after the 2026 ruleset) it is about $1,200, not $3,000. That erosion is
  intended — the statute never indexes the allowance — but it means a long projection deducts
  less per year than the familiar figure.

---

## California Sources & Authorities

All California tables live under `states/CA/<year>.ts` (currently `states/CA/2025.ts`). Six tables
live there (`CaliforniaTaxTables` in `types.ts`) and every one is documented below; state
disability insurance is a separate module, `california-sdi.ts`, documented under § 2.

### 1. Personal Income Tax Brackets & Exemption Credits

- **Source**: California Franchise Tax Board (FTB) 2025 California Tax Rate Schedules (Form 540 Booklet).
- **Mental Health Services Tax**: California Proposition 63 (1% surcharge on taxable income exceeding $1,000,000, unindexed).

### 2. State Disability Insurance (CA SDI)

- **Source**: California Employment Development Department (EDD).
- **Rate**: 1.3% (tax year 2026), 1.2% (tax year 2025). No taxable wage ceiling since SB 951 (effective 2024). Not assessed on self-employment income.

### 3. California Non-Conformity

- **HSA**: California does not conform to IRC § 223. Contributions are not deductible, annual interest and dividend earnings are taxable annually, and distributions are returns of basis.
- **Early Withdrawal Penalty**: FTB 3805P imposes an additional 2.5% penalty on early distributions from qualified retirement plans.
- **Social Security**: California fully excludes Social Security benefits from state income tax (RTC § 17087).
- **Capital Gains**: California taxes all net capital gains as ordinary income (no preferential rate).

### 4. Itemized Deduction Limitation

- **Source**: 2025 Schedule CA (540), Part II, line 29 and its Itemized Deductions Worksheet.
- **Limitation**: the itemized deduction is reduced by 6% of federal AGI over $252,203 (single and
  separate) / $504,411 (joint) / $378,310 (head of household), capped at 80% of the deduction.
- **Disallowed lines**: the Schedule disallows the state income tax, SDI and general sales tax
  lines; property tax stays deductible.
- **Indexing**: `'indexed'`.
