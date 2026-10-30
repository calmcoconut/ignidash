import type { Doc } from '../_generated/dataModel';

/**
 * The owner/household backfill, as a pure function (parity plan P1-P2).
 *
 * A plan written before households existed has no `owner` on its entities and no
 * `household` in its timeline. Readers already apply `owner ?? 'primary'` and treat a missing
 * household as one person, so the backfill is not needed for correctness — it is here so the
 * stored documents say what the readers assume, before P1-P3 starts reading ownership for real.
 *
 * `backfillPatch` returns only the collections that actually need a write, and returns
 * `undefined` when the plan is already backfilled. That is what makes the migration idempotent:
 * the second run over the same plan computes an empty patch and writes nothing, so running it
 * twice leaves byte-identical documents.
 *
 * Deliberately untouched:
 * - an `owner` that is already set, including `partner` and `joint`;
 * - a `propertyRegime` that is already set;
 * - an existing `household`, however many members it lists;
 * - `planSnapshots`. Snapshots are read through the same defaulting readers, and rewriting
 *   history would make a restored snapshot differ from what was stored.
 */

type EntityWithOwnership = { owner?: unknown; propertyRegime?: unknown };

/** Every plan collection that carries an owner. `debts`/`physicalAssets` may be absent. */
type OwnedCollections = Pick<Doc<'plans'>, 'accounts' | 'incomes' | 'expenses'> & Partial<Pick<Doc<'plans'>, 'debts' | 'physicalAssets'>>;

/**
 * Adds `owner: 'primary'` to an entity that has none, and `propertyRegime: 'community'` to a
 * `joint` entity that has none (California is a community-property state). Anything already set
 * is left exactly as stored.
 */
function withOwnership<T extends EntityWithOwnership>(entity: T): T {
  const needsOwner = entity.owner === undefined;
  const needsRegime = entity.owner === 'joint' && entity.propertyRegime === undefined;
  if (!needsOwner && !needsRegime) return entity;

  return { ...entity, ...(needsOwner ? { owner: 'primary' } : {}), ...(needsRegime ? { propertyRegime: 'community' } : {}) };
}

/**
 * The stored household of a plan that predates households: the plan's owner, alone.
 *
 * Mirrors `SINGLE_MEMBER_HOUSEHOLD` in `src/lib/schemas/inputs/household-schema.ts`. Convex
 * functions may only import from `convex/`, so the one-line literal lives in both places.
 */
export const SINGLE_MEMBER_HOUSEHOLD = { members: [{ id: 'primary', role: 'primary' as const }] };

export interface BackfillPatch {
  timeline?: Doc<'plans'>['timeline'];
  accounts?: Doc<'plans'>['accounts'];
  incomes?: Doc<'plans'>['incomes'];
  expenses?: Doc<'plans'>['expenses'];
  debts?: NonNullable<Doc<'plans'>>['debts'];
  physicalAssets?: NonNullable<Doc<'plans'>>['physicalAssets'];
}

/**
 * The patch that backfills one plan, or `undefined` when there is nothing to write.
 *
 * Pure: no database, no clock, no module state, so a test can feed it constructed documents and
 * call it twice to prove idempotency.
 */
export function backfillPatch(plan: OwnedCollections & { timeline?: Doc<'plans'>['timeline'] }): BackfillPatch | undefined {
  const patch: BackfillPatch = {};

  const backfill = <T extends EntityWithOwnership>(entities: T[]): T[] => entities.map(withOwnership);

  const accounts = backfill(plan.accounts);
  if (accounts.some((entity, index) => entity !== plan.accounts[index])) patch.accounts = accounts;

  const incomes = backfill(plan.incomes);
  if (incomes.some((entity, index) => entity !== plan.incomes[index])) patch.incomes = incomes;

  const expenses = backfill(plan.expenses);
  if (expenses.some((entity, index) => entity !== plan.expenses[index])) patch.expenses = expenses;

  if (plan.debts !== undefined) {
    const debts = backfill(plan.debts);
    if (debts.some((entity, index) => entity !== plan.debts![index])) patch.debts = debts;
  }

  if (plan.physicalAssets !== undefined) {
    const physicalAssets = backfill(plan.physicalAssets);
    if (physicalAssets.some((entity, index) => entity !== plan.physicalAssets![index])) patch.physicalAssets = physicalAssets;
  }

  // `timeline: null` is a plan with no timeline yet; there is no household to record on it.
  if (plan.timeline !== undefined && plan.timeline !== null && plan.timeline.household === undefined) {
    patch.timeline = { ...plan.timeline, household: SINGLE_MEMBER_HOUSEHOLD };
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}
