import { z } from 'zod';

import { currencyFieldForbidsZero } from '@/lib/utils/zod-utils';

import { ownerSchema, propertyRegimeSchema } from './household-schema';
import { amountBasisSchema, growthSchema, frequencyTimeframeSchema } from './income-expenses-shared-schemas';

export const expenseFormSchema = z
  .object({
    id: z.string(),
    name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters'),
    amount: currencyFieldForbidsZero('Expense cannot be negative or zero'),
    amountBasis: amountBasisSchema.optional(),
    // Whose expense this is (P1-P2). Absent means `primary`.
    owner: ownerSchema.optional(),
    propertyRegime: propertyRegimeSchema.optional(),
    growth: growthSchema.optional(),
    disabled: z.boolean().optional(),
    // Essential spending (P1-P4). Absent means `false`: a withdrawal strategy's annual cap may
    // only cut spending that is not marked essential, so an untouched plan is unaffected.
    essential: z.boolean().optional(),
  })
  .extend(frequencyTimeframeSchema.shape)
  .refine(
    (data) => {
      if (data.growth?.growthLimit === undefined || data.growth?.growthRate === undefined || data.growth.growthRate <= 0) {
        return true;
      }

      return data.growth.growthLimit > data.amount;
    },
    {
      message: 'Growth limit must be greater than Amount for positive growth',
      path: ['growth', 'growthLimit'],
    }
  )
  .refine(
    (data) => {
      if (data.growth?.growthLimit === undefined || data.growth?.growthRate === undefined || data.growth.growthRate >= 0) {
        return true;
      }

      return data.growth.growthLimit < data.amount;
    },
    {
      message: 'Growth limit must be less than Amount for negative growth',
      path: ['growth', 'growthLimit'],
    }
  );

export type ExpenseInputs = z.infer<typeof expenseFormSchema>;
