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

export const acaSettingsValidator = v.object({
  optIn: v.boolean(),
  householdSize: v.optional(v.number()),
  slcsp: v.optional(v.number()),
  actualPremium: v.optional(v.number()),
});

export const medicareSettingsValidator = v.object({
  includePremiums: v.boolean(),
  enrollmentAge: v.optional(v.number()),
  partDMonthly: v.optional(v.number()),
  supplementalMonthly: v.optional(v.number()),
});

export const taxSettingsValidator = v.object({
  /**
   * The filing status a single return is settled under (IRC §1). `marriedFilingSeparately` (P3-P1b)
   * means the household files **two** separate returns: the engine prices one return at a time and
   * the engine's tax block is the sum of the two.
   */
  filingStatus: v.union(
    v.literal('single'),
    v.literal('marriedFilingJointly'),
    v.literal('marriedFilingSeparately'),
    v.literal('headOfHousehold')
  ),
  /**
   * Which state files a return (P3-P8). Optional and absent by default; absent means California,
   * because this is a California instance and the payroll layer has charged CA SDI all along. Only
   * `'none'` turns the state return off.
   */
  stateResidency: v.optional(v.union(v.literal('CA'), v.literal('none'))),
  itemizedDeductions: v.optional(itemizedDeductionsValidator),
  spouseQualifiesForSeniorDeduction: v.optional(v.boolean()),
  aca: v.optional(acaSettingsValidator),
  medicare: v.optional(medicareSettingsValidator),
});
