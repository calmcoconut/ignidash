/**
 * Vendored inputs for the §72(t) SEPP methods (IRS Notice 2022-6): the §1.401(a)(9)-9 Single Life
 * Table and the published monthly federal mid-term rates.
 *
 * `../retirement-rules/sepp` implements the three methods Notice 2022-6 accepts, but it takes the
 * distribution period and the interest rate as caller arguments — and nothing in the plan data
 * supplies either. Both are published tables, so they are vendored here, the way `tax-data/` vendors
 * the tax tables: as data with a citation per value, resolved through a function that refuses a
 * value it cannot cite rather than approximating one.
 *
 * ## 1. The Single Life Table — Treas. Reg. §1.401(a)(9)-9(b), Table 1
 *
 * Notice 2022-6 §3.02(a) says the required-minimum-distribution method **and** the fixed
 * amortization method take their distribution period from one of three tables: the Uniform Lifetime
 * Table (Appendix A to the notice), the Single Life Table in §1.401(a)(9)-9(b), or the Joint and
 * Last Survivor Table in §1.401(a)(9)-9(d). This module vendors the Single Life Table, because it is
 * the only one of the three that needs no second person's age: the engine's SEPP inputs are one
 * owner, one balance, one date. A caller who has a designated beneficiary's age can still pass an
 * explicit `distributionPeriod` to `seppAnnualAmount`, which is the parameterised path the tests
 * already exercise.
 *
 * The third method, fixed annuitization, is defined by the notice as an annuity factor built from
 * the §1.401(a)(9)-9(e) mortality **rates**, not from a life-expectancy table. The committed
 * implementation in `sepp.ts` divides the balance by an annuity-due factor over a distribution
 * period instead, so the period it needs is the same Single Life Table entry and no separate rate
 * table is vendored here. (A future rate-built factor needs the qx column of §1.401(a)(9)-9(e), a
 * third dataset — not this one.)
 *
 *   Reg. text: https://www.ecfr.gov/current/title-26/section-1.401(a)(9)-9
 *   As adopted: T.D. 9930, 85 FR 72472 (2020-11-12), "Updated Life Expectancy and Distribution
 *   Period Tables Used for Purposes of Determining Minimum Required Distributions"
 *   https://www.federalregister.gov/documents/2020/11/12/2020-24723/updated-life-expectancy-and-distribution-period-tables-used-for-purposes-of-determining-minimum
 *
 * §1.401(a)(9)-9(f)(1) makes the table apply to distribution calendar years beginning on or after
 * 1 January 2022. The table gives an explicit entry for ages 0 through 119 and a single "120+"
 * entry of 1.0, which is why `singleLifeExpectancy` treats 120 and above as the last row instead of
 * running off the end of the data.
 *
 * ## 2. The federal mid-term rate — IRC §1274(d), published monthly
 *
 * Notice 2022-6 §3.02(c) caps the rate a fixed method may use at the greater of 5 % or 120 % of the
 * §1274(d) federal mid-term rate "for either of the two months immediately preceding the month in
 * which the distribution begins". That rate is published **every month**, in a revenue ruling, so a
 * single vendored number would go stale silently within weeks. `MID_TERM_RATES` is therefore a dated
 * lookup keyed `YYYY-MM`, and an unknown month is a loud failure with the revision instruction —
 * never a fallback, never an interpolation, never a neighbouring month.
 *
 *   Rulings index: https://www.irs.gov/applicable-federal-rates
 *   Each month's ruling is cited on its row below; the value is the **annual**-compounding
 *   "Mid-term AFR" row of Table 1 in that ruling, expressed as a decimal (4.61 % → 0.0461).
 *   Annual compounding is the right reading here because the SEPP arithmetic discounts with annual
 *   periods (`(1 + r)^-n` in `seppAnnualAmount`), and Notice 2022-6's own examples are annual.
 *   Cross-check available: the IRS "Section 7520 interest rates" tables print 120 % of the same
 *   mid-term rate next to each month's ruling number, which is how the rows below were verified.
 *
 * Coverage: rates for 2021-11 through 2026-11. That is enough to price a series beginning in any
 * month from 2022-01 — Notice 2022-6 §4 supersedes the old guidance for series commencing on or
 * after 2023-01-01 and may be used for one commencing in 2022 — through 2026-12, since a series
 * beginning in month M prices off M−1 and M−2. A later start, or a month the IRS has not yet
 * published, fails in `federalMidTermRate` with the instruction to add it.
 *
 * ## Revision instructions
 *
 * - **Rates (monthly).** Each time the IRS publishes the next month's AFR ruling, append one row
 *   (`'YYYY-MM': 0.0xxx`) with the ruling number in its comment and advance
 *   `NEWEST_MID_TERM_RATE_MONTH`. Never delete an older month: a series that began in that month is
 *   still priced from it, and removing it turns a working calculation into a throw.
 * - **Single Life Table (per regulation change).** If §1.401(a)(9)-9(b) is ever re-issued with new
 *   factors, replace `SINGLE_LIFE_TABLE` wholesale — do not mix old and new rows, and do not patch a
 *   single age — and update the T.D. / Federal Register citation above. The table is `fixed` data:
 *   copy it forward byte-identical between re-issues.
 * - The mid-term rate row and the mortality table are independent: a rate change never touches the
 *   table, and a regulation change never touches the rates.
 *
 * Not vendored, deliberately:
 * - **The Joint and Last Survivor Table (§1.401(a)(9)-9(d))**, which Notice 2022-6 also allows for
 *   the RMD and fixed amortization methods. It is a 121×121 matrix indexed by two ages, and no SEPP
 *   input in this engine carries a beneficiary age, so vendoring it would be unused data. A caller
 *   with a beneficiary supplies the resulting period explicitly.
 * - **The Uniform Lifetime Table (Appendix A to Notice 2022-6)**, for the same reason: the fixed
 *   methods may use it, but it is a second choice of period, not an input the engine needs to
 *   compute a payment. Note it is already carried for RMDs at
 *   `src/lib/calc/historical-data/rmd-table.ts` (ages 72–120); it is not re-vendored or reused here,
 *   because that module is an age→factor map for the RMD withdrawal path and this one has to refuse
 *   an age it cannot cite.
 */

