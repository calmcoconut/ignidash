import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createLivingExpense, createSavingsAccount, createSimulatorInputs, createWageIncome } from '@/lib/calc/__tests__/test-utils';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { planJsonSchemaFileName } from './plan-json-schema';
import { HEADLESS_EXIT, runHeadlessSimulate, type HeadlessIo } from './simulate-cli';

const PLAN_PATH = 'plan.json';
const AS_OF = '2026-01-01';

function makePlan(overrides: Partial<SimulatorInputs> = {}): SimulatorInputs {
  return createSimulatorInputs({
    incomes: { 'income-1': createWageIncome() },
    expenses: { 'expense-1': createLivingExpense() },
    accounts: { 'savings-1': createSavingsAccount() },
    ...overrides,
  });
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the command with an in-memory file, so no process or temp file is involved. */
function runCli(argv: string[], files: Record<string, string>): CliRun {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: HeadlessIo = {
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return contents;
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  };

  const code = runHeadlessSimulate(argv, io);
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const planFile = (plan: unknown) => ({ [PLAN_PATH]: JSON.stringify(plan, null, 2) });

describe('headless:simulate', () => {
  it("prints simulate()'s result on stdout and the resolved inputs on stderr", () => {
    const run = runCli([PLAN_PATH, '--as-of', AS_OF, '--seed', '7'], planFile(makePlan()));

    expect(run.code).toBe(HEADLESS_EXIT.ok);
    expect(run.stderr).toContain(`mode=fixedReturns (from plan) seed=7 (--seed) asOf=${AS_OF} (--as-of)`);

    const result = JSON.parse(run.stdout) as { mode: string; result: { data: unknown[] } };
    expect(result.mode).toBe('fixedReturns');
    expect(result.result.data.length).toBeGreaterThan(0);
  });

  it('produces byte-identical output for the same seed and as-of, and a different seed changes it', () => {
    const files = planFile(makePlan());
    const args = [PLAN_PATH, '--mode', 'stochasticReturns', '--seed', '42', '--as-of', AS_OF];

    const first = runCli(args, files);
    const second = runCli(args, files);
    const otherSeed = runCli([PLAN_PATH, '--mode', 'stochasticReturns', '--seed', '43', '--as-of', AS_OF], files);

    expect(first.code).toBe(HEADLESS_EXIT.ok);
    expect(first.stdout.length).toBeGreaterThan(0);
    expect(second.stdout).toBe(first.stdout);
    expect(otherSeed.stdout).not.toBe(first.stdout);
  });

  it('reports a malformed plan as field paths and exits non-zero, without a stack trace', () => {
    const plan = makePlan();
    const malformed = {
      ...plan,
      incomes: { 'income-1': { ...plan.incomes['income-1'], amount: 'not a number' } },
      taxSettings: { filingStatus: 'bogus' },
    };

    const run = runCli([PLAN_PATH, '--as-of', AS_OF], planFile(malformed));

    expect(run.code).toBe(HEADLESS_EXIT.invalidPlan);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`headless:simulate: ${PLAN_PATH} is not a valid plan`);
    expect(run.stderr).toContain('incomes.income-1.amount:');
    expect(run.stderr).toContain('taxSettings.filingStatus:');
    // A path list, not a thrown error.
    expect(run.stderr).not.toMatch(/\n\s+at \S+/);
  });

  it('warns about an unknown top-level field instead of silently dropping it', () => {
    const run = runCli([PLAN_PATH, '--as-of', AS_OF], planFile({ ...makePlan(), incomeTypo: {} }));

    expect(run.code).toBe(HEADLESS_EXIT.ok);
    expect(run.stderr).toContain('ignoring unknown top-level field(s): incomeTypo');
  });

  it('refuses to invent an as-of date, and says which flag to pass', () => {
    const run = runCli([PLAN_PATH], planFile(makePlan()));

    expect(run.code).toBe(HEADLESS_EXIT.usage);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no as-of date');
    expect(run.stderr).toContain('--as-of:');
  });

  it("takes the as-of date from the plan's simulationSettings when the flag is absent", () => {
    const plan = makePlan({ simulationSettings: { simulationSeed: 99, simulationMode: 'fixedReturns', asOfDate: '2027-03-01' } });

    const run = runCli([PLAN_PATH], planFile(plan));

    expect(run.code).toBe(HEADLESS_EXIT.ok);
    expect(run.stderr).toContain('seed=99 (from plan) asOf=2027-03-01 (from plan)');
  });

  it('applies the clock-relative timeline rules with the run date', () => {
    const plan = makePlan();
    const aged = { ...plan, timeline: { ...plan.timeline, birthYear: 1925, lifeExpectancy: 110 } };

    const run = runCli([PLAN_PATH, '--as-of', '2030-01-01'], planFile(aged));

    expect(run.code).toBe(HEADLESS_EXIT.invalidPlan);
    expect(run.stderr).toContain('as of 2030-01-01');
    expect(run.stderr).toContain('timeline.birthYear: You must be between 18 and 100 years old');
  });

  it('rejects --trials for a single-run mode', () => {
    const run = runCli([PLAN_PATH, '--as-of', AS_OF, '--trials', '5'], planFile(makePlan()));

    expect(run.code).toBe(HEADLESS_EXIT.usage);
    expect(run.stderr).toContain('--trials:');
    expect(run.stderr).toContain('runs once');
  });

  it('honours --trials for a Monte Carlo mode', () => {
    const run = runCli(
      [PLAN_PATH, '--mode', 'monteCarloStochasticReturns', '--trials', '3', '--seed', '1', '--as-of', AS_OF],
      planFile(makePlan())
    );

    expect(run.code).toBe(HEADLESS_EXIT.ok);
    expect(run.stderr).toContain('trials=3 (--trials)');
    const result = JSON.parse(run.stdout) as { mode: string; result: { simulations: unknown[] } };
    expect(result.mode).toBe('monteCarloStochasticReturns');
    expect(result.result.simulations).toHaveLength(3);
  });

  it('rejects an export envelope and points at the schema', () => {
    const run = runCli([PLAN_PATH, '--as-of', AS_OF], planFile({ schemaVersion: 2, kind: 'ignidash-plan', exportedAt: AS_OF }));

    expect(run.code).toBe(HEADLESS_EXIT.invalidPlan);
    expect(run.stderr).toContain('export envelope');
    expect(run.stderr).toContain(`schema/${planJsonSchemaFileName()}`);
  });

  it('fails on a missing file and on unknown flags with a usage exit code', () => {
    const missing = runCli(['nope.json', '--as-of', AS_OF], {});
    const unknown = runCli([PLAN_PATH, '--as-of', AS_OF, '--bogus', '1'], planFile(makePlan()));
    const notJson = runCli([PLAN_PATH], { [PLAN_PATH]: '{ not json' });

    expect(missing.code).toBe(HEADLESS_EXIT.usage);
    expect(missing.stderr).toContain('could not be read');
    expect(unknown.code).toBe(HEADLESS_EXIT.usage);
    expect(unknown.stderr).toContain('--bogus: Unknown option.');
    expect(notJson.code).toBe(HEADLESS_EXIT.invalidPlan);
    expect(notJson.stderr).toContain('is not valid JSON');
  });

  it('documents every flag, its default and the exit codes in --help', () => {
    const run = runCli(['--help'], {});

    expect(run.code).toBe(HEADLESS_EXIT.ok);
    expect(run.stderr).toBe('');
    for (const fragment of ['--mode', '--seed', '--as-of', '--trials', 'default:', 'Exit codes: 0', 'docs/HEADLESS.md']) {
      expect(run.stdout).toContain(fragment);
    }
    expect(run.stdout).toContain(planJsonSchemaFileName());
  });

  it('is wired into package.json as the documented command', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };

    expect(packageJson.scripts['headless:simulate']).toBe('tsx scripts/headless-simulate.ts');
    expect(packageJson.scripts['schema:plan']).toBe('tsx scripts/generate-plan-json-schema.ts');
  });
});
