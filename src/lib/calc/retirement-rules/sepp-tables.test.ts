import { describe, expect, it } from 'vitest';

import {
  MID_TERM_RATES,
  MID_TERM_RATE_SOURCE,
  NEWEST_MID_TERM_RATE_MONTH,
  SINGLE_LIFE_TABLE,
  SINGLE_LIFE_TABLE_OLDEST_AGE,
  SINGLE_LIFE_TABLE_SOURCE,
  SINGLE_LIFE_TABLE_TERMINAL_AGE,
  SINGLE_LIFE_TABLE_YOUNGEST_AGE,
  federalMidTermRate,
  offsetSeppRateMonth,
  parseSeppRateMonth,
  singleLifeExpectancy,
} from './sepp-tables';

/**
 * The vendored SEPP inputs: the §1.401(a)(9)-9(b) Single Life Table and the monthly §1274(d)
 * federal mid-term rates.
 *
 * The values themselves are published data, so these tests pin three different things: the shape
 * the lookups rely on (a contiguous age range with a terminal "120+" row, a contiguous run of
 * months), a handful of published rows that would catch a mis-transcribed table, and the refusal
 * path — an age or a month that cannot be cited must fail loudly instead of being approximated.
 */

describe('the Single Life Table (§1.401(a)(9)-9(b), Table 1)', () => {
  it('states every age from 0 to 119 plus the "120+" row', () => {
    const ages = Object.keys(SINGLE_LIFE_TABLE)
      .map(Number)
      .sort((a, b) => a - b);

    expect(ages[0]).toBe(SINGLE_LIFE_TABLE_YOUNGEST_AGE);
    expect(ages[ages.length - 1]).toBe(SINGLE_LIFE_TABLE_TERMINAL_AGE);
    expect(ages).toStrictEqual(Array.from({ length: SINGLE_LIFE_TABLE_TERMINAL_AGE + 1 }, (_, age) => age));
    expect(SINGLE_LIFE_TABLE_TERMINAL_AGE).toBe(SINGLE_LIFE_TABLE_OLDEST_AGE + 1);
  });

  it('is non-increasing in age and positive throughout', () => {
    // Life expectancy can repeat a value between adjacent ages (115 and 116 are both 1.8 years) but
    // can never rise as the owner ages.
    for (let age = SINGLE_LIFE_TABLE_YOUNGEST_AGE; age < SINGLE_LIFE_TABLE_TERMINAL_AGE; age++) {
      expect(SINGLE_LIFE_TABLE[age]).toBeGreaterThanOrEqual(SINGLE_LIFE_TABLE[age + 1] as number);
    }
    for (const factor of Object.values(SINGLE_LIFE_TABLE)) expect(factor).toBeGreaterThan(0);
  });

  it('matches the published rows', () => {
    // Ages as printed in Table 1 to §1.401(a)(9)-9(b) (T.D. 9930, 85 FR 72472): 0 → 84.6,
    // 65 → 22.9, 70 → 18.8, 72 → 17.2, 90 → 5.7, 119 → 1.1, 120+ → 1.0.
    expect(SINGLE_LIFE_TABLE[0]).toBe(84.6);
    expect(SINGLE_LIFE_TABLE[65]).toBe(22.9);
    expect(SINGLE_LIFE_TABLE[70]).toBe(18.8);
    expect(SINGLE_LIFE_TABLE[72]).toBe(17.2);
    expect(SINGLE_LIFE_TABLE[90]).toBe(5.7);
    expect(SINGLE_LIFE_TABLE[119]).toBe(1.1);
    expect(SINGLE_LIFE_TABLE[120]).toBe(1.0);
  });

  it('cites the regulation and the adoption of the table', () => {
    expect(SINGLE_LIFE_TABLE_SOURCE).toMatch(/§1\.401\(a\)\(9\)-9\(b\) Table 1/);
    expect(SINGLE_LIFE_TABLE_SOURCE).toMatch(/85 FR 72472/);
    expect(SINGLE_LIFE_TABLE_SOURCE).toMatch(/https:\/\/www\.ecfr\.gov/);
  });

  it('resolves the boundary ages the table states, and the terminal row above them', () => {
    // The youngest row is age 0 at 84.6 years — the table has no row below it.
    expect(singleLifeExpectancy(0)).toBe(84.6);
    // The oldest individually stated row.
    expect(singleLifeExpectancy(119)).toBe(1.1);
    // 120 and above are the regulation's single "120+" row, not a run off the end of the data.
    expect(singleLifeExpectancy(120)).toBe(1.0);
    expect(singleLifeExpectancy(130)).toBe(1.0);
    // A fractional attained age uses the whole-age row (the table is filed by birthday).
    expect(singleLifeExpectancy(65.5)).toBe(22.9);
  });

  it('refuses an age it has no row for instead of rounding to one', () => {
    expect(() => singleLifeExpectancy(-1)).toThrow(/starts at age 0/);
    expect(() => singleLifeExpectancy(Number.NaN)).toThrow(/finite attained age/);
    expect(() => singleLifeExpectancy(Number.POSITIVE_INFINITY)).toThrow(/finite attained age/);
  });
});

