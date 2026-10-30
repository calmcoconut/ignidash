/**
 * Federal income tax brackets by filing status — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `incomeTaxBrackets`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.incomeTaxBrackets.values`.
 */

import { getRules } from './index';
import type { FederalIncomeTaxBracket } from './types';

export type { FederalIncomeTaxBracket };

const FEDERAL_INCOME_TAX_BRACKETS = getRules(2026).tables.incomeTaxBrackets.values;

export const FEDERAL_INCOME_TAX_BRACKETS_SINGLE: FederalIncomeTaxBracket[] = FEDERAL_INCOME_TAX_BRACKETS.single;
export const FEDERAL_INCOME_TAX_BRACKETS_MARRIED_FILING_JOINTLY: FederalIncomeTaxBracket[] =
  FEDERAL_INCOME_TAX_BRACKETS.marriedFilingJointly;
export const FEDERAL_INCOME_TAX_BRACKETS_HEAD_OF_HOUSEHOLD: FederalIncomeTaxBracket[] = FEDERAL_INCOME_TAX_BRACKETS.headOfHousehold;
