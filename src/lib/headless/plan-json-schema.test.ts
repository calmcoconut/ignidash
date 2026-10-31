import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXPORT_SCHEMA_VERSION } from '@/lib/export/plan-envelope';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';

import {
  CLOCK_RELATIVE_TIMELINE_RULES,
  PLAN_JSON_SCHEMA_DIRECTORY,
  SHAPE_PATTERNS,
  UNVALIDATED_RULE_CLASSES,
  generatePlanJsonSchema,
  planJsonSchemaComment,
  planJsonSchemaFileName,
  planJsonSchemaPath,
} from './plan-json-schema';

/** Vitest runs from the repository root; a wrong root fails loudly on the first read. */
const REPO_ROOT = process.cwd();
const SCHEMA_DIRECTORY = join(REPO_ROOT, PLAN_JSON_SCHEMA_DIRECTORY);
const HEADLESS_DOC = readFileSync(join(REPO_ROOT, 'docs', 'HEADLESS.md'), 'utf8');
/** Prose is line-wrapped, so compare on collapsed whitespace. */
const HEADLESS_DOC_FLAT = HEADLESS_DOC.replace(/\s+/g, ' ');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const SCHEMA_FILE_PATTERN = /^ignidash-plan\.v\d+\.schema\.json$/;

describe('the checked-in plan JSON Schema', () => {
  it('matches what the generator produces, so the file cannot drift', () => {
    const generated = generatePlanJsonSchema();
    const onDisk = readFileSync(join(REPO_ROOT, generated.path), 'utf8');

    // A mismatch means `npm run schema:plan` was not run after a schema change.
    expect(onDisk, `${generated.path} is stale; run npm run schema:plan`).toBe(generated.contents);
  });

  it('is versioned with the export envelope version', () => {
    expect(planJsonSchemaFileName()).toBe(`ignidash-plan.v${EXPORT_SCHEMA_VERSION}.schema.json`);
    expect(planJsonSchemaPath()).toBe(`${PLAN_JSON_SCHEMA_DIRECTORY}/${planJsonSchemaFileName()}`);
  });

  it('publishes exactly one version, so an old one cannot linger', () => {
    const published = readdirSync(SCHEMA_DIRECTORY).filter((file) => SCHEMA_FILE_PATTERN.test(file));

    expect(published).toEqual([planJsonSchemaFileName()]);
  });

  it('describes the simulator input, with every required field and the optional plan fields', () => {
    const { document } = generatePlanJsonSchema();
    const required = document.required as string[];

    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(document.type).toBe('object');

    // The optional plan fields: a plan without a glide path, without milestones, or without
    // conversions are complete plans.
    const optionalPlanFields = ['glidePath', 'milestones', 'conversions'];
    const expectedRequired = Object.keys(simulatorSchema.shape)
      .filter((key) => !optionalPlanFields.includes(key))
      .sort();
    expect([...required].sort()).toEqual(expectedRequired);
    expect(Object.keys(document.properties as Record<string, unknown>).sort()).toEqual(Object.keys(simulatorSchema.shape).sort());
  });

  it('keeps the timeline nullable and inlines every definition, so it validates offline', () => {
    const { document, contents } = generatePlanJsonSchema();

    expect(JSON.stringify((document.properties as Record<string, unknown>).timeline)).toContain('"null"');

    // No $ref/$defs means a consumer never resolves a second document, and no remote $id
    // means nothing is fetched at validation time.
    expect(contents).not.toContain('"$ref"');
    expect(contents).not.toContain('"$defs"');
    expect(contents).not.toContain('"$id"');
    expect(contents.match(/https?:\/\/[^"\s]+/g)).toEqual(['https://json-schema.org/draft/2020-12/schema']);
  });

  it('generates deterministically and round-trips through JSON', () => {
    const first = generatePlanJsonSchema();
    const second = generatePlanJsonSchema();

    expect(second.contents).toBe(first.contents);
    expect(JSON.parse(first.contents)).toStrictEqual(first.document);
    expect(first.contents.endsWith('\n')).toBe(true);
  });
});

describe('the document states its own limits', () => {
  it('says plainly that only shape and per-field bounds are published', () => {
    const { document } = generatePlanJsonSchema();
    const comment = String(document.$comment);

    expect(comment).toBe(planJsonSchemaComment());
    expect(comment).toContain('SHAPE and PER-FIELD BOUNDS only');
    expect(comment).toContain('drops every .refine()/.superRefine()');
    expect(comment).toContain('ACCEPTS files the app refuses');
  });

  it('names every rule class it does not carry, in the file and in docs/HEADLESS.md', () => {
    const comment = planJsonSchemaComment();

    for (const ruleClass of UNVALIDATED_RULE_CLASSES) {
      expect(comment, `$comment is missing "${ruleClass.label}"`).toContain(ruleClass.label);
      expect(HEADLESS_DOC_FLAT, `docs/HEADLESS.md is missing "${ruleClass.label}"`).toContain(ruleClass.label);
    }
    // P3-P4 retired `enum-policy`: its only member was the self-employment income gate, which
    // the app now accepts. An empty class is not kept for the taxonomy's shape.
    expect(UNVALIDATED_RULE_CLASSES.map((entry) => entry.id)).toEqual(['cross-field', 'clock', 'unknown-keys']);
  });

  it('keeps the clock-relative rules listed for readers', () => {
    expect(CLOCK_RELATIVE_TIMELINE_RULES).toHaveLength(3);
    for (const rule of CLOCK_RELATIVE_TIMELINE_RULES) {
      expect(rule).toMatch(/^timeline\./);
    }
  });
});

describe('the documented narrowing', () => {
  it('gives asOfDate a shape pattern, and adds no other pattern', () => {
    const { document, contents } = generatePlanJsonSchema();

    expect(SHAPE_PATTERNS).toHaveLength(1);
    const [asOf] = SHAPE_PATTERNS;
    expect(asOf.path.join('.')).toBe('properties.simulationSettings.properties.asOfDate');

    let node: unknown = document;
    for (const step of asOf.path) node = (node as Record<string, unknown>)[step];
    expect(node).toMatchObject({ type: 'string', pattern: asOf.pattern });

    // Exactly the documented narrowings: nothing narrower may appear without a doc entry.
    expect(contents.match(/"pattern":/g)).toHaveLength(SHAPE_PATTERNS.length);
  });

  it('rejects a non-date, yet still lets a rollover date through (shape only)', () => {
    const [asOf] = SHAPE_PATTERNS;
    const regex = new RegExp(asOf.pattern);

    expect(regex.test('2026-01-01')).toBe(true);
    expect(regex.test('not-a-date')).toBe(false);
    expect(regex.test('2026-1-1')).toBe(false);
    // The pattern counts digits; it cannot know February has 28 days in 2026.
    expect(regex.test('2026-02-30')).toBe(true);
  });

  it('tells readers the pattern is shape-only, including the rollover date it misses', () => {
    for (const { limitation } of SHAPE_PATTERNS) {
      expect(HEADLESS_DOC_FLAT).toContain(flat(limitation));
    }
    expect(HEADLESS_DOC_FLAT).toContain('2026-02-30');
    expect(planJsonSchemaComment()).toContain('2026-02-30');
  });
});

describe('the two shape differences stated in the docs', () => {
  it('requires debts and physicalAssets here, though import treats them as optional', () => {
    const { document } = generatePlanJsonSchema();
    const required = document.required as string[];

    expect(required).toContain('debts');
    expect(required).toContain('physicalAssets');
    // The docs explain why the stricter stance is right for simulate().
    expect(HEADLESS_DOC).toContain('`debts` and `physicalAssets` are `required`');
  });

  it('accepts timeline: null here, though simulate() refuses to run it', () => {
    const { document } = generatePlanJsonSchema();
    const timeline = JSON.stringify((document.properties as Record<string, unknown>).timeline);

    expect(timeline).toContain('"null"');
    expect(HEADLESS_DOC).toContain('`timeline: null`');
  });
});
