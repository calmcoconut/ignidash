import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { issuesFromZodError as cliIssuesFromZodError } from '@/lib/headless/simulate-cli';
import { issuesFromZodError } from './zod-issues';

/**
 * One Zod-error reader for both entry points.
 *
 * The import path (`src/lib/export/plan-envelope.ts`) and the headless CLI
 * (`src/lib/headless/simulate-cli.ts`) used to carry separate walkers, and the CLI's copy had
 * already drifted: it reported every union member's complaints, so a plan with a correct
 * discriminant and one missing field also told the operator their `type` was wrong. These tests
 * pin the shared implementation and the union behaviour it exists for.
 */

const retirementStrategy = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixedAge'), retirementAge: z.number() }),
  z.object({ type: z.literal('swrTarget'), safeWithdrawalRate: z.number() }),
]);

const planShape = z.object({ retirementStrategy });

function issuesFor(value: unknown) {
  const parsed = planShape.safeParse(value);
  if (parsed.success) throw new Error('expected the value to fail validation');

  return issuesFromZodError(parsed.error);
}

describe('issuesFromZodError', () => {
  it('is the same function in the CLI and in the import path', () => {
    // Identity, not merely equality: the CLI has no copy left to drift.
    expect(cliIssuesFromZodError).toBe(issuesFromZodError);
  });

  it('names the missing field, not the discriminant the file got right', () => {
    // `{ type: 'fixedAge' }` with no `retirementAge`: the `swrTarget` member objects to `type`,
    // but `type` is correct, so only the missing field is reported. This is what the import path
    // has always done (`plan-envelope.test.ts` pins the same leaf for the real timeline schema),
    // and what the CLI used to get wrong.
    expect(issuesFor({ retirementStrategy: { type: 'fixedAge' } })).toStrictEqual([
      { path: 'retirementStrategy.retirementAge', message: expect.any(String) },
    ]);
  });

  it('reports the discriminant alone when no member matches it', () => {
    const issues = issuesFor({ retirementStrategy: { type: 'unknown' } });

    expect(issues.map((issue) => issue.path)).toStrictEqual(['retirementStrategy.type']);
    expect(issues.every((issue) => issue.message.includes('retirementStrategy'))).toBe(false);
  });

  it('gives the CLI and the import path the same issues for the same input', () => {
    const parsed = planShape.safeParse({ retirementStrategy: { type: 'fixedAge' } });
    if (parsed.success) throw new Error('expected the value to fail validation');

    expect(cliIssuesFromZodError(parsed.error)).toStrictEqual(issuesFromZodError(parsed.error));
    // ...and the paths are the ones the import path reports, prefixed by where the value sits.
    expect(cliIssuesFromZodError(parsed.error).map((issue) => `plan.${issue.path}`)).toStrictEqual([
      'plan.retirementStrategy.retirementAge',
    ]);
  });
});
