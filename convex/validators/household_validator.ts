import { v } from 'convex/values';

/**
 * Ownership and household validators (parity plan P1-P2).
 *
 * These mirror `src/lib/schemas/inputs/household-schema.ts` field for field: the export guard
 * is derived from these validators, so a divergence shows up as an import that cannot read
 * what the app writes. Every field is optional, so plans stored before this module existed
 * still validate and read as `primary` / one person.
 */

/** `primary`, `partner` or `joint` (California community property unless tagged). */
export const ownerValidator = v.union(v.literal('primary'), v.literal('partner'), v.literal('joint'));

/** `community` is the California default for a `joint` item; `jointTenancy` is the exception. */
export const propertyRegimeValidator = v.union(v.literal('community'), v.literal('jointTenancy'));

export const householdValidator = v.object({
  members: v.array(
    v.object({
      id: v.string(),
      role: v.union(v.literal('primary'), v.literal('partner')),
    })
  ),
});
