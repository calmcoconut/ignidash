#!/usr/bin/env tsx
/**
 * Headless simulation entry (parity plan P5.2).
 *
 *   npm run headless:simulate -- plan.json --as-of 2026-01-01 --seed 1
 *
 * All of the behaviour lives in `src/lib/headless/simulate-cli.ts` so it can be tested
 * without spawning a process; this file only wires the real filesystem and stdio.
 */

import { readFileSync } from 'node:fs';

import { runHeadlessSimulate } from '../src/lib/headless/simulate-cli';

process.exitCode = runHeadlessSimulate(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
});
