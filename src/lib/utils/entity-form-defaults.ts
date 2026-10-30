/**
 * New-entity defaults for the four simulator entity dialogs.
 *
 * Each dialog builds its "new item" form state here instead of inline, so a test can submit
 * exactly what an untouched dialog submits. The two P1-P1 controls (`amountBasis` and the
 * `everyNYears` cadence) are deliberately absent: an untouched dialog keeps today's payload,
 * where a plan's amounts are real and nothing repeats, and the readers apply those defaults.
 */

import type { DebtInputs } from '@/lib/schemas/inputs/debt-form-schema';
import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';
import type { IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';

import { defaultWithholding } from '@/lib/schemas/inputs/income-form-schema';

export const newIncomeDefaults = (numIncomes: number) =>
  ({
    name: 'Income ' + (numIncomes + 1),
    id: '',
    owner: 'primary',
    frequency: 'yearly',
    timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
    growth: { growthRate: 0 },
    taxes: { incomeType: 'wage', withholding: defaultWithholding('wage') },
  }) as const satisfies Partial<IncomeInputs>;

export const newExpenseDefaults = (numExpenses: number) =>
  ({
    name: 'Expense ' + (numExpenses + 1),
    id: '',
    owner: 'primary',
    frequency: 'yearly',
    timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    growth: { growthRate: 0 },
  }) as const satisfies Partial<ExpenseInputs>;

export const newDebtDefaults = (numDebts: number) =>
  ({
    id: '',
    owner: 'primary',
    name: 'Debt ' + (numDebts + 1),
    apr: 24,
    interestType: 'compound',
    compoundingFrequency: 'daily',
    startDate: { type: 'now' },
  }) as const satisfies Partial<DebtInputs>;

export const newPhysicalAssetDefaults = (numPhysicalAssets: number) =>
  ({
    id: '',
    owner: 'primary',
    name: 'Asset ' + (numPhysicalAssets + 1),
    assetType: 'other',
    purchaseDate: { type: 'now' },
    appreciationRate: 1,
    saleDate: { type: 'atLifeExpectancy' },
    paymentMethod: { type: 'cash' },
  }) as const satisfies Partial<PhysicalAssetInputs>;
