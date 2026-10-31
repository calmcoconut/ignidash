import { describe, expect, it } from 'vitest';

import { applicablePercentageAt, calculatePremiumTaxCredit, type AcaPremiumTaxCreditInputs } from './aca-premium-tax-credit';
import {
  ACA_TABLE_YEARS,
  getAcaTable,
  PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS,
  PRE_ARPA_ELIGIBILITY_BOUNDS,
  povertyLineForSize,
  type AcaYearTable,
} from './tax-data/aca';

/**
 * ACA premium tax credit (parity plan P3-P7b).
 *
 * Every expected number below is worked out in a comment from the vendored tables, so a change to
 * a table shows up as a failing assertion with the arithmetic beside it rather than as a mystery
 * diff. Coverage year 2025 is used unless a test says otherwise, and by IRC §36B(d)(3)(B) its
 * poverty line is the **2024** guideline:
 *
 *   FPL for coverage 2025 (2024 guidelines), one person = $15,060
 *   two people = $20,440
 *   ARPA schedule         = 0 % ≤150 %, 2 % at 200 %, 4 % at 250 %, 6 % at 300 %, 8.5 % at 400 %+
 *   ARPA bounds           = 100 % to ∞ (the 400 % cliff is suspended for 2021–2025)
 *
 * The 2026 and 2027 tables are the other pairing worth holding on to: the 2025 guidelines ($15,650)
 * with the pre-ARPA percentages Rev. Proc. 2025-25 indexes for 2026, and the 2026 guidelines
 * ($15,960) with the tax-year-2027 table from Rev. Proc. 2026-26 §3.01 — the 400 % cliff is in force
 * in both.
 */

const ONE_PERSON_FPL = 15_060;
const TWO_PERSON_FPL = 20_440;

const credit = (overrides: Partial<AcaPremiumTaxCreditInputs> = {}, ruleset?: AcaYearTable) =>
  calculatePremiumTaxCredit(
    {
      householdIncome: ONE_PERSON_FPL,
      householdSize: 1,
      taxYear: 2025,
      slcspPremium: 9_000,
      ...overrides,
    },
    ruleset
  );

/** The pre-ARPA schedule and 400 % cliff, on coverage year 2025's poverty line, as a shape fixture. */
const PRE_ARPA_ON_2025_TABLE: AcaYearTable = {
  ...getAcaTable(2025),
  applicablePercentages: {
    values: PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS,
    indexing: 'fixed',
    source: 'IRC §36B(b)(3)(A), 2014 base-year text.',
  },
  eligibility: {
    values: PRE_ARPA_ELIGIBILITY_BOUNDS,
    indexing: 'fixed',
    source: 'IRC §36B(c)(1)(A).',
  },
};

