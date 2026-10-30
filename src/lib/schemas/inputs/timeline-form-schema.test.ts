import { describe, it, expect } from 'vitest';
import { calculateAge, calculatePreciseAge, createTimelineFormSchema, timelineBaseSchema } from './timeline-form-schema';

/**
 * Every rule in `createTimelineFormSchema` compares the plan against "today", so the date is
 * pinned here instead of being read from the wall clock: the suite no longer depends on the
 * day it runs.
 */
const NOW = '2026-02-01';

const timelineSchema = createTimelineFormSchema(NOW);

// birthYear=2000, birthMonth=1 → age 26 on 2026-02-01 (birthday already passed)
const validTimeline = {
  birthMonth: 1,
  birthYear: 2000,
  lifeExpectancy: 85,
  retirementStrategy: {
    type: 'fixedAge' as const,
    retirementAge: 65,
  },
};

describe('createTimelineFormSchema', () => {
  it('should accept valid fixedAge strategy', () => {
    expect(timelineSchema.safeParse(validTimeline).success).toBe(true);
  });

  it('should accept valid swrTarget strategy', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 },
    });
    expect(result.success).toBe(true);
  });

  it('should coerce string values for numeric fields', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      lifeExpectancy: '85',
      retirementStrategy: { type: 'fixedAge', retirementAge: '65' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject current age < 18', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      birthYear: 2010, // age 16 on 2026-02-01
    });
    expect(result.success).toBe(false);
  });

  it('should reject current age > 100', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      birthYear: 1925, // age 101 on 2026-02-01
      retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject lifeExpectancy <= current age', () => {
    // Need someone older than 50 so lifeExpectancy can pass the ageField(50,110) min check
    const result = timelineSchema.safeParse({
      ...validTimeline,
      birthYear: 1970, // age 56 on 2026-02-01
      lifeExpectancy: 55,
      retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject fixedAge retirement age < current age', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      retirementStrategy: { type: 'fixedAge', retirementAge: 20 }, // current age 26
    });
    expect(result.success).toBe(false);
  });

  it('should reject fixedAge retirement age >= life expectancy', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      lifeExpectancy: 65,
      retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject SWR rate below 2%', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject SWR rate above 6%', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 7 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject lifeExpectancy below 50', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      lifeExpectancy: 45,
    });
    expect(result.success).toBe(false);
  });

  it('should reject lifeExpectancy above 110', () => {
    const result = timelineSchema.safeParse({
      ...validTimeline,
      lifeExpectancy: 115,
    });
    expect(result.success).toBe(false);
  });

  it('evaluates the age rules against the date it was created with', () => {
    // 18th birthday falls in January 2026: adult on 2026-02-01, still a minor on 2025-12-01.
    const eighteenInJanuary2026 = { ...validTimeline, birthMonth: 1, birthYear: 2008 };

    expect(createTimelineFormSchema('2026-02-01').safeParse(eighteenInJanuary2026).success).toBe(true);
    expect(createTimelineFormSchema('2025-12-01').safeParse(eighteenInJanuary2026).success).toBe(false);
  });

  it('keeps the clock-relative rules out of the structural schema', () => {
    // Documents the split: `timelineBaseSchema` is shape-only, so it has no date to compare
    // against and accepts a minor's birth year. Plan-level composition uses it; the form
    // boundary uses `createTimelineFormSchema(now)`.
    expect(timelineBaseSchema.safeParse({ ...validTimeline, birthYear: 2010 }).success).toBe(true);
    expect(createTimelineFormSchema('2026-02-01').safeParse({ ...validTimeline, birthYear: 2010 }).success).toBe(false);
  });
});

describe('calculateAge / calculatePreciseAge', () => {
  // Clock injection (parity plan P2-P0): `now` is explicit and required, so both functions
  // are pure and their results do not depend on the day the code runs.

  it('calculatePreciseAge uses the supplied ISO date', () => {
    expect(calculatePreciseAge(6, 1990, '2026-03-15')).toBeCloseTo(35 + 9 / 12, 10);
    expect(calculatePreciseAge(6, 1990, '2026-06-15')).toBeCloseTo(36, 10);
    expect(calculatePreciseAge(6, 1990, '2026-07-01')).toBeCloseTo(36 + 1 / 12, 10);
  });

  it('calculatePreciseAge treats a Date instant as UTC, independent of the host timezone', () => {
    const instant = new Date('2026-03-15T00:00:00Z');
    expect(calculatePreciseAge(6, 1990, instant)).toBeCloseTo(calculatePreciseAge(6, 1990, '2026-03-15'), 10);
    expect(calculatePreciseAge(6, 1990, new Date('2026-03-15T23:30:00Z'))).toBeCloseTo(35 + 9 / 12, 10);
  });

  it('calculateAge counts whole years as of the supplied date', () => {
    expect(calculateAge(6, 1990, '2026-03-15')).toBe(35);
    expect(calculateAge(6, 1990, '2026-06-01')).toBe(36);
    expect(calculateAge(1, 2000, '2026-01-01')).toBe(26);
  });

  it('calculateAge is driven only by the supplied date and the birth date', () => {
    // Crossing a birthday changes the answer; calling twice with the same inputs is stable.
    expect(calculateAge(2, 2000, '2026-01-31')).toBe(25);
    expect(calculateAge(2, 2000, '2026-02-01')).toBe(26);
    expect(calculateAge(2, 2000, '2026-02-01')).toBe(calculateAge(2, 2000, '2026-02-01'));
    // A Date instant and the equivalent ISO date agree, so callers cannot smuggle in a clock.
    expect(calculateAge(2, 2000, new Date('2026-02-01T12:00:00Z'))).toBe(calculateAge(2, 2000, '2026-02-01'));
  });

  it('calculateAge and calculatePreciseAge agree on the whole-year part', () => {
    for (const now of ['2026-01-01', '2026-03-15', '2026-12-31', '2031-06-15']) {
      for (const birthMonth of [1, 6, 12]) {
        expect(Math.floor(calculatePreciseAge(birthMonth, 1990, now))).toBe(calculateAge(birthMonth, 1990, now));
      }
    }
  });
});
