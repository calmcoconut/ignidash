/**
 * Social Security benefit taxation thresholds by filing status — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `socialSecurityTaxation`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.socialSecurityTaxation.values`. The tax processor reads
 * each tier's `taxablePercentage` directly — no tier percentage is hard-coded there.
 */

import { getRules } from './index';
import type { SocialSecurityTaxThreshold } from './types';

export type { SocialSecurityTaxThreshold };

const SOCIAL_SECURITY_TAX_THRESHOLDS = getRules(2026).tables.socialSecurityTaxation.values;

export const SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE: SocialSecurityTaxThreshold[] = SOCIAL_SECURITY_TAX_THRESHOLDS.single;
export const SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY: SocialSecurityTaxThreshold[] =
  SOCIAL_SECURITY_TAX_THRESHOLDS.marriedFilingJointly;
export const SOCIAL_SECURITY_TAX_THRESHOLDS_HEAD_OF_HOUSEHOLD: SocialSecurityTaxThreshold[] =
  SOCIAL_SECURITY_TAX_THRESHOLDS.headOfHousehold;