describe('the tables', () => {
  it('carries exactly the years it can cite, resolves a later year to the newest row, and refuses an earlier one', () => {
    expect([...ACA_TABLE_YEARS]).toStrictEqual([2024, 2025, 2026, 2027]);

    // A coverage year past the last vendored row is priced by the nearest prior row, the way
    // `getRules` resolves a year that has no ruleset of its own — and the resolved year is the row's
    // own `year`, which is what the result reports back.
    expect(getAcaTable(2028)).toBe(getAcaTable(2027));
    expect(getAcaTable(2028).year).toBe(2027);
    expect(credit({ taxYear: 2028 }).resolvedYear).toBe(2027);
    expect(credit({ taxYear: 2028 }).povertyLine).toBe(15_960); // the 2026 guidelines, not 2028's
    expect(credit({ taxYear: 2026 }).resolvedYear).toBe(2026);

    // Before the first table there is nothing to fall back to, so that still fails loudly rather
    // than inventing a poverty line.
    expect(() => getAcaTable(2023)).toThrow(/No ACA premium-tax-credit table for 2023 or any earlier year/);
    expect(() => credit({ taxYear: 2023 })).toThrow(/No ACA premium-tax-credit table for 2023/);
  });

  it('pairs each coverage year with the previous year’s guidelines (§36B(d)(3)(B))', () => {
    // The line in force is the one published before open enrollment, which for coverage year N
    // began on the previous 1 November — so the row keyed N carries the N−1 guidelines.
    const guidelinesByCoverageYear = [
      [2024, 14_580, 5_140],
      [2025, 15_060, 5_380],
      [2026, 15_650, 5_500],
      [2027, 15_960, 5_680],
    ] as const;

    for (const [coverageYear, baseAmount, perAdditionalPerson] of guidelinesByCoverageYear) {
      const { values, source } = getAcaTable(coverageYear).povertyGuideline;

      expect(values.baseAmount).toBe(baseAmount);
      expect(values.perAdditionalPerson).toBe(perAdditionalPerson);
      // The row's own provenance names the guidelines year, so the off-by-one cannot come back.
      expect(source).toContain(`${coverageYear - 1} guidelines`);
    }
  });

  it('cites a Federal Register page on every poverty guideline, with the right volume and page per year', () => {
    // The dollars and the citation are two separate facts and only the dollars used to be pinned: the
    // 2025 row shipped `89 FR 1459` for what is `89 FR 2961` (the 2024 civilian HHS notice, FR Doc
    // 2024-00796, 89 FR 2961–2963, Jan 17 2024) and nothing failed. Every row must carry a citation,
    // and the exact one, so a wrong volume or page cannot pass silently again.
    const expectedCitationByCoverageYear = [
      [2024, '88 FR 3424'],
      [2025, '89 FR 2961'],
      [2026, '90 FR 5917'],
      [2027, '91 FR 1797'],
    ] as const;

    for (const year of ACA_TABLE_YEARS) {
      expect(getAcaTable(year).povertyGuideline.source).toMatch(/\b\d+ FR \d+\b/);
    }

    for (const [coverageYear, citation] of expectedCitationByCoverageYear) {
      expect(getAcaTable(coverageYear).povertyGuideline.source).toContain(`${citation} (`);
    }
  });

  it('declares an indexing mode and a source on every table', () => {
    for (const year of ACA_TABLE_YEARS) {
      const table = getAcaTable(year);
      for (const meta of [table.povertyGuideline, table.applicablePercentages, table.eligibility]) {
        expect(meta.source.length).toBeGreaterThan(0);
        expect(['indexed', 'fixed']).toContain(meta.indexing);
      }
      expect(table.povertyGuideline.indexing).toBe('indexed');
    }
  });

  it('builds the poverty line from the published base and increment', () => {
    const { values } = getAcaTable(2025).povertyGuideline;

    expect(povertyLineForSize(values, 1)).toBe(ONE_PERSON_FPL);
    expect(povertyLineForSize(values, 2)).toBe(TWO_PERSON_FPL); // 15,060 + 5,380
    expect(povertyLineForSize(values, 3)).toBe(25_820); // 15,060 + 2 × 5,380
    // A nonsense size still resolves to a real household rather than a zero line.
    expect(povertyLineForSize(values, 0)).toBe(ONE_PERSON_FPL);
  });

  it('has contiguous bands, and the continuity the law actually has', () => {
    const arpa = getAcaTable(2025).applicablePercentages.values;
    const preArpa = PRE_ARPA_APPLICABLE_PERCENTAGE_BANDS;

    // Contiguity holds for both: each band starts where the previous one ends.
    for (const schedule of [arpa, preArpa]) {
      for (let index = 1; index < schedule.length; index++) {
        expect(schedule[index].minFplPercent).toBe(schedule[index - 1].maxFplPercent);
      }
    }

    // The ARPA schedule is continuous as well: each band ends on the next one's starting share.
    for (let index = 1; index < arpa.length; index++) {
      expect(arpa[index].startRate).toBeCloseTo(arpa[index - 1].endRate, 12);
    }

    // The pre-ARPA table is **not** continuous at 133 %: §36B(b)(3)(A) takes the share from 2 %
    // (at or below 133 %) to 3 % (the foot of the 133–150 % tier). That step is the statute's, and
    // a test that smoothed it out would hide a real jump in the credit.
    const atOneThirtyThree = preArpa.filter((band) => band.minFplPercent === 133)[0];
    const belowOneThirtyThree = preArpa.filter((band) => band.minFplPercent === 100)[0];
    expect(belowOneThirtyThree.endRate).toBeCloseTo(0.02, 12);
    expect(atOneThirtyThree.startRate).toBeCloseTo(0.03, 12);
  });
});

