/**
 * Section 121 capital gains exclusion on primary residence sale — 2026 aliases.
 *
 * The values live in the 2026 federal ruleset (`./years/2026.ts`, table `section121Exclusion`).
 * These named exports are kept so pre-harness call sites and assertions keep working; new code
 * should resolve `getRules(year).tables.section121Exclusion.values`.
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { getRules } from './index';

export const SECTION_121_EXCLUSION: Record<FilingStatus, number> = getRules(2026).tables.section121Exclusion.values;
