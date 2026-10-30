/**
 * Ownership and household (parity plan P1-P2, decisions E1/E2/F10).
 *
 * A plan belongs to one household: one person, or two. Every entity that holds value or moves
 * money — accounts, incomes, expenses, debts, physical assets — records *whose* it is with an
 * `owner` of `primary`, `partner` or `joint`.
 *
 * California is a community-property state (E2), so `joint` means **community property** unless
 * the item is tagged otherwise: `propertyRegime: 'jointTenancy'` marks joint property that is
 * not community property. `jointTenancy` exists only to carry that distinction; it is not a
 * separate ownership model.
 *
 * F10 — what is deliberately NOT modelled here:
 * - transmutation agreements (a couple legally converting separate property into community
 *   property, or the reverse);
 * - quasi-community property (property acquired in another state that California would treat
 *   as community property on divorce or death).
 * Both are out of scope for this plan, not merely unimplemented: nothing in the schema reserves
 * space for them, so adding either later is a new field, not a reinterpretation of this one.
 *
 * Every field is optional. A stored plan written before this module existed has no `owner`,
 * no `propertyRegime` and no `household`; readers apply `owner ?? 'primary'` and treat a
 * missing household as one person, so old plans load and simulate exactly as they did.
 *
 * ## Member ages (P1-P3)
 *
 * A member may carry its own `birthMonth`, `birthYear` and `lifeExpectancy`, because a couple
 * is two people of two ages: each member's own birth year decides that member's RMD age, and
 * the run lasts until the *longest* lived member's expectancy. Every one of the three is
 * optional, and an absent field falls back **field by field** to the plan-level timeline value:
 *
 * | stored on the member | resolved value |
 * | --- | --- |
 * | `birthMonth` + `birthYear` | the member's own date |
 * | neither | the plan's `birthMonth`/`birthYear`, i.e. the primary's |
 * | `lifeExpectancy` | the member's own expectancy |
 * | absent | the plan's `lifeExpectancy` |
 *
 * The plan-level fields are the primary member's own calendar facts, so a household of one
 * holding no member ages resolves to exactly the plan's values — that is what keeps a
 * single-member plan's numbers unchanged. A *partner* that stores no ages therefore resolves
 * to the primary's, which models the couple as two people of the same age rather than
 * inventing an age for them; the timeline drawer asks for the partner's ages, and a plan that
 * omits them keeps working (the run simply has no survivor window).
 *
 * Absence is never read as an error and never as zero: a zero birth year would make the member
 * older than the calendar, which is the opposite of the fallback.
 */

import { z } from 'zod';

export const ownerSchema = z.enum(['primary', 'partner', 'joint']);

export type Owner = z.infer<typeof ownerSchema>;

/**
 * Which body of law governs a `joint` item. `community` (the California default) splits it
 * 50/50 between the two members; `jointTenancy` is a tagged exception.
 */
export const propertyRegimeSchema = z.enum(['community', 'jointTenancy']);

export type PropertyRegime = z.infer<typeof propertyRegimeSchema>;

/** The two plan members. There is no third role: an account is the only tenant (E1). */
export const householdMemberRoleSchema = z.enum(['primary', 'partner']);

export type HouseholdMemberRole = z.infer<typeof householdMemberRoleSchema>;

export const householdMemberSchema = z.object({
  /** Stable id, so later items can reference a member (per-member RMD age, survivor rules). */
  id: z.string().min(1),
  role: householdMemberRoleSchema,
  /**
   * The member's own birth date. Optional and stored as a pair: a member either knows its own
   * birthday or inherits the plan's (see `resolveHouseholdMember`), never half of each.
   */
  birthMonth: z.number().int().min(1).max(12).optional(),
  birthYear: z.number().int().min(1925).max(2025).optional(),
  /** The member's own life expectancy, i.e. the age at which this member dies. */
  lifeExpectancy: z.number().int().min(50).max(110).optional(),
});

export type HouseholdMember = z.infer<typeof householdMemberSchema>;

/**
 * Who is in the plan. `members` has at most two entries and each role at most once, so a plan
 * cannot claim two partners or an empty household.
 */