describe('eligibility bounds', () => {
  it('grants nothing just below the lower bound, and everything the formula allows at it', () => {
    // 99 % of $15,060 = $14,909.40: below the 100 % floor, so no credit at all.
    const below = credit({ householdIncome: 14_909.4 });
    expect(below.eligible).toBe(false);
    expect(below.credit).toBe(0);
    expect(below.fplPercent).toBeCloseTo(99, 10);

    // Exactly 100 %: $15,060 at the 0 % band → contribution 0 → credit = SLCSP = $9,000.
    const at = credit({ householdIncome: ONE_PERSON_FPL });
    expect(at.eligible).toBe(true);
    expect(at.applicablePercentage).toBe(0);
    expect(at.requiredContribution).toBe(0);
    expect(at.credit).toBe(9_000);
  });

  it('keeps paying above 400 % of the FPL in 2025, because the cliff is suspended', () => {
    // 400 % of $15,060 = $60,240 → 8.5 % → contribution 0.085 × 60,240 = $5,120.40
    // → credit 9,000 − 5,120.40 = $3,879.60.
    const atFourHundred = credit({ householdIncome: 60_240 });
    expect(atFourHundred.eligible).toBe(true);
    expect(atFourHundred.applicablePercentage).toBeCloseTo(0.085, 12);
    expect(atFourHundred.requiredContribution).toBeCloseTo(5_120.4, 10);
    expect(atFourHundred.credit).toBeCloseTo(3_879.6, 10);

    // 500 % = $75,300: still 8.5 % → $6,400.50 → credit $2,599.50. No cliff in 2025.
    const atFiveHundred = credit({ householdIncome: 75_300 });
    expect(atFiveHundred.eligible).toBe(true);
    expect(atFiveHundred.requiredContribution).toBeCloseTo(6_400.5, 10);
    expect(atFiveHundred.credit).toBeCloseTo(2_599.5, 10);
  });

  it('drops the credit off the 400 % cliff under the pre-ARPA rules', () => {
    // At exactly 400 % ($60,240) the 9.5 % band applies: contribution 0.095 × 60,240 = $5,722.80
    // → credit 9,000 − 5,722.80 = $3,277.20.
    const atCliff = credit({ householdIncome: 60_240 }, PRE_ARPA_ON_2025_TABLE);
    expect(atCliff.eligible).toBe(true);
    expect(atCliff.applicablePercentage).toBeCloseTo(0.095, 12);
    expect(atCliff.requiredContribution).toBeCloseTo(5_722.8, 10);
    expect(atCliff.credit).toBeCloseTo(3_277.2, 10);

    // $60 more (400.40 %) and the credit is gone: the whole $3,277.20 disappears at the cliff.
    const overCliff = credit({ householdIncome: 60_300 }, PRE_ARPA_ON_2025_TABLE);
    expect(overCliff.eligible).toBe(false);
    expect(overCliff.credit).toBe(0);
    expect(overCliff.creditBeforePremiumCap).toBe(0);
  });

  it('enforces the 2026 table on the 2025 guidelines, with the 400 % cliff', () => {
    // Coverage year 2026 → 2025 HHS guidelines (90 FR 5917): 1 person = $15,650, so 400 % = $62,600.
    // At 400 %, applicable percentage is 9.96 % (Rev. Proc. 2025-25 §3.01).
    // Required contribution = 62,600 × 0.0996 = 6,234.96.
    // SLCSP = 9,000 -> credit = 9,000 - 6,234.96 = 2,765.04.
    const atCliff2026 = calculatePremiumTaxCredit({
      householdIncome: 62_600,
      householdSize: 1,
      taxYear: 2026,
      slcspPremium: 9_000,
    });
    expect(atCliff2026.eligible).toBe(true);
    expect(atCliff2026.applicablePercentage).toBeCloseTo(0.0996, 6);
    expect(atCliff2026.requiredContribution).toBeCloseTo(6_234.96, 3);
    expect(atCliff2026.credit).toBeCloseTo(2_765.04, 3);

    // Over 400% ($62,601): cliff bites, credit = 0, eligible = false
    const overCliff2026 = calculatePremiumTaxCredit({
      householdIncome: 62_601,
      householdSize: 1,
      taxYear: 2026,
      slcspPremium: 9_000,
    });
    expect(overCliff2026.eligible).toBe(false);
    expect(overCliff2026.credit).toBe(0);
  });

  it('enforces the 2027 table: 2026 guidelines, Rev. Proc. 2026-26 §3.01, and the 400 % cliff', () => {
    // Coverage year 2027 → the 2026 HHS guidelines (91 FR 1797): 1 person = $15,960, so 400 % = $63,840.
    // At 400 % the tax-year-2027 table's flat top rate applies, and it is also §3.02's required
    // contribution percentage for 2027: 10.22 %.
    // Required contribution = 63,840 × 0.1022 = 6,524.448.
    // SLCSP = 9,000 → credit = 9,000 − 6,524.448 = 2,475.552.
    expect(getAcaTable(2027).povertyGuideline.values.baseAmount).toBe(15_960);
    const atCliff2027 = calculatePremiumTaxCredit({
      householdIncome: 63_840,
      householdSize: 1,
      taxYear: 2027,
      slcspPremium: 9_000,
    });
    expect(atCliff2027.resolvedYear).toBe(2027);
    expect(atCliff2027.eligible).toBe(true);
    expect(atCliff2027.applicablePercentage).toBeCloseTo(0.1022, 6);
    expect(atCliff2027.requiredContribution).toBeCloseTo(6_524.448, 3);
    expect(atCliff2027.credit).toBeCloseTo(2_475.552, 3);

    // One dollar over the cliff ($63,841) and the credit is gone entirely.
    const overCliff2027 = calculatePremiumTaxCredit({
      householdIncome: 63_841,
      householdSize: 1,
      taxYear: 2027,
      slcspPremium: 9_000,
    });
    expect(overCliff2027.eligible).toBe(false);
    expect(overCliff2027.credit).toBe(0);
  });
});

