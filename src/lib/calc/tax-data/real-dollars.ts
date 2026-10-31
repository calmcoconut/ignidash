/**
 * Monetary amounts from a ruleset, expressed in the plan's **real** (today's) dollars.
 *
 * ## The problem this closes
 *
 * The simulation engine works in today's dollars: returns are Fisher-deflated, and
 * `time-binding.ts` converts every dated nominal amount with `cumulativeInflationIndex`
 * (contract 3.1's single inflation path). Tax law is written in **nominal** dollars, so a
 * table's numbers have to be translated into the same units before they are compared with a
 * balance.
 *
 * - An **`indexed`** table is re-issued every year with amounts that rise with CPI. In today's
 *   dollars those amounts are constant, so the table's own numbers are already correct and are
 *   returned unchanged. That is why the engine could read the 2026 brackets for a 2056 return
 *   and be right.
 * - A **`fixed`** table is statute-locked: the 2026 amount is the 2056 amount, in nominal terms.
 *   In today's dollars it therefore *shrinks* by the cumulative inflation since the ruleset year,
 *   and reading it raw is the same as assuming the threshold rises with inflation forever. The
 *   §86 base amount is $25,000 today and would still be read as $25,000 thirty years out, where
 *   its real value is $25,000 / 1.03^30 ≈ $10,300.
 *
 * ## What deflates
 *
 * Only the fields named by `TableMeta.dollarFields`. A rate never moves: 3.8% NIIT is 3.8% in
 * every year. A fixed table with no `dollarFields` throws rather than guessing which of its
 * numbers are money.
 *
 * ## The anchor
 *
 * A fixed amount's age is measured from the ruleset that states it — `simYear - rulesetYear` —
 * which is the same span the plan's own deflation uses, because a plan's first settlement year
 * is the newest ruleset year. When a settlement uses a ruleset *older* than the plan's start (a
 * 2026 California return resolves the 2025 ruleset), the amount has been unadjusted for one
 * more year, and this anchor counts that year. `getRules` never borrows a later year, so the
 * span is never negative.
 */

import type { TableMeta, TaxYear } from './types';

/**
 * A table's value tree. Every `TableMeta<TValues>` value is one of these shapes — numbers,
 * strings, booleans, `null`, and arrays/records of them — which is what lets the deflator walk a
 * table without knowing which table it is.
 */
type TableValue = number | string | boolean | null | readonly TableValue[] | { readonly [key: string]: TableValue };

/** A record of `TableValue`s: the only object shape a table nests. */
type TableRecord = { readonly [key: string]: TableValue };

/**
 * The facts a table needs to be expressed in today's dollars.
 *
 * `cumulativeInflationIndex` is injected rather than imported so `tax-data/` stays free of the
 * plan's assumptions; the caller passes `cumulativeInflationIndex` from `time-binding.ts`, so
 * there is still exactly one inflation path in the engine.
 */
export interface RealDollarContext {
  /** The year whose rules are in force — `getRules(...).year`, not the year asked for. */
  readonly rulesetYear: TaxYear;
  /** The year being settled. */
  readonly simYear: TaxYear;
  /** `cumulativeInflationIndex(marketAssumptions, years)` — 1 today, 1.03 after a year at 3%. */
  readonly cumulativeInflationIndex: (years: number) => number;
}

/** The whole value is a dollar amount. See the `'$'` case in `DollarFieldPath`. */
const WHOLE_VALUE = '$';

/**
 * The divisor that turns a table's nominal amounts into today's dollars: 1 for an indexed table
 * (nothing to do), and the cumulative index over `simYear - rulesetYear` for a fixed one.
 *
 * @throws when a fixed table does not declare which of its fields are dollars.
 */
export function realDollarDivisor(table: TableMeta<unknown>, context: RealDollarContext): number {
  if (table.indexing === 'indexed') return 1;
  if (table.dollarFields === undefined) {
    throw new Error(
      'A `fixed` tax table must declare `dollarFields` (or an empty list for a rates-only table) before it can be ' +
        'expressed in real dollars; deflating the wrong fields would be a silent wrong number.'
    );
  }
  return context.cumulativeInflationIndex(context.simYear - context.rulesetYear);
}

