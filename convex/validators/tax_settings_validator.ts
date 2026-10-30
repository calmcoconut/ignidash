import { v } from 'convex/values';

/**
 * The itemized deductions a plan may carry (P3-P3). Optional and absent by default: absent means
 * "this plan does not itemize", which is what every file written before version 7 holds.
 */
export const itemizedDeductionsValidator = v.object({
  mortgageInterest: v.number(),
  charitable: v.number(),
  stateAndLocalTaxes: v.number(),
  medicalExpenses: v.number(),
});

export const taxSettingsValidator = v.object({
  filingStatus: v.union(v.literal('single'), v.literal('marriedFilingJointly'), v.literal('headOfHousehold')),
  itemizedDeductions: v.optional(itemizedDeductionsValidator),
  spouseQualifiesForSeniorDeduction: v.optional(v.boolean()),
});
