/**
 * Milestone dependency graph and cycle detection (parity plan P1-P7).
 *
 * A milestone may reference another milestone — "sell the rental once the mortgage is paid off"
 * is one milestone whose condition is another's — so a plan's milestones form a directed graph.
 * A cycle in that graph is unplannable, not merely odd: each milestone's condition would be
 * decided by a condition that is decided by the first one, so there is no month at which any of
 * them can be evaluated, and a latched milestone would either never fire or fire on an accident of
 * evaluation order. The plan row therefore rejects cycles in a plan-level `superRefine`.
 *
 * That rejection has to be actionable, so this module reports the **loop of names**, not a
 * boolean. "Cycle detected" leaves the user with a plan that will not save and no idea which two
 * of their twenty milestones disagree; `['Pay off mortgage', 'Sell the rental', 'Pay off
 * mortgage']` names the loop and tells them which edge to cut. `formatMilestoneCycle` renders it
 * for an error message.
 *
 * ## The path shape
 *
 * A reported cycle is a **closed** walk: the first id is repeated at the end, so
 * `path.length === ids.length === loopLength + 1` and reading the array in order walks the loop and
 * returns to its start. Reporting `['pay-off', 'sell-rental']` for `pay-off → sell-rental → pay-off`
 * would be ambiguous (is it an edge or a loop?) and hides the closing edge, which is exactly the
 * edge the user has to remove. `ids` is carried alongside `path` so a caller can select the
 * offending milestones in the UI without matching on user-editable names.
 *
 * ## Self-references
 *
 * A milestone that references itself reports `['Pay off mortgage', 'Pay off mortgage']`: a loop of
 * one node, still closed, still one edge to remove. It is a cycle, not a special case.
 *
 * ## Determinism and completeness
 *
 * The walk is a depth-first search in **declaration order** (the plan's array order, and within a
 * milestone its `references` order), so the same plan always reports the same cycles in the same
 * order — a test can assert on the output and a UI can render it stably. Cycle detection is
 * three-colour DFS: a grey (in progress) node reached again is a back edge and closes one cycle;
 * black (finished) nodes are not re-entered, so each back edge is reported exactly once. Two
 * disjoint loops, and two loops that share a node, are both reported in full.
 *
 * ## What this module deliberately does not do
 *
 * - **No dangling-reference validation.** A `references` entry naming an id that is not in the
 *   plan has no outgoing edges and can close no cycle, so it is skipped here. Rejecting it is the
 *   plan-level `superRefine`'s job (wiring item), which has the account and milestone identity the
 *   graph does not.
 * - **No evaluation order.** The graph answers "is this plan plannable", not "in what order do I
 *   evaluate"; the wiring item evaluates every milestone from the same month snapshot, so it needs
 *   no topological order.
 * - **No mutation.** Both functions are pure: they allocate their result and touch nothing the
 *   caller passed in.
 */

/**
 * One milestone's place in the graph: its identity, its display name, and what it references.
 *
 * `references` holds milestone **ids** (not names), because a name is user-editable and two
 * milestones may share one. An id that is not in the plan is ignored (see the module header).
 */
export interface MilestoneDependency {
  readonly id: string;
  readonly name: string;
  readonly references: readonly string[];
}

/** A cycle: the loop, closed — the first id and name are repeated at the end. */
export interface MilestoneCycle {
  /** The loop's milestone ids, first repeated last: `['a', 'b', 'a']`. */
  readonly ids: readonly string[];
  /** The loop's milestone names, in the same order and equally closed: `['A', 'B', 'A']`. */
  readonly path: readonly string[];
}

/**
 * Every cycle in the plan's milestone graph, in declaration order; empty means the plan is acyclic.
 *
 * The caller decides what a non-empty result means — the row's plan-level `superRefine` turns it
 * into a validation issue carrying `formatMilestoneCycle(cycle)`.
 */
export function findMilestoneCycles(milestones: readonly MilestoneDependency[]): readonly MilestoneCycle[] {
  // Duplicate ids: the first declaration wins, so the map and the walk over `values()` agree and
  // the result stays deterministic. (A duplicate id is a separate identity problem; it cannot
  // create a cycle that the first node's edges do not already describe.)
  const byId = new Map<string, MilestoneDependency>();
  for (const milestone of milestones) if (!byId.has(milestone.id)) byId.set(milestone.id, milestone);

  /** `visiting` is the DFS grey set, `done` the black set. Absent means unvisited. */
  const status = new Map<string, 'visiting' | 'done'>();
  /** The current DFS path, so a back edge can be turned into the loop that closes it. */
  const stack: MilestoneDependency[] = [];
  const cycles: MilestoneCycle[] = [];

  const visit = (milestone: MilestoneDependency): void => {
    status.set(milestone.id, 'visiting');
    stack.push(milestone);

    for (const reference of milestone.references) {
      const referenced = byId.get(reference);
      if (referenced === undefined) continue; // dangling: the superRefine's job, not a cycle

      const referencedStatus = status.get(referenced.id);
      if (referencedStatus === 'visiting') {
        // A back edge closes a cycle: the loop is the part of the current path from `referenced`
        // onward, closed by returning to `referenced`.
        const start = stack.findIndex((node) => node.id === referenced.id);
        const loop = stack.slice(start);
        cycles.push({
          ids: [...loop.map((node) => node.id), referenced.id],
          path: [...loop.map((node) => node.name), referenced.name],
        });
      } else if (referencedStatus === undefined) {
        visit(referenced);
      }
    }

    stack.pop();
    status.set(milestone.id, 'done');
  };

  for (const milestone of byId.values()) if (!status.has(milestone.id)) visit(milestone);

  return cycles;
}

/**
 * Render one cycle for an error message: `'Pay off mortgage → Sell the rental → Pay off mortgage'`.
 *
 * Names rather than ids, and the closing arrow kept, so the message reads as the loop the user has
 * to break rather than as a list of milestones.
 */
export function formatMilestoneCycle(cycle: MilestoneCycle): string {
  return cycle.path.join(' → ');
}
