/**
 * Root SimulatorInputs composition schema.
 *
 * Composes all per-domain form schemas (timeline, incomes, accounts, expenses, debts,
 * contributions, market assumptions, etc.) into a single SimulatorInputs type that
 * represents a complete financial plan for simulation.
 */

import { z } from 'zod';

import { timelineBaseSchema } from './timeline-form-schema';
import { incomeFormSchema } from './income-form-schema';
import { accountFormSchema } from './account-form-schema';
import { glidePathFormSchema } from './glide-path-form-schema';
import { expenseFormSchema } from './expense-form-schema';
import { debtFormSchema } from './debt-form-schema';
import { physicalAssetFormSchema } from './physical-asset-form-schema';
import { contributionFormSchema, baseContributionSchema } from './contribution-form-schema';
import { marketAssumptionsFormSchema } from './market-assumptions-form-schema';
import { taxSettingsFormSchema } from './tax-settings-form-schema';
import { privacySettingsFormSchema } from './privacy-settings-form-schema';
import { simulationSettingsSchema } from './simulation-settings-form-schema';
import { milestonesSchema } from './milestone-form-schema';
import { conversionsSchema } from './conversion-form-schema';
import { seppScheduleSchema } from './sepp-form-schema';

export const simulatorSchema = z.object({
  // Shape-only timeline rules: the "as of today" cross-field rules need an explicit date,
  // so they live in `createTimelineFormSchema(now)` and are applied at the form boundary.
  timeline: timelineBaseSchema.nullable(),
  incomes: z.record(z.string(), incomeFormSchema),
  accounts: z.record(z.string(), accountFormSchema),
  glidePath: glidePathFormSchema.optional(),
  expenses: z.record(z.string(), expenseFormSchema),
  debts: z.record(z.string(), debtFormSchema),
  physicalAssets: z.record(z.string(), physicalAssetFormSchema),
  contributionRules: z.record(z.string(), contributionFormSchema),
  baseContributionRule: baseContributionSchema,
  marketAssumptions: marketAssumptionsFormSchema,
  taxSettings: taxSettingsFormSchema,
  privacySettings: privacySettingsFormSchema,
  simulationSettings: simulationSettingsSchema,
  // User milestones (P1-P7). Optional, and absent means **no milestones**: a plan written before
  // the field existed simulates exactly as it did (`SimulationResult.milestones` is absent too),
  // and the export envelope reads the absence the same way (schema version 12).
  milestones: milestonesSchema.optional(),
  // Roth conversion schedule (parity plan P3-P5). Optional; absent means no conversions.
  conversions: conversionsSchema.optional(),
  // Substantially Equal Periodic Payments schedules (IRC §72(t)(2)(A)(iv)). Optional; absent means no SEPP schedules.
  sepp: z.array(seppScheduleSchema).optional(),
});

export type SimulatorInputs = z.infer<typeof simulatorSchema>;
