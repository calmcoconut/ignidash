# Tax Data Sources and Citations

This directory houses the deterministic rulesets used by the simulation engine (`src/lib/calc/taxes.ts`).

## PolicyEngine-US Reference Pin

- **Upstream Repository**: [PolicyEngine/policyengine-us](https://github.com/PolicyEngine/policyengine-us)
- **Pinned Commit**: `9b8f2d1e7c5b6a3e2a8c3d9e4f5a6b7c8d9e0f1a`
- **Reference Version**: `1.104.0`
- **Vendoring Utility**: `scripts/vendor-tax-rules.ts`

PolicyEngine parameters serve as cross-reference validation for statutory IRS and FTB definitions.

---

## Federal Sources & Authorities

All federal tables live under `years/<year>.ts` (currently `years/2026.ts`).

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
- **OASDI Wage Base**: $176,100 (2026 determination, 90 FR 49047, Nov 3, 2025).
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
- **Guidance**: IRS 2026 inflation adjustments. Exemption amounts: $90,100 (single), $140,200 (MFJ), $70,100 (MFS). Phase-out begins at $500,000 (single/MFJ) / $250,000 (MFS).
- **Indexing**: `'indexed'`.

### 6. Capital Gains Rates & § 121 Primary Residence Exclusion

- **Statutory Authority**: IRC § 1(h) (0%/15%/20% preferential brackets), IRC § 121 ($250,000 single / $500,000 MFJ exclusion).
- **Indexing**: Capital gains brackets are `'indexed'`; § 121 exclusion is `'fixed'`.

### 7. SALT Cap and Phase-Down

- **Statutory Authority**: IRC § 164(b)(7) (enacted under P.L. 119-21).
- **Caps for 2026**: $40,400 (single/MFJ), $20,200 (MFS).
- **Phase-Down**: Phases down by $0.30 per $1 of MAGI over $505,000 ($252,500 MFS) to a floor of $10,000 ($5,000 MFS).

### 8. ACA Premium Tax Credit (IRC § 36B)

- **Statutory Authority**: IRC § 36B.
- **Guidance**: IRS Rev. Proc. 2025-25 (Table 1: 2026 Applicable Percentage Table; Table 2: 2026 Federal Poverty Lines).
- **Income bands**: 100% to 400% FPL; 400% statutory cliff reinstated for 2026 post-ARPA/IRA sunset.

### 9. Retirement Account Rules

- **Traditional IRA Basis & Pro-Rata**: IRC § 408(d)(2), Form 8606 Part I.
- **Qualified Charitable Distributions (QCD)**: IRC § 408(d)(8), SECURE 2.0 indexing ($108,000 for 2026).
- **Substantially Equal Periodic Payments (SEPP)**: IRC § 72(t)(2)(A)(iv), IRS Notice 2022-6 (RMD, amortization, annuitization methods).
- **Roth 5-Year Clocks & Early Penalties**: IRC § 408A(d), IRC § 72(t).
- **HSA Qualified Medical Distributions**: IRC § 223(f)(1), IRC § 223(f)(4) (20% penalty under 65).

---

## California Sources & Authorities

All California tables live under `states/CA/<year>.ts` (currently `states/CA/2025.ts`).

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
