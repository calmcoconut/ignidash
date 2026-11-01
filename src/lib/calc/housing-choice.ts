/**
 * The residence, loan and `HousingChoice` a rent-vs-own comparison is built from.
 *
 * Both the AI chat tool (`compareHousing` in `convex/chat_tools.ts`) and the results-page section
 * (`rent-vs-own-section.tsx`) turn their own inputs into a `HousingChoice` through this one
 * function, so the two surfaces cannot disagree about what "a $500k home, 20% down, 6.5%, 30 years"
 * means. It is pure: no clock, no store, no network.
 *
 * Every field that is not given takes the default the AI tool has always used, so a caller that
 * passes only a price and a rent gets the same choice the tool built before this was extracted.
 */
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';

import { computeLoanPayment } from './amortization-schedule';
import type { HousingChoice } from './housing-comparison';

export const DEFAULT_DOWN_PAYMENT_PERCENT = 20;
export const DEFAULT_INTEREST_RATE_PERCENT = 6.5;
export const DEFAULT_TERM_MONTHS = 360;
export const DEFAULT_APPRECIATION_RATE_PERCENT = 3;
export const DEFAULT_RESIDENCE_ID = 'chat-comparison-residence';
export const DEFAULT_RESIDENCE_NAME = 'Primary Residence';

export interface BuildHousingChoiceArgs {
  /** Purchase price of the home, in today's dollars. Must be positive. */
  residencePrice: number;
  /** Monthly rent for the renting path, in today's dollars. Must be positive. */
  monthlyRent: number;
  /** Down payment as a percent of the price; 100 is a cash purchase. Defaults to 20. */
  downPaymentPercent?: number;
  /** Mortgage APR in percent. Defaults to 6.5. */
  interestRatePercent?: number;
  /** Mortgage term in months. Defaults to 360. */
  termMonths?: number;
  /** Real annual appreciation of the home, in percent. Defaults to 3. */
  appreciationRatePercent?: number;
  /** Property tax as a percent of assessed value; the comparison's default when absent. */
  propertyTaxRatePercent?: number;
  /** Maintenance and insurance as a percent of the home's value; the comparison's default when absent. */
  maintenanceRatePercent?: number;
  /** Real growth of the rent in percent; the comparison's default (0) when absent. */
  rentRealGrowthRatePercent?: number;
  /** Id of the residence on the owning path. Defaults to the chat tool's id. */
  residenceId?: string;
  /** Display name of the residence. Defaults to the chat tool's name. */
  residenceName?: string;
}

/**
 * Builds the residence (cash, or a loan with its derived monthly payment), dated `now` so that
 * `compareHousing` resolves it to a purchase in the plan's first month, and the `HousingChoice`
 * around it.
 *
 * The loan is only created when a balance is left after the down payment; a 100% down payment is
 * a cash purchase. The loan payment is `computeLoanPayment` over the balance, so a validation
 * failure there (for example a non-positive term) throws rather than producing a silent zero.
 */
export function buildHousingChoice(args: BuildHousingChoiceArgs): HousingChoice {
  const downPaymentPercent = args.downPaymentPercent ?? DEFAULT_DOWN_PAYMENT_PERCENT;
  const interestRatePercent = args.interestRatePercent ?? DEFAULT_INTEREST_RATE_PERCENT;
  const termMonths = args.termMonths ?? DEFAULT_TERM_MONTHS;
  const downPayment = (downPaymentPercent / 100) * args.residencePrice;
  const loanBalance = Math.max(0, args.residencePrice - downPayment);
  const monthlyPayment =
    loanBalance > 0
      ? computeLoanPayment({
          principal: loanBalance,
          annualRatePercent: interestRatePercent,
          termMonths,
        })
      : 0;

  const residence: PhysicalAssetInputs = {
    id: args.residenceId ?? DEFAULT_RESIDENCE_ID,
    name: args.residenceName ?? DEFAULT_RESIDENCE_NAME,
    assetType: 'primaryResidence',
    purchaseDate: { type: 'now' },
    purchasePrice: args.residencePrice,
    appreciationRate: args.appreciationRatePercent ?? DEFAULT_APPRECIATION_RATE_PERCENT,
    paymentMethod:
      loanBalance > 0
        ? {
            type: 'loan',
            downPayment,
            loanBalance,
            apr: interestRatePercent,
            monthlyPayment,
            termMonths,
          }
        : { type: 'cash' },
    saleDate: { type: 'atLifeExpectancy' },
  };

  return {
    residence,
    monthlyRent: args.monthlyRent,
    propertyTaxRatePercent: args.propertyTaxRatePercent,
    maintenanceRatePercent: args.maintenanceRatePercent,
    rentRealGrowthRatePercent: args.rentRealGrowthRatePercent,
  };
}
