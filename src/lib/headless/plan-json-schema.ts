import { z } from 'zod';

import { EXPORT_SCHEMA_VERSION } from '@/lib/export/plan-envelope';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';

/**
 * The published JSON Schema for a simulator plan (parity plan P5.2).
 *
 * Generated with Zod 4's `z.toJSONSchema()` from `simulatorSchema`, which is the single
 * description of what the engine reads, so the document cannot describe a different shape
 * than the app accepts. `io: 'input'` is deliberate: the document describes what a *file*
 * may contain, not the normalised value Zod hands back (output mode adds
 * `additionalProperties: false` to every object, which would reject files the app accepts).
 *
 * ## Shape-only, on purpose
 *
 * `simulatorSchema` uses `timelineBaseSchema`, which carries the timeline's field shapes and
 * per-field bounds but none of the three rules that compare the plan against "today" (current
 * age 18-100, life expectancy above current age, retirement age between them). Those live in
 * `createTimelineFormSchema(now)` because a static schema cannot consult a clock, and JSON
 * Schema cannot express them without hard-coding a reference date that would go stale.
 *
 * The published document therefore validates exactly what the app's own file import validates
 * (`src/lib/export/plan-envelope.ts` checks the same `timelineBaseSchema`), and `docs/HEADLESS.md`
 * says so and lists the three extra rules. The headless entry applies them itself, using its
 * explicit `--as-of`, so a plan the app would reject for its age is rejected there too.
 */
export const PLAN_JSON_SCHEMA_DIRECTORY = 'schema';

/** `schema/ignidash-plan.v2.schema.json` — the number follows the export envelope (contract 3.3). */
export function planJsonSchemaFileName(version: number = EXPORT_SCHEMA_VERSION): string {
  return `ignidash-plan.v${version}.schema.json`;
}

export function planJsonSchemaPath(version: number = EXPORT_SCHEMA_VERSION): string {
  return `${PLAN_JSON_SCHEMA_DIRECTORY}/${planJsonSchemaFileName(version)}`;
}

/** The clock-relative timeline rules that a static schema cannot carry; mirrored in docs/HEADLESS.md. */
export const CLOCK_RELATIVE_TIMELINE_RULES = [
  'timeline.birthYear — current age (as of the run date) must be between 18 and 100',
  'timeline.lifeExpectancy — life expectancy must be greater than the current age',
  'timeline.retirementStrategy.retirementAge — retirement age must be between the current age and life expectancy',
] as const;

export interface PlanJsonSchema {
  /** Repo-relative path the document belongs at. */
  path: string;
  /** The document, ready to serialise. */
  document: Record<string, unknown>;
  /** Pretty-printed JSON with a trailing newline, i.e. the file contents. */
  contents: string;
}

/**
 * Builds the document. Kept pure so the snapshot test and the writer script share one
 * definition and the checked-in file cannot drift from the schema.
 */
export function generatePlanJsonSchema(): PlanJsonSchema {
  const generated = z.toJSONSchema(simulatorSchema, { io: 'input' }) as Record<string, unknown>;

  const document: Record<string, unknown> = {
    ...generated,
    title: 'Ignidash simulator input',
    description:
      'A complete financial plan as the Ignidash engine reads it: the object passed to simulate() (the simulator input), not the export envelope. Generated from simulatorSchema; do not edit by hand.',
    $comment:
      'Shape-only. The three clock-relative timeline rules (current age 18-100, life expectancy above current age, retirement age between the two) need a run date and are applied by the app and by scripts/headless-simulate.ts --as-of, not by this document. See docs/HEADLESS.md.',
  };

  return {
    path: planJsonSchemaPath(),
    document,
    contents: `${JSON.stringify(document, null, 2)}\n`,
  };
}
