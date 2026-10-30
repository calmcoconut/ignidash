/**
 * The milestone evaluator (parity plan P1-P7): does this expression hold at this instant?
 *
 * `evaluateMilestone(expression, snapshot)` is a pure function of exactly two arguments. It reads
 * no clock, no store, no plan and no module state, so two calls with the same arguments always
 * agree — which is what lets the same expression be evaluated by the engine, by a compare run, by
 * the annotation extractor and by a form's live preview without any of them disagreeing.
 *
 * ## The empty-group decision
 *
 * **A group with no children is not met** — for `and` *and* for `or`:
 *
 *     and()  → false        (Boolean algebra would say true)
 *     or()   → false        (same as Boolean algebra)
 *
 * The Boolean identity `and() = true` is the classic bug in this kind of evaluator: every group
 * the user has not finished filling in becomes vacuously true, so a brand-new "net worth ≥ $2M
 * **and** retired" milestone fires the month the plan starts — and because a milestone latches
 * (see `latch.ts`) it can never un-fire. The user sees a milestone that was reached before the
 * plan existed, and the marker, any event date driven by it, and the completion count are all
 * wrong from the first month.
 *
 * So the rule is stated in terms of the user's own words instead: *an `and` milestone is met when
 * all of its conditions are met, and a milestone with no conditions has nothing that is met.*
 * `or` needs no argument — `false` is both the safe answer and the algebraically correct one — and
 * stating it identically for both operators means the two cases cannot drift apart.
 *
 * The two outcomes this produces are both honest in the UI:
 *
 * - a bare or empty group is simply **never reached**, so the milestone shows as pending and the
 *   user adds the condition they meant to add;
 * - inside a parent `and`, an empty group makes the whole expression unreachable — visible, and
 *   reported by whatever validation the wiring item attaches — while inside a parent `or` it is
 *   inert and harmless.
 *
 * The trade-off is deliberate: never firing is recoverable (the user edits the condition), a
 * spurious fire is not (the latch has no reset).
 *
 * ## `==` is cents-exact
 *
 * Every currency figure is the result of a compounding computation, so an "exactly $500,000" goal
 * can land on 499999.99999999994. `==` therefore compares within
 * {@link MILESTONE_EQUALITY_TOLERANCE} (half a cent) so that a floating-point residual cannot make
 * an exact goal unreachable. The inequality operators are exact: a threshold in a goal is a
 * boundary the user means literally, and giving `<` a tolerance would silently move every
 * boundary by half a cent.
 */

import { isMilestoneGroup, type MilestoneExpression, type MilestoneLeaf, type MilestoneOperator, type MilestoneSnapshot } from './types';

/**
 * Half a cent. The only slack in the evaluator, and only for `==`: see the module header.
 *
 * Half a cent rather than a rounded dollar because the snapshot carries cents; a larger tolerance
 * would turn `== $500,000` into "within a dollar", which the user did not ask for.
 */
export const MILESTONE_EQUALITY_TOLERANCE = 0.005;

/** Compare one reading against a threshold. `==` is within {@link MILESTONE_EQUALITY_TOLERANCE}. */
export function compareMilestoneValues(actual: number, operator: MilestoneOperator, value: number): boolean {
  switch (operator) {
    case '<':
      return actual < value;
    case '<=':
      return actual <= value;
    case '==':
      return Math.abs(actual - value) <= MILESTONE_EQUALITY_TOLERANCE;
    case '>=':
      return actual >= value;
    case '>':
      return actual > value;
  }
}

/**
 * Read the one number a leaf compares.
 *
 * An `account` id absent from the snapshot reads as 0 (documented on `MilestoneSnapshot`). Every
 * other metric has a required field, so a snapshot cannot be missing it at compile time.
 */
export function readMilestoneLeafValue(leaf: MilestoneLeaf, snapshot: MilestoneSnapshot): number {
  switch (leaf.metric) {
    case 'age':
      return snapshot.age;
    case 'year':
      return snapshot.year;
    case 'portfolio':
      return snapshot.portfolio;
    case 'account':
      return snapshot.accounts[leaf.accountId] ?? 0;
    case 'income':
      return snapshot.income;
    case 'expense':
      return snapshot.expense;
    case 'netWorth':
      return snapshot.netWorth;
  }
}

/**
 * Is the milestone met at this instant?
 *
 * Groups short-circuit (`every`/`some`), which is safe because evaluation has no side effects and
 * every leaf is a pure read. An empty group is `false` before either operator is applied — see the
 * module header — so the empty case cannot be reintroduced by a later refactor of the `and`/`or`
 * branch.
 */
export function evaluateMilestone(expression: MilestoneExpression, snapshot: MilestoneSnapshot): boolean {
  if (!isMilestoneGroup(expression)) {
    return compareMilestoneValues(readMilestoneLeafValue(expression, snapshot), expression.operator, expression.value);
  }

  // Empty groups are not met for BOTH operators. Written before the operator switch so that the
  // vacuous-truth of `[].every()` can never leak back in.
  if (expression.children.length === 0) return false;

  return expression.op === 'and'
    ? expression.children.every((child) => evaluateMilestone(child, snapshot))
    : expression.children.some((child) => evaluateMilestone(child, snapshot));
}
