/**
 * Physical asset processing for the simulation engine
 *
 * Handles real estate and other physical assets with appreciation, secured loans,
 * purchase/sale lifecycle, and realized gains tracking. Assets transition through
 * pending -> owned -> sold states based on user-specified dates.
 */

import type { PhysicalAssetInputs, PaymentMethodInputs, PhysicalAssetType } from '@/lib/schemas/inputs/physical-asset-form-schema';

import { computeLoanPayment } from './amortization-schedule';
import { TimeBinding, type TimeBindingContext } from './time-binding';

import type { SimulationState } from './simulation-engine';

/** Lifecycle state of a physical asset */
export type OwnershipStatus = 'pending' | 'owned' | 'sold';

/** Processes all physical assets each month including purchases, appreciation, loans, and sales */
export class PhysicalAssetsProcessor {
  private monthlyData: PhysicalAssetsData[] = [];

  constructor(
    private simulationState: SimulationState,
    private physicalAssets: PhysicalAssets
  ) {}

  /**
   * @param monthlyInflationRate - The month's inflation, as `returns-processor` reports it.
   * @param accountBalance - How to read a named account's balance, used by a mortgage offset
   *   account (`paymentMethod.offsetAccountId`): the offset's balance is subtracted from the
   *   loan's interest-bearing principal. Defaults to `0`, which is "no offset" — the behaviour
   *   before the field existed, and what a caller that does not own the portfolio gets.
   */
  process(monthlyInflationRate: number, accountBalance: (accountId: string) => number = () => 0): PhysicalAssetsData {
    let totalPurchaseOutlay = 0;
    let totalPurchaseMarketValue = 0;
    const purchaseDataByAsset: Record<string, { purchaseOutlay: number; purchaseMarketValue: number }> = {};

    const assetsToPurchase = this.physicalAssets.getAssetsToPurchaseThisPeriod(this.simulationState);
    for (const asset of assetsToPurchase) {
      const { purchaseOutlay, purchaseMarketValue } = asset.purchase();

      purchaseDataByAsset[asset.getId()] = { purchaseOutlay, purchaseMarketValue };
      totalPurchaseOutlay += purchaseOutlay;
      totalPurchaseMarketValue += purchaseMarketValue;
    }

    let totalAppreciation = 0;
    let totalLoanPayment = 0;
    let totalInterest = 0;
    let totalPrincipalPaid = 0;
    let totalUnpaidInterest = 0;
    let totalDebtPaydown = 0;
    let totalSaleProceeds = 0;
    let totalSaleMarketValue = 0;
    let totalRealizedGains = 0;
    let totalSecuredDebtIncurred = 0;
    let totalDebtPayoff = 0;
    const perAssetData: Record<string, PhysicalAssetData> = {};

    const ownedAssets = this.physicalAssets.getOwnedAssets();
    for (const asset of ownedAssets) {
      const securedDebtIncurred = asset.incurSecuredDebt();
      totalSecuredDebtIncurred += securedDebtIncurred;

      const { monthlyAppreciation: appreciation } = asset.applyMonthlyAppreciation();

      const offsetAccountId = asset.getOffsetAccountId();
      const offsetBalance = offsetAccountId === undefined ? 0 : accountBalance(offsetAccountId);
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflationRate, offsetBalance);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
      asset.applyMonthlyInflation(monthlyInflationRate);

      const principalPaid = Math.max(0, monthlyPaymentDue - interest);
      const unpaidInterest = Math.max(0, interest - monthlyPaymentDue);

      const debtPaydown = monthlyPaymentDue - interest;

      const assetData: PhysicalAssetData = {
        id: asset.getId(),
        name: asset.getName(),
        assetType: asset.getAssetType(),
        marketValue: asset.getMarketValue(),
        loanBalance: asset.getLoanBalance(),
        equity: asset.getEquity(),
        paymentType: asset.getPaymentType(),
        appreciation,
        loanPayment: monthlyPaymentDue,
        interest,
        principalPaid,
        unpaidInterest,
        debtPaydown,
        purchaseOutlay: purchaseDataByAsset[asset.getId()]?.purchaseOutlay ?? 0,
        purchaseMarketValue: purchaseDataByAsset[asset.getId()]?.purchaseMarketValue ?? 0,
        saleProceeds: 0,
        saleMarketValue: 0,
        realizedGains: 0,
        securedDebtIncurred,
        debtPayoff: 0,
        isSold: asset.isSold(),
      };

      perAssetData[asset.getId()] = assetData;
      totalAppreciation += appreciation;
      totalLoanPayment += monthlyPaymentDue;
      totalInterest += interest;
      totalPrincipalPaid += principalPaid;
      totalUnpaidInterest += unpaidInterest;
      totalDebtPaydown += debtPaydown;
    }

