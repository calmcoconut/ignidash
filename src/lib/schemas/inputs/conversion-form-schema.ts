/**
 * Roth conversion schedule schema (parity plan P3-P5).
 *
 * A Roth conversion is a transfer of funds from a tax-deferred account (such as a traditional IRA)
 * to a Roth IRA.
 *
 * Each entry in the schedule specifies:
 * - `id`: unique identifier for the conversion rule.
 * - `name`: optional descriptive label.
 * - `fromAccountId`: the source tax-deferred account.
 * - `toAccountId`: the destination Roth account.
 * - timing: `year` (calendar year) or `timePoint` (event or age).
 * - target: either a fixed `amount`, or a `fillToBracket` target rate (and optional jurisdiction).
 */

import { z } from 'zod';

import { timePointSchema } from './income-expenses-shared-schemas';

export const conversionJurisdictionSchema = z.enum(['federal', 'california']);
export type ConversionJurisdiction = z.infer<typeof conversionJurisdictionSchema>;

export const conversionFillToBracketTargetSchema = z.object({
  targetBracketRate: z.number().min(0).max(1),
  jurisdiction: conversionJurisdictionSchema.optional(),
});
export type ConversionFillToBracketTarget = z.infer<typeof conversionFillToBracketTargetSchema>;

const baseConversionFields = {
  id: z.string().min(1),
  name: z.string().optional(),
  fromAccountId: z.string().min(1, 'Source account is required'),
  toAccountId: z.string().min(1, 'Destination account is required'),
  year: z.number().int().min(1900).max(2150).optional(),
  timePoint: timePointSchema.optional(),
};

export const conversionWithAmountSchema = z.object({
  ...baseConversionFields,
  amount: z.number().min(0, 'Conversion amount must be non-negative'),
});

export const conversionWithFillToBracketSchema = z.object({
  ...baseConversionFields,
  fillToBracket: z.union([z.number().min(0).max(1), conversionFillToBracketTargetSchema]),
});

export const conversionSchema = z
  .union([conversionWithAmountSchema, conversionWithFillToBracketSchema])
  .refine((data) => data.year !== undefined || data.timePoint !== undefined, {
    message: 'Conversion must specify a year or timePoint',
  });

export type ConversionInputs = z.infer<typeof conversionSchema>;

export const conversionsSchema = z.array(conversionSchema);
