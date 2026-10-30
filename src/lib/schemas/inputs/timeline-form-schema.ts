/**
 * Timeline and retirement strategy schema with cross-field validation.
 *
 * Defines birth date, life expectancy, and retirement strategy (fixed age or
 * SWR target). Includes validation ensuring retirement age < life expectancy.
 */

import { z } from 'zod';

import { type ISODateString, parseISODateString } from '@/lib/calc/clock';
import { ageField, percentageField } from '@/lib/utils/zod-utils';

import { householdSchema, resolveHouseholdMembers } from './household-schema';

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

/**
 * Structural timeline schema: field shapes and per-field bounds only.
 *
 * It carries no rule that compares against "today" (see `createTimelineFormSchema`), so it
 * is safe to compose into a plan-level schema without a clock — `simulator-schema.ts` does
 * so. This module never reads the wall clock; the date is always passed in by the caller.
 */
export const timelineBaseSchema = z.object({
  birthMonth: z.number().int().min(1).max(12),
  birthYear: z.number().int().min(1925).max(2025),
  lifeExpectancy: ageField(50, 110, {
    min: 'Life expectancy must be at least 50 years',
    max: 'Life expectancy must be at most 110 years',
  }),
  retirementStrategy: retirementStrategySchema,
  // Who is in the plan (P1-P2): one member, or two. Absent means "one person" — every plan
  // written before households existed. The stored plan carries it inside `timeline`
  // (`planDataFields.timeline`), so no separate plan field was needed.
  household: householdSchema.optional(),
});

export type RetirementStrategyInputs = z.infer<typeof retirementStrategySchema>;
export type TimelineInputs = z.infer<typeof timelineBaseSchema>;

/**
 * Timeline schema including the cross-field rules that compare the plan against "today":
 * current age 18-100, life expectancy above current age, and retirement age between current
 * age and life expectancy.
 *
 * `now` is explicit — supplied by the UI boundary with `currentLocalISODate()` — because this
 * module is forbidden to read the wall clock (see the determinism rules in
 * `eslint.config.mjs`).
 */
export function createTimelineFormSchema(now: ISODateString | Date) {
  return timelineBaseSchema
    .refine(
      (data) => {
        const currentAge = calculateAge(data.birthMonth, data.birthYear, now);
        return currentAge >= 18 && currentAge <= 100;
      },
      {
        message: 'You must be between 18 and 100 years old',
        path: ['birthYear'],
      }
    )
    .refine(
      (data) => {
        const currentAge = calculateAge(data.birthMonth, data.birthYear, now);
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
        const currentAge = calculateAge(data.birthMonth, data.birthYear, now);
        return currentAge <= data.retirementStrategy.retirementAge && data.retirementStrategy.retirementAge < data.lifeExpectancy;
      },
      {
        message: 'Retirement age must be between current age and life expectancy',
        path: ['retirementStrategy', 'retirementAge'],
      }
    )
    .superRefine((data, ctx) => {
      // A member who stored its own ages is validated against them; one that inherits the plan's
      // is already covered by the rules above, so it would only duplicate their messages.
      const planAges = { birthMonth: data.birthMonth, birthYear: data.birthYear, lifeExpectancy: data.lifeExpectancy };
      resolveHouseholdMembers(data.household, planAges).forEach((member, index) => {
        if (!member.hasStoredAges) return;

        const memberAge = calculateAge(member.birthMonth, member.birthYear, now);
        if (memberAge < 18 || memberAge > 100) {
          ctx.addIssue({
            code: 'custom',
            message: 'Each household member must be between 18 and 100 years old',
            path: ['household', 'members', index, 'birthYear'],
          });
        }
        if (memberAge >= member.lifeExpectancy) {
          ctx.addIssue({
            code: 'custom',
            message: "Each household member's life expectancy must be greater than their current age",
            path: ['household', 'members', index, 'lifeExpectancy'],
          });
        }
      });
    });
}

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

/** Whole years since birth as of `now`. `now` is explicit so this stays a pure function. */
export function calculateAge(birthMonth: number, birthYear: number, now: ISODateString | Date): number {
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
