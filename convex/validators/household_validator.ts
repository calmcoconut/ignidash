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

/**
 * `community` is the California default for a `joint` item; `jointTenancy` is the exception.
 */
export const propertyRegimeValidator = v.union(v.literal('community'), v.literal('jointTenancy'));

/**
 * A member's optional ages (P1-P3). Absent means "inherit the plan-level timeline value", so a
 * v5 document — whose members carry only `id` and `role` — still validates and reads through
 * `resolveHouseholdMember` exactly as it did before the fields existed.
 */
export const householdValidator = v.object({
  members: v.array(
    v.object({
      id: v.string(),
      role: v.union(v.literal('primary'), v.literal('partner')),
      birthMonth: v.optional(v.number()),
      birthYear: v.optional(v.number()),
      lifeExpectancy: v.optional(v.number()),
    })
  ),
  // Dependent children for Social Security children's benefits (v20). Absent means none.
  children: v.optional(
    v.array(
      v.object({
        id: v.string(),
        name: v.optional(v.string()),
        birthMonth: v.number(),
        birthYear: v.number(),
        student: v.optional(v.boolean()),
      })
    )
  ),
});
