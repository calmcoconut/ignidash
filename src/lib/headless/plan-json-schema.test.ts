import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXPORT_SCHEMA_VERSION } from '@/lib/export/plan-envelope';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';

import {
  CLOCK_RELATIVE_TIMELINE_RULES,
  PLAN_JSON_SCHEMA_DIRECTORY,
  generatePlanJsonSchema,
  planJsonSchemaFileName,
  planJsonSchemaPath,
} from './plan-json-schema';

/** Vitest runs from the repository root; a wrong root fails loudly on the first read. */
const REPO_ROOT = process.cwd();
const SCHEMA_DIRECTORY = join(REPO_ROOT, PLAN_JSON_SCHEMA_DIRECTORY);

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

  it('describes the simulator input, with every required field and an optional glide path', () => {
    const { document } = generatePlanJsonSchema();
    const required = document.required as string[];

    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(document.type).toBe('object');

    const expectedRequired = Object.keys(simulatorSchema.shape)
      .filter((key) => key !== 'glidePath')
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

  it('says in the document itself that the clock-relative rules are not in it', () => {
    const { document } = generatePlanJsonSchema();

    expect(String(document.$comment)).toMatch(/Shape-only/);
    for (const rule of CLOCK_RELATIVE_TIMELINE_RULES) {
      expect(rule).toMatch(/^timeline\./);
    }
  });

  it('generates deterministically and round-trips through JSON', () => {
    const first = generatePlanJsonSchema();
    const second = generatePlanJsonSchema();

    expect(second.contents).toBe(first.contents);
    expect(JSON.parse(first.contents)).toStrictEqual(first.document);
    expect(first.contents.endsWith('\n')).toBe(true);
  });
});
