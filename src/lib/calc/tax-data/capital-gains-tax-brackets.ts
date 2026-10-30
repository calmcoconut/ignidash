/**
 * Federal long-term capital gains tax brackets by filing status — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `capitalGainsTaxBrackets`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.capitalGainsTaxBrackets.values`.
 */

import { getRules } from './index';
import type { CapitalGainsTaxBracket } from './types';

export type { CapitalGainsTaxBracket };

const CAPITAL_GAINS_TAX_BRACKETS = getRules(2026).tables.capitalGainsTaxBrackets.values;

export const CAPITAL_GAINS_TAX_BRACKETS_SINGLE: CapitalGainsTaxBracket[] = CAPITAL_GAINS_TAX_BRACKETS.single;
export const CAPITAL_GAINS_TAX_BRACKETS_MARRIED_FILING_JOINTLY: CapitalGainsTaxBracket[] = CAPITAL_GAINS_TAX_BRACKETS.marriedFilingJointly;
export const CAPITAL_GAINS_TAX_BRACKETS_HEAD_OF_HOUSEHOLD: CapitalGainsTaxBracket[] = CAPITAL_GAINS_TAX_BRACKETS.headOfHousehold;