/**
 * A table's values in the plan's real (today's) dollars.
 *
 * Returns `table.values` **by identity** when nothing has to move — every `indexed` table, and any
 * fixed one in its own ruleset year — so a zero-inflation run (and a first-year return) is
 * byte-identical to the pre-deflation code rather than merely equal.
 *
 * The `TableValue` casts at the two edges are the boundary between a generic `TValues` and the
 * concrete tree this module knows how to walk; every table's value is structurally that tree.
 *
 * @throws when a fixed table does not declare `dollarFields`, when `'$'` is combined with another
 * path, or when a declared path does not resolve.
 */
export function tableValuesInRealDollars<TValues>(table: TableMeta<TValues>, context: RealDollarContext): TValues {
  const divisor = realDollarDivisor(table, context);
  if (divisor === 1) return table.values;

  const paths = table.dollarFields ?? [];
  if (paths.length > 1 && paths.includes(WHOLE_VALUE)) {
    throw new Error(
      `dollarFields cannot combine "${WHOLE_VALUE}" with another path: the second pass would deflate the same dollars twice.`
    );
  }

  // The two `unknown` casts are the boundary between a generic `TValues` and the concrete tree this
  // module walks. TypeScript cannot relate a type parameter to the tree (an interface has no
  // implicit index signature), and every ruleset table's value is structurally that tree.
  // SAFETY: `TableMeta<TValues>` is only ever instantiated with a ruleset table, and every ruleset
  // table's `values` is a tree of numbers, strings, booleans, `null`, arrays and plain records —
  // the exact shape `TableValue` names. The walk copies rather than mutates, so the result has the
  // same shape as the input and is therefore a `TValues`.
  let scaled = table.values as unknown as TableValue;
  for (const path of paths) scaled = applyPath(scaled, path.split('.'), divisor, path);
  // SAFETY: the same invariant as above — `applyPath` copies the tree and only divides numbers, so
  // the result still has `TValues`' shape and can be handed back as the table's values.
  return scaled as unknown as TValues;
}

/**
 * Apply one `dollarFields` path.
 *
 * Named keys are consumed in order. An array (bracket or tier rows) and a `ByFilingStatus` record
 * are transparent: the same remaining path is applied to each element, which is what lets
 * `'tiers.min'` reach `tiers[status][i].min` without spelling out the filing statuses. The path
 * only falls through a record when the record has no such key, so an object that genuinely has
 * both a named field and status keys still behaves.
 */
function applyPath(node: TableValue, segments: readonly string[], divisor: number, original: string): TableValue {
  if (segments.length === 0) return scaleEveryNumber(node, divisor);

  const [segment, ...rest] = segments;
  if (segment === WHOLE_VALUE) {
    if (rest.length > 0) throw new Error(`dollarFields path "${original}" uses "${WHOLE_VALUE}" before its last segment.`);
    return scaleEveryNumber(node, divisor);
  }

  if (Array.isArray(node)) return node.map((element) => applyPath(element, segments, divisor, original));

  if (isTableRecord(node)) {
    if (segment in node) return { ...node, [segment]: applyPath(node[segment], rest, divisor, original) };
    // A collection (a ByFilingStatus record): apply the same path to each member.
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, applyPath(value, segments, divisor, original)]));
  }

  throw new Error(
    `dollarFields path "${original}" cannot be resolved: "${segment}" was not found and the value is not a collection ` +
      `(${node === null ? 'null' : typeof node}).`
  );
}

/**
 * Divide every number reachable from `node`, leaving everything that is not a number untouched.
 *
 * `Infinity` (the top bracket's `max`, a year with no phase-down) stays `Infinity`, and strings,
 * booleans and `null` are preserved, because a table's non-dollar metadata must survive the copy.
 */
function scaleEveryNumber(node: TableValue, divisor: number): TableValue {
  if (typeof node === 'number') return node / divisor;
  if (Array.isArray(node)) return node.map((element) => scaleEveryNumber(element, divisor));
  if (isTableRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, scaleEveryNumber(value, divisor)]));
  return node;
}

function isTableRecord(value: TableValue): value is TableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
