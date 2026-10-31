/**
 * User milestones on the plan (parity plan P1-P7, the wiring half).
 *
 * A milestone is a *named condition over the simulation*: "net worth ≥ $1.5M", "retire at 60 or
 * later", "the mortgage is paid off while still working". The vocabulary, the evaluator, the
 * dependency graph and the latch are the committed pure core under
 * `src/lib/calc/milestones/`; this module is the plan field they are evaluated from:
 *
 *     { id, name, condition, references }
 *
 * - `id` is the milestone's identity (`string`), `name` its label, and `references` the ids of the
 *   milestones it depends on ("sell the rental once the mortgage is paid off"). `references` is
 *   identity only: it is what `findMilestoneCycles` walks and what the `superRefine` below rejects
 *   when it dangles or loops. The engine deliberately evaluates every milestone from the *same*
 *   month snapshot, so a reference never gates an evaluation and needs no topological order.
 * - `condition` is the core's own `MilestoneExpression` — no second shape, no flattened mirror.
 *   `and`/`or` groups over the metrics in `MILESTONE_METRICS` compared with `MILESTONE_OPERATORS`,
 *   built from those two tuples so the schema cannot drift from the evaluator.
 *
 * ## The time point is the fire date, not an input
 *
 * A milestone carries **no authored time point**, on purpose. When it is reached is what the
 * simulation answers: the latch stamps the month start at which the condition first held
 * (`MilestoneFireDate`), and that is the only date a milestone has. An authored "target date" would
 * be a second, contradictory answer to the same question, and the committed core has no field for
 * one — `MilestoneSnapshot.month` is documented there as metadata the latch stamps onto the state,
 * not a metric and not an input. So nothing here invents one, and `timePointSchema` grows no
 * `milestone` kind: the core has no code path that resolves a time point to a fire date, and one
 * cannot be resolved before the run that computes it (`TimeBinding` is built before the month loop).
 *
 * ## An empty group is legal, and is never met
 *
 * `children: []` is *accepted* here — a half-built condition is a milestone the user is still
 * writing, and refusing to save it would lose their work. It is not "vacuously true": the evaluator
 * answers `false` for an empty `and` as well as an empty `or` (`evaluate.ts`), so such a milestone
 * stays pending until it has a condition. That is a deliberate departure from Boolean algebra and
 * the reason this module does not need to reject the case.
 *
 * ## The depth bound
 *
 * A condition may nest its groups three deep (`and(or(and(...)))`). That is a storage/authoring
 * bound, not an evaluation one: the field is stored through a Convex validator, a Convex validator
 * cannot be cyclic (it is serialised for the schema push), so a *recursive* type has no storable
 * mirror. `convex/validators/milestone_validator.ts` carries the same three levels and the published
 * JSON Schema stays `$ref`-free because of it. `evaluateMilestone` itself has no depth limit.
 */

import { z } from 'zod';

import {
  MILESTONE_METRICS,
  MILESTONE_OPERATORS,
  findMilestoneCycles,
  formatMilestoneCycle,
  type MilestoneExpression,
  type MilestoneMetric,
  type SimpleMilestoneMetric,
} from '@/lib/calc/milestones';

/** How deep a condition may nest its `and`/`or` groups. See the module header. */
export const MILESTONE_MAX_GROUP_DEPTH = 3;

/** The operators, taken from the evaluator's own tuple so a new one cannot be missed. */
export const milestoneOperatorSchema = z.enum(MILESTONE_OPERATORS);

/** The metrics that read straight off the snapshot (everything the leaf union has besides `account`). */
const SIMPLE_MILESTONE_METRICS: SimpleMilestoneMetric[] = MILESTONE_METRICS.filter(
  (metric): metric is SimpleMilestoneMetric => metric !== 'account'
);

/** The comparison half of every leaf: an operator and the threshold in the metric's own unit. */
const comparisonShape = { operator: milestoneOperatorSchema, value: z.number() };

/**
 * One metric compared against one threshold.
 *
 * A discriminated union on `metric`, because `account` is the one member that carries an
 * `accountId` — the evaluator's own rule (`MilestoneLeaf`): an account comparison without an id does
 * not type-check there, so it must not parse here either.
 */
