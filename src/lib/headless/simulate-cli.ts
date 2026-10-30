import { z } from 'zod';

import { isISODateString } from '@/lib/calc/clock';
import { DEFAULT_MONTE_CARLO_TRIALS, simulate } from '@/lib/calc/simulate';
import type { ImportIssue } from '@/lib/export/plan-envelope';
import { createTimelineFormSchema } from '@/lib/schemas/inputs/timeline-form-schema';
import { simulatorSchema, type SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { simulationSettingsSchema, type SimulationSettingsInputs } from '@/lib/schemas/inputs/simulation-settings-form-schema';

import { planJsonSchemaFileName } from './plan-json-schema';

/**
 * `npm run headless:simulate -- plan.json` (parity plan P5.2).
 *
 * Runs the pure `simulate()` entry point on a plan file. Nothing here re-implements the
 * engine: the plan is validated with `simulatorSchema` (the same schema the app uses), the
 * run options are passed through explicitly, and the result is printed unchanged.
 *
 * Two things are deliberate:
 *
 * - **No wall clock.** `simulate()` has no default `asOf` and this CLI adds none: it takes
 *   `--as-of`, or the plan's own `simulationSettings.asOfDate`. With neither, the run fails
 *   instead of silently pinning "today" and breaking the determinism guarantee.
 * - **The same issue format as the import path.** Validation failures are reported as
 *   `path: message` lines (see `ImportIssue` in `src/lib/export/plan-envelope.ts`), never as
 *   a stack trace, so a typo names the field that has to change.
 */

export type SimulationMode = SimulationSettingsInputs['simulationMode'];

const SIMULATION_MODES = simulationSettingsSchema.shape.simulationMode.options;
const MONTE_CARLO_MODES: readonly SimulationMode[] = ['monteCarloStochasticReturns', 'monteCarloHistoricalReturns'];

export const HEADLESS_EXIT = {
  ok: 0,
  /** The plan or the run itself is invalid (field paths are printed). */
  invalidPlan: 1,
  /** The command line, or the file it names, is wrong. */
  usage: 2,
} as const;

export const HEADLESS_USAGE = `Usage: npm run headless:simulate -- <plan.json> [options]

Runs the plan through simulate() with an explicit mode, seed and as-of date.
stdout is simulate()'s result as JSON; stderr carries the resolved run inputs.

Options:
  --mode <mode>     One of: ${SIMULATION_MODES.join(', ')}
                    (default: the plan's simulationSettings.simulationMode)
  --seed <n>        Run seed, a positive integer
                    (default: the plan's simulationSettings.simulationSeed)
  --as-of <date>    Run clock, YYYY-MM-DD
                    (default: the plan's simulationSettings.asOfDate; if neither is set
                    the run fails on purpose — the engine never reads the wall clock)
  --trials <n>      Monte Carlo trials
                    (default: ${DEFAULT_MONTE_CARLO_TRIALS}, Monte Carlo modes only)
  -h, --help        Show this help

Input: the simulator input object (what schema/${planJsonSchemaFileName()} describes),
not an export envelope. See docs/HEADLESS.md.

Exit codes: 0 success, 1 invalid plan or simulation failure, 2 usage error.
`;

export interface HeadlessArgs {
  planPath: string;
  mode?: string;
  seed?: number;
  asOf?: string;
  trials?: number;
}

export type HeadlessArgParse = { kind: 'help' } | { kind: 'ok'; args: HeadlessArgs } | { kind: 'error'; issues: ImportIssue[] };

export interface HeadlessIo {
  readFile: (path: string) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const VALUE_OPTIONS = ['mode', 'seed', 'as-of', 'trials'] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

/** Parses the CLI surface. Any problem comes back as `--flag: message`, never as an exception. */
export function parseHeadlessArgs(argv: string[]): HeadlessArgParse {
  const issues: ImportIssue[] = [];
  const positionals: string[] = [];
  const values: Partial<Record<ValueOption, string>> = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    if (token === '-h' || token === '--help') return { kind: 'help' };

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const separator = token.indexOf('=');
    const name = (separator === -1 ? token.slice(2) : token.slice(2, separator)) as ValueOption | string;
    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) {
      issues.push({ path: `--${name}`, message: 'Unknown option.' });
      continue;
    }

    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === '') {
      issues.push({ path: `--${name}`, message: 'Missing value.' });
      continue;
    }
    values[name as ValueOption] = value;
  }

  if (positionals.length === 0) issues.push({ path: '(plan file)', message: 'Expected one plan file, e.g. plan.json.' });
  if (positionals.length > 1) {
    issues.push({ path: positionals.slice(1).join(' '), message: `Expected one plan file, got ${positionals.length}.` });
  }

  const args: HeadlessArgs = { planPath: positionals[0] ?? '' };

  if (values.mode !== undefined) {
    if (!(SIMULATION_MODES as readonly string[]).includes(values.mode)) {
      issues.push({ path: '--mode', message: `Unknown mode "${values.mode}"; expected one of ${SIMULATION_MODES.join(', ')}.` });
    } else {
      args.mode = values.mode;
    }
  }

  if (values.seed !== undefined) {
    const seed = Number(values.seed);
    if (!Number.isInteger(seed) || seed <= 0) {
      issues.push({ path: '--seed', message: `Expected a positive integer, got "${values.seed}".` });
    } else {
      args.seed = seed;
    }
  }

  if (values['as-of'] !== undefined) {
    if (!isISODateString(values['as-of'])) {
      issues.push({ path: '--as-of', message: `Expected a real calendar date as YYYY-MM-DD, got "${values['as-of']}".` });
    } else {
      args.asOf = values['as-of'];
    }
  }

  if (values.trials !== undefined) {
    const trials = Number(values.trials);
    if (!Number.isInteger(trials) || trials <= 0) {
      issues.push({ path: '--trials', message: `Expected a positive integer, got "${values.trials}".` });
    } else {
      args.trials = trials;
    }
  }

  if (issues.length > 0) return { kind: 'error', issues };
  return { kind: 'ok', args };
}

