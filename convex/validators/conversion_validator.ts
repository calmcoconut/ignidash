import { v, type Infer } from 'convex/values';

/**
 * Convex validator for Roth conversion schedule (parity plan P3-P5).
 *
 * Mirrors `src/lib/schemas/inputs/conversion-form-schema.ts`.
 */

const conversionTimePointValidator = v.object({
  type: v.union(
    v.literal('now'),
    v.literal('atRetirement'),
    v.literal('atLifeExpectancy'),
    v.literal('customDate'),
    v.literal('customAge')
  ),
  month: v.optional(v.number()),
  year: v.optional(v.number()),
  age: v.optional(v.number()),
  everyNYears: v.optional(v.number()),
  recurrenceYears: v.optional(v.number()),
});

export const conversionFillToBracketValidator = v.object({
  targetBracketRate: v.number(),
  jurisdiction: v.optional(v.union(v.literal('federal'), v.literal('california'))),
});

const conversionBaseFields = {
  id: v.string(),
  name: v.optional(v.string()),
  fromAccountId: v.string(),
  toAccountId: v.string(),
  year: v.optional(v.number()),
  timePoint: v.optional(conversionTimePointValidator),
};

export const conversionAmountValidator = v.object({
  ...conversionBaseFields,
  amount: v.number(),
});

export const conversionFillToBracketEntryValidator = v.object({
  ...conversionBaseFields,
  fillToBracket: v.union(v.number(), conversionFillToBracketValidator),
});

export const conversionValidator = v.union(conversionAmountValidator, conversionFillToBracketEntryValidator);
export const conversionsValidator = v.array(conversionValidator);

export type ConversionDoc = Infer<typeof conversionValidator>;
