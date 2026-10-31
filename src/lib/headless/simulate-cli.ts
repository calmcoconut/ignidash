import { z } from 'zod';

import { isISODateString } from '@/lib/calc/clock';
import { DEFAULT_MONTE_CARLO_TRIALS, MONTE_CARLO_MAX_TRIALS, simulate } from '@/lib/calc/simulate';
import type { ImportIssue } from '@/lib/export/plan-envelope';
import { issuesFromZodError } from '@/lib/utils/zod-issues';
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
    const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
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

  const largeRunWarning = fullRetentionWarning(trials);
  if (largeRunWarning) io.writeStderr(`${largeRunWarning}\n`);

  let outcome;
  try {
    // Full retention is opt-in on `simulate()`; this CLI's contract is to print every trial's
    // result, so it asks for exactly that alongside the trial count.
    outcome =
      trials === undefined
        ? simulate(plan, { mode, seed, asOf })
        : simulate(plan, { mode, seed, asOf, trials, monteCarlo: { retention: 'full' } });
  } catch (error) {
    printIssues(io, 'headless:simulate: the simulation failed', [
      { path: '', message: error instanceof Error ? error.message : String(error) },
    ]);
    return HEADLESS_EXIT.invalidPlan;
  }

  const serialized = serializeOutcome(outcome);
  if (!serialized.ok) {
    printIssues(io, 'headless:simulate: the result is too large to print', [
      {
        path: '--trials',
        message: `the retained results could not be written as one JSON document (${serialized.message}). Rerun with fewer --trials.`,
      },
    ]);
    return HEADLESS_EXIT.invalidPlan;
  }

  io.writeStdout(serialized.text);
  return HEADLESS_EXIT.ok;
}

/**
 * Pretty-prints the outcome, reporting rather than throwing when it cannot.
 *
 * Full retention makes this reachable: V8 refuses to build a string larger than ~512 MB, and a
 * few hundred trials on a realistic plan are enough to reach it. A stack trace would be a poor
 * answer for an explicit, documented flag value.
 */
