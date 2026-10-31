import { v, type Infer } from 'convex/values';

/**
 * A plan milestone (parity plan P1-P7 wiring).
 *
 * The shape is the committed core's own — `{ id, name, condition, references }` — where `condition`
 * is a `MilestoneExpression` (`src/lib/calc/milestones/types.ts`) and `references` holds the ids of
 * the milestones this one depends on. Nothing parallel is invented here: the metric and operator
 * literals are the evaluator's tuples written out, and the group is its `{ op, children }`.
 *
 * ## Why the expression is written out in levels
 *
 * A Convex validator cannot be cyclic. `api`/schema serialisation walks every validator to JSON, so
 * a self-referencing validator would recurse forever, and the schema push would fail. An
 * `and`/`or` tree is inherently recursive, so the stored shape is bounded instead: **three** nested
 * group levels (`and(or(and(...)))` over leaves), which is what
 * `MILESTONE_MAX_GROUP_DEPTH` in `src/lib/schemas/inputs/milestone-form-schema.ts` says as well.
 * The bound is a storage/authoring limit, not an evaluation one — `evaluateMilestone` recurses over
 * any depth.
 *
 * It also keeps the published plan JSON Schema `$ref`-free: a recursive Zod schema would emit
 * `$defs`, which `src/lib/headless/plan-json-schema.test.ts` refuses so the document validates
 * offline.
 */

const milestoneComparisonFields = {
  operator: v.union(v.literal('<'), v.literal('<='), v.literal('=='), v.literal('>='), v.literal('>')),
  value: v.number(),
};

/**
 * One metric compared against one threshold.
 *
 * `account` is the single member that carries an `accountId`, exactly as `MilestoneLeaf` requires:
 * an account comparison without an id is not a milestone the evaluator can read.
 */
export const milestoneLeafValidator = v.union(
  v.object({ metric: v.literal('account'), accountId: v.string(), ...milestoneComparisonFields }),
  v.object({
    metric: v.union(
      v.literal('age'),
      v.literal('year'),
      v.literal('portfolio'),
      v.literal('income'),
      v.literal('expense'),
      v.literal('netWorth')
    ),
    ...milestoneComparisonFields,
  })
);

/** Level 1: a group whose children are leaves. */
const milestoneGroup1Validator = v.object({ op: v.union(v.literal('and'), v.literal('or')), children: v.array(milestoneLeafValidator) });

const milestoneExpression1Validator = v.union(milestoneLeafValidator, milestoneGroup1Validator);

/** Level 2: a group whose children are leaves or level-1 groups. */
const milestoneGroup2Validator = v.object({
  op: v.union(v.literal('and'), v.literal('or')),
  children: v.array(milestoneExpression1Validator),
});

const milestoneExpression2Validator = v.union(milestoneLeafValidator, milestoneGroup1Validator, milestoneGroup2Validator);

/** Level 3: the deepest the plan stores (`MILESTONE_MAX_GROUP_DEPTH`). */
const milestoneGroup3Validator = v.object({
  op: v.union(v.literal('and'), v.literal('or')),
  children: v.array(milestoneExpression2Validator),
});

export const milestoneExpressionValidator = v.union(
  milestoneLeafValidator,
  milestoneGroup1Validator,
  milestoneGroup2Validator,
  milestoneGroup3Validator
);

export const milestoneValidator = v.object({
  id: v.string(),
  name: v.string(),
  condition: milestoneExpressionValidator,
  // The ids of the milestones this one depends on. Identity only: it is what cycle detection walks,
  // and it never gates an evaluation — every milestone is evaluated from the same month snapshot.
  references: v.array(v.string()),
});

export const milestonesValidator = v.array(milestoneValidator);

export type MilestoneExpressionDoc = Infer<typeof milestoneExpressionValidator>;
export type MilestoneDoc = Infer<typeof milestoneValidator>;
