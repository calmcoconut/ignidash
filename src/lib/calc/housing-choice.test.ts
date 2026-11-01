/**
 * `buildHousingChoice` is the one place a residence, its loan and a `HousingChoice` are made, for
 * both the AI chat tool and the rent-vs-own section. These tests pin its arithmetic by hand (the
 * loan payment is the standard amortisation formula, not a value read back from the code), its
 * cash/loan split, its defaults, and that it reproduces the inline construction the chat tool used
 * before the extraction, so moving the code did not move the AI's numbers.
 */
import { describe, expect, it } from 'vitest';

import { computeLoanPayment } from './amortization-schedule';
import { buildHousingChoice, type BuildHousingChoiceArgs } from './housing-choice';
import type { HousingChoice } from './housing-comparison';

/**
 * The chat tool's inline construction, copied verbatim from `runCompareHousing` before it was
 * extracted. It is the reference the builder must match for the same arguments.
 */
function legacyInlineChoice(args: {
  residencePrice: number;
  monthlyRent: number;
  downPaymentPercent?: number;
  interestRatePercent?: number;
  termMonths?: number;
  appreciationRatePercent?: number;
  propertyTaxRatePercent?: number;
  maintenanceRatePercent?: number;
  rentRealGrowthRatePercent?: number;
}): HousingChoice {
  const residencePrice = args.residencePrice;
  const monthlyRent = args.monthlyRent;
  const downPaymentPercent = args.downPaymentPercent !== undefined ? args.downPaymentPercent : 20;
  const interestRatePercent = args.interestRatePercent !== undefined ? args.interestRatePercent : 6.5;
  const termMonths = args.termMonths !== undefined ? args.termMonths : 360;
  const downPayment = (downPaymentPercent / 100) * residencePrice;
  const loanBalance = Math.max(0, residencePrice - downPayment);
  const monthlyPayment =
    loanBalance > 0
      ? computeLoanPayment({
          principal: loanBalance,
          annualRatePercent: interestRatePercent,
          termMonths,
        })
      : 0;

  const residence = {
    id: 'chat-comparison-residence',
    name: 'Primary Residence',
    assetType: 'primaryResidence' as const,
    purchaseDate: { type: 'now' as const },
    purchasePrice: residencePrice,
    appreciationRate: args.appreciationRatePercent !== undefined ? args.appreciationRatePercent : 3,
    paymentMethod:
      loanBalance > 0
        ? {
            type: 'loan' as const,
            downPayment,
            loanBalance,
            apr: interestRatePercent,
            monthlyPayment,
            termMonths,
          }
        : { type: 'cash' as const },
    saleDate: { type: 'atLifeExpectancy' as const },
  };

  return {
    residence,
    monthlyRent,
    propertyTaxRatePercent: args.propertyTaxRatePercent !== undefined ? args.propertyTaxRatePercent : undefined,
    maintenanceRatePercent: args.maintenanceRatePercent !== undefined ? args.maintenanceRatePercent : undefined,
    rentRealGrowthRatePercent: args.rentRealGrowthRatePercent !== undefined ? args.rentRealGrowthRatePercent : undefined,
  } as HousingChoice;
}

const loanOf = (choice: HousingChoice) => {
  if (choice.residence.paymentMethod.type !== 'loan') throw new Error('expected a loan');
  return choice.residence.paymentMethod;
};

describe('loan arithmetic', () => {
  it('derives a 30-year 6.5% mortgage on a $500,000 home with 20% down to the standard payment', () => {
    // Principal 400,000 at 6.5% APR over 360 months: the textbook amortisation payment is
    // 400000 * r / (1 - (1 + r)^-360) with r = 0.065 / 12, which is 2,528.27 to the cent.
    const choice = buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500 });
    const loan = loanOf(choice);

    expect(loan.downPayment).toBeCloseTo(100_000, 6);
    expect(loan.loanBalance).toBeCloseTo(400_000, 6);
    expect(loan.apr).toBe(6.5);
    expect(loan.termMonths).toBe(360);
    expect(loan.monthlyPayment).toBeCloseTo(2_528.27, 2);
  });

  it('uses the given down payment, rate and term when they are stated', () => {
    // 10% down on 300,000 leaves 270,000 at 5% over 15 years: 270000 * r / (1 - (1 + r)^-180),
    // r = 0.05 / 12, which is 2,135.14 to the cent.
    const choice = buildHousingChoice({
      residencePrice: 300_000,
      monthlyRent: 1_800,
      downPaymentPercent: 10,
      interestRatePercent: 5,
      termMonths: 180,
    });
    const loan = loanOf(choice);

    expect(loan.downPayment).toBeCloseTo(30_000, 6);
    expect(loan.loanBalance).toBeCloseTo(270_000, 6);
    expect(loan.termMonths).toBe(180);
    expect(loan.monthlyPayment).toBeCloseTo(2_135.14, 2);
  });

  it('refuses a non-positive term rather than reporting a zero payment', () => {
    expect(() => buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500, termMonths: 0 })).toThrow();
  });
});

