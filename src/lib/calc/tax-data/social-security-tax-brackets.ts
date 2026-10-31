/**
 * Social Security benefit taxation thresholds by filing status — 2026 aliases.
 *
 * Only the per-status tier arrays: the table's other half, `taxableFromFirstDollar`, is a property
 * of the computation rather than of a tier list, and the tax processor reads it from the ruleset.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `socialSecurityTaxation`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.socialSecurityTaxation.values`. The tax processor reads
 * each tier's `taxablePercentage` directly — no tier percentage is hard-coded there.
 */

import { getRules } from './index';
import type { SocialSecurityTaxThreshold } from './types';

export type { SocialSecurityTaxThreshold };

const SOCIAL_SECURITY_TAX_THRESHOLDS = getRules(2026).tables.socialSecurityTaxation.values.tiers;

export const SOCIAL_SECURITY_TAX_THRESHOLDS_SINGLE: readonly SocialSecurityTaxThreshold[] = SOCIAL_SECURITY_TAX_THRESHOLDS.single;
export const SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_JOINTLY: readonly SocialSecurityTaxThreshold[] =
  SOCIAL_SECURITY_TAX_THRESHOLDS.marriedFilingJointly;
export const SOCIAL_SECURITY_TAX_THRESHOLDS_HEAD_OF_HOUSEHOLD: readonly SocialSecurityTaxThreshold[] =
  SOCIAL_SECURITY_TAX_THRESHOLDS.headOfHousehold;
export const SOCIAL_SECURITY_TAX_THRESHOLDS_MARRIED_FILING_SEPARATELY: readonly SocialSecurityTaxThreshold[] =
  SOCIAL_SECURITY_TAX_THRESHOLDS.marriedFilingSeparately;
