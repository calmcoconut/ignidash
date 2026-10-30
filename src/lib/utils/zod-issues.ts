import type { z } from 'zod';

/**
 * The one Zod-error reader both the import path and the headless CLI use.
 *
 * It lives here because the CLI had grown its own copy, and the copies had already drifted:
 * the CLI's version reported every union member's complaints, so a file whose
 * `retirementStrategy` simply lacked `retirementAge` also told the operator their correct
 * `type` was wrong. The import path's behaviour is the canonical one (below), and both entry
 * points now call this function, so a malformed union reads the same either way.
 */

/** One failed field, with the path that failed. */
export interface ImportIssue {
  path: string;
  message: string;
}

/** One issue while its path is still a list of keys, before it is formatted. */
interface RawIssue {
  parts: PropertyKey[];
  message: string;
  /**
   * True when this leaf is a `z.literal`/`z.enum` mismatch (`invalid_value`): the member
   * expected a different discriminator, so the leaf says "your `type` should be X" rather
   * than naming a field the file is missing.
   */
  mismatchedLiteral: boolean;
}

type ZodIssue = z.ZodError['issues'][number];

/**
 * Flattens a Zod error tree into one issue per failing field, `prefix` first.
 *
 * A union does not fail at its own path: Zod reports `invalid_union` and puts the useful
 * paths one level down, in `issue.errors` (one list per member). Reporting the union issue
 * itself would say `plan.timeline :: Invalid input` where the file actually needs
 * `plan.timeline.retirementStrategy.retirementAge`, so the walk recurses into every member
 * to whatever depth the unions nest and emits the leaves.
 *
 * Two members' worth of noise is removed while walking:
 *
 * - The `z.null()` member is skipped: `timeline` is `v.union(timelineValidator, v.null())`,
 *   so every failure of the object member would otherwise carry a useless "expected null".
 * - Members that objected to the DISCRIMINATOR are dropped when another member matched.
 *   `{ type: 'fixedAge' }` with no `retirementAge` makes the `swrTarget` member report
 *   `type :: expected "swrTarget"` plus a missing `safeWithdrawalRate`; the file's `type` is
 *   correct, so telling the operator to change it is wrong. If no member matched (the
 *   discriminator really is unknown), only the discriminator complaints are reported.
 *
 * If nothing survives, the union's own issue is reported instead, so a failure is never
 * dropped.
 */
export function issuesFromZodError(error: z.ZodError, prefix: readonly PropertyKey[] = []): ImportIssue[] {
  const raw: RawIssue[] = [];
  collectZodIssues(error.issues, prefix, raw, new Set<string>(), false);
  return raw.map((issue) => ({ path: formatPath(issue.parts) || '(root)', message: issue.message }));
}

function collectZodIssues(
  zodIssues: readonly ZodIssue[],
  prefix: readonly PropertyKey[],
  out: RawIssue[],
  seen: Set<string>,
  skipNullMember: boolean
): void {
  for (const issue of zodIssues) {
    const parts = [...prefix, ...issue.path];

    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) pushIssue(out, seen, [...parts, key], 'Unrecognized field');
      continue;
    }

    // The null member of a union never explains the failure; the other members do.
    if (skipNullMember && issue.code === 'invalid_type' && issue.expected === 'null') continue;

    if (issue.code === 'invalid_union') {
      const members = issue.errors.map((branch) => {
        const leaves: RawIssue[] = [];
        collectZodIssues(branch, parts, leaves, new Set<string>(), true);
        return leaves;
      });
      for (const leaf of chooseUnionLeaves(members, parts, issue.message))
        pushIssue(out, seen, leaf.parts, leaf.message, leaf.mismatchedLiteral);
      continue;
    }

    pushIssue(out, seen, parts, issue.message, issue.code === 'invalid_value');
  }
}

/**
 * Picks which union members' leaves to report.
 *
 * A member that reports a discriminator mismatch was simply not the right shape, so it is
 * dropped as soon as another member matched. When every member mismatched, the
 * discriminator is the real problem and only those complaints survive; when the union is not
 * discriminated at all (no `invalid_value` leaves anywhere, e.g. `object | null` or
 * `cash | loan` payment methods), every member is reported as before.
 */
function chooseUnionLeaves(members: RawIssue[][], parts: readonly PropertyKey[], unionMessage: string): RawIssue[] {
  const matched = members.filter((leaves) => !leaves.some((leaf) => leaf.mismatchedLiteral));
  if (matched.length > 0) return matched.flat();

  const discriminatorOnly = members.flat().filter((leaf) => leaf.mismatchedLiteral);
  if (discriminatorOnly.length > 0) return discriminatorOnly;

  const all = members.flat();
  return all.length > 0 ? all : [{ parts: [...parts], message: unionMessage, mismatchedLiteral: false }];
}

function pushIssue(out: RawIssue[], seen: Set<string>, parts: PropertyKey[], message: string, mismatchedLiteral = false): void {
  const key = `${formatPath(parts)}\u0000${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ parts, message, mismatchedLiteral });
}

/** Renders a Zod path (`['incomes', 0, 'amount']`) as `incomes[0].amount`. */
export function formatPath(parts: readonly PropertyKey[]): string {
  let path = '';
  for (const part of parts) {
    if (typeof part === 'number') {
      path += `[${part}]`;
      continue;
    }
    path = path === '' ? String(part) : `${path}.${String(part)}`;
  }
  return path;
}