describe('cash purchase', () => {
  it('is a cash purchase when the down payment is 100%', () => {
    const choice = buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500, downPaymentPercent: 100 });

    expect(choice.residence.paymentMethod).toEqual({ type: 'cash' });
  });

  it('is a cash purchase with no loan fields when the down payment covers the whole price', () => {
    const choice = buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500, downPaymentPercent: 100 });

    expect(Object.keys(choice.residence.paymentMethod)).toEqual(['type']);
  });
});

describe('defaults and the residence it describes', () => {
  it('builds a primary residence bought at the start of the plan and sold at life expectancy', () => {
    const { residence } = buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500 });

    expect(residence.assetType).toBe('primaryResidence');
    expect(residence.purchaseDate).toEqual({ type: 'now' });
    expect(residence.saleDate).toEqual({ type: 'atLifeExpectancy' });
    expect(residence.purchasePrice).toBe(500_000);
    expect(residence.appreciationRate).toBe(3);
    expect(residence.id).toBe('chat-comparison-residence');
    expect(residence.name).toBe('Primary Residence');
  });

  it('leaves the optional rates undefined so the comparison applies its own defaults', () => {
    const choice = buildHousingChoice({ residencePrice: 500_000, monthlyRent: 2_500 });

    expect(choice.monthlyRent).toBe(2_500);
    expect(choice.propertyTaxRatePercent).toBeUndefined();
    expect(choice.maintenanceRatePercent).toBeUndefined();
    expect(choice.rentRealGrowthRatePercent).toBeUndefined();
  });

  it('passes the optional rates and the residence id and name through when given', () => {
    const args: BuildHousingChoiceArgs = {
      residencePrice: 500_000,
      monthlyRent: 2_500,
      appreciationRatePercent: 4,
      propertyTaxRatePercent: 1.2,
      maintenanceRatePercent: 0.8,
      rentRealGrowthRatePercent: 0.5,
      residenceId: 'home-a',
      residenceName: 'Oak Street',
    };
    const choice = buildHousingChoice(args);

    expect(choice.residence.appreciationRate).toBe(4);
    expect(choice.propertyTaxRatePercent).toBe(1.2);
    expect(choice.maintenanceRatePercent).toBe(0.8);
    expect(choice.rentRealGrowthRatePercent).toBe(0.5);
    expect(choice.residence.id).toBe('home-a');
    expect(choice.residence.name).toBe('Oak Street');
  });
});

describe('the chat tool construction is unchanged by the extraction', () => {
  const cases: Array<{ name: string; args: Parameters<typeof legacyInlineChoice>[0] }> = [
    { name: 'the bare minimum', args: { residencePrice: 500_000, monthlyRent: 2_500 } },
    {
      name: 'every optional stated',
      args: {
        residencePrice: 750_000,
        monthlyRent: 3_100,
        downPaymentPercent: 25,
        interestRatePercent: 5.75,
        termMonths: 240,
        appreciationRatePercent: 2.5,
        propertyTaxRatePercent: 1.1,
        maintenanceRatePercent: 1.2,
        rentRealGrowthRatePercent: 0.4,
      },
    },
    { name: 'an all-cash purchase', args: { residencePrice: 400_000, monthlyRent: 1_900, downPaymentPercent: 100 } },
  ];

  it.each(cases)('builds the same choice as the inline code for $name', ({ args }) => {
    expect(buildHousingChoice(args)).toEqual(legacyInlineChoice(args));
  });
});