/** A calendar month a published rate is filed under, `YYYY-MM`. */
export type SeppRateMonth = string;

/**
 * The life expectancy in years for each attained age: Treas. Reg. §1.401(a)(9)-9(b), Table 1.
 *
 * Ages 0–119 are the table's own rows; key `120` is the regulation's "120+" row (1.0), which
 * `singleLifeExpectancy` applies to every age from 120 up. The factors are non-increasing in age.
 */
export const SINGLE_LIFE_TABLE: Readonly<Record<number, number>> = {
  0: 84.6,
  1: 83.7,
  2: 82.8,
  3: 81.8,
  4: 80.8,
  5: 79.8,
  6: 78.8,
  7: 77.9,
  8: 76.9,
  9: 75.9,
  10: 74.9,
  11: 73.9,
  12: 72.9,
  13: 71.9,
  14: 70.9,
  15: 69.9,
  16: 69.0,
  17: 68.0,
  18: 67.0,
  19: 66.0,
  20: 65.0,
  21: 64.1,
  22: 63.1,
  23: 62.1,
  24: 61.1,
  25: 60.2,
  26: 59.2,
  27: 58.2,
  28: 57.3,
  29: 56.3,
  30: 55.3,
  31: 54.4,
  32: 53.4,
  33: 52.5,
  34: 51.5,
  35: 50.5,
  36: 49.6,
  37: 48.6,
  38: 47.7,
  39: 46.7,
  40: 45.7,
  41: 44.8,
  42: 43.8,
  43: 42.9,
  44: 41.9,
  45: 41.0,
  46: 40.0,
  47: 39.0,
  48: 38.1,
  49: 37.1,
  50: 36.2,
  51: 35.3,
  52: 34.3,
  53: 33.4,
  54: 32.5,
  55: 31.6,
  56: 30.6,
  57: 29.8,
  58: 28.9,
  59: 28.0,
  60: 27.1,
  61: 26.2,
  62: 25.4,
  63: 24.5,
  64: 23.7,
  65: 22.9,
  66: 22.0,
  67: 21.2,
  68: 20.4,
  69: 19.6,
  70: 18.8,
  71: 18.0,
  72: 17.2,
  73: 16.4,
  74: 15.6,
  75: 14.8,
  76: 14.1,
  77: 13.3,
  78: 12.6,
  79: 11.9,
  80: 11.2,
  81: 10.5,
  82: 9.9,
  83: 9.3,
  84: 8.7,
  85: 8.1,
  86: 7.6,
  87: 7.1,
  88: 6.6,
  89: 6.1,
  90: 5.7,
  91: 5.3,
  92: 4.9,
  93: 4.6,
  94: 4.3,
  95: 4.0,
  96: 3.7,
  97: 3.4,
  98: 3.2,
  99: 3.0,
  100: 2.8,
  101: 2.6,
  102: 2.5,
  103: 2.3,
  104: 2.2,
  105: 2.1,
  106: 2.1,
  107: 2.1,
  108: 2.0,
  109: 2.0,
  110: 2.0,
  111: 2.0,
  112: 2.0,
  113: 1.9,
  114: 1.9,
  115: 1.8,
  116: 1.8,
  117: 1.6,
  118: 1.4,
  119: 1.1,
  120: 1.0,
};

