#!/usr/bin/env tsx
/**
 * Regenerates the checked-in JSON Schema for the simulator input (parity plan P5.2).
 *
 *   npm run schema:plan
 *
 * Developer-side only, per the standing rule that vendored data is generated here and
 * reviewed as a data diff: the output is committed, and `plan-json-schema.test.ts` fails
 * if the committed file drifts from what this produces.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAN_JSON_SCHEMA_DIRECTORY, generatePlanJsonSchema, planJsonSchemaFileName } from '../src/lib/headless/plan-json-schema';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_DIRECTORY = join(REPO_ROOT, PLAN_JSON_SCHEMA_DIRECTORY);

const generated = generatePlanJsonSchema();
const target = join(REPO_ROOT, generated.path);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, generated.contents, 'utf8');
console.log(`wrote ${generated.path} (${generated.contents.length} bytes)`);

// A version bump renames the file; leaving the previous one behind would publish two.
const staleVersions = readdirSync(SCHEMA_DIRECTORY).filter(
  (file) => /^ignidash-plan\.v\d+\.schema\.json$/.test(file) && file !== planJsonSchemaFileName()
);
for (const file of staleVersions) {
  rmSync(join(SCHEMA_DIRECTORY, file));
  console.log(`removed stale ${PLAN_JSON_SCHEMA_DIRECTORY}/${file}`);
}
