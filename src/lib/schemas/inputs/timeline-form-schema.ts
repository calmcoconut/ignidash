/**
 * Timeline and retirement strategy schema with cross-field validation.
 *
 * Defines birth date, life expectancy, and retirement strategy (fixed age or
 * SWR target). Includes validation ensuring retirement age < life expectancy.
 */

import { z } from 'zod';

import { type ISODateString, parseISODateString } from '@/lib/calc/clock';
import { currentLocalISODate } from '@/lib/utils/system-clock';
import { ageField, percentageField } from '@/lib/utils/zod-utils';

export const retirementStrategySchema = z.discriminatedUnion('type', [
  z.object({
    retirementAge: ageField(19, 73, {
      min: 'Retirement age must be at least 19 years',
      max: 'Retirement age must be at most 73 years',
    }),
    type: z.literal('fixedAge'),
  }),
  z.object({
    safeWithdrawalRate: percentageField(2, 6, 'Safe withdrawal rate'),
    type: z.literal('swrTarget'),
  }),
]);

export const timelineFormSchema = z
  .object({
    birthMonth: z.number().int().min(1).max(12),
    birthYear: z.number().int().min(1925).max(2025),
    lifeExpectancy: ageField(50, 110, {
      min: 'Life expectancy must be at least 50 years',
      max: 'Life expectancy must be at most 110 years',
    }),
    retirementStrategy: retirementStrategySchema,
  })
  .refine(
    (data) => {
      const currentAge = calculateAge(data.birthMonth, data.birthYear);
      return currentAge >= 18 && currentAge <= 100;
    },
    {
      message: 'You must be between 18 and 100 years old',
      path: ['birthYear'],
    }
  )
  .refine(
    (data) => {
      const currentAge = calculateAge(data.birthMonth, data.birthYear);
      return currentAge < data.lifeExpectancy;
    },
    {
      message: 'Life expectancy must be greater than current age',
      path: ['lifeExpectancy'],
    }
  )
  .refine(
    (data) => {
      if (data.retirementStrategy.type !== 'fixedAge') return true;
      const currentAge = calculateAge(data.birthMonth, data.birthYear);
      return currentAge <= data.retirementStrategy.retirementAge && data.retirementStrategy.retirementAge < data.lifeExpectancy;
    },
    {
      message: 'Retirement age must be between current age and life expectancy',
      path: ['retirementStrategy', 'retirementAge'],
    }
  );

export type RetirementStrategyInputs = z.infer<typeof retirementStrategySchema>;
export type TimelineInputs = z.infer<typeof timelineFormSchema>;

/**
 * Calendar year and month of `now`, read without depending on the host timezone.
 * ISO date strings are parsed as calendar values; `Date` instances are read in UTC.
 */
function calendarYearAndMonth(now: ISODateString | Date): { year: number; month: number } {
  if (typeof now === 'string') {
    const { year, month } = parseISODateString(now);
    return { year, month };
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/**
 * Whole years since birth as of `now` (defaults to today's local calendar date, read once
 * at the boundary in `@/lib/utils/system-clock`).
 */
export function calculateAge(birthMonth: number, birthYear: number, now: ISODateString | Date = currentLocalISODate()): number {
  const { year: currentYear, month: currentMonth } = calendarYearAndMonth(now);

  let age = currentYear - birthYear;
  if (currentMonth < birthMonth) {
    age--;
  }
  return age;
}

/** Age in fractional years as of `now`; `now` is explicit so simulations are deterministic. */
export function calculatePreciseAge(birthMonth: number, birthYear: number, now: ISODateString | Date): number {
  const { year: currentYear, month: currentMonth } = calendarYearAndMonth(now);

  const yearDiff = currentYear - birthYear;
  const monthDiff = currentMonth - birthMonth;

  return yearDiff + monthDiff / 12;
}
