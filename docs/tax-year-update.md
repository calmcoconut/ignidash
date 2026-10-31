# Annual Tax Data Update Drill (January Protocol)

This document describes the annual procedure for updating federal and California tax parameters in Ignidash.

## Overview

The simulation engine evaluates future years using the latest vendored ruleset (`LATEST_TAX_YEAR`, currently 2026 federal and 2025 California). Indexed tables are preserved in real terms, and fixed statutory tables (NIIT, §86, Additional Medicare, §121) are deflated to today's dollars using the simulation's inflation assumptions.

Every January, when new calendar-year figures take effect, update the vendored rulesets to reflect newly published IRS and California FTB guidance.

---

## Timeline of Releases

1. **October / November**:
   - The IRS issues its annual inflation-adjustment Revenue Procedure for the upcoming tax year (e.g., Rev. Proc. 2024-40 for 2025, 2025-32 for 2026).
   - The Social Security Administration announces the OASDI maximum wage base in the Federal Register (typically late October/early November).
   - The IRS issues the ACA Applicable Percentage and Federal Poverty Line table in a separate Rev. Proc. (e.g., Rev. Proc. 2025-25).
2. **Late Autumn / December**:
   - California Franchise Tax Board publishes indexed brackets, exemption credits, and standard deductions for the current tax year in the FTB 540 instructions.
   - California EDD publishes the upcoming calendar year SDI employee contribution rate.

---

## Step-by-Step Update Procedure

### Step 1: Validate Current Baseline

Ensure the current test suite and rulesets pass:

```bash
npm run typecheck
npm run test:once
npx tsx scripts/vendor-tax-rules.ts --check
```

### Step 2: Cross-Check Against PolicyEngine-US

Update or pull the latest PolicyEngine-US reference parameters:

- Pinned reference repository: `https://github.com/PolicyEngine/policyengine-us`
- Compare bracket thresholds, standard deductions, and social security caps against official IRS bulletins.

### Step 3: Add the New Federal Ruleset

1. Create `src/lib/calc/tax-data/years/<YYYY>.ts`.
2. Populate:
   - `incomeTaxBrackets` (IRC § 1)
   - `capitalGainsTaxBrackets` (IRC § 1(h))
   - `standardDeductions` (IRC § 63(c))
   - `alternativeMinimumTax` exemptions and phaseout thresholds (IRC § 55)
   - `payrollTaxRates` and `socialSecurityWageBase` (SSA determination)
   - Ensure every `indexing: 'fixed'` table includes an explicit `dollarFields` array.
   - Add source citations to the specific IRS Revenue Procedure or Federal Register volume/page.

### Step 4: Add the New California Ruleset

1. Create `src/lib/calc/tax-data/states/CA/<YYYY>.ts`.
2. Populate:
   - `incomeTaxBrackets` (California FTB 540)
   - `standardDeductions`
   - `exemptionCredits`
   - `californiaSdi` rate (California EDD)
   - Disallowed deductions and conformity settings.

### Step 5: Register in `src/lib/calc/tax-data/index.ts`

1. Import the new rulesets.
2. Register them in `FEDERAL_RULESETS` or `CALIFORNIA_RULESETS`.
3. `LATEST_TAX_YEAR` automatically updates to `Math.max(...FEDERAL_RULESETS.keys())`.

### Step 6: Verify and Run Golden Regression Net

```bash
npm run typecheck
npm run lint
npm run test:once
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json
```

If any golden fixture moved because the new year's rates took effect for that plan, document each moved fixture in `src/lib/calc/__tests__/golden/README.md`.