    const assetsToSell = this.physicalAssets.getAssetsToSellThisPeriod(this.simulationState);
    for (const asset of assetsToSell) {
      const { saleProceeds, realizedGains, saleMarketValue, debtPayoff } = asset.sell();

      perAssetData[asset.getId()] = {
        ...perAssetData[asset.getId()],
        marketValue: 0,
        loanBalance: 0,
        equity: 0,
        saleProceeds,
        saleMarketValue,
        realizedGains,
        debtPayoff,
        isSold: true,
      };

      totalSaleProceeds += saleProceeds;
      totalSaleMarketValue += saleMarketValue;
      totalRealizedGains += realizedGains;
      totalDebtPayoff += debtPayoff;
    }

    const result: PhysicalAssetsData = {
      totalMarketValue: this.physicalAssets.getTotalMarketValue(),
      totalLoanBalance: this.physicalAssets.getTotalLoanBalance(),
      totalEquity: this.physicalAssets.getTotalEquity(),
      totalAppreciation,
      totalLoanPayment,
      totalInterest,
      totalPrincipalPaid,
      totalUnpaidInterest,
      totalDebtPaydown,
      totalPurchaseOutlay,
      totalPurchaseMarketValue,
      totalSaleProceeds,
      totalSaleMarketValue,
      totalRealizedGains,
      totalSecuredDebtIncurred,
      totalDebtPayoff,
      perAssetData,
    };