describe('the monthly federal mid-term rate', () => {
  it('is a contiguous run of months that ends at the documented newest month', () => {
    const months = Object.keys(MID_TERM_RATES).sort();
    const first = months[0] as string;

    expect(months).toContain(NEWEST_MID_TERM_RATE_MONTH);
    expect(months[months.length - 1]).toBe(NEWEST_MID_TERM_RATE_MONTH);

    // Every month between the first and the newest is present: a gap would turn a working
    // calculation into a throw for no reason, and the lookup deliberately has no fallback.
    const expected: string[] = [];
    for (let month = first; month <= NEWEST_MID_TERM_RATE_MONTH; month = offsetSeppRateMonth(month, 1)) {
      expected.push(month);
    }
    expect(months).toStrictEqual(expected);
  });

  it('files every month under a real YYYY-MM key as a decimal rate', () => {
    for (const [month, rate] of Object.entries(MID_TERM_RATES)) {
      expect(parseSeppRateMonth(month)).toMatchObject({ year: expect.any(Number), month: expect.any(Number) });
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThan(0.15);
    }
  });

  it('matches the published AFR rows', () => {
    // "Mid-term AFR", annual column, of the month's revenue ruling:
    // Rev. Rul. 2022-1 (1.30 %), Rev. Rul. 2023-3 (3.82 %), Rev. Rul. 2024-26 (4.18 %),
    // Rev. Rul. 2026-21 (5.08 %). The 2023-02 row is the one the ruling prints column-major.
    expect(federalMidTermRate('2022-01')).toBeCloseTo(0.013, 10);
    expect(federalMidTermRate('2023-02')).toBeCloseTo(0.0382, 10);
    expect(federalMidTermRate('2024-12')).toBeCloseTo(0.0418, 10);
    expect(federalMidTermRate('2026-11')).toBeCloseTo(0.0508, 10);
  });

  it('cites the rulings index and the §1274(d) mid-term row', () => {
    expect(MID_TERM_RATE_SOURCE).toMatch(/§1274\(d\)/);
    expect(MID_TERM_RATE_SOURCE).toMatch(/https:\/\/www\.irs\.gov\/applicable-federal-rates/);
  });

  it('fails loudly for a month with no published rate, naming where to add it', () => {
    // A month after the newest vendored one, a month before the first, and a month the AFR table
    // simply has no row for. Each must throw from the lookup — never price at a default.
    for (const month of ['2026-12', '2021-10']) {
      expect(() => federalMidTermRate(month)).toThrow(new RegExp(`No federal mid-term rate vendored for ${month}`));
      expect(() => federalMidTermRate(month)).toThrow(new RegExp(`through ${NEWEST_MID_TERM_RATE_MONTH}`));
      expect(() => federalMidTermRate(month)).toThrow(/https:\/\/www\.irs\.gov\/applicable-federal-rates/);
      expect(() => federalMidTermRate(month)).toThrow(/Do not interpolate/);
    }
  });

  it('rejects a malformed month as a malformed month, not as a missing rate', () => {
    for (const month of ['2026-13', '2026-00', '2026-1', '2026/11', '', 'november']) {
      expect(() => federalMidTermRate(month)).toThrow(/is not a rate month: expected YYYY-MM/);
      expect(() => parseSeppRateMonth(month)).toThrow(/is not a rate month: expected YYYY-MM/);
    }
  });
});

describe('month arithmetic for the rate window', () => {
  it('steps whole months in both directions across a year boundary', () => {
    expect(offsetSeppRateMonth('2026-01', -1)).toBe('2025-12');
    expect(offsetSeppRateMonth('2026-01', -2)).toBe('2025-11');
    expect(offsetSeppRateMonth('2025-12', 1)).toBe('2026-01');
    expect(offsetSeppRateMonth('2026-03', -14)).toBe('2025-01');
    expect(offsetSeppRateMonth('2026-11', 0)).toBe('2026-11');
  });

  it('validates the month it starts from', () => {
    expect(() => offsetSeppRateMonth('2026-13', 1)).toThrow(/is not a rate month/);
  });
});