describe('the applicable-percentage bands', () => {
  it('is continuous across a band boundary', () => {
    const bands = getAcaTable(2025).applicablePercentages.values;

    // 200 % of the FPL is where the 150–200 % band ends and the 200–250 % band begins. Both sides
    // must give 2 %, so the credit cannot jump because income crossed a tier.
    expect(applicablePercentageAt(bands, 199.999999)).toBeCloseTo(0.02, 8);
    expect(applicablePercentageAt(bands, 200)).toBeCloseTo(0.02, 12);
    expect(applicablePercentageAt(bands, 200.000001)).toBeCloseTo(0.02, 8);

    // 250 % = $37,650: contribution 0.04 × 37,650 = $1,506 → credit 9,000 − 1,506 = $7,494.
    const atTwoHundredFifty = credit({ householdIncome: 37_650 });
    expect(atTwoHundredFifty.applicablePercentage).toBeCloseTo(0.04, 12);
    expect(atTwoHundredFifty.requiredContribution).toBeCloseTo(1_506, 10);
    expect(atTwoHundredFifty.credit).toBeCloseTo(7_494, 10);

    // A dollar either side of the boundary moves the credit by well under a dollar, not by a tier.
    // (The marginal cost of income is steep near a boundary — the contribution grows with both the
    // rate and the income — but it stays continuous.)
    const justBelow = credit({ householdIncome: 37_649 });
    const justAbove = credit({ householdIncome: 37_651 });
    expect(Math.abs(justAbove.credit - justBelow.credit)).toBeLessThan(1);
  });

  it('interpolates linearly inside a band', () => {
    const bands = getAcaTable(2025).applicablePercentages.values;

    // Halfway through 150–200 % the share is halfway from 0 % to 2 %.
    expect(applicablePercentageAt(bands, 175)).toBeCloseTo(0.01, 12);
    // 225 % is halfway through 200–250 %, from 2 % to 4 %.
    expect(applicablePercentageAt(bands, 225)).toBeCloseTo(0.03, 12);
  });

  it('carries the tax-year-2027 indexation from Rev. Proc. 2026-26 §3.01, not a reused 2026 table', () => {
    const bands = getAcaTable(2027).applicablePercentages.values;

    // The 2027 row has its own published table, so it must not be the same object the 2026 row carries.
    expect(bands).not.toBe(getAcaTable(2026).applicablePercentages.values);

    // §3.01 for 2027, read at each tier's own boundaries (initial → final):
    // 2.15 flat ≤133 %, 3.23 → 4.30 % (133–150), 4.30 → 6.78 % (150–200),
    // 6.78 → 8.66 % (200–250), 8.66 → 10.22 % (250–300), 10.22 flat to the 400 % cliff.
    expect(applicablePercentageAt(bands, 100)).toBeCloseTo(0.0215, 12);
    expect(applicablePercentageAt(bands, 133)).toBeCloseTo(0.0215, 12);
    expect(applicablePercentageAt(bands, 150)).toBeCloseTo(0.043, 12);
    expect(applicablePercentageAt(bands, 200)).toBeCloseTo(0.0678, 12);
    expect(applicablePercentageAt(bands, 250)).toBeCloseTo(0.0866, 12);
    expect(applicablePercentageAt(bands, 300)).toBeCloseTo(0.1022, 12);
    expect(applicablePercentageAt(bands, 400)).toBeCloseTo(0.1022, 12);

    // The tiers are contiguous, and the step at 133 % (2.15 % → 3.23 %) is the statute's, as in the
    // 2014 base text: a test that smoothed it out would hide a real jump in the credit.
    for (let index = 1; index < bands.length; index++) {
      expect(bands[index].minFplPercent).toBe(bands[index - 1].maxFplPercent);
    }
    expect(applicablePercentageAt(bands, 133.000001)).toBeCloseTo(0.0323, 6);
  });
});

