/**
 * User milestones (parity plan P1-P7) — the expression vocabulary.
 *
 * A milestone ("retire with $1.5M at 60 or later", "the mortgage is paid off while still
 * working") is a boolean expression over simulation metrics. The plan row types it as
 *
 *     { op: 'and' | 'or', children }        — a group
 *     { metric, operator, value }           — a comparison against one metric
 *
 * and this module is that vocabulary and nothing else. It has no schema, no Zod, no plan field
 * and no engine import: the `milestones` plan field, `timePointSchema.milestone`, the plan-level
 * `superRefine` and the engine call are the wiring item (see the module header of `index.ts`).
 *
 * ## Why the unions are literal
 *
 * `metric` and `operator` are literal unions, so an unknown metric (`aportfolio`) or an unknown
 * operator (`'=>`, `'==='` typed by hand, a typo in a form) is a **compile error** at the call
 * site rather than a silent `false` at run time. The same union is what the future Zod schema
 * will be built from (`z.enum(MILESTONE_METRICS)`), so the schema cannot drift from the
 * evaluator: adding a metric here without a case in `readLeafValue` fails the exhaustive switch.
 *
 * ## The metric set is the row's list
 *
 * `age`, `year`, `portfolio`, `account`, `income`, `expense` and `netWorth` — exactly the metrics
 * plan 1 row 7 names, no more. Each is a **reading at one point in time**, not a whole series:
 * the evaluator is handed a snapshot and answers a question about that month, and the caller
 * decides which month it asks about. That is what keeps the evaluator a pure function of
 * `(expression, snapshot)` — it never walks the simulation, so it cannot depend on the horizon,
 * the strategy, a clock or a store.
 *
 * Two consequences worth stating, because they are the wiring item's business:
 *
 * - **`account` needs an account id.** A balance alone does not say which account, so the
 *   `account` leaf is the one member of the union that carries `accountId` (`AccountInputs['id']`,
 *   a string on the plan's account objects). It is not optional: an `account` comparison without
 *   an id does not type-check.
 * - **`netWorth` is not a simulation data-point field.** `SimulationDataPoint` has `portfolio`,
 *   `incomes`, `expenses`, `debts` and `physicalAssets`, and the snapshot is where the caller
 *   reconciles them (net worth = portfolio + physical assets − debt). The evaluator trusts the
 *   number it is given rather than re-deriving it, so a change to how net worth is defined lands
 *   in one place (the snapshot builder) and not in the evaluator.
 */

/**
 * Every metric a milestone may compare against, in the order the plan row lists them.
 *
 * `account` is special: see `MilestoneLeaf`, which requires an `accountId` for it.
 */
export const MILESTONE_METRICS = ['age', 'year', 'portfolio', 'account', 'income', 'expense', 'netWorth'] as const;

/** A metric a milestone may compare against. */
export type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

/** The metrics that are read straight off the snapshot (everything except `account`). */
export type SimpleMilestoneMetric = Exclude<MilestoneMetric, 'account'>;

/**
 * What a metric is measured in, so a form can format the threshold and offer the operators that
 * make sense. A `Record` over the metric union, so adding a metric without a unit is a compile
 * error.
 */
export type MilestoneMetricUnit = 'years' | 'calendarYear' | 'currency';

/** Units per metric: ages and years of age, the calendar year, and dollars for the rest. */
export const MILESTONE_METRIC_UNITS: Record<MilestoneMetric, MilestoneMetricUnit> = {
  age: 'years',
  year: 'calendarYear',
  portfolio: 'currency',
  account: 'currency',
  income: 'currency',
  expense: 'currency',
  netWorth: 'currency',
};

/**
 * The comparison operators, in ascending order.
 *
 * There is no `!=`: the five relational operators cover every goal the plan row asks for, and
 * "is not equal to" has no monotone reading as a threshold a plan can approach. `==` is exact to
 * within half a cent — see `MILESTONE_EQUALITY_TOLERANCE` in `evaluate.ts`.
 */
export const MILESTONE_OPERATORS = ['<', '<=', '==', '>=', '>'] as const;

/** A comparison operator. */
export type MilestoneOperator = (typeof MILESTONE_OPERATORS)[number];

/** The comparison every leaf carries: an operator and the threshold it compares the metric to. */
export interface MilestoneComparison {
  readonly operator: MilestoneOperator;
  /** The threshold, in the metric's own unit (dollars, years of age, or a calendar year). */
  readonly value: number;
}

/**
 * A leaf: one metric compared against one threshold.
 *
 * The `account` member carries the account it reads; every other member is just
 * `metric`/`operator`/`value`. An unknown metric or operator does not type-check (see the module
 * header), and neither does an `account` leaf without an `accountId`.
 */
export type MilestoneLeaf =
  | ({ readonly metric: 'account'; readonly accountId: string } & MilestoneComparison)
  | ({ readonly metric: SimpleMilestoneMetric } & MilestoneComparison);

/**
 * A group: `and`/`or` over any number of children, including none.
 *
 * An **empty** group is *not met* for both operators, which is a deliberate departure from
 * Boolean algebra (`and` over nothing is conventionally `true`). It is documented and pinned in
 * `evaluate.ts`; in short, a half-built condition must not fire a milestone that can then never
 * un-fire.
 */
export interface MilestoneGroup {
  readonly op: 'and' | 'or';
  readonly children: readonly MilestoneExpression[];
}

/** A milestone's condition: a comparison, or a group of them. */
export type MilestoneExpression = MilestoneGroup | MilestoneLeaf;

/**
 * One month's readings, the only thing an evaluation is allowed to depend on.
 *
 * `age`, `year`, `portfolio`, `income`, `expense` and `netWorth` are the metrics, plus `accounts`
 * for the `account` metric. `month` is not a metric (no operator is defined over months): it is
 * metadata — the calendar point the readings were taken at, which the latch stamps onto the state
 * when a milestone fires and the annotation extractor later turns into a marker date.
 *
 * `month` is 1-12 and `year` is a calendar year; the caller is responsible for taking every
 * reading at the same instant (a month start, per the row), which is why `month` lives here rather
 * than as a second argument that could disagree with `year`.
 */
export interface MilestoneSnapshot {
  /** Years of age on the plan's axis (the primary member's). */
  readonly age: number;
  /** Calendar year. */
  readonly year: number;
  /** Calendar month, 1-12. Metadata for the latch's fire date, not a comparable metric. */
  readonly month: number;
  /** Total portfolio value. */
  readonly portfolio: number;
  /** Income received, in the plan's real dollars, for the period being read. */
  readonly income: number;
  /** Expenses paid, in the plan's real dollars, for the period being read. */
  readonly expense: number;
  /** Portfolio + physical assets − debts. */
  readonly netWorth: number;
  /**
   * Balances keyed by the plan account's `id`.
   *
   * An id that is absent reads as **0**, so the evaluator stays total over a plan whose accounts
   * changed shape between runs. Rejecting a dangling reference is the plan-level `superRefine`'s
   * job (wiring item), not the evaluator's: a pure function of `(expression, snapshot)` has no
   * plan to validate against.
   */
  readonly accounts: Readonly<Record<string, number>>;
}

/** Narrowing helper: a group has an `op`, a leaf has a `metric`. */
export function isMilestoneGroup(expression: MilestoneExpression): expression is MilestoneGroup {
  return 'op' in expression;
}
