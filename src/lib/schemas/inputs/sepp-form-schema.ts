/**
 * Substantially Equal Periodic Payments (SEPP) schema under IRC §72(t)(2)(A)(iv).
 *
 * Safe-harbor withdrawal schedules exempt from the 10% early distribution penalty.
 */

import { z } from 'zod';

export const seppMethodSchema = z.enum(['rmd', 'fixedAmortization', 'fixedAnnuitization']);
export type SeppMethod = z.infer<typeof seppMethodSchema>;

export const seppScheduleSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  accountId: z.string(),
  method: seppMethodSchema,
  startYear: z.number().int().min(1900).max(2200),
  rate: z.number().min(0).max(1).optional(),
  annualAmount: z.number().min(0).optional(),
  stopYear: z.number().int().min(1900).max(2200).optional(),
  disabled: z.boolean().optional(),
});

export type SeppScheduleInputs = z.infer<typeof seppScheduleSchema>;
