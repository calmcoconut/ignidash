/**
 * Medicare IRMAA tier resolution (42 U.S.C. §1395r(i)).
 *
 * The table itself lives in the ruleset (`tables.medicareIrmaa`), so the tax engine can charge the
 * surcharge and the analytics can describe it from one source. This module owns the one piece both
 * need: which tier a MAGI lands in.
 *
 * CMS publishes the tiers as "greater than X and less than or equal to Y", with the top tier written
 * as "greater than or equal to $500,000". The published X is kept as each tier's `min`, so a lookup
 * is `magi > min` — except for the **top** tier, which applies *at* its threshold. Storing X + 1
 * instead would work too, but then the stored number would not be the published one, and the annual
 * data diff could not be reviewed against the CMS table.
 */

import type { MedicareIrmaaTier } from './types';

/**
 * The index of the tier a MAGI falls in. `0` is the standard premium (no surcharge).
 *
 * Hand check against the 2026 single column ($0 / $109,000 / $137,000 / $171,000 / $205,000 /
 * $500,000): 109,000 → 0; 109,001 → 1; 205,001 → 4; 499,999 → 4; 500,000 → 5; 1,000,000 → 5.
 */
export function irmaaTierFor(magi: number, tiers: readonly MedicareIrmaaTier[]): number {
  const last = tiers.length - 1;
  let found = 0;

  tiers.forEach((tier, index) => {
    const applies = index === last ? magi >= tier.min : magi > tier.min;
    if (applies) found = index;
  });

  return found;
}
