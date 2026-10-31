import { z } from 'zod';

import { currencyFieldAllowsZero } from '@/lib/utils/zod-utils';

/**
 * The filing statuses the engine can settle a return under (IRC §1(a), §1(d) and §1(b)).
 *
 * `marriedFilingSeparately` (P3-P1b) is a **separate return per spouse**: `TaxProcessor.process()`
 * prices one return, so a separate-return household is priced twice and the two results are summed
 * into the one `TaxesData` block the cash-flow engine consumes. The ruleset carries its own row in
 * every table, because half of the joint amounts is not the same thing as the single amounts
 * (the top bracket, the §86 tiers and the IRMAA tiers are the places where they part company).
 */
const filingStatus = z.enum(['single', 'marriedFilingJointly', 'marriedFilingSeparately', 'headOfHousehold']);

export type FilingStatus = z.infer<typeof filingStatus>;

/**
 * The itemized deductions the operator can enter (P3-P3).
 *
 * Every amount is a yearly figure in the plan's own dollars — the same basis the standard deduction
 * and the brackets are in — and it is applied unchanged to every simulated year, like the standard
 * deduction. The engine applies the statutory limits itself: the SALT cap with its MAGI phase-down,
 * and the 7.5%-of-AGI floor on medical expenses. So a user enters the *gross* amounts they expect
 * (property tax plus state income tax, say) and the cap is the engine's job, not theirs.
 *
 * The block is **optional and absent by default**, which means "this plan does not itemize" — not
 * "itemized deductions of zero". The distinction matters for the export envelope (contract 3.3): a
 * version 6 file has no such block, and an absent block must read as the standard deduction, never
 * as a file that happened to itemize nothing.
 */
const itemizedDeductions = z.object({
  /** Mortgage interest on a principal residence (allowed in full, also for AMT). */
  mortgageInterest: currencyFieldAllowsZero('Mortgage interest cannot be negative'),
  /** Charitable contributions (allowed in full, also for AMT). */
  charitable: currencyFieldAllowsZero('Charitable contributions cannot be negative'),
  /**
   * Property and local taxes — **not** state income tax, which the engine computes and adds to the
   * federal SALT line itself. Disallowed for AMT (the engine adds the SALT line back).
   */
  stateAndLocalTaxes: currencyFieldAllowsZero('State and local taxes cannot be negative'),
  /** Medical expenses, before the 7.5%-of-AGI floor (allowed above the floor, also for AMT). */
  medicalExpenses: currencyFieldAllowsZero('Medical expenses cannot be negative'),
});

export type ItemizedDeductionsInputs = z.infer<typeof itemizedDeductions>;

/**
 * Which state files a return. Only California is modelled (D2), so the enum has two members: CA, or
 * no state return at all. It is optional and **defaults to California** — this is a California
 * instance, and the payroll layer has charged CA SDI unconditionally since P3-P4, so an absent flag
 * must not mean "no state tax" for a plan that has been paying California payroll tax all along.
 * A plan that is not a resident sets `'none'` explicitly.
 */
export const stateResidencySchema = z.enum(['CA', 'none']);

export type StateResidencyInputs = z.infer<typeof stateResidencySchema>;

export const taxSettingsFormSchema = z.object({
  filingStatus,
  stateResidency: stateResidencySchema.optional(),
  itemizedDeductions: itemizedDeductions.optional(),
  /**
   * Whether the *spouse* on a joint return is 65 or older, for the §151(d)(5)(C) senior deduction.
   *
   * The primary's own age comes from the simulation clock, so a single filer never needs this. A
   * joint return needs it because the tax layer sees one age (the primary's) and not the household's
   * member ages; absent means "the spouse is under 65", which is the conservative reading.
   */
  spouseQualifiesForSeniorDeduction: z.boolean().optional(),
});

export type TaxSettingsInputs = z.infer<typeof taxSettingsFormSchema>;