export function serializeOutcome(outcome: unknown): { ok: true; text: string } | { ok: false; message: string } {
  try {
    return { ok: true, text: `${JSON.stringify(outcome, null, 2)}\n` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
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
 * Above this many trials the CLI's full-retention output gets expensive: it prints every
 * trial's complete result, and a single pretty-printed result measured ~0.75 MB on a plan with
 * income, expenses and a savings account (100 trials ≈ 75 MB, the 500-trial default ≈ 375 MB).
 * The engine already refuses more than `MONTE_CARLO_MAX_TRIALS`; this warns earlier and still
 * runs, because a large run can be deliberate and the flag is explicit.
 */
export const FULL_RETENTION_WARNING_TRIALS = 100;

/**
 * Measured on the CLI's own fixture-sized plan. Output is what the user sees; the same results
 * are also held in memory before they are printed.
 */
const APPROX_OUTPUT_BYTES_PER_TRIAL = 770_000;

/** The stderr warning for a large full-retention run, or null when the run is small. */
export function fullRetentionWarning(trials: number | undefined): string | null {
  if (trials === undefined || trials <= FULL_RETENTION_WARNING_TRIALS) return null;

  return (
    `headless:simulate: warning: --trials ${trials} keeps the full result of every trial — about ` +
    `${formatBytes(trials * APPROX_OUTPUT_BYTES_PER_TRIAL)} of JSON on stdout, held in memory first. ` +
    `simulate() refuses more than ${MONTE_CARLO_MAX_TRIALS} trials.`
  );
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  if (gigabytes >= 1) return `${gigabytes.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

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

/**
 * A typo would otherwise vanish: `z.object` strips unknown keys silently, and a mistyped
 * optional field changes the answer (a `disabeld` income runs as active).
 *
 * So the walk recurses through the schema at every depth and reports the paths. It is a
 * warning, not a refusal, in line with top-level fields: `simulatorSchema` is not strict, the
 * published JSON Schema is the contract for shape, and refusing here would reject files the
 * app itself runs.
 */
function warnAboutUnknownFields(raw: unknown, io: HeadlessIo): void {
  const found: string[] = [];
  collectUnknownFields(simulatorSchema, raw, '', found, 0);

  const unique = [...new Set(found)].sort();
  if (unique.length === 0) return;

  const shown = unique.slice(0, MAX_REPORTED_UNKNOWN_FIELDS);
  const rest = unique.length - shown.length;
  io.writeStderr(`headless:simulate: warning: ignoring unknown field(s): ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}\n`);
}

const MAX_REPORTED_UNKNOWN_FIELDS = 10;
/** Plan data is shallow; the cap only stops a pathological file from recursing forever. */
const MAX_UNKNOWN_FIELD_DEPTH = 32;

/** The slice of Zod's internal definition this walk reads. */
interface ZodDefinition {
  type?: string;
  shape?: Record<string, z.ZodType>;
  valueType?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  getter?: () => z.ZodType;
  in?: z.ZodType;
}

function definitionOf(schema: z.ZodType): ZodDefinition | undefined {
  // SAFETY: Zod 4 keeps the definition on `_zod.def`; only the fields listed above are read,
  // and every read is guarded, so an unexpected node kind degrades to "no keys to check".
  return (schema as unknown as { _zod?: { def?: ZodDefinition } })._zod?.def;
}

/** Collects dotted/indexed paths of keys the schema at that position does not define. */
function collectUnknownFields(schema: z.ZodType, value: unknown, path: string, out: string[], depth: number): void {
  if (depth > MAX_UNKNOWN_FIELD_DEPTH) return;
  const def = definitionOf(schema);
  if (!def) return;

  switch (def.type) {
    case 'object': {
      if (!isPlainObject(value) || !def.shape) return;
      for (const [key, child] of Object.entries(value)) {
        const childSchema = def.shape[key];
        if (childSchema) collectUnknownFields(childSchema, child, joinPath(path, key), out, depth + 1);
        else out.push(joinPath(path, key));
      }
      return;
    }

    case 'record': {
      if (!isPlainObject(value) || !def.valueType) return;
      // Record keys are free-form by design; only their values have a schema.
      for (const [key, child] of Object.entries(value)) {
        collectUnknownFields(def.valueType, child, joinPath(path, key), out, depth + 1);
      }
      return;
    }

    case 'array': {
      if (!Array.isArray(value) || !def.element) return;
      value.forEach((item, index) => collectUnknownFields(def.element!, item, `${path}[${index}]`, out, depth + 1));
      return;
    }

    case 'union': {
      // A union's variants have different field sets. Report the variant that fits the value
      // best (fewest unknown keys), so a `fixedAge` frame is not blamed for lacking
      // `safeWithdrawalRate`. Members whose runtime kind cannot match are not candidates.
      const options = (def.options ?? []).filter((option) => couldAccept(option, value));
      const candidates = options.length > 0 ? options : (def.options ?? []);
      let best: string[] | null = null;
      for (const option of candidates) {
        const branch: string[] = [];
        collectUnknownFields(option, value, path, branch, depth + 1);
        if (best === null || branch.length < best.length) best = branch;
      }
      if (best) out.push(...best);
      return;
    }

    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
    case 'prefault':
      if (def.innerType) collectUnknownFields(def.innerType, value, path, out, depth + 1);
      return;

    case 'pipe':
      // The input side is what a file is checked against.
      if (def.in) collectUnknownFields(def.in, value, path, out, depth + 1);
      return;

    case 'lazy': {
      const inner = def.getter?.();
      if (inner) collectUnknownFields(inner, value, path, out, depth + 1);
      return;
    }

    default:
      // Leaf kinds (string, number, boolean, enum, literal, ...) hold no keys.
      return;
  }
}

/** Whether a schema node could accept a value of this runtime kind, used to pick a union member. */
function couldAccept(schema: z.ZodType, value: unknown): boolean {
  const def = definitionOf(schema);
  if (!def) return false;

  switch (def.type) {
    case 'object':
    case 'record':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
    case 'prefault':
      return def.innerType ? couldAccept(def.innerType, value) : false;
    case 'pipe':
      return def.in ? couldAccept(def.in, value) : false;
    case 'lazy': {
      const inner = def.getter?.();
      return inner ? couldAccept(inner, value) : false;
    }
    case 'union':
      return (def.options ?? []).some((option) => couldAccept(option, value));
    default:
      return !isPlainObject(value) && !Array.isArray(value);
  }
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExportEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.schemaVersion === 'number' && typeof record.kind === 'string';
}

// `issuesFromZodError` and the path formatter are shared with the import path
// (`src/lib/utils/zod-issues.ts`), so a malformed union — say a `retirementStrategy` with a
// correct `type` and a missing field — reports the same leaves here as it does on import.
export { issuesFromZodError };

function printIssues(io: HeadlessIo, title: string, issues: readonly ImportIssue[]): void {
  io.writeStderr(`${title}\n`);
  for (const issue of issues) {
    io.writeStderr(issue.path ? `  ${issue.path}: ${issue.message}\n` : `  ${issue.message}\n`);
  }
}
