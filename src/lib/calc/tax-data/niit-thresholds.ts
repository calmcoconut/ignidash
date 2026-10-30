/**
 * Net Investment Income Tax (NIIT) rate and thresholds by filing status — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `netInvestmentIncomeTax`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.netInvestmentIncomeTax.values`.
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { getRules } from './index';

const NET_INVESTMENT_INCOME_TAX = getRules(2026).tables.netInvestmentIncomeTax.values;

/** 3.8% surtax on net investment income above the applicable threshold */
export const NIIT_RATE = NET_INVESTMENT_INCOME_TAX.rate;

export const NIIT_THRESHOLDS: Record<FilingStatus, number> = NET_INVESTMENT_INCOME_TAX.thresholds;