    this.monthlyData.push(result);
    return result;
  }

  resetMonthlyData(): void {
    this.monthlyData = [];
  }

  getAnnualData(): PhysicalAssetsData {
    const lastMonthData = this.monthlyData[this.monthlyData.length - 1];

    return {
      ...lastMonthData,
      ...this.monthlyData.reduce(
        (acc, curr) => {
          acc.totalAppreciation += curr.totalAppreciation;
          acc.totalLoanPayment += curr.totalLoanPayment;
          acc.totalInterest += curr.totalInterest;
          acc.totalPrincipalPaid += curr.totalPrincipalPaid;
          acc.totalUnpaidInterest += curr.totalUnpaidInterest;
          acc.totalDebtPaydown += curr.totalDebtPaydown;
          acc.totalPurchaseOutlay += curr.totalPurchaseOutlay;
          acc.totalPurchaseMarketValue += curr.totalPurchaseMarketValue;
          acc.totalSaleProceeds += curr.totalSaleProceeds;
          acc.totalSaleMarketValue += curr.totalSaleMarketValue;
          acc.totalRealizedGains += curr.totalRealizedGains;
          acc.totalSecuredDebtIncurred += curr.totalSecuredDebtIncurred;
          acc.totalDebtPayoff += curr.totalDebtPayoff;

          for (const [assetID, assetData] of Object.entries(curr.perAssetData)) {
            const existing = acc.perAssetData[assetID];
            acc.perAssetData[assetID] = {
              ...assetData,
              appreciation: (existing?.appreciation ?? 0) + assetData.appreciation,
              loanPayment: (existing?.loanPayment ?? 0) + assetData.loanPayment,
              interest: (existing?.interest ?? 0) + assetData.interest,
              principalPaid: (existing?.principalPaid ?? 0) + assetData.principalPaid,
              unpaidInterest: (existing?.unpaidInterest ?? 0) + assetData.unpaidInterest,
              debtPaydown: (existing?.debtPaydown ?? 0) + assetData.debtPaydown,
              purchaseOutlay: (existing?.purchaseOutlay ?? 0) + assetData.purchaseOutlay,
              purchaseMarketValue: (existing?.purchaseMarketValue ?? 0) + assetData.purchaseMarketValue,
              saleProceeds: (existing?.saleProceeds ?? 0) + assetData.saleProceeds,
              saleMarketValue: (existing?.saleMarketValue ?? 0) + assetData.saleMarketValue,
              realizedGains: (existing?.realizedGains ?? 0) + assetData.realizedGains,
              securedDebtIncurred: (existing?.securedDebtIncurred ?? 0) + assetData.securedDebtIncurred,
              debtPayoff: (existing?.debtPayoff ?? 0) + assetData.debtPayoff,
            };
          }

          return acc;
        },
        {
          totalAppreciation: 0,
          totalLoanPayment: 0,
          totalInterest: 0,
          totalPrincipalPaid: 0,
          totalUnpaidInterest: 0,
          totalDebtPaydown: 0,
          totalPurchaseOutlay: 0,
          totalPurchaseMarketValue: 0,
          totalSaleProceeds: 0,
          totalSaleMarketValue: 0,
          totalRealizedGains: 0,
          totalSecuredDebtIncurred: 0,
          totalDebtPayoff: 0,
          perAssetData: {} as Record<string, PhysicalAssetData>,
        } satisfies PhysicalAssetsFlowData
      ),
    };
  }
}

/** Point-in-time snapshot fields — taken from last month's data, not summed */
interface PhysicalAssetsSnapshotData {
  totalMarketValue: number;
  totalLoanBalance: number;
  totalEquity: number;
}

/** Flow fields — summed across months in getAnnualData */
interface PhysicalAssetsFlowData {
  totalAppreciation: number;
  totalLoanPayment: number;
  totalPurchaseOutlay: number;
  totalPurchaseMarketValue: number;
  totalSaleProceeds: number;
  totalSaleMarketValue: number;
  totalRealizedGains: number;
  totalInterest: number;
  totalPrincipalPaid: number;
  totalUnpaidInterest: number;
  totalDebtPaydown: number;
  totalSecuredDebtIncurred: number;
  totalDebtPayoff: number;
  perAssetData: Record<string, PhysicalAssetData>;
}

export type PhysicalAssetsData = PhysicalAssetsSnapshotData & PhysicalAssetsFlowData;

export interface PhysicalAssetData {
  id: string;
  name: string;
  assetType: PhysicalAssetType;
  marketValue: number;
  loanBalance: number;
  equity: number;
  paymentType: 'loan' | 'cash';
  appreciation: number;
  loanPayment: number;
  purchaseOutlay: number;
  purchaseMarketValue: number;
  saleProceeds: number;
  saleMarketValue: number;
  realizedGains: number;
  interest: number;
  principalPaid: number;
  unpaidInterest: number;
  debtPaydown: number;
  securedDebtIncurred: number;
  debtPayoff: number;
  isSold: boolean;
}

/** Collection of physical assets with lifecycle management */
export class PhysicalAssets {
  private readonly assets: PhysicalAsset[];

  /**
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   */
  constructor(data: PhysicalAssetInputs[], context: TimeBindingContext) {
    this.assets = data.map((asset) => new PhysicalAsset(asset, context));
  }

  getOwnedAssets(): PhysicalAsset[] {
    return this.assets.filter((asset) => asset.getOwnershipStatus() === 'owned');
  }

  getAssetsToSellThisPeriod(simulationState: SimulationState): PhysicalAsset[] {
    return this.assets.filter((asset) => asset.shouldSellThisPeriod(simulationState));
  }