describe('the credit arithmetic', () => {
  it('computes a two-person household from the two-person poverty line', () => {
    // FPL 2 = $20,440; 250 % = $51,100; 4 % → contribution $2,044; SLCSP $12,000
    // → credit $9,956.
    const result = credit({ householdSize: 2, householdIncome: 51_100, slcspPremium: 12_000 });

    expect(result.povertyLine).toBe(TWO_PERSON_FPL);
    expect(result.fplPercent).toBeCloseTo(250, 10);
    expect(result.requiredContribution).toBeCloseTo(2_044, 10);
    expect(result.credit).toBeCloseTo(9_956, 10);
  });

  it('floors at zero when the required contribution exceeds the silver premium', () => {
    // 400 % ($60,240) needs $5,120.40 of contribution; a $5,000 silver plan is cheaper than that,
    // so the household owes its own premium and the credit is zero.
    const result = credit({ householdIncome: 60_240, slcspPremium: 5_000 });

    expect(result.eligible).toBe(true);
    expect(result.creditBeforePremiumCap).toBe(0);
    expect(result.credit).toBe(0);

    expect(credit({ slcspPremium: 0 }).credit).toBe(0);
  });

  it('caps the credit at the premium actually paid (§36B(b)(2))', () => {
    // At 100 % of the FPL the required contribution is 0, so the formula offers the whole $9,000
    // silver premium — but the household only paid $7,000 for its plan, and no more than that can
    // be credited.
    const result = credit({ actualPremium: 7_000 });

    expect(result.creditBeforePremiumCap).toBe(9_000);
    expect(result.credit).toBe(7_000);
    expect(result.cappedByActualPremium).toBe(true);

    // A premium above the silver benchmark does not raise the credit: the cap is a ceiling.
    const aboveBenchmark = credit({ actualPremium: 20_000 });
    expect(aboveBenchmark.credit).toBe(9_000);
    expect(aboveBenchmark.cappedByActualPremium).toBe(false);
  });

  it('is a pure function of its inputs', () => {
    const inputs = { householdIncome: 40_000, householdSize: 2, taxYear: 2025, slcspPremium: 11_000 };

    expect(calculatePremiumTaxCredit(inputs)).toStrictEqual(calculatePremiumTaxCredit(inputs));
    // The caller's object is never mutated.
    expect(inputs).toStrictEqual({ householdIncome: 40_000, householdSize: 2, taxYear: 2025, slcspPremium: 11_000 });
  });
});
