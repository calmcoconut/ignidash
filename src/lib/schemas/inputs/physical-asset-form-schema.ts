import { z } from 'zod';
import {
  currencyFieldForbidsZero,
  optionalCoerceNumber,
  optionalCurrencyFieldForbidsZero,
  optionalCurrencyFieldAllowsZero,
  optionalPercentageField,
  percentageField,
} from '@/lib/utils/zod-utils';
import { ownerSchema, propertyRegimeSchema } from './household-schema';
import { amountBasisSchema, timePointSchema } from './income-expenses-shared-schemas';

export const physicalAssetTypeSchema = z.enum(['primaryResidence', 'other']);

export type PhysicalAssetType = z.infer<typeof physicalAssetTypeSchema>;

const cashPaymentSchema = z.object({
  type: z.literal('cash'),
});

/**
 * A loan term in whole months (P1-P5). Optional: absent means the monthly payment drives the loan,
 * which is what every plan written before this field did. When it is stated the engine derives the
 * payment from the term and the APR (see `amortization-schedule.ts`), and `monthlyPayment` becomes
 * informational — the mortgage dialog writes the derived value into it.
 */
const loanTermMonthsField = optionalCoerceNumber(
  z
    .number('Must be a valid number of months')
    .int('Loan term must be a whole number of months')
    .min(1, 'Loan term must be at least 1 month')
    .max(600, 'Loan term must be at most 600 months')
);

const loanPaymentSchema = z.object({
  type: z.literal('loan'),
  downPayment: optionalCurrencyFieldAllowsZero('Down payment cannot be negative'),
  loanBalance: currencyFieldForbidsZero('Loan balance must be greater than zero'),
  apr: percentageField(0, 25, 'APR'),
  monthlyPayment: currencyFieldForbidsZero('Monthly payment must be greater than zero'),
  // Loan term in months (P1-P5). Absent = the monthly payment drives the loan, as before.
  termMonths: loanTermMonthsField,
  // Account whose balance offsets the loan's interest-bearing principal (P1-P5).
  // Absent = no offset: interest is charged on the whole principal, as before.
  offsetAccountId: z.string().min(1, 'Offset account must be an account id').optional(),
});

/**
 * Property tax on a physical asset (P1-P5, real estate II).
 *
 * Two ways to state the same bill, both optional: a rate applied to the property's assessed value
 * (`prop-13.ts`), or the annual amount the plan already knows. `annualAmount` wins when both are
 * given. Absent `propertyTax` means the plan pays no property tax through the engine — exactly the
 * behaviour before this field existed.
 */
export const propertyTaxSchema = z.object({
  /** Annual rate in percent applied to the assessed value; `prop-13.ts`'s 1.1% total when absent. */
  ratePercent: optionalPercentageField(0, 10, 'Property tax rate'),
  /** The annual bill itself, in the plan's dollars for the purchase year (real unless `amountBasis` is nominal). */
  annualAmount: optionalCurrencyFieldAllowsZero('Annual property tax cannot be negative'),
});

export type PropertyTaxInputs = z.infer<typeof propertyTaxSchema>;

const paymentMethodSchema = z.discriminatedUnion('type', [cashPaymentSchema, loanPaymentSchema]);

export type PaymentMethodInputs = z.infer<typeof paymentMethodSchema>;

export const physicalAssetFormSchema = z
  .object({
    id: z.string(),
    name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters'),
    assetType: physicalAssetTypeSchema,
    purchaseDate: timePointSchema,
    purchasePrice: currencyFieldForbidsZero('Purchase price must be greater than zero'),
    marketValue: optionalCurrencyFieldForbidsZero('Market value must be greater than zero'),
    appreciationRate: percentageField(-30, 20, 'Annual appreciation rate'),
    amountBasis: amountBasisSchema.optional(),
    // Whose asset this is (P1-P2). Absent means `primary`.
    owner: ownerSchema.optional(),
    propertyRegime: propertyRegimeSchema.optional(),
    saleDate: timePointSchema,
    paymentMethod: paymentMethodSchema,
    // Property tax on the asset (P1-P5). Absent = none charged, as before.
    propertyTax: propertyTaxSchema.optional(),
    syncedAssetId: z.string().optional(),
    syncedLiabilityId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.paymentMethod.type === 'loan' && data.purchaseDate.type !== 'now') {
        return data.paymentMethod.downPayment !== undefined;
      }
      return true;
    },
    {
      path: ['paymentMethod', 'downPayment'],
      message: 'Down payment is required when financing a future purchase',
    }
  )
  .refine(
    (data) => {
      if (data.paymentMethod.type === 'loan' && data.purchaseDate.type !== 'now') {
        const downPayment = data.paymentMethod.downPayment ?? 0;
        const loanBalance = data.paymentMethod.loanBalance;

        return Math.abs(downPayment + loanBalance - data.purchasePrice) < 0.01;
      }
      return true;
    },
    {
      path: ['paymentMethod', 'loanBalance'],
      message: 'Down payment + loan balance must equal purchase price',
    }
  );

export type PhysicalAssetInputs = z.infer<typeof physicalAssetFormSchema>;

export const hasLoan = (asset: PhysicalAssetInputs): boolean => asset.paymentMethod.type === 'loan';
