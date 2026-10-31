/**
 * `convex/_generated/api.d.ts` is hand-maintained, and this is the guard (parity plan R13).
 *
 * Regenerating it needs `npx convex codegen` against a configured deployment, which this fork does
 * not have, so a module added to `convex/` needs its two lines added by hand: a `import type * as
 * <ident> from "../<path>.js"` and a `<path>: typeof <ident>` entry in `fullApi`. AGENTS.md §8.1
 * records the trap — the keys are **module paths**, so `net_worth_journal`, not `netWorthJournal`.
 * The camelCase spelling type-checks today and breaks the moment codegen runs.
 *
 * What this test can prove without a deployment is the correspondence between the file and the tree:
 *
 *   1. every module that exports a Convex function is declared, under its module-path key;
 *   2. no declaration outlives its file;
 *   3. each declaration is the shape codegen emits — identifier `path.replace(/[/.]/g, '_')`, import
 *      `../<path>.js`, key `<path>`.
 *
 * `betterAuth/` is a Convex **component**: it is registered through `convex.config.ts` and reachable
 * as `components.betterAuth`, never as `api.betterAuth.*`, so its modules are not in this file. That
 * is the one exclusion, and it is by path rather than by a list of names so a new component module
 * cannot slip through.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CONVEX_DIR = fileURLToPath(new URL('.', import.meta.url));
const API_DTS = join(CONVEX_DIR, '_generated', 'api.d.ts');

/** Directories that are generated, vendored, or a Convex component — never in the app's `api`. */
const EXCLUDED_DIRECTORIES = ['_generated', 'betterAuth'];

const FUNCTION_EXPORT = /^export const \w+ = (query|mutation|action|internalQuery|internalMutation|internalAction)\(/m;

/** Every `.ts` module codegen would walk: no tests, no generated files, no component files. */
function modulesOnDisk(): string[] {
  const found: string[] = [];

  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
        walk(path, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      found.push(`${prefix}${entry.name.slice(0, -'.ts'.length)}`);
    }
  };

  walk(CONVEX_DIR, '');
  return found.sort();
}

const declared = (() => {
  const source = readFileSync(API_DTS, 'utf8');

  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^import type \* as (\w+) from "\.\.\/(.+)\.js";$/gm)) {
    imports.set(match[2], match[1]);
  }

  const fullApiBlock = source.match(/^declare const fullApi: ApiFromModules<\{([\s\S]+?)^\}>;/m);
  if (!fullApiBlock) throw new Error('could not find the `declare const fullApi` block in api.d.ts');

  const keys = new Map<string, string>();
  for (const match of fullApiBlock[1].matchAll(/^ {2}"?([^":]+)"?: typeof (\w+);$/gm)) {
    keys.set(match[1], match[2]);
  }

  return { imports, keys };
})();

const exportsConvexFunction = (module: string): boolean => FUNCTION_EXPORT.test(readFileSync(join(CONVEX_DIR, `${module}.ts`), 'utf8'));

describe('convex/_generated/api.d.ts against the module tree', () => {
  it('parses the file it is guarding, so an empty reading cannot pass', () => {
    // A regex that stopped matching would leave both maps empty and every assertion below vacuous.
    expect(modulesOnDisk().length).toBeGreaterThan(50);
    expect(declared.keys.size).toBeGreaterThan(40);
    expect(declared.imports.size).toBe(declared.keys.size);
  });

  it('declares every module that exports a Convex function, under its module-path key', () => {
    const missing = modulesOnDisk().filter((module) => exportsConvexFunction(module) && !declared.keys.has(module));

    expect(missing).toEqual([]);
  });

  it('declares no module whose file is gone', () => {
    const modules = new Set(modulesOnDisk());
    const stale = [...declared.keys.keys()].filter((key) => !modules.has(key));

    expect(stale).toEqual([]);
  });

  it('emits each declaration the shape codegen would, so a codegen run is a no-op', () => {
    const wrong = [...declared.keys.entries()].flatMap(([key, identifier]) => {
      const expectedIdentifier = key.replace(/[/.]/g, '_');
      const imported = declared.imports.get(key);

      if (identifier !== expectedIdentifier) return [`${key}: declares \`${identifier}\`, expected \`${expectedIdentifier}\``];
      if (imported !== identifier) return [`${key}: \`fullApi\` uses \`${identifier}\` but the import is \`${imported ?? 'missing'}\``];
      return [];
    });

    expect(wrong).toEqual([]);
  });

  it('keys the multi-word modules by path, which is the form that breaks when codegen runs', () => {
    // The AGENTS.md §8.1 trap, stated as a fact about the file: `net_worth_journal`, never
    // `netWorthJournal`. A camelCase key compiles today because nothing type-checks the key against a
    // path, and codegen would then emit the snake_case name beside it.
    const camelCase = [...declared.keys.keys()].filter((key) => /[A-Z]/.test(key));

    expect(camelCase).toEqual([]);
    expect(declared.keys.has('net_worth_journal')).toBe(true);
    expect(declared.keys.has('templates/basic')).toBe(true);
  });
});
