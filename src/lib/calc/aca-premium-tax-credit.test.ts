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
 * diff. The 2025 table is used unless a test says otherwise:
 *
 *   FPL 2025, one person  = $15,650      two people = $21,150
 *   ARPA schedule         = 0 % ≤150 %, 2 % at 200 %, 4 % at 250 %, 6 % at 300 %, 8.5 % at 400 %+
 *   ARPA bounds           = 100 % to ∞ (the 400 % cliff is suspended for 2021–2025)
 */

const ONE_PERSON_FPL_2025 = 15_650;
const TWO_PERSON_FPL_2025 = 21_150;

const credit = (overrides: Partial<AcaPremiumTaxCreditInputs> = {}, ruleset?: AcaYearTable) =>
  calculatePremiumTaxCredit(
    {
      householdIncome: ONE_PERSON_FPL_2025,
      householdSize: 1,
      taxYear: 2025,
      slcspPremium: 9_000,
      ...overrides,
    },
    ruleset
  );

/** The pre-ARPA schedule and 400 % cliff, on the 2025 poverty line, as a shape fixture. */
const PRE_ARPA_ON_2025_FPL: AcaYearTable = {
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
  it('carries exactly the years it can cite, and refuses the rest', () => {
    expect([...ACA_TABLE_YEARS]).toStrictEqual([2024, 2025, 2026]);

    // 2027 has no published table yet; borrowing either neighbour would be wrong.
    expect(() => getAcaTable(2027)).toThrow(/No ACA premium-tax-credit table for 2027/);
    expect(() => credit({ taxYear: 2027 })).toThrow(/No ACA premium-tax-credit table for 2027/);
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

    expect(povertyLineForSize(values, 1)).toBe(ONE_PERSON_FPL_2025);
    expect(povertyLineForSize(values, 2)).toBe(TWO_PERSON_FPL_2025); // 15,650 + 5,500
    expect(povertyLineForSize(values, 3)).toBe(26_650); // 15,650 + 2 × 5,500
    // A nonsense size still resolves to a real household rather than a zero line.
    expect(povertyLineForSize(values, 0)).toBe(ONE_PERSON_FPL_2025);
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
    // 99 % of $15,650 = $15,493.50: below the 100 % floor, so no credit at all.
    const below = credit({ householdIncome: 15_493.5 });
    expect(below.eligible).toBe(false);
    expect(below.credit).toBe(0);
    expect(below.fplPercent).toBeCloseTo(99, 10);

    // Exactly 100 %: $15,650 at the 0 % band → contribution 0 → credit = SLCSP = $9,000.
    const at = credit({ householdIncome: ONE_PERSON_FPL_2025 });
    expect(at.eligible).toBe(true);
    expect(at.applicablePercentage).toBe(0);
    expect(at.requiredContribution).toBe(0);
    expect(at.credit).toBe(9_000);
  });

  it('keeps paying above 400 % of the FPL in 2025, because the cliff is suspended', () => {
    // 400 % of $15,650 = $62,600 → 8.5 % → contribution 0.085 × 62,600 = $5,321
    // → credit 9,000 − 5,321 = $3,679.
    const atFourHundred = credit({ householdIncome: 62_600 });
    expect(atFourHundred.eligible).toBe(true);
    expect(atFourHundred.applicablePercentage).toBeCloseTo(0.085, 12);
    expect(atFourHundred.requiredContribution).toBeCloseTo(5_321, 10);
    expect(atFourHundred.credit).toBeCloseTo(3_679, 10);

    // 500 % = $78,250: still 8.5 % → $6,651.25 → credit $2,348.75. No cliff in 2025.
    const atFiveHundred = credit({ householdIncome: 78_250 });
    expect(atFiveHundred.eligible).toBe(true);
    expect(atFiveHundred.requiredContribution).toBeCloseTo(6_651.25, 10);
    expect(atFiveHundred.credit).toBeCloseTo(2_348.75, 10);
  });

  it('drops the credit off the 400 % cliff under the pre-ARPA rules', () => {
    // At exactly 400 % ($62,600) the 9.5 % band applies: contribution 0.095 × 62,600 = $5,947
    // → credit 9,000 − 5,947 = $3,053.
    const atCliff = credit({ householdIncome: 62_600 }, PRE_ARPA_ON_2025_FPL);
    expect(atCliff.eligible).toBe(true);
    expect(atCliff.applicablePercentage).toBeCloseTo(0.095, 12);
    expect(atCliff.credit).toBeCloseTo(3_053, 10);

    // $50 more (400.32 %) and the credit is gone: the whole $3,053 disappears at the cliff.
    const overCliff = credit({ householdIncome: 62_650 }, PRE_ARPA_ON_2025_FPL);
    expect(overCliff.eligible).toBe(false);
    expect(overCliff.credit).toBe(0);
    expect(overCliff.creditBeforePremiumCap).toBe(0);
  });

  it('enforces the statutory 2026 table and 400 % cliff from Rev. Proc. 2025-25', () => {
    // 2026 FPL 1 person = $15,960. 400% = $63,840.
    // At 400% ($63,840), applicable percentage is 9.96% (0.0996).
    // Required contribution = 63,840 * 0.0996 = 6,358.464.
    // SLCSP = 9,000 -> credit = 9,000 - 6,358.464 = 2,641.536.
    const atCliff2026 = calculatePremiumTaxCredit({
      householdIncome: 63_840,
      householdSize: 1,
      taxYear: 2026,
      slcspPremium: 9_000,
    });
    expect(atCliff2026.eligible).toBe(true);
    expect(atCliff2026.applicablePercentage).toBeCloseTo(0.0996, 6);
    expect(atCliff2026.requiredContribution).toBeCloseTo(6_358.464, 3);
    expect(atCliff2026.credit).toBeCloseTo(2_641.536, 3);

    // Over 400% ($63,841): cliff bites, credit = 0, eligible = false
    const overCliff2026 = calculatePremiumTaxCredit({
      householdIncome: 63_841,
      householdSize: 1,
      taxYear: 2026,
      slcspPremium: 9_000,
    });
    expect(overCliff2026.eligible).toBe(false);
    expect(overCliff2026.credit).toBe(0);
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

    // 250 % = $39,125: contribution 0.04 × 39,125 = $1,565 → credit 9,000 − 1,565 = $7,435.
    const atTwoHundredFifty = credit({ householdIncome: 39_125 });
    expect(atTwoHundredFifty.applicablePercentage).toBeCloseTo(0.04, 12);
    expect(atTwoHundredFifty.requiredContribution).toBeCloseTo(1_565, 10);
    expect(atTwoHundredFifty.credit).toBeCloseTo(7_435, 10);

    // A dollar either side of the boundary moves the credit by well under a dollar, not by a tier.
    // (The marginal cost of income is steep near a boundary — the contribution grows with both the
    // rate and the income — but it stays continuous.)
    const justBelow = credit({ householdIncome: 39_124 });
    const justAbove = credit({ householdIncome: 39_126 });
    expect(Math.abs(justAbove.credit - justBelow.credit)).toBeLessThan(1);
  });

  it('interpolates linearly inside a band', () => {
    const bands = getAcaTable(2025).applicablePercentages.values;

    // Halfway through 150–200 % the share is halfway from 0 % to 2 %.
    expect(applicablePercentageAt(bands, 175)).toBeCloseTo(0.01, 12);
    // 225 % is halfway through 200–250 %, from 2 % to 4 %.
    expect(applicablePercentageAt(bands, 225)).toBeCloseTo(0.03, 12);
  });
});

describe('the credit arithmetic', () => {
  it('computes a two-person household from the two-person poverty line', () => {
    // FPL 2 = $21,150; 250 % = $52,875; 4 % → contribution $2,115; SLCSP $12,000
    // → credit $9,885.
    const result = credit({ householdSize: 2, householdIncome: 52_875, slcspPremium: 12_000 });

    expect(result.povertyLine).toBe(TWO_PERSON_FPL_2025);
    expect(result.fplPercent).toBeCloseTo(250, 10);
    expect(result.requiredContribution).toBeCloseTo(2_115, 10);
    expect(result.credit).toBeCloseTo(9_885, 10);
  });

  it('floors at zero when the required contribution exceeds the silver premium', () => {
    // 400 % ($62,600) needs $5,321 of contribution; a $5,000 silver plan is cheaper than that,
    // so the household owes its own premium and the credit is zero.
    const result = credit({ householdIncome: 62_600, slcspPremium: 5_000 });

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
