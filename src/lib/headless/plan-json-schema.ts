import { z } from 'zod';

import { EXPORT_SCHEMA_VERSION } from '@/lib/export/plan-envelope';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';

/**
 * The published JSON Schema for a simulator plan (parity plan P5.2).
 *
 * Generated with Zod 4's `z.toJSONSchema(simulatorSchema, { io: 'input' })`. `io: 'input'` is
 * deliberate: the document describes what a *file* may contain, not the normalised value Zod
 * hands back (output mode adds `additionalProperties: false` to every object, which would
 * reject files the app accepts).
 *
 * ## What this document validates: shape and per-field bounds only
 *
 * `z.toJSONSchema()` emits types, required keys, enum values and numeric bounds — and it
 * **silently drops every `.refine()` / `.superRefine()`**. The document is therefore *looser*
 * than the app, not equal to it: it accepts files the app refuses. Three classes of rule do not
 * reach the file (each with one example; the full list is in `UNVALIDATED_RULE_CLASSES` and
 * `docs/HEADLESS.md`):
 *
 * There used to be a fourth class, **enum-policy gates** — an enum member the document publishes
 * and the app's refine refuses. Its only member was `taxes.incomeType: "selfEmployment"`, released
 * by P3-P4 once the engine could charge the self-employment tax, so the class is gone rather than
 * kept alive with an invented example.
 *
 * 1. **Cross-field refinements** — e.g. `marketAssumptions.stockYield` above `stockReturn`, a
 *    wage income with no `withholding`, a `customDate` frame with no month/year, historical
 *    start-year overrides outside `historicalReturns`.
 * 2. **Clock-relative timeline rules** — current age 18-100, life expectancy above current age,
 *    retirement age between the two. They live in `createTimelineFormSchema(now)`; a static
 *    document could only encode them with a reference date that would go stale.
 * 3. **Unknown-key strictness** — this document accepts unknown nested keys; the app's import
 *    rejects them, and `scripts/headless-simulate.ts` warns about them.
 *
 * Two differences run the other way, and both are deliberate: `debts` and `physicalAssets` are
 * `required` here but optional to import (kept stricter because `simulate()` throws on
 * `undefined`), and `timeline: null` is accepted here while `simulate()` refuses it.
 *
 * One gap is narrowed where JSON Schema can express it: `simulationSettings.asOfDate` carries a
 * `YYYY-MM-DD` pattern (see `SHAPE_PATTERNS`). That constrains shape only — it rejects
 * `not-a-date` but still accepts `2026-02-30`, which the app's `isISODateString` refuses.
 *
 * Nothing in the app is weakened to match: the document under-claims, never over-claims, apart
 * from the two documented shape differences above.
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

/**
 * The classes of rule `z.toJSONSchema()` cannot carry, with one example each. The document's
 * `$comment` is built from this list and the test asserts each label reaches both the published
 * file and `docs/HEADLESS.md`, so the three places cannot drift apart.
 */
export const UNVALIDATED_RULE_CLASSES = [
  {
    id: 'cross-field',
    label: 'cross-field refinements',
    example: 'marketAssumptions.stockYield above stockReturn; wage income with no withholding; customDate with no month/year',
  },
  {
    id: 'clock',
    label: 'clock-relative timeline rules',
    example: 'timeline.birthYear giving an age outside 18-100 as of the run date',
  },
  {
    id: 'unknown-keys',
    label: 'unknown-key strictness',
    example: 'an unknown nested key, which this document accepts and the app\u2019s import rejects',
  },
] as const;

export interface ShapePattern {
  /** Path into the generated document, one key per step. */
  path: readonly string[];
  /** ECMA-262 pattern the string must match. */
  pattern: string;
  /** What the pattern cannot do, so the narrowing is never mistaken for the app's real check. */
  limitation: string;
}

/**
 * Shape-level narrowings applied after generation, for rules the Zod schema enforces with a
 * refine that JSON Schema *can* partly express. Each entry may only reject something the app
 * also rejects — never the other way round — and each is documented in `docs/HEADLESS.md`.
 *
 * Adding an entry is a deliberate, reviewed act: the test pins this list so an undocumented
 * narrowing cannot appear in the published file.
 */
export const SHAPE_PATTERNS: readonly ShapePattern[] = [
  {
    path: ['properties', 'simulationSettings', 'properties', 'asOfDate'],
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    limitation: 'shape only: it accepts a rollover date such as 2026-02-30, which the app refuses',
  },
];

export interface PlanJsonSchema {
  /** Repo-relative path the document belongs at. */
  path: string;
  /** The document, ready to serialise. */
  document: Record<string, unknown>;
  /** Pretty-printed JSON with a trailing newline, i.e. the file contents. */
  contents: string;
}

/** The `$comment` published in the file: the parity claim, built from the lists above. */
export function planJsonSchemaComment(): string {
  const classes = UNVALIDATED_RULE_CLASSES.map((entry) => entry.label).join('; ');
  const patterns = SHAPE_PATTERNS.map((entry) => `${entry.path[entry.path.length - 1]} must match ${entry.pattern}`).join('; ');

  return [
    'Publishes SHAPE and PER-FIELD BOUNDS only: z.toJSONSchema() drops every .refine()/.superRefine(), so this document ACCEPTS files the app refuses.',
    `Rule classes it does not carry: ${classes}.`,
    'Two differences run the other way: debts/physicalAssets are required here (simulate() throws on undefined) but optional to import, and timeline:null is accepted here but simulate() refuses it.',
    `Narrowed where JSON Schema can: ${patterns} — shape only, so it still accepts a rollover date like 2026-02-30.`,
    'See docs/HEADLESS.md for one example per class.',
  ].join(' ');
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
      'A complete financial plan as the Ignidash engine reads it: the object passed to simulate() (the simulator input), not the export envelope. Shape and per-field bounds only; generated from simulatorSchema, do not edit by hand.',
    $comment: planJsonSchemaComment(),
  };

  applyShapePatterns(document);

  return {
    path: planJsonSchemaPath(),
    document,
    contents: `${JSON.stringify(document, null, 2)}\n`,
  };
}

/**
 * Applies {@link SHAPE_PATTERNS} to the generated document.
 *
 * Throws when a declared path no longer exists: a renamed or restructured field must not
 * silently drop the narrowing the documentation promises.
 */
function applyShapePatterns(document: Record<string, unknown>): void {
  for (const { path, pattern } of SHAPE_PATTERNS) {
    let node: unknown = document;

    for (const step of path) {
      if (!isPlainObject(node) || !(step in node)) {
        throw new Error(
          `plan JSON Schema: cannot apply the documented pattern at ${path.join('.')} — the generated document no longer has that shape. Update SHAPE_PATTERNS (and docs/HEADLESS.md) instead of dropping the narrowing.`
        );
      }
      node = node[step];
    }

    if (!isPlainObject(node)) {
      throw new Error(`plan JSON Schema: the documented pattern target ${path.join('.')} is not an object; update SHAPE_PATTERNS.`);
    }
    node.pattern = pattern;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