/** Runs the command and returns its exit code. All output goes through `io`. */
export function runHeadlessSimulate(argv: string[], io: HeadlessIo): number {
  const parsed = parseHeadlessArgs(argv);

  if (parsed.kind === 'help') {
    io.writeStdout(HEADLESS_USAGE);
    return HEADLESS_EXIT.ok;
  }
  if (parsed.kind === 'error') {
    printIssues(io, 'headless:simulate: invalid usage', parsed.issues);
    io.writeStderr(`\nRun with --help for the full command reference.\n`);
    return HEADLESS_EXIT.usage;
  }

  const { planPath } = parsed.args;

  let text: string;
  try {
    text = io.readFile(planPath);
  } catch (error) {
    printIssues(io, 'headless:simulate: cannot read the plan', [
      { path: planPath, message: `could not be read: ${error instanceof Error ? error.message : String(error)}` },
    ]);
    return HEADLESS_EXIT.usage;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    printIssues(io, 'headless:simulate: cannot read the plan', [
      { path: planPath, message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` },
    ]);
    return HEADLESS_EXIT.invalidPlan;
  }

  if (isExportEnvelope(raw)) {
    printIssues(io, 'headless:simulate: wrong kind of file', [
      {
        path: planPath,
        message: `looks like an export envelope (schemaVersion/kind). This command takes the simulator input the engine reads, described by schema/${planJsonSchemaFileName()}. See docs/HEADLESS.md.`,
      },
    ]);
    return HEADLESS_EXIT.invalidPlan;
  }

  const validated = simulatorSchema.safeParse(raw);
  if (!validated.success) {
    printIssues(io, `headless:simulate: ${planPath} is not a valid plan`, issuesFromZodError(validated.error));
    return HEADLESS_EXIT.invalidPlan;
  }
  const plan: SimulatorInputs = validated.data;

  warnAboutUnknownFields(raw, io);

  const run = resolveRunOptions(parsed.args, plan, io);
  if (typeof run === 'number') return run;
  const { mode, seed, asOf, trials, provenance } = run;

  // The clock-relative timeline rules the published schema cannot carry: applied here with
  // the same date the run is pinned to, exactly as the form applies them with "now".
  if (plan.timeline) {
    const timeline = createTimelineFormSchema(asOf).safeParse(plan.timeline);
    if (!timeline.success) {
      printIssues(io, `headless:simulate: ${planPath} is not a valid plan as of ${asOf}`, issuesFromZodError(timeline.error, ['timeline']));
      return HEADLESS_EXIT.invalidPlan;
    }
  }

  io.writeStderr(
    `headless:simulate: ${planPath}\n  mode=${mode} (${provenance.mode}) seed=${seed} (${provenance.seed}) asOf=${asOf} (${provenance.asOf})` +
      (trials === undefined ? '' : ` trials=${trials} (${provenance.trials})`) +
      '\n'
  );

  let outcome;
  try {
    outcome = trials === undefined ? simulate(plan, { mode, seed, asOf }) : simulate(plan, { mode, seed, asOf, trials });
  } catch (error) {
    printIssues(io, 'headless:simulate: the simulation failed', [
      { path: '', message: error instanceof Error ? error.message : String(error) },
    ]);
    return HEADLESS_EXIT.invalidPlan;
  }

  io.writeStdout(`${JSON.stringify(outcome, null, 2)}\n`);
  return HEADLESS_EXIT.ok;
}

type ResolvedRun =
  | {
      mode: SimulationMode;
      seed: number;
      asOf: string;
      trials: number | undefined;
      provenance: Record<'mode' | 'seed' | 'asOf' | 'trials', string>;
    }
  | number;

/**
 * Resolves mode/seed/as-of/trials, recording where each came from so the banner can show
 * that no value was defaulted invisibly.
 */
function resolveRunOptions(args: HeadlessArgs, plan: SimulatorInputs, io: HeadlessIo): ResolvedRun {
  const settings = plan.simulationSettings;

  const mode = (args.mode ?? settings.simulationMode) as SimulationMode;
  const seed = args.seed ?? settings.simulationSeed;
  const asOf = args.asOf ?? settings.asOfDate;

  if (asOf === undefined) {
    printIssues(io, 'headless:simulate: no as-of date', [
      {
        path: '--as-of',
        message:
          'No as-of date was given and the plan has no simulationSettings.asOfDate. Pass --as-of YYYY-MM-DD: the engine never reads the wall clock, so the run date has to be explicit.',
      },
    ]);
    return HEADLESS_EXIT.usage;
  }

  const isMonteCarlo = MONTE_CARLO_MODES.includes(mode);
  if (args.trials !== undefined && !isMonteCarlo) {
    printIssues(io, 'headless:simulate: --trials does not apply', [
      { path: '--trials', message: `Mode "${mode}" runs once; --trials is only valid for ${MONTE_CARLO_MODES.join(', ')}.` },
    ]);
    return HEADLESS_EXIT.usage;
  }

  const trials = isMonteCarlo ? (args.trials ?? DEFAULT_MONTE_CARLO_TRIALS) : undefined;

  return {
    mode,
    seed,
    asOf,
    trials,
    provenance: {
      mode: args.mode === undefined ? 'from plan' : '--mode',
      seed: args.seed === undefined ? 'from plan' : '--seed',
      asOf: args.asOf === undefined ? 'from plan' : '--as-of',
      trials: args.trials === undefined ? 'default' : '--trials',
    },
  };
}

/** A top-level typo would otherwise vanish: `z.object` strips unknown keys silently. */
function warnAboutUnknownFields(raw: unknown, io: HeadlessIo): void {
  if (typeof raw !== 'object' || raw === null) return;
  const known = new Set(Object.keys(simulatorSchema.shape));
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    io.writeStderr(`headless:simulate: warning: ignoring unknown top-level field(s): ${unknown.join(', ')}\n`);
  }
}

function isExportEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.schemaVersion === 'number' && typeof record.kind === 'string';
}

type ZodIssue = z.ZodError['issues'][number];

interface RawIssue {
  parts: PropertyKey[];
  message: string;
}

/**
 * Flattens a Zod error into `{ path, message }` issues.
 *
 * Mirrors the walker behind the import path's issue list (`src/lib/export/plan-envelope.ts`):
 * unions report their leaves (a bad nested field in a union member must not degrade to
 * `timeline: Invalid input`), the null member of a nullable union is skipped, and duplicate
 * path+message pairs are reported once.
 */
export function issuesFromZodError(error: z.ZodError, prefix: readonly PropertyKey[] = []): ImportIssue[] {
  const collected: RawIssue[] = [];
  collectZodIssues(error.issues, prefix, collected, new Set<string>(), false);
  return collected.map((issue) => ({ path: formatPath(issue.parts) || '(root)', message: issue.message }));
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

    // The null member of a nullable union never explains the failure; the other members do.
    if (skipNullMember && issue.code === 'invalid_type' && issue.expected === 'null') continue;

    if (issue.code === 'invalid_union') {
      const branches: RawIssue[] = [];
      for (const branch of issue.errors) collectZodIssues(branch, parts, branches, new Set<string>(), true);
      if (branches.length === 0) {
        pushIssue(out, seen, parts, issue.message);
        continue;
      }
      for (const leaf of branches) pushIssue(out, seen, leaf.parts, leaf.message);
      continue;
    }

    pushIssue(out, seen, parts, issue.message);
  }
}

function pushIssue(out: RawIssue[], seen: Set<string>, parts: PropertyKey[], message: string): void {
  const key = `${formatPath(parts)}\u0000${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ parts, message });
}

function formatPath(parts: readonly PropertyKey[]): string {
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

function printIssues(io: HeadlessIo, title: string, issues: readonly ImportIssue[]): void {
  io.writeStderr(`${title}\n`);
  for (const issue of issues) {
    io.writeStderr(issue.path ? `  ${issue.path}: ${issue.message}\n` : `  ${issue.message}\n`);
  }
}