/** The youngest age the Single Life Table states a row for (0 → 84.6 years). */
export const SINGLE_LIFE_TABLE_YOUNGEST_AGE = 0;

/** The oldest individually stated age (119 → 1.1 years); 120 and above use the "120+" row. */
export const SINGLE_LIFE_TABLE_OLDEST_AGE = 119;

/** The age key holding the regulation's "120+" terminal row (1.0 years). */
export const SINGLE_LIFE_TABLE_TERMINAL_AGE = 120;

/** Where the factors come from, for a caller that wants to cite them alongside a payment. */
export const SINGLE_LIFE_TABLE_SOURCE =
  'Treas. Reg. §1.401(a)(9)-9(b) Table 1 (Single Life Table), as adopted by T.D. 9930, 85 FR 72472 (2020-11-12); ' +
  'applies to distribution calendar years beginning on or after 2022-01-01 (§1.401(a)(9)-9(f)(1)). ' +
  'https://www.ecfr.gov/current/title-26/section-1.401(a)(9)-9';

/**
 * The §1274(d) federal mid-term rate for each month it has been vendored for, annual compounding.
 *
 * Decimal, not percent: 0.0461 is 4.61 %. The month is the month the rate applies to (the revenue
 * ruling published the month before says "for <month> <year> (the current month)"), which is the
 * month Notice 2022-6 §3.02(c) counts back from.
 */
