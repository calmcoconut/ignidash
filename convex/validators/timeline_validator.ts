import { v } from 'convex/values';

import { householdValidator } from './household_validator';

export const timelineValidator = v.object({
  birthMonth: v.number(),
  birthYear: v.number(),
  lifeExpectancy: v.number(),
  retirementStrategy: v.union(
    v.object({ type: v.literal('fixedAge'), retirementAge: v.number() }),
    v.object({ type: v.literal('swrTarget'), safeWithdrawalRate: v.number() })
  ),
  // Who is in the plan (P1-P2). Optional: absent means one person. Stored inside `timeline`,
  // which is already in `planDataFields`, so the plan document carries the household with no
  // extra top-level field.
  household: v.optional(householdValidator),
});
