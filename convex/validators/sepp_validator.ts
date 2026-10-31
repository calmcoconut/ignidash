import { v } from 'convex/values';

export const seppMethodValidator = v.union(v.literal('rmd'), v.literal('fixedAmortization'), v.literal('fixedAnnuitization'));

export const seppScheduleValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  accountId: v.string(),
  method: seppMethodValidator,
  startYear: v.number(),
  rate: v.optional(v.number()),
  annualAmount: v.optional(v.number()),
  stopYear: v.optional(v.number()),
  disabled: v.optional(v.boolean()),
});

export const seppValidator = v.array(seppScheduleValidator);
