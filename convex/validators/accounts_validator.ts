import { v } from 'convex/values';

import { ownerValidator, propertyRegimeValidator } from './household_validator';

export const accountValidator = v.object({
  id: v.string(),
  name: v.string(),
  balance: v.number(),
  type: v.union(
    v.literal('savings'),
    v.literal('taxableBrokerage'),
    v.literal('roth401k'),
    v.literal('roth403b'),
    v.literal('rothIra'),
    v.literal('401k'),
    v.literal('403b'),
    v.literal('ira'),
    v.literal('hsa')
  ),
  percentBonds: v.optional(v.number()),
  costBasis: v.optional(v.number()),
  contributionBasis: v.optional(v.number()),
  // After-tax basis in a traditional IRA (Form 8606 lines 2/5). Optional because it is newer than
  // the table: absent means no after-tax basis, which is what every plan written before it had.
  // Only an `ira` reads it — the schema offers the field on that variant alone.
  nondeductibleBasis: v.optional(v.number()),
  syncedFinanceId: v.optional(v.string()),
  // Whose item this is (P1-P2). Absent means `primary`.
  owner: v.optional(ownerValidator),
  propertyRegime: v.optional(propertyRegimeValidator),
});