export const MID_TERM_RATES: Readonly<Record<SeppRateMonth, number>> = {
  '2021-11': 0.0108, // Rev. Rul. 2021-21
  '2021-12': 0.0126, // Rev. Rul. 2021-23
  '2022-01': 0.013, // Rev. Rul. 2022-1
  '2022-02': 0.014, // Rev. Rul. 2022-3
  '2022-03': 0.0174, // Rev. Rul. 2022-4
  '2022-04': 0.0187, // Rev. Rul. 2022-8
  '2022-05': 0.0251, // Rev. Rul. 2022-9
  '2022-06': 0.0293, // Rev. Rul. 2022-10
  '2022-07': 0.0299, // Rev. Rul. 2022-12
  '2022-08': 0.0315, // Rev. Rul. 2022-14
  '2022-09': 0.0293, // Rev. Rul. 2022-17
  '2022-10': 0.0328, // Rev. Rul. 2022-18
  '2022-11': 0.0397, // Rev. Rul. 2022-20
  '2022-12': 0.0427, // Rev. Rul. 2022-22
  '2023-01': 0.0385, // Rev. Rul. 2023-1
  '2023-02': 0.0382, // Rev. Rul. 2023-3
  '2023-03': 0.037, // Rev. Rul. 2023-5
  '2023-04': 0.0415, // Rev. Rul. 2023-6
  '2023-05': 0.0357, // Rev. Rul. 2023-9
  '2023-06': 0.0356, // Rev. Rul. 2023-10
  '2023-07': 0.0385, // Rev. Rul. 2023-12
  '2023-08': 0.0409, // Rev. Rul. 2023-13
  '2023-09': 0.0419, // Rev. Rul. 2023-16
  '2023-10': 0.0443, // Rev. Rul. 2023-18
  '2023-11': 0.0469, // Rev. Rul. 2023-20
  '2023-12': 0.0482, // Rev. Rul. 2023-21
  '2024-01': 0.0437, // Rev. Rul. 2024-2
  '2024-02': 0.0398, // Rev. Rul. 2024-3
  '2024-03': 0.0413, // Rev. Rul. 2024-4
  '2024-04': 0.043, // Rev. Rul. 2024-7
  '2024-05': 0.0442, // Rev. Rul. 2024-9
  '2024-06': 0.0466, // Rev. Rul. 2024-12
  '2024-07': 0.0449, // Rev. Rul. 2024-13
  '2024-08': 0.0434, // Rev. Rul. 2024-15
  '2024-09': 0.0402, // Rev. Rul. 2024-17
  '2024-10': 0.037, // Rev. Rul. 2024-21
  '2024-11': 0.037, // Rev. Rul. 2024-24
  '2024-12': 0.0418, // Rev. Rul. 2024-26
  '2025-01': 0.0424, // Rev. Rul. 2025-1
  '2025-02': 0.0452, // Rev. Rul. 2025-5
  '2025-03': 0.0446, // Rev. Rul. 2025-6
  '2025-04': 0.0421, // Rev. Rul. 2025-8
  '2025-05': 0.041, // Rev. Rul. 2025-10
  '2025-06': 0.0407, // Rev. Rul. 2025-12
  '2025-07': 0.0419, // Rev. Rul. 2025-13
  '2025-08': 0.0406, // Rev. Rul. 2025-14
  '2025-09': 0.0404, // Rev. Rul. 2025-17
  '2025-10': 0.0387, // Rev. Rul. 2025-19
  '2025-11': 0.0383, // Rev. Rul. 2025-21
  '2025-12': 0.0379, // Rev. Rul. 2025-24
  '2026-01': 0.0381, // Rev. Rul. 2026-2
  '2026-02': 0.0386, // Rev. Rul. 2026-3
  '2026-03': 0.0393, // Rev. Rul. 2026-6
  '2026-04': 0.0382, // Rev. Rul. 2026-7
  '2026-05': 0.0408, // Rev. Rul. 2026-9
  '2026-06': 0.0413, // Rev. Rul. 2026-11
  '2026-07': 0.0435, // Rev. Rul. 2026-12
  '2026-08': 0.0435, // Rev. Rul. 2026-13
  '2026-09': 0.0449, // Rev. Rul. 2026-17
  '2026-10': 0.0461, // Rev. Rul. 2026-19
  '2026-11': 0.0508, // Rev. Rul. 2026-21
};

/** The oldest month in `MID_TERM_RATES`; advance this when appending the next published month. */
export const NEWEST_MID_TERM_RATE_MONTH: SeppRateMonth = '2026-11';

/** Where the rates come from, for a caller that wants to cite them alongside a payment. */
export const MID_TERM_RATE_SOURCE =
  'IRC §1274(d) federal mid-term applicable federal rate (annual compounding), as published in the monthly ' +
  'applicable-federal-rates revenue ruling; the ruling number is cited on each row. Index: ' +
  'https://www.irs.gov/applicable-federal-rates';

