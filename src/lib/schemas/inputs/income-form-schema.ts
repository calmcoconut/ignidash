/**
 * Income type schema with tax treatment and withholding rules.
 *
 * Supports wage, socialSecurity, exempt, selfEmployment, and pension income types.
 * Includes withholding validation (required for wages, constrained rates for Social Security)
 * and helper functions for withholding support checks and defaults.
 *
 * Every type in the enum is accepted (P3-P4): `selfEmployment` was gated while the engine had no
 * self-employment tax, which would have taxed SE income as an ordinary wage and under-taxed it by
 * ~15.3%. The payroll-tax layer (`payroll-taxes.ts`) now charges the SE tax, so the gate is gone
 * and nothing may be re-gated without a matching tax.
 */

import { z } from 'zod';

import { currencyFieldForbidsZero, optionalPercentageField } from '@/lib/utils/zod-utils';

import { ownerSchema, propertyRegimeSchema } from './household-schema';
import { amountBasisSchema, growthSchema, frequencyTimeframeSchema } from './income-expenses-shared-schemas';

export type IncomeType = 'wage' | 'socialSecurity' | 'exempt' | 'selfEmployment' | 'pension';

export const incomeTaxSchema = z
  .object({
    incomeType: z.enum(['wage', 'socialSecurity', 'exempt', 'selfEmployment', 'pension']),
    withholding: optionalPercentageField(0, 50, 'Withholding'),
  })
  .refine(
    (data) => {
      if (data.incomeType === 'wage') {
        return data.withholding !== undefined;
      }
      return true;
    },
    {
      message: 'Withholding required for wage income',
      path: ['withholding'],
    }
  )
  .refine(
    (data) => {
      if (data.incomeType === 'socialSecurity' && data.withholding !== undefined) {
        return [0, 7, 10, 12, 22].includes(data.withholding);
      }
      return true;
    },
    {
      message: 'Social Security withholding must be 0%, 7%, 10%, 12%, or 22%',
      path: ['withholding'],
    }
  );

/**
 * Social Security benefit inputs on an income (parity plan P1-P8).
 *
 * The benefit is estimated in `src/lib/calc/social-security.ts` from either an AIME or a PIA:
 *
 * - `mode: 'estimated'` takes the Average Indexed Monthly Earnings and runs them through the PIA
 *   bend points;
 * - `mode: 'manual'` takes the monthly PIA directly, for someone who already has the figure from
 *   their SSA statement.
 *
 * `claimAge` is the retirement age the benefit starts at (62–70); the early/delayed adjustment is
 * relative to the full retirement age, which depends on birth year and therefore lives on the
 * timeline, not here. `colaRate` is the cost-of-living assumption; the module reads it as real
 * growth against the plan's inflation assumption.
 *
 * Optional on the income, so every plan written before this field existed loads unchanged, and an
 * income without it simply has no Social Security estimate.
 *
 * Spousal and survivor benefits are modelled for a couple (P1-P8, E2): `src/lib/calc/incomes.ts`
 * adds the spousal share and the survivor top-up to the lines that carry this block. The block itself
 * still describes one earner's own retirement benefit, and the schema is unchanged.
 */
export const socialSecuritySchema = z
  .object({
    mode: z.enum(['manual', 'estimated']),
    /** Average Indexed Monthly Earnings, in monthly dollars. */
    aime: currencyFieldForbidsZero('AIME must be greater than zero').optional(),
    /** Monthly Primary Insurance Amount, in today's dollars. */
    pia: currencyFieldForbidsZero('PIA must be greater than zero').optional(),
    claimAge: z
      .number()
      .int('Claim age must be a whole age')
      .min(62, 'Claim age must be at least 62')
      .max(70, 'Claim age must be at most 70'),
    colaRate: optionalPercentageField(0, 10, 'COLA rate'),
  })
  .refine((data) => data.mode !== 'estimated' || data.aime !== undefined, {
    message: 'Estimated Social Security needs an AIME',
    path: ['aime'],
  })
  .refine((data) => data.mode !== 'manual' || data.pia !== undefined, {
    message: 'Manual Social Security needs a PIA',
    path: ['pia'],
  });

export type SocialSecurityInputs = z.infer<typeof socialSecuritySchema>;

export const incomeFormSchema = z
  .object({
    id: z.string(),
    name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters'),
    amount: currencyFieldForbidsZero('Income cannot be negative or zero'),
    amountBasis: amountBasisSchema.optional(),
    // Whose income this is (P1-P2). Absent means `primary`; `joint` carries a property regime.
    owner: ownerSchema.optional(),
    propertyRegime: propertyRegimeSchema.optional(),
    growth: growthSchema.optional(),
    taxes: incomeTaxSchema,
    // Social Security estimate for this income (P1-P8). Absent on every older plan.
    socialSecurity: socialSecuritySchema.optional(),
    disabled: z.boolean().optional(),
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

export type IncomeInputs = z.infer<typeof incomeFormSchema>;

export const supportsWithholding = (incomeType: IncomeType): boolean => {
  switch (incomeType) {
    case 'wage':
    case 'socialSecurity':
      return true;
    case 'exempt':
    case 'selfEmployment':
    case 'pension':
      return false;
  }
};

export const defaultWithholding = (incomeType: IncomeType): number | undefined => {
  switch (incomeType) {
    case 'wage':
      return 20;
    case 'socialSecurity':
      return 0;
    case 'exempt':
    case 'selfEmployment':
    case 'pension':
      return undefined;
  }
};