export const milestoneLeafSchema = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('account'), accountId: z.string().min(1, 'An account comparison needs an account'), ...comparisonShape }),
  ...SIMPLE_MILESTONE_METRICS.map((metric) => z.object({ metric: z.literal(metric), ...comparisonShape })),
]);

/**
 * The condition schema: leaves, `and`/`or` groups over them, and at most
 * {@link MILESTONE_MAX_GROUP_DEPTH} nested groups.
 *
 * Annotated with the core's `MilestoneExpression` so what a caller parses is exactly what
 * `evaluateMilestone` takes; every value this accepts is one of those (the annotation widens the
 * type over a depth-bounded schema, it does not loosen what parses).
 */
export const milestoneExpressionSchema: z.ZodType<MilestoneExpression> =
  // SAFETY: every value this accepts is a `MilestoneExpression` — each level is a group over the
  // level below and the bottom level is a leaf — so the assertion only restates what the loop
  // builds. Zod's own inference cannot follow a schema that is reassigned inside the loop.
  buildMilestoneExpressionSchema() as z.ZodType<MilestoneExpression>;

function buildMilestoneExpressionSchema(): z.ZodType {
  let expression: z.ZodType = milestoneLeafSchema;

  for (let depth = 0; depth < MILESTONE_MAX_GROUP_DEPTH; depth += 1) {
    const child: z.ZodType = expression;
    const group = z.object({ op: z.enum(['and', 'or']), children: z.array(child) });
    expression = z.union([group, child]);
  }

  return expression;
}

/** One milestone as the plan stores it. */
export const milestoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters'),
  condition: milestoneExpressionSchema,
  /** The ids of the milestones this one depends on. Identity only; see the module header. */
  references: z.array(z.string().min(1)),
});

export type MilestoneInputs = z.infer<typeof milestoneSchema>;

/** The evaluation-facing shape of a plan's milestones: identity, name and what it references. */
export function milestoneDependencies(milestones: readonly MilestoneInputs[]): Array<{ id: string; name: string; references: string[] }> {
  return milestones.map(({ id, name, references }) => ({ id, name, references: [...references] }));
}

/**
 * The plan's milestone list, with the reference rules that only the *plan* can check.
 *
 * The evaluator cannot reject a dangling reference (a pure function of expression and snapshot has
 * no plan to look in) and `findMilestoneCycles` deliberately skips one (an id that is not in the
 * plan has no outgoing edge and closes no loop). Left unchecked, both are silent no-ops: the user
 * names a milestone that does not exist, or sets up two milestones that decide each other, and the
 * plan simply never fires — with no error anywhere. So both become validation issues here, and the
 * cycle message names the loop (`'A → B → A'`) instead of saying "cycle detected".
 *
 * A duplicate id is rejected too: the graph's first declaration wins, so a second milestone under
 * the same id silently loses its edges and can never be referenced on purpose.
 */
export const milestonesSchema = z.array(milestoneSchema).superRefine((milestones, ctx) => {
  const seen = new Set<string>();

  milestones.forEach((milestone, index) => {
    if (seen.has(milestone.id)) {
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `Two milestones share the id "${milestone.id}"` });
    }
    seen.add(milestone.id);

    milestone.references.forEach((reference, referenceIndex) => {
      if (!milestones.some((candidate) => candidate.id === reference)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'references', referenceIndex],
          message: `No milestone has the id "${reference}"; a milestone can only depend on one that exists`,
        });
      }
    });
  });

  // Cycles are reported on the first milestone of the loop, so the message lands where the user can
  // see the edge they have to cut. `findMilestoneCycles` reports a loop closed (`['a', 'b', 'a']`),
  // and a self-reference is a loop of one.
  for (const cycle of findMilestoneCycles(milestoneDependencies(milestones))) {
    const first = cycle.ids[0];
    const index = milestones.findIndex((milestone) => milestone.id === first);
    ctx.addIssue({
      code: 'custom',
      path: [Math.max(index, 0), 'references'],
      message: `These milestones depend on each other in a loop: ${formatMilestoneCycle(cycle)}`,
    });
  }
});

/** A metric a milestone may compare against, re-exported so a form can render the options. */
export type { MilestoneMetric };

export const MILESTONE_METRIC_OPTIONS = MILESTONE_METRICS;
