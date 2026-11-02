/**
 * Two-way mapping between Convex documents (DB layer) and Zod-validated types (app layer).
 *
 * Convex stores plan data as flat arrays with optional fields shared across discriminated unions.
 * Zod schemas use stricter discriminated unions and id-keyed records. These transformers bridge
 * the two representations so the rest of the app only works with Zod types.
 *
 * Naming convention:
 *   - `xFromConvex` — Convex Doc → Zod input type
 *   - `xToConvex`   — Zod input type → Convex Doc
 */

import type { Doc } from '@/convex/_generated/dataModel';
import type { SimulationResult as ConvexSimulationResult } from '@/convex/validators/simulation_result_validator';

import { ChartDataExtractor } from '@/lib/calc/data-extractors/chart-data-extractor';
import type { PhaseName } from '@/lib/calc/phase';
import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';
import type { ContributionInputs, BaseContributionInputs } from '@/lib/schemas/inputs/contribution-form-schema';
import type { IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';
import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import type { DebtInputs } from '@/lib/schemas/inputs/debt-form-schema';
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import type { MarketAssumptionsInputs } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import type { TimelineInputs } from '@/lib/schemas/inputs/timeline-form-schema';
import type { TaxSettingsInputs } from '@/lib/schemas/inputs/tax-settings-form-schema';
import type { PrivacySettingsInputs } from '@/lib/schemas/inputs/privacy-settings-form-schema';
import type { SimulationSettingsInputs } from '@/lib/schemas/inputs/simulation-settings-form-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { AssetInputs } from '@/lib/schemas/finances/asset-form-schema';
import type { LiabilityInputs } from '@/lib/schemas/finances/liability-form-schema';
import type { GlidePathInputs } from '@/lib/schemas/inputs/glide-path-form-schema';
import type { MilestoneInputs } from '@/lib/schemas/inputs/milestone-form-schema';
import type { ConversionInputs } from '@/lib/schemas/inputs/conversion-form-schema';
import type { SeppScheduleInputs } from '@/lib/schemas/inputs/sepp-form-schema';
import type { JournalEntryInputs } from '@/lib/schemas/inputs/journal-form-schema';
import type { SimulationResult } from '@/lib/calc/simulation-engine';

// percentBonds is optional in Convex (not applicable to savings), but guaranteed by the
// Zod discriminated union for investment account types — hence the non-null assertions.
export function accountFromConvex(account: Doc<'plans'>['accounts'][number]): AccountInputs {
  const base = {
    id: account.id,
    name: account.name,
    balance: account.balance,
    syncedFinanceId: account.syncedFinanceId,
    owner: account.owner,
    propertyRegime: account.propertyRegime,
  };

  switch (account.type) {
    case 'savings':
      return { ...base, type: 'savings' };
    case 'taxableBrokerage':
      return {
        ...base,
        type: 'taxableBrokerage',
        percentBonds: account.percentBonds!,
        costBasis: account.costBasis,
        ...(account.distributeIncome === true ? { distributeIncome: true } : {}),
      };
    case 'roth401k':
    case 'roth403b':
    case 'rothIra':
      return { ...base, type: account.type, percentBonds: account.percentBonds!, contributionBasis: account.contributionBasis };
    case 'ira':
      // The one account type Form 8606 apportions. Absent stays absent: a plan with no after-tax
      // money must not read back as a stated zero basis, which is a different claim.
      return { ...base, type: 'ira', percentBonds: account.percentBonds!, nondeductibleBasis: account.nondeductibleBasis };
    case '401k':
    case '403b':
    case 'hsa':
      return { ...base, type: account.type, percentBonds: account.percentBonds! };
  }
}

// Flattens nested amount union ({ type, dollarAmount }) into top-level fields (contributionType, dollarAmount).
export function contributionFromConvex(contribution: Doc<'plans'>['contributionRules'][number]): ContributionInputs {
  const base = {
    id: contribution.id,
    accountId: contribution.accountId,
    rank: contribution.rank,
    maxBalance: contribution.maxBalance,
    incomeId: contribution.incomeId,
    disabled: contribution.disabled ?? false,
    employerMatch: contribution.employerMatch,
    enableMegaBackdoorRoth: contribution.enableMegaBackdoorRoth,
  };

  switch (contribution.amount.type) {
    case 'dollarAmount':
      return { ...base, contributionType: 'dollarAmount', dollarAmount: contribution.amount.dollarAmount };
    case 'percentRemaining':
      return { ...base, contributionType: 'percentRemaining', percentRemaining: contribution.amount.percentRemaining };
    case 'unlimited':
      return { ...base, contributionType: 'unlimited' };
  }
}

export function baseContributionFromConvex(baseContribution: Doc<'plans'>['baseContributionRule']): BaseContributionInputs {
  return { type: baseContribution.type };
}

export function taxSettingsFromConvex(taxSettings: Doc<'plans'>['taxSettings']): TaxSettingsInputs {
  // Absent stays absent: a plan that does not itemize must not read back as itemizing zeros.
  return {
    filingStatus: taxSettings.filingStatus,
    stateResidency: taxSettings.stateResidency,
    itemizedDeductions: taxSettings.itemizedDeductions,
    spouseQualifiesForSeniorDeduction: taxSettings.spouseQualifiesForSeniorDeduction,
    aca: taxSettings.aca,
    medicare: taxSettings.medicare,
  };
}

export function privacySettingsFromConvex(privacySettings: Doc<'plans'>['privacySettings']): PrivacySettingsInputs {
  return { isPrivate: privacySettings.isPrivate };
}

export function simulationSettingsFromConvex(simulationSettings: Doc<'plans'>['simulationSettings']): SimulationSettingsInputs {
  return { ...simulationSettings };
}

export function expenseFromConvex(expense: Doc<'plans'>['expenses'][number]): ExpenseInputs {
  return {
    id: expense.id,
    name: expense.name,
    amount: expense.amount,
    amountBasis: expense.amountBasis,
    owner: expense.owner,
    propertyRegime: expense.propertyRegime,
    frequency: expense.frequency,
    timeframe: { start: expense.timeframe.start, end: expense.timeframe.end },
    growth: expense.growth,
    disabled: expense.disabled ?? false,
    // Absent in the document means `false`: before the flag existed, no expense was essential.
    essential: expense.essential ?? false,
    // Absent in the document means `false`: before the flag existed, no expense was qualified medical.
    qualifiedMedical: expense.qualifiedMedical ?? false,
    // Absent in the document means `false`: before the flag existed, no expense was satisfied from IRA.
    satisfyFromIra: expense.satisfyFromIra ?? false,
  };
}

export function debtFromConvex(debt: NonNullable<Doc<'plans'>['debts']>[number]): DebtInputs {
  return {
    id: debt.id,
    name: debt.name,
    balance: debt.balance,
    apr: debt.apr,
    interestType: debt.interestType,
    compoundingFrequency: debt.compoundingFrequency,
    startDate: { ...debt.startDate },
    monthlyPayment: debt.monthlyPayment,
    amountBasis: debt.amountBasis,
    owner: debt.owner,
    propertyRegime: debt.propertyRegime,
    disabled: debt.disabled ?? false,
    syncedFinanceId: debt.syncedFinanceId,
  };
}

// Defaults: assetType → 'other', missing saleDate → 'atLifeExpectancy' (never sold).
// No defaults for `paymentMethod.termMonths`, `paymentMethod.offsetAccountId` or `propertyTax`:
// each one's absence is a statement (no term-driven payment, no offset, no property tax), so it is
// carried through as absent rather than filled in — see the v11 history in `plan-envelope.ts`.
export function physicalAssetFromConvex(physicalAsset: NonNullable<Doc<'plans'>['physicalAssets']>[number]): PhysicalAssetInputs {
  return {
    id: physicalAsset.id,
    name: physicalAsset.name,
    assetType: physicalAsset.assetType ?? 'other',
    purchaseDate: { ...physicalAsset.purchaseDate },
    purchasePrice: physicalAsset.purchasePrice,
    marketValue: physicalAsset.marketValue,
    appreciationRate: physicalAsset.appreciationRate,
    saleDate: physicalAsset.saleDate ? { ...physicalAsset.saleDate } : { type: 'atLifeExpectancy' },
    amountBasis: physicalAsset.amountBasis,
    owner: physicalAsset.owner,
    propertyRegime: physicalAsset.propertyRegime,
    // Absent `termMonths`: the monthly payment drives the loan, as before P1-P5.
    // Absent `offsetAccountId`: interest is charged on the whole principal.
    // Both stay absent rather than being written as `undefined`: nothing downstream defaults them.
    paymentMethod:
      physicalAsset.paymentMethod.type === 'loan'
        ? {
            type: 'loan',
            ...(physicalAsset.paymentMethod.downPayment !== undefined ? { downPayment: physicalAsset.paymentMethod.downPayment } : {}),
            loanBalance: physicalAsset.paymentMethod.loanBalance,
            apr: physicalAsset.paymentMethod.apr,
            monthlyPayment: physicalAsset.paymentMethod.monthlyPayment,
            ...(physicalAsset.paymentMethod.termMonths !== undefined ? { termMonths: physicalAsset.paymentMethod.termMonths } : {}),
            ...(physicalAsset.paymentMethod.offsetAccountId !== undefined
              ? { offsetAccountId: physicalAsset.paymentMethod.offsetAccountId }
              : {}),
          }
        : { type: 'cash' },
    // Absent `propertyTax`: the plan pays no property tax through the engine, as before P1-P5.
    ...(physicalAsset.propertyTax !== undefined ? { propertyTax: physicalAsset.propertyTax } : {}),
    syncedAssetId: physicalAsset.syncedAssetId,
    syncedLiabilityId: physicalAsset.syncedLiabilityId,
  };
}

export function incomeFromConvex(income: Doc<'plans'>['incomes'][number]): IncomeInputs {
  return {
    id: income.id,
    name: income.name,
    amount: income.amount,
    frequency: income.frequency,
    timeframe: { start: income.timeframe.start, end: income.timeframe.end },
    amountBasis: income.amountBasis,
    owner: income.owner,
    propertyRegime: income.propertyRegime,
    socialSecurity: income.socialSecurity,
    growth: income.growth,
    taxes: { incomeType: income.taxes.incomeType, withholding: income.taxes.withholding },
    disabled: income.disabled ?? false,
  };
}

export function marketAssumptionsFromConvex(marketAssumptions: Doc<'plans'>['marketAssumptions']): MarketAssumptionsInputs {
  return {
    stockReturn: marketAssumptions.stockReturn,
    stockYield: marketAssumptions.stockYield,
    bondReturn: marketAssumptions.bondReturn,
    bondYield: marketAssumptions.bondYield,
    cashReturn: marketAssumptions.cashReturn,
    inflationRate: marketAssumptions.inflationRate,
  };
}

// structuredClone to deep-copy nested TimePoint objects and avoid shared references with the Convex doc.
export function timelineFromConvex(timeline: Doc<'plans'>['timeline']): TimelineInputs | null {
  return timeline ? structuredClone(timeline) : null;
}

// Converts the full plan: arrays → id-keyed records, Convex unions → Zod discriminated unions.
export function simulatorFromConvex(plan: Doc<'plans'>): SimulatorInputs {
  const incomes = Object.fromEntries(plan.incomes.map((income) => [income.id, incomeFromConvex(income)]));
  const accounts = Object.fromEntries(plan.accounts.map((account) => [account.id, accountFromConvex(account)]));
  const glidePath = glidePathFromConvex(plan.glidePath);
  const expenses = Object.fromEntries(plan.expenses.map((expense) => [expense.id, expenseFromConvex(expense)]));
  const debts = Object.fromEntries((plan.debts ?? []).map((debt) => [debt.id, debtFromConvex(debt)]));
  const physicalAssets = Object.fromEntries((plan.physicalAssets ?? []).map((asset) => [asset.id, physicalAssetFromConvex(asset)]));
  const contributionRules = Object.fromEntries(plan.contributionRules.map((rule) => [rule.id, contributionFromConvex(rule)]));
  // Absent stays absent rather than becoming an `undefined` key: "no milestones" is one value from
  // the document to the engine (see `milestonesFromConvex`).
  const milestones = milestonesFromConvex(plan.milestones);
  const conversions = conversionsFromConvex(plan.conversions);
  const sepp = seppFromConvex(plan.sepp);
  const journal = journalFromConvex(plan.journal);

  return {
    timeline: timelineFromConvex(plan.timeline),
    incomes,
    accounts,
    glidePath,
    expenses,
    debts,
    physicalAssets,
    contributionRules,
    baseContributionRule: baseContributionFromConvex(plan.baseContributionRule),
    marketAssumptions: marketAssumptionsFromConvex(plan.marketAssumptions),
    taxSettings: taxSettingsFromConvex(plan.taxSettings),
    privacySettings: privacySettingsFromConvex(plan.privacySettings),
    simulationSettings: simulationSettingsFromConvex(plan.simulationSettings),
    ...(milestones === undefined ? {} : { milestones }),
    ...(conversions === undefined ? {} : { conversions }),
    ...(sepp === undefined ? {} : { sepp }),
    ...(journal === undefined ? {} : { journal }),
  };
}

export function assetFromConvex(asset: Doc<'finances'>['assets'][number]): AssetInputs {
  return { ...asset };
}

export function liabilityFromConvex(liability: Doc<'finances'>['liabilities'][number]): LiabilityInputs {
  return { ...liability };
}

export function glidePathFromConvex(glidePath: Doc<'plans'>['glidePath']): GlidePathInputs | undefined {
  return glidePath ? structuredClone(glidePath) : undefined;
}

/**
 * A plan's milestones, or `undefined` when the plan has none.
 *
 * `undefined` rather than `[]`, so "no milestones" stays one value all the way through: the field
 * is absent from a plan written before it existed, `simulatorFromConvex` omits it, and the engine
 * reads the omission as "evaluate nothing" — the same run a pre-P1-P7 build produced. `[]` would be
 * a second spelling of the same thing; the editor is the one place that wants a list, and it does
 * `?? []` (see `convex/milestones.ts`).
 */
export function milestonesFromConvex(milestones: Doc<'plans'>['milestones']): MilestoneInputs[] | undefined {
  return milestones ? structuredClone(milestones) : undefined;
}

/**
 * A plan's Roth conversions, or `undefined` when the plan has none.
 */
export function conversionsFromConvex(conversions: Doc<'plans'>['conversions']): ConversionInputs[] | undefined {
  return conversions ? structuredClone(conversions) : undefined;
}

/**
 * A plan's SEPP schedules, or `undefined` when the plan has none.
 */
export function seppFromConvex(sepp: Doc<'plans'>['sepp']): SeppScheduleInputs[] | undefined {
  return sepp ? structuredClone(sepp) : undefined;
}

/**
 * A plan's manual net-worth journal snapshots, or `undefined` when the plan has none (R11).
 */
export function journalFromConvex(journal: Doc<'plans'>['journal']): JournalEntryInputs[] | undefined {
  return journal ? structuredClone(journal) : undefined;
}

export function accountToConvex(account: AccountInputs): Doc<'plans'>['accounts'][number] {
  const base = {
    id: account.id,
    name: account.name,
    balance: account.balance,
    syncedFinanceId: account.syncedFinanceId,
    owner: account.owner,
    propertyRegime: account.propertyRegime,
  };

  switch (account.type) {
    case 'savings':
      return { ...base, type: 'savings' };
    case 'taxableBrokerage':
      return {
        ...base,
        type: 'taxableBrokerage',
        percentBonds: account.percentBonds,
        costBasis: account.costBasis,
        // Absent means reinvested, so only a payout is stored.
        ...(account.distributeIncome === true ? { distributeIncome: true } : {}),
      };
    case 'roth401k':
    case 'roth403b':
    case 'rothIra':
      return { ...base, type: account.type, percentBonds: account.percentBonds, contributionBasis: account.contributionBasis };
    case 'ira':
      return { ...base, type: 'ira', percentBonds: account.percentBonds, nondeductibleBasis: account.nondeductibleBasis };
    case '401k':
    case '403b':
    case 'hsa':
      return { ...base, type: account.type, percentBonds: account.percentBonds };
  }
}

// Re-nests flat contributionType/dollarAmount back into the amount union.
export function contributionToConvex(contribution: ContributionInputs): Doc<'plans'>['contributionRules'][number] {
  const base = {
    id: contribution.id,
    accountId: contribution.accountId,
    rank: contribution.rank,
    disabled: contribution.disabled ?? false,
    maxBalance: contribution.maxBalance,
    incomeId: contribution.incomeId,
    employerMatch: contribution.employerMatch,
    enableMegaBackdoorRoth: contribution.enableMegaBackdoorRoth,
  };

  switch (contribution.contributionType) {
    case 'dollarAmount':
      return { ...base, amount: { type: 'dollarAmount', dollarAmount: contribution.dollarAmount } };
    case 'percentRemaining':
      return { ...base, amount: { type: 'percentRemaining', percentRemaining: contribution.percentRemaining } };
    case 'unlimited':
      return { ...base, amount: { type: 'unlimited' } };
  }
}

export function baseContributionToConvex(baseContribution: BaseContributionInputs): Doc<'plans'>['baseContributionRule'] {
  return { type: baseContribution.type };
}

export function taxSettingsToConvex(taxSettings: TaxSettingsInputs): Doc<'plans'>['taxSettings'] {
  // A block of all zeros is stored as absent, because "absent" is what every reader means by "this
  // plan does not itemize" — writing zeros would say the same thing in a second dialect, and the
  // export envelope's v6 statement (absent = not itemized) would stop being true of new files.
  const entered = taxSettings.itemizedDeductions;
  const itemizes =
    entered !== undefined &&
    (entered.mortgageInterest > 0 || entered.charitable > 0 || entered.stateAndLocalTaxes > 0 || entered.medicalExpenses > 0);

  return {
    filingStatus: taxSettings.filingStatus,
    // California is the default, so only an explicit opt-out is stored; that keeps every existing
    // plan's document byte-identical until someone chooses otherwise.
    ...(taxSettings.stateResidency === 'none' ? { stateResidency: 'none' as const } : {}),
    ...(itemizes ? { itemizedDeductions: entered } : {}),
    ...(taxSettings.spouseQualifiesForSeniorDeduction === true ? { spouseQualifiesForSeniorDeduction: true } : {}),
    ...(taxSettings.aca?.optIn ? { aca: taxSettings.aca } : {}),
    // Absent means enrolment at 65 with no base premiums, so only a setting that says something
    // else is stored.
    ...(taxSettings.medicare !== undefined && (taxSettings.medicare.includePremiums || taxSettings.medicare.enrollmentAge !== undefined)
      ? { medicare: taxSettings.medicare }
      : {}),
  };
}

export function privacySettingsToConvex(privacySettings: PrivacySettingsInputs): Doc<'plans'>['privacySettings'] {
  return { isPrivate: privacySettings.isPrivate };
}

export function simulationSettingsToConvex(simulationSettings: SimulationSettingsInputs): Doc<'plans'>['simulationSettings'] {
  return { ...simulationSettings };
}

export function expenseToConvex(expense: ExpenseInputs): Doc<'plans'>['expenses'][number] {
  return {
    id: expense.id,
    name: expense.name,
    amount: expense.amount,
    amountBasis: expense.amountBasis,
    owner: expense.owner,
    propertyRegime: expense.propertyRegime,
    frequency: expense.frequency,
    timeframe: { start: expense.timeframe.start, end: expense.timeframe.end },
    growth: expense.growth,
    disabled: expense.disabled ?? false,
    // Stored only when it is a real statement, so an untouched expense keeps the document it had.
    ...(expense.essential === true ? { essential: true } : {}),
    ...(expense.qualifiedMedical === true ? { qualifiedMedical: true } : {}),
    ...(expense.satisfyFromIra === true ? { satisfyFromIra: true } : {}),
  };
}

export function debtToConvex(debt: DebtInputs): NonNullable<Doc<'plans'>['debts']>[number] {
  return {
    id: debt.id,
    name: debt.name,
    balance: debt.balance,
    apr: debt.apr,
    interestType: debt.interestType,
    compoundingFrequency: debt.compoundingFrequency,
    startDate: { ...debt.startDate },
    monthlyPayment: debt.monthlyPayment,
    amountBasis: debt.amountBasis,
    owner: debt.owner,
    propertyRegime: debt.propertyRegime,
    disabled: debt.disabled ?? false,
    syncedFinanceId: debt.syncedFinanceId,
  };
}

export function physicalAssetToConvex(physicalAsset: PhysicalAssetInputs): NonNullable<Doc<'plans'>['physicalAssets']>[number] {
  return {
    id: physicalAsset.id,
    name: physicalAsset.name,
    assetType: physicalAsset.assetType,
    purchaseDate: { ...physicalAsset.purchaseDate },
    purchasePrice: physicalAsset.purchasePrice,
    marketValue: physicalAsset.marketValue,
    appreciationRate: physicalAsset.appreciationRate,
    saleDate: physicalAsset.saleDate ? { ...physicalAsset.saleDate } : undefined,
    amountBasis: physicalAsset.amountBasis,
    owner: physicalAsset.owner,
    propertyRegime: physicalAsset.propertyRegime,
    // Absent `termMonths`: the monthly payment drives the loan, as before P1-P5.
    // Absent `offsetAccountId`: interest is charged on the whole principal.
    // Both stay absent rather than being written as `undefined`: nothing downstream defaults them.
    paymentMethod:
      physicalAsset.paymentMethod.type === 'loan'
        ? {
            type: 'loan',
            ...(physicalAsset.paymentMethod.downPayment !== undefined ? { downPayment: physicalAsset.paymentMethod.downPayment } : {}),
            loanBalance: physicalAsset.paymentMethod.loanBalance,
            apr: physicalAsset.paymentMethod.apr,
            monthlyPayment: physicalAsset.paymentMethod.monthlyPayment,
            ...(physicalAsset.paymentMethod.termMonths !== undefined ? { termMonths: physicalAsset.paymentMethod.termMonths } : {}),
            ...(physicalAsset.paymentMethod.offsetAccountId !== undefined
              ? { offsetAccountId: physicalAsset.paymentMethod.offsetAccountId }
              : {}),
          }
        : { type: 'cash' },
    // Absent `propertyTax`: the plan pays no property tax through the engine, as before P1-P5.
    ...(physicalAsset.propertyTax !== undefined
      ? {
          propertyTax: {
            ...(physicalAsset.propertyTax.ratePercent !== undefined ? { ratePercent: physicalAsset.propertyTax.ratePercent } : {}),
            ...(physicalAsset.propertyTax.annualAmount !== undefined ? { annualAmount: physicalAsset.propertyTax.annualAmount } : {}),
          },
        }
      : {}),
    syncedAssetId: physicalAsset.syncedAssetId,
    syncedLiabilityId: physicalAsset.syncedLiabilityId,
  };
}

export function incomeToConvex(income: IncomeInputs): Doc<'plans'>['incomes'][number] {
  return {
    id: income.id,
    name: income.name,
    amount: income.amount,
    frequency: income.frequency,
    timeframe: { start: income.timeframe.start, end: income.timeframe.end },
    amountBasis: income.amountBasis,
    owner: income.owner,
    propertyRegime: income.propertyRegime,
    socialSecurity: income.socialSecurity,
    growth: income.growth,
    taxes: { incomeType: income.taxes.incomeType, withholding: income.taxes.withholding },
    disabled: income.disabled ?? false,
  };
}

export function marketAssumptionsToConvex(marketAssumptions: MarketAssumptionsInputs): Doc<'plans'>['marketAssumptions'] {
  return {
    stockReturn: marketAssumptions.stockReturn,
    stockYield: marketAssumptions.stockYield,
    bondReturn: marketAssumptions.bondReturn,
    bondYield: marketAssumptions.bondYield,
    cashReturn: marketAssumptions.cashReturn,
    inflationRate: marketAssumptions.inflationRate,
  };
}

export function timelineToConvex(timeline: TimelineInputs | null): Doc<'plans'>['timeline'] {
  return timeline ? structuredClone(timeline) : null;
}

// Coerces empty-string URLs to undefined so Convex doesn't store "".
export function assetToConvex(asset: AssetInputs): Doc<'finances'>['assets'][number] {
  return { ...asset, url: asset.url === '' ? undefined : asset.url };
}

export function liabilityToConvex(liability: LiabilityInputs): Doc<'finances'>['liabilities'][number] {
  return { ...liability, url: liability.url === '' ? undefined : liability.url };
}

export function glidePathToConvex(glidePath: GlidePathInputs): NonNullable<Doc<'plans'>['glidePath']> {
  return structuredClone(glidePath);
}

/**
 * The plan's milestones in the stored shape.
 *
 * One milestone maps field-for-field: the condition is the core's own expression, so nothing is
 * flattened or re-keyed here. The stored expression is depth-bounded (three nested groups — a
 * Convex validator cannot be cyclic) while the app schema accepts any depth the evaluator does; the
 * editor builds one group, and a hand-written file deeper than the bound is refused by the import
 * validator rather than written to the database.
 */
export function milestonesToConvex(milestones: MilestoneInputs[]): NonNullable<Doc<'plans'>['milestones']> {
  return structuredClone(milestones) as NonNullable<Doc<'plans'>['milestones']>;
}

export function conversionsToConvex(conversions: ConversionInputs[]): NonNullable<Doc<'plans'>['conversions']> {
  return structuredClone(conversions) as NonNullable<Doc<'plans'>['conversions']>;
}

export function seppToConvex(sepp: SeppScheduleInputs[]): NonNullable<Doc<'plans'>['sepp']> {
  return structuredClone(sepp) as NonNullable<Doc<'plans'>['sepp']>;
}

export function journalToConvex(journal: JournalEntryInputs[]): NonNullable<Doc<'plans'>['journal']> {
  return structuredClone(journal) as NonNullable<Doc<'plans'>['journal']>;
}

// Flattens multiple chart data extractors (net worth, cash flow, taxes, contributions,
// withdrawals, returns) into a single flat row per year for LLM API consumption.
// Skips the first net worth data point (initial state before year 1).
export function simulationResultToConvex(simulation: SimulationResult): ConvexSimulationResult {
  const netWorthData = ChartDataExtractor.extractSingleSimulationNetWorthData(simulation).slice(1);
  const cashFlowData = ChartDataExtractor.extractSingleSimulationCashFlowData(simulation);
  const taxesData = ChartDataExtractor.extractSingleSimulationTaxesData(simulation);
  const contributionsData = ChartDataExtractor.extractSingleSimulationContributionsData(simulation);
  const withdrawalsData = ChartDataExtractor.extractSingleSimulationWithdrawalsData(simulation);
  const returnsData = ChartDataExtractor.extractSingleSimulationReturnsData(simulation);

  const phaseLabels = { accumulation: 'accum', retirement: 'retire' } as const;
  const toPhaseLabel = (name: PhaseName | undefined): 'accum' | 'retire' | null => (name ? phaseLabels[name] : null);

  const simulationResult: ConvexSimulationResult['simulationResult'] = [];
  for (let i = 0; i < netWorthData.length; i++) {
    const phase = simulation.data[i + 1]?.phase;

    simulationResult.push({
      age: netWorthData[i].age,
      phaseName: toPhaseLabel(phase?.name),

      netWorth: netWorthData[i].netWorth,
      stockHoldings: netWorthData[i].stockHoldings,
      bondHoldings: netWorthData[i].bondHoldings,
      cashHoldings: netWorthData[i].cashHoldings,
      taxableValue: netWorthData[i].taxableValue,
      taxDeferredValue: netWorthData[i].taxDeferredValue,
      taxFreeValue: netWorthData[i].taxFreeValue,
      cashSavings: netWorthData[i].cashSavings,
      totalValue: netWorthData[i].stockHoldings + netWorthData[i].bondHoldings + netWorthData[i].cashHoldings,

      earnedIncome: cashFlowData[i].earnedIncome,
      socialSecurityIncome: cashFlowData[i].socialSecurityIncome,
      taxFreeIncome: cashFlowData[i].taxFreeIncome,
      retirementDistributions: taxesData[i].taxableRetirementDistributions,
      interestIncome: taxesData[i].taxableInterestIncome,
      realizedGains: taxesData[i].realizedGains,
      dividendIncome: taxesData[i].taxableDividendIncome,
      taxesAndPenalties: cashFlowData[i].taxesAndPenalties,
      expenses: cashFlowData[i].expenses,
      surplusDeficit: cashFlowData[i].surplusDeficit,
      savingsRate: cashFlowData[i].savingsRate,
      netCashFlow: cashFlowData[i].netCashFlow,

      grossIncome: taxesData[i].grossIncome,
      adjustedGrossIncome: taxesData[i].adjustedGrossIncome,
      taxableIncome: taxesData[i].taxableIncome,
      ficaTax: taxesData[i].annualFicaTax,
      federalIncomeTax: taxesData[i].annualFederalIncomeTax,
      capitalGainsTax: taxesData[i].annualCapitalGainsTax,
      niit: taxesData[i].annualNiit,
      earlyWithdrawalPenalties: taxesData[i].annualEarlyWithdrawalPenalties,
      netInvestmentIncome: taxesData[i].netInvestmentIncome,
      effectiveFederalIncomeTaxRate: taxesData[i].effectiveFederalIncomeTaxRate,
      topMarginalFederalIncomeTaxRate: taxesData[i].topMarginalFederalIncomeTaxRate,
      effectiveCapitalGainsTaxRate: taxesData[i].effectiveCapitalGainsTaxRate,
      topMarginalCapitalGainsTaxRate: taxesData[i].topMarginalCapitalGainsTaxRate,
      taxDeductibleContributions: taxesData[i].taxDeductibleContributions,
      capitalLossDeduction: taxesData[i].capitalLossDeduction,

      totalContributions: contributionsData[i].annualContributions,
      taxableContributions: contributionsData[i].taxableContributions,
      taxDeferredContributions: contributionsData[i].taxDeferredContributions,
      taxFreeContributions: contributionsData[i].taxFreeContributions,
      cashContributions: contributionsData[i].cashSavingsContributions,
      employerMatch: contributionsData[i].annualEmployerMatch,

      totalWithdrawals: withdrawalsData[i].annualWithdrawals,
      taxableWithdrawals: withdrawalsData[i].taxableWithdrawals,
      taxDeferredWithdrawals: withdrawalsData[i].taxDeferredWithdrawals,
      taxFreeWithdrawals: withdrawalsData[i].taxFreeWithdrawals,
      cashWithdrawals: withdrawalsData[i].cashSavingsWithdrawals,
      requiredMinimumDistributions: withdrawalsData[i].annualRequiredMinimumDistributions,
      // The year's Roth conversions, from the same `portfolio.conversions` the withdrawals chart
      // reads (absent means no conversion, so it flattens to 0). Named for the chart field it
      // mirrors so the two surfaces cannot drift: the assistant could patch a conversion but could
      // not see its effect in any figure it was given.
      annualRothConversions: withdrawalsData[i].annualRothConversions,
      earlyWithdrawals: withdrawalsData[i].annualEarlyWithdrawals,
      rothEarningsWithdrawals: withdrawalsData[i].annualRothEarningsWithdrawals,
      withdrawalRate: withdrawalsData[i].withdrawalRate,

      unsecuredDebtBalance: netWorthData[i].unsecuredDebtBalance,
      securedDebtBalance: netWorthData[i].securedDebtBalance,
      debtPayments: cashFlowData[i].debtPayments,
      debtPaydown: netWorthData[i].annualDebtPaydown,
      debtPayoff: netWorthData[i].annualDebtPayoff,
      debtIncurred: netWorthData[i].annualDebtIncurred,

      assetValue: netWorthData[i].assetValue,
      assetEquity: netWorthData[i].assetEquity,
      assetPurchaseOutlay: cashFlowData[i].assetPurchaseOutlay,
      assetSaleProceeds: cashFlowData[i].assetSaleProceeds,
      assetAppreciation: netWorthData[i].annualAssetAppreciation,

      realStockReturnRate: returnsData[i].realStockReturnRate,
      realBondReturnRate: returnsData[i].realBondReturnRate,
      realCashReturnRate: returnsData[i].realCashReturnRate,
      inflationRate: returnsData[i].inflationRate,
      annualStockGain: returnsData[i].annualStockGain,
      annualBondGain: returnsData[i].annualBondGain,
      annualCashGain: returnsData[i].annualCashGain,
      totalAnnualGains: returnsData[i].totalAnnualGains,
    });
  }

  const federalIncomeTaxBrackets: ConvexSimulationResult['federalIncomeTaxBrackets'] = taxesData[0].federalIncomeTaxBrackets;
  const capitalGainsTaxBrackets: ConvexSimulationResult['capitalGainsTaxBrackets'] = taxesData[0].capitalGainsTaxBrackets;
  const standardDeduction: ConvexSimulationResult['standardDeduction'] = taxesData[0].standardDeduction;
  const niitThreshold: ConvexSimulationResult['niitThreshold'] = taxesData[0].niitThreshold;

  return { simulationResult, federalIncomeTaxBrackets, capitalGainsTaxBrackets, standardDeduction, niitThreshold };
}

export function arrayToRecord<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function recordToArray<T>(record: Record<string, T>): T[] {
  return Object.values(record);
}
