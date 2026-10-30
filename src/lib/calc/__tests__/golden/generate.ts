/**
 * Regenerates `corpus.json` (parity plan P2-P1b).
 *
 * Run with `npm run test:golden:update`. This rewrites the frozen corpus, so read
 * `README.md` in this directory before you do: a diff here must arrive with an explanation,
 * never as a regenerated file that makes CI green.
 *
 * The generator is deterministic — it calls `simulate()` with a pinned `asOf` and no clock,
 * store or worker — so running it twice on the same code writes byte-identical files.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, serializeCorpus } from './snapshot';
import { GOLDEN_FIXTURES } from './fixtures';

const directory = dirname(fileURLToPath(import.meta.url));
const target = join(directory, 'corpus.json');

const serialized = serializeCorpus(buildCorpus());
writeFileSync(target, serialized);

const runs = GOLDEN_FIXTURES.reduce((total, fixture) => total + fixture.runs.length, 0);

console.log(`Wrote ${target}`);
console.log(`  fixtures: ${GOLDEN_FIXTURES.length} (${GOLDEN_FIXTURES.map((fixture) => fixture.id).join(', ')})`);
console.log(`  runs: ${runs}`);
console.log(`  bytes: ${Buffer.byteLength(serialized)}`);
console.log(`  sha256: ${createHash('sha256').update(serialized).digest('hex')}`);