  getAssetsToPurchaseThisPeriod(simulationState: SimulationState): PhysicalAsset[] {
    return this.assets.filter((asset) => asset.shouldPurchaseThisPeriod(simulationState));
  }

  getTotalMarketValue(): number {
    return this.assets.reduce((sum, asset) => sum + asset.getMarketValue(), 0);
  }

  getTotalLoanBalance(): number {
    return this.assets.reduce((sum, asset) => sum + asset.getLoanBalance(), 0);
  }

  getTotalEquity(): number {
    return this.assets.reduce((sum, asset) => sum + asset.getEquity(), 0);
  }
}

/** A single physical asset with appreciation, optional loan, and purchase/sale lifecycle */
export class PhysicalAsset {
  private id: string;
  private name: string;
  private assetType: PhysicalAssetType;
  private purchaseBinding: TimeBinding;
  private marketValue: number;
  private purchasePrice: number;
  private appreciationRate: number;
  private saleBinding: TimeBinding | undefined;
  private paymentMethod: PaymentMethodInputs;
  private loanBalance: number = 0;
  private loanPrincipal: number = 0;
  private nominalAPR: number = 0; // Store nominal APR (user input)
  private monthlyLoanPayment: number = 0; // Mutable, deflates over time
  private termMonths: number | undefined; // When set, the payment is derived from the term
  private termPayment: number | undefined; // The derived payment, solved once at the first payment
  private offsetAccountId: string | undefined; // Account whose balance offsets the interest
  private downPayment: number | undefined; // Scaled with the rest of the purchase price
  private ownershipStatus: OwnershipStatus;
  private hasSecuredDebtBeenIncurred: boolean;

  /**
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   */
  constructor(data: PhysicalAssetInputs, context: TimeBindingContext) {
    this.id = data.id;
    this.name = data.name;
    this.assetType = data.assetType;
    this.purchaseBinding = new TimeBinding(data.purchaseDate, undefined, context);
    this.saleBinding = data.saleDate === undefined ? undefined : new TimeBinding(data.saleDate, undefined, context);
    // A nominal price, market value and loan are expressed in the dollars of the purchase date,
    // so all of them are converted to the plan's real dollars with the same factor. Scaling them
    // together keeps the "down payment + loan balance = purchase price" identity intact.
    const amountScale = this.purchaseBinding.amountScale(data.amountBasis);
    this.marketValue = (data.marketValue ?? data.purchasePrice) * amountScale;
    this.purchasePrice = data.purchasePrice * amountScale;
    this.appreciationRate = data.appreciationRate / 100;
    this.paymentMethod = data.paymentMethod;

    if (data.paymentMethod.type === 'loan') {
      this.loanBalance = data.paymentMethod.loanBalance * amountScale;
      this.loanPrincipal = this.loanBalance;
      this.nominalAPR = data.paymentMethod.apr / 100;
      this.monthlyLoanPayment = data.paymentMethod.monthlyPayment * amountScale;
      this.termMonths = data.paymentMethod.termMonths;
      this.offsetAccountId = data.paymentMethod.offsetAccountId;
      this.downPayment = data.paymentMethod.downPayment === undefined ? undefined : data.paymentMethod.downPayment * amountScale;
    }

    // Assets with purchaseDate.type === 'now' are already owned (no purchase expense)
    // All other purchase date types start as pending
    this.ownershipStatus = data.purchaseDate.type === 'now' ? 'owned' : 'pending';
    this.hasSecuredDebtBeenIncurred = data.purchaseDate.type === 'now' && data.paymentMethod.type === 'loan';
  }

  /** Deflates the nominal loan payment to reflect real purchasing power loss.
   *  Must only be called on owned assets, after payment processing. */
  applyMonthlyInflation(monthlyInflationRate: number): void {
    if (this.paymentMethod.type === 'loan') {
      this.monthlyLoanPayment /= 1 + monthlyInflationRate;
    }
  }

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getAssetType(): PhysicalAssetType {
    return this.assetType;
  }

