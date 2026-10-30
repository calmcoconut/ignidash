/**
 * Federal standard deduction amounts by filing status — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `standardDeduction`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.standardDeduction.values`.
 */

import { getRules } from './index';

const STANDARD_DEDUCTION = getRules(2026).tables.standardDeduction.values;

export const STANDARD_DEDUCTION_SINGLE = STANDARD_DEDUCTION.single;
export const STANDARD_DEDUCTION_MARRIED_FILING_JOINTLY = STANDARD_DEDUCTION.marriedFilingJointly;
export const STANDARD_DEDUCTION_HEAD_OF_HOUSEHOLD = STANDARD_DEDUCTION.headOfHousehold;
