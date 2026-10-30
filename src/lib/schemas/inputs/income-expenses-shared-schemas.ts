/**
 * Shared schemas for income and expense forms.
 *
 * Provides reusable sub-schemas for TimePoint (now / atRetirement / atLifeExpectancy /
 * customDate / customAge), Frequency, Growth (rate + optional limit), and the combined
 * frequency + timeframe shape used by both income and expense forms.
 */

import { z } from 'zod';

import { optionalPercentageField, optionalCurrencyFieldAllowsZero } from '@/lib/utils/zod-utils';

/**
 * A dated event, optionally repeating on a fixed cadence.
 *
 * `everyNYears` makes the event active only in its occurrence years (every N years from the
 * event's own start); `recurrenceYears` caps how many years the cadence runs for, counted
 * from that start, and is meaningless without a cadence. Both are optional: a plan saved
 * before recurrence existed has neither, and readers treat its events as continuous.
 */
export const timePointSchema = z
  .object({
    type: z.enum(['now', 'atRetirement', 'atLifeExpectancy', 'customDate', 'customAge']),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    age: z.number().int().min(0).max(120).optional(),
    everyNYears: z
      .number()
      .int()
      .min(1, 'Repeat interval must be at least 1 year')
      .max(100, 'Repeat interval must be at most 100 years')
      .optional(),
    recurrenceYears: z
      .number()
      .int()
      .min(1, 'Repeat span must be at least 1 year')
      .max(100, 'Repeat span must be at most 100 years')
      .optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'customDate') {
        return data.month !== undefined && data.year !== undefined && data.age === undefined;
      }
      if (data.type === 'customAge') {
        return data.age !== undefined && data.month === undefined && data.year === undefined;
      }
      return true;
    },
    {
      message: 'Custom fields are required when custom option is selected',
    }
  )
  .refine((data) => data.recurrenceYears === undefined || data.everyNYears !== undefined, {
    message: 'A repeat span needs a repeat interval',
    path: ['recurrenceYears'],
  });

export type TimePoint = z.infer<typeof timePointSchema>;

/**
 * Whether an entered amount is in today's dollars (`real`, the default everywhere) or in the
 * dollars of the date the event takes effect (`nominal`, converted with the plan's cumulative
 * inflation index).
 */
export const amountBasisSchema = z.enum(['real', 'nominal']);

export type AmountBasis = z.infer<typeof amountBasisSchema>;

// Shared frequency schema for income and expenses
export const frequencySchema = z.enum(['yearly', 'oneTime', 'quarterly', 'monthly', 'biweekly', 'weekly']);

export type Frequency = z.infer<typeof frequencySchema>;

// Shared frequency and timeframe schema for income and expenses
export const frequencyTimeframeSchema = z
  .object({
    frequency: frequencySchema,
    timeframe: z.object({
      start: timePointSchema,
      end: timePointSchema.optional(),
    }),
  })
  .refine(
    (data) => {
      const isOneTime = data.frequency === 'oneTime';
      const hasEndTime = !!data.timeframe.end;

      return isOneTime ? !hasEndTime : hasEndTime;
    },
    {
      message: 'One-time frequency should not have an end date, recurring frequencies require an end date',
      path: ['timeframe', 'end'],
    }
  );

export type FrequencyTimeframe = z.infer<typeof frequencyTimeframeSchema>;

// Shared growth schema for income and expenses
export const growthSchema = z
  .object({
    growthRate: optionalPercentageField(-50, 50, 'Growth rate'),
    growthLimit: optionalCurrencyFieldAllowsZero('Growth limit cannot be negative'),
  })
  .refine(
    (data) => {
      if (data.growthLimit !== undefined) {
        return data.growthRate !== undefined;
      }
      return true;
    },
    {
      message: 'Growth limit requires a growth rate to be set',
      path: ['growthLimit'],
    }
  );

export type Growth = z.infer<typeof growthSchema>;