const RATE_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Splits and validates a `YYYY-MM` key, so a malformed month fails as a malformed month and not as
 * a missing rate.
 */
export function parseSeppRateMonth(month: SeppRateMonth): { year: number; month: number } {
  const match = RATE_MONTH_PATTERN.exec(month);
  if (!match) {
    throw new Error(`"${month}" is not a rate month: expected YYYY-MM (e.g. "2026-11"), with a two-digit month from 01 to 12.`);
  }

  return { year: Number(match[1]), month: Number(match[2]) };
}

/** Moves a `YYYY-MM` key by whole months, in either direction, across year boundaries. */
export function offsetSeppRateMonth(month: SeppRateMonth, offsetMonths: number): SeppRateMonth {
  const parsed = parseSeppRateMonth(month);
  const totalMonths = parsed.year * 12 + (parsed.month - 1) + Math.trunc(offsetMonths);
  const year = Math.floor(totalMonths / 12);
  const monthNumber = (((totalMonths % 12) + 12) % 12) + 1;

  return `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`;
}

/**
 * The Single Life Table factor for an attained age.
 *
 * `age` is the age attained on the owner's birthday in the distribution year (Notice 2022-6
 * §3.02(a)); a fractional age is floored, since the table is filed by whole age. Ages 120 and above
 * all resolve to the "120+" row. An age the table cannot state — negative, non-finite, or missing
 * from the data — throws instead of rounding to the nearest row.
 */
export function singleLifeExpectancy(age: number): number {
  if (!Number.isFinite(age)) {
    throw new Error(`A SEPP distribution period needs a finite attained age; got ${age}.`);
  }
  if (age < SINGLE_LIFE_TABLE_YOUNGEST_AGE) {
    throw new Error(
      `The Single Life Table (§1.401(a)(9)-9(b) Table 1) starts at age ${SINGLE_LIFE_TABLE_YOUNGEST_AGE}; ` +
        `got ${age}. A negative age is not an attained age, so there is no row to use.`
    );
  }

  const attainedAge = Math.floor(age);
  if (attainedAge >= SINGLE_LIFE_TABLE_TERMINAL_AGE) return SINGLE_LIFE_TABLE[SINGLE_LIFE_TABLE_TERMINAL_AGE] as number;

  const factor = SINGLE_LIFE_TABLE[attainedAge];
  if (factor === undefined) {
    throw new Error(
      `No Single Life Table factor vendored for age ${attainedAge}. The table states ages ` +
        `${SINGLE_LIFE_TABLE_YOUNGEST_AGE}–${SINGLE_LIFE_TABLE_OLDEST_AGE} plus the "120+" row; re-vendor it from ` +
        '§1.401(a)(9)-9(b) rather than interpolating.'
    );
  }

  return factor;
}

/**
 * The federal mid-term rate for a month, as a decimal.
 *
 * No fallback: an unsupported month throws with the exact place to add the next published value,
 * because Notice 2022-6 §3.02(c) prices the cap off a specific month's published rate and both an
 * interpolation and a neighbouring month would be an invented number.
 */
export function federalMidTermRate(month: SeppRateMonth): number {
  parseSeppRateMonth(month);

  const rate = MID_TERM_RATES[month];
  if (rate !== undefined) return rate;

  throw new Error(
    `No federal mid-term rate vendored for ${month}. Covered months: ${Object.keys(MID_TERM_RATES).sort()[0]} through ` +
      `${NEWEST_MID_TERM_RATE_MONTH}. Add the month to MID_TERM_RATES in src/lib/calc/retirement-rules/sepp-tables.ts ` +
      'from that month\'s AFR revenue ruling ("Mid-term AFR", annual column) at https://www.irs.gov/applicable-federal-rates, ' +
      'and advance NEWEST_MID_TERM_RATE_MONTH. Do not interpolate and do not reuse a neighbouring month: ' +
      'Notice 2022-6 §3.02(c) allows the rate for the two months before the distribution begins, not an estimate for them.'
  );
}