  getMarketValue(): number {
    return this.ownershipStatus !== 'owned' ? 0 : this.marketValue;
  }

  getLoanBalance(): number {
    return this.ownershipStatus !== 'owned' ? 0 : this.loanBalance;
  }

  getEquity(): number {
    return this.ownershipStatus !== 'owned' ? 0 : Math.max(0, this.marketValue - this.loanBalance);
  }

  getPaymentType(): 'loan' | 'cash' {
    return this.paymentMethod.type;
  }

  /** The loan term in months, when the plan states one; `undefined` for a payment-driven loan. */
  getTermMonths(): number | undefined {
    return this.termMonths;
  }

  /** The account whose balance offsets this loan's interest, when the plan names one. */
  getOffsetAccountId(): string | undefined {
    return this.offsetAccountId;
  }

  isSold(): boolean {
    return this.ownershipStatus === 'sold';
  }

  isPaidOff(): boolean {
    return this.ownershipStatus === 'owned' && this.loanBalance <= 0;
  }

  getOwnershipStatus(): OwnershipStatus {
    return this.ownershipStatus;
  }

  /** Applies monthly appreciation to the asset's market value */
  applyMonthlyAppreciation(): { monthlyAppreciation: number } {
    if (this.ownershipStatus !== 'owned') throw new Error('Asset is not owned');

    const monthlyRate = Math.pow(1 + this.appreciationRate, 1 / 12) - 1;
    const monthlyAppreciation = this.marketValue * monthlyRate;

    this.marketValue += monthlyAppreciation;
    return { monthlyAppreciation };
  }

  /**
   * Interest for the month, on the principal the offset account leaves exposed.
   *
   * An offset account is a deposit the lender nets against the mortgage before charging interest:
   * the loan principal is unchanged, but interest accrues on `principal - offset`. Both sides are
   * capped at the loan (`Math.max(0, …)`), so an offset larger than the mortgage charges no
   * interest rather than a negative amount — and the loan is not credited for the surplus.
   */
  private calculateMonthlyInterest(monthlyInflationRate: number, offsetBalance = 0): number {
    if (this.paymentMethod.type !== 'loan') return 0;

    const realRate = (1 + this.nominalAPR / 12) / (1 + monthlyInflationRate) - 1;
    const interestBearingPrincipal = Math.max(0, this.loanPrincipal - Math.max(0, offsetBalance));

    return interestBearingPrincipal * realRate;
  }

  /**
   * The month's payment and interest for an owned asset.
   *
   * @param monthlyInflationRate - The month's inflation, for the engine's real-rate convention.
   * @param offsetBalance - The named offset account's balance this month (0 for none); it reduces
   *   the interest charged, never the payment.
   */
  getMonthlyPaymentInfo(monthlyInflationRate: number, offsetBalance = 0): { monthlyPaymentDue: number; interest: number } {
    if (this.ownershipStatus !== 'owned') throw new Error('Asset is not owned');
    if (this.isPaidOff()) return { monthlyPaymentDue: 0, interest: 0 };

    // Derived once, at the first payment: every later month deflates it exactly as the schedule
    // does, so re-deriving here would undo that deflation.
    if (this.termMonths !== undefined && this.termPayment === undefined) {
      this.monthlyLoanPayment = this.resolveTermPayment(monthlyInflationRate);
    }

    // Interest can be negative when inflation > APR (real rate is negative)
    const interest = this.calculateMonthlyInterest(monthlyInflationRate, offsetBalance);
    const monthlyPaymentDue = Math.min(this.monthlyLoanPayment, this.loanBalance + interest);

    return { monthlyPaymentDue, interest };
  }

