import { v } from 'convex/values';

import { ownerValidator, propertyRegimeValidator } from './household_validator';

const physicalAssetTimePointValidator = v.object({
  type: v.union(
    v.literal('now'),
    v.literal('atRetirement'),
    v.literal('atLifeExpectancy'),
    v.literal('customDate'),
    v.literal('customAge')
  ),
  month: v.optional(v.number()),
  year: v.optional(v.number()),
  age: v.optional(v.number()),
  everyNYears: v.optional(v.number()),
  recurrenceYears: v.optional(v.number()),
});

const cashPaymentValidator = v.object({
  type: v.literal('cash'),
});

const loanPaymentValidator = v.object({
  type: v.literal('loan'),
  downPayment: v.optional(v.number()),
  loanBalance: v.number(),
  apr: v.number(),
  monthlyPayment: v.number(),
  // Loan term in whole months (P1-P5). Absent means the monthly payment drives the loan, as before.
  termMonths: v.optional(v.number()),
  // Account whose balance offsets the loan's interest-bearing principal (P1-P5).
  // Absent means no offset: interest is charged on the whole principal, as before.
  offsetAccountId: v.optional(v.string()),
});

const propertyTaxValidator = v.object({
  // Annual rate in percent applied to the assessed value; `prop-13.ts`'s 1.1% when absent.
  ratePercent: v.optional(v.number()),
  // The annual bill itself; wins over `ratePercent` when both are present.
  annualAmount: v.optional(v.number()),
});

const paymentMethodValidator = v.union(cashPaymentValidator, loanPaymentValidator);

export const physicalAssetValidator = v.object({
  id: v.string(),
  name: v.string(),
  assetType: v.optional(v.union(v.literal('primaryResidence'), v.literal('other'))),
  purchaseDate: physicalAssetTimePointValidator,
  purchasePrice: v.number(),
  marketValue: v.optional(v.number()),
  appreciationRate: v.number(),
  saleDate: v.optional(physicalAssetTimePointValidator),
  paymentMethod: paymentMethodValidator,
  // Property tax on the asset (P1-P5). Absent means none is charged, as before.
  propertyTax: v.optional(propertyTaxValidator),
  // real (today's dollars, default) | nominal (dollars of the purchase date)
  amountBasis: v.optional(v.union(v.literal('real'), v.literal('nominal'))),
  // Whose item this is (P1-P2). Absent means `primary`.
  owner: v.optional(ownerValidator),
  propertyRegime: v.optional(propertyRegimeValidator),
  syncedAssetId: v.optional(v.string()),
  syncedLiabilityId: v.optional(v.string()),
});