export const householdSchema = z
  .object({
    members: z.array(householdMemberSchema).min(1, 'A household needs at least one member').max(2, 'A household has at most two members'),
  })
  .refine((data) => new Set(data.members.map((member) => member.role)).size === data.members.length, {
    message: 'Each household member must have a distinct role',
    path: ['members'],
  })
  .refine((data) => data.members.every((member) => (member.birthMonth === undefined) === (member.birthYear === undefined)), {
    message: "A member's birth month and birth year go together",
    path: ['members'],
  });

export type Household = z.infer<typeof householdSchema>;

/** The household of a plan that predates this module: one person, the plan's owner. */
export const SINGLE_MEMBER_HOUSEHOLD: Household = { members: [{ id: 'primary', role: 'primary' }] };

/**
 * The calendar facts the plan timeline carries: the primary member's own birth date and
 * life expectancy. They are the fallback every member without its own ages inherits.
 */
export interface PlanMemberAges {
  readonly birthMonth: number;
  readonly birthYear: number;
  readonly lifeExpectancy: number;
}

/** A member with every absent age filled from the plan, ready for the engine to use. */
export interface ResolvedHouseholdMember extends PlanMemberAges {
  readonly role: HouseholdMemberRole;
  /** True when the member stored at least one age of its own rather than inheriting it. */
  readonly hasStoredAges: boolean;
}

/** The members of a plan's household; a plan with no stored household is one person. */
export const householdMembersOf = (household: Household | undefined): readonly HouseholdMember[] =>
  household?.members ?? SINGLE_MEMBER_HOUSEHOLD.members;

/**
 * A member's own ages, with every absent field filled from the plan-level timeline values.
 *
 * Field by field rather than all-or-nothing: a member that stores a life expectancy but no birth
 * date is a real case ("same age as the plan, different horizon"), and refusing to mix would
 * force the user to restate the primary's birthday on the partner.
 */
export const resolveHouseholdMember = (member: HouseholdMember, planAges: PlanMemberAges): ResolvedHouseholdMember => ({
  role: member.role,
  birthMonth: member.birthMonth ?? planAges.birthMonth,
  birthYear: member.birthYear ?? planAges.birthYear,
  lifeExpectancy: member.lifeExpectancy ?? planAges.lifeExpectancy,
  hasStoredAges: member.birthMonth !== undefined || member.birthYear !== undefined || member.lifeExpectancy !== undefined,
});

/** Every member of the household, with the plan-level fallback applied. */
export const resolveHouseholdMembers = (household: Household | undefined, planAges: PlanMemberAges): readonly ResolvedHouseholdMember[] =>
  householdMembersOf(household).map((member) => resolveHouseholdMember(member, planAges));

/** The owner of an entity. Absence means `primary`, which is what every reader applies. */
export const ownerOf = (entity: { owner?: Owner | undefined }): Owner => entity.owner ?? 'primary';

/**
 * The body of law that governs an entity, or `undefined` when it is not jointly held.
 *
 * A stored `joint` item with no `propertyRegime` is community property (California, E2).
 */
export const propertyRegimeOf = (entity: {
  owner?: Owner | undefined;
  propertyRegime?: PropertyRegime | undefined;
}): PropertyRegime | undefined => (ownerOf(entity) === 'joint' ? (entity.propertyRegime ?? 'community') : undefined);

/** Whether a plan describes a couple. A plan with no stored household is one person. */
export const isCoupleHousehold = (household: Household | undefined): boolean => (household?.members.length ?? 1) > 1;

/**
 * The `owner`/`propertyRegime` pair as it should be stored.
 *
 * `owner` is written explicitly (`primary` when the form left it unset), and `propertyRegime` is
 * kept only for a jointly held item: a regime left over from switching an item back to a single
 * owner is dead data every later per-owner reader would have to remember to ignore. The dialogs
 * run their submitted entity through this, so the rule lives in one place and is tested directly.
 */
export const ownershipForStorage = <T extends object>(
  entity: T & { owner?: Owner | undefined; propertyRegime?: PropertyRegime | undefined }
): T & { owner: Owner; propertyRegime: PropertyRegime | undefined } => {
  const stored: { owner: Owner; propertyRegime: PropertyRegime | undefined } = {
    owner: ownerOf(entity),
    propertyRegime: propertyRegimeOf(entity),
  };

  return { ...entity, ...stored };
};