  /**
   * The monthly payment that clears this loan in exactly its term, under the engine's own
   * deflated recurrence (`amortization-schedule.ts`: interest first, then principal, with the
   * payment deflated by inflation every month). Solved once, at the first payment, from the plan's
   * own monthly inflation — which is the same rate the loop below deflates the payment by, so the
   * schedule and the engine cannot disagree about what month the loan ends.
   */
  private resolveTermPayment(monthlyInflationRate: number): number {
    if (this.termPayment !== undefined) return this.termPayment;

    // The engine's inflation is monthly; `computeLoanPayment` takes the annual assumption, so the
    // conversion is inverted here (the same geometric monthly rate `amortization-schedule.ts` uses).
    const annualInflationPercent = (Math.pow(1 + monthlyInflationRate, 12) - 1) * 100;
    this.termPayment = computeLoanPayment({
      principal: this.loanPrincipal,
      annualRatePercent: this.nominalAPR * 100,
      termMonths: this.termMonths!,
      annualInflationPercent,
    });

    return this.termPayment;
  }

  /** Applies a loan payment, allocating to interest then principal (simple interest) */
  applyLoanPayment(payment: number, interest: number): void {
    if (this.ownershipStatus !== 'owned') throw new Error('Asset is not owned');
    if (this.isPaidOff()) return;

    const unpaidPrevInterest = Math.max(0, this.loanBalance - this.loanPrincipal);
    let remainingPayment = payment;

    const paidCurrInterest = Math.min(remainingPayment, interest);
    remainingPayment -= paidCurrInterest;
    const unpaidCurrInterest = interest - paidCurrInterest;

    const paidPrevInterest = Math.min(remainingPayment, unpaidPrevInterest);
    remainingPayment -= paidPrevInterest;

    this.loanPrincipal = Math.max(0, this.loanPrincipal - remainingPayment);
    this.loanBalance = this.loanPrincipal + (unpaidPrevInterest - paidPrevInterest) + unpaidCurrInterest;
  }

  shouldSellThisPeriod(simulationState: SimulationState): boolean {
    if (this.ownershipStatus !== 'owned' || this.saleBinding === undefined) return false;
    return this.saleBinding.isActiveAt(simulationState);
  }

  /**
   * Sells the asset, paying off remaining loan and realizing gains
   * @returns Sale proceeds (net of loan), realized gains, market value, and debt paid off
   */
  sell(): { saleProceeds: number; realizedGains: number; saleMarketValue: number; debtPayoff: number } {
    if (this.ownershipStatus !== 'owned') throw new Error('Asset is not owned');

    const saleMarketValue = this.marketValue;
    const debtPayoff = this.loanBalance;
    const saleProceeds = saleMarketValue - debtPayoff;
    const realizedGains = saleMarketValue - this.purchasePrice;

    this.ownershipStatus = 'sold';

    return { saleProceeds, realizedGains, saleMarketValue, debtPayoff };
  }

  shouldPurchaseThisPeriod(simulationState: SimulationState): boolean {
    if (this.ownershipStatus !== 'pending') return false;
    return this.purchaseBinding.isActiveAt(simulationState);
  }

  /**
   * Purchases the asset, transitioning from pending to owned
   * @returns Cash outlay (down payment or full price) and market value at purchase
   */
  purchase(): { purchaseOutlay: number; purchaseMarketValue: number } {
    if (this.ownershipStatus !== 'pending') throw new Error('Asset is not pending');

    this.ownershipStatus = 'owned';

    const purchaseMarketValue = this.marketValue;
    const purchaseOutlay = this.paymentMethod.type === 'loan' ? (this.downPayment ?? 0) : this.purchasePrice;

    return { purchaseOutlay, purchaseMarketValue };
  }

  incurSecuredDebt(): number {
    if (this.ownershipStatus !== 'owned') throw new Error('Asset is not owned');
    if (this.hasSecuredDebtBeenIncurred) return 0;
    if (this.paymentMethod.type !== 'loan') return 0;

    this.hasSecuredDebtBeenIncurred = true;
    return this.loanBalance;
  }
}
