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
   - The IRS issues the ACA applicable percentages in a separate Rev. Proc. (e.g., Rev. Proc. 2025-25). The Federal Poverty Lines come from HHS, in the annual Federal Register poverty-guideline notice.
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
npm run tax:validate
```

### Step 2: Compare Against the Published IRS / FTB Release

There is no fetcher and no vendoring: every figure is transcribed by hand from the primary release,
and the comparison is manual. Nothing here is generated, so review it as a data diff.

- Open the year's IRS Revenue Procedure (or the SSA Federal Register notice, CMS fact sheet, or FTB
  540 instructions) and name that document in the `source` of every table it fills.
- Check each amount in `years/<YYYY>.ts` against it: brackets, standard deduction, AMT exemption and
  phase-out, the OASDI wage base, the ACA applicable percentages, and (for California) the FTB
  brackets, standard deduction and exemption credits.
- [PolicyEngine-US](https://github.com/PolicyEngine/policyengine-us) is an independent open-source
  transcription you may read as a second opinion. It is not a source of record, no commit of it is
  pinned, and nothing in this repository is derived from it.

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
3. Document every table you add or change in `src/lib/calc/tax-data/SOURCE.md`, under the federal
   heading that covers it (one section per table), naming the authority and the release you
   transcribed. A table with no `SOURCE.md` section is undocumented data.

### Step 4: Add the New California Ruleset

1. Create `src/lib/calc/tax-data/states/CA/<YYYY>.ts`.
2. Populate:
   - `incomeTaxBrackets` (California FTB 540)
   - `standardDeductions`
   - `exemptionCredits`
   - `californiaSdi` rate (California EDD)
   - Disallowed deductions and conformity settings.
3. Document every table you add or change in `src/lib/calc/tax-data/SOURCE.md`, under the California
   heading that covers it — including the itemized-deduction limitation.

### Step 5: Register in `src/lib/calc/tax-data/index.ts`

1. Import the new rulesets.
2. Register them in `FEDERAL_RULESETS` or `CALIFORNIA_RULESETS`.
3. `LATEST_TAX_YEAR` automatically updates to `Math.max(...FEDERAL_RULESETS.keys())`.

### Step 6: Vendor the New ACA Coverage Year

`src/lib/calc/tax-data/aca.ts` prices one coverage year per row, and `ACA_TABLE_YEARS` lists the years
it can price. A plan that opts into the premium tax credit and is simulated past the last listed year
has no table, so extend both in the same change.

1. Add a row keyed by the **coverage** (tax) year, not the guidelines year: the poverty line a
   coverage year uses is the previous year's guidelines (IRC § 36B(d)(3)(B)).
2. Set its poverty line from the HHS Federal Register notice for that guidelines year, and name the
   citation in the row's `povertyGuideline.source`.
3. Set its applicable percentages from the revenue procedure that indexes that coverage year (Rev.
   Proc. 2025-25 for 2026, Rev. Proc. 2026-26 for 2027). A revenue procedure carries percentages
   only — the poverty lines never come from it.
4. Add the year to `ACA_TABLE_YEARS`.
5. Extend § 8 of `SOURCE.md` with the new row's two citations.

### Step 7: Verify and Run Golden Regression Net

```bash
npm run typecheck
npm run lint
npm run test:once
shasum -a 256 src/lib/calc/__tests__/golden/corpus.json
```

If any golden fixture moved because the new year's rates took effect for that plan, document each moved fixture in `src/lib/calc/__tests__/golden/README.md`.
