// @vitest-environment node
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { basicTemplate } from './templates/basic';
import { simulatorFromConvex } from '../src/lib/utils/data-transformers';
import { SimulationDataExtractor } from '../src/lib/calc/data-extractors/simulation-data-extractor';
import { simulate, type MonteCarloOutcome, type SingleSimulationOutcome } from '../src/lib/calc/simulate';
import { analyzeSimulationTaxYear } from '../src/lib/calc/tax-analytics';
import { isToolCallingEnabled } from './utils/ai_utils';
import { CHAT_TOOL_DEFINITIONS, MAX_TOOL_CALLS_PER_TURN, MAX_VARIANTS_PER_TURN, TOOL_SEED, createChatToolkit } from './chat_tools';

const modules = import.meta.glob('./**/*.ts');
const TEST_USER = 'test-user-123';
const AS_OF = '2026-03-15';

/** A plan from the database, run through the real transformer the chat action uses. */
async function createToolkit(t: ReturnType<typeof convexTest>, planId: Doc<'plans'>['_id'], asOf = AS_OF, seed = TOOL_SEED) {
  const inputs = await t.run(async (ctx) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new Error('plan missing');

    return simulatorFromConvex(plan);
  });

  return createChatToolkit({ inputs, asOf, seed });
}

async function insertPlan(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.insert('plans', { ...basicTemplate, userId: TEST_USER, name: 'Tool Plan', isDefault: true }));
}

/** The subset of each tool's JSON result these tests read. */
interface ToolResult {
  error?: string;
  issues?: Array<{ path: string; message: string }>;
  variantId?: string;
  finalPortfolioValue?: number;
  retirementAge?: number | null;
  perYearTaxes?: Array<{ year: number }>;
  monteCarlo?: { trials: number; retention: string; successRate: number; seed: number } | null;
  deltaMeaning?: string;
  seed?: number;
  metrics?: Array<{ id: string; delta: number | null }>;
  yearly?: Array<{ delta: number }>;
  plan?: { asOf: string; seed: number; counts: { accounts: number } };
  baseline?: { finalPortfolioValue: number };
}

const parse = (json: string): ToolResult => JSON.parse(json) as ToolResult;

describe('chat tools', () => {
  it('round-trip: reads the plan from Convex, runs a patched variant, and leaves the plan untouched', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const before = await t.run(async (ctx) => ctx.db.get(planId));

    const result = await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      if (!plan) throw new Error('plan missing');

      const toolkit = createChatToolkit({ inputs: simulatorFromConvex(plan), asOf: AS_OF });

      return toolkit.execute('simulateVariant', {
        variantId: 'longer-horizon',
        planPatch: { timeline: { ...plan.timeline, lifeExpectancy: 80 } },
      });
    });

    const variant = parse(result);
    expect(variant.error).toBeUndefined();
    expect(variant.variantId).toBe('longer-horizon');
    expect(typeof variant.finalPortfolioValue).toBe('number');
    expect(variant.perYearTaxes?.length ?? 0).toBeGreaterThan(0);

    // The patch is a simulation input only: nothing was written to the plan.
    const after = await t.run(async (ctx) => ctx.db.get(planId));
    expect(after).toEqual(before);
  });

  it('uses the same fixed seed and clock as a direct simulate() call', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const inputs = await t.run(async (ctx) => simulatorFromConvex((await ctx.db.get(planId))!));

    const patched = { ...inputs, marketAssumptions: { ...inputs.marketAssumptions, stockReturn: 6 } };
    const toolkit = createChatToolkit({ inputs, asOf: AS_OF });

    const fromTool = parse(
      toolkit.execute('simulateVariant', { variantId: 'lower-returns', planPatch: { marketAssumptions: { stockReturn: 6 } } })
    );
    // The declared union makes the narrowing explicit instead of leaning on simulate()'s
    // conditional return type.
    const direct: SingleSimulationOutcome<'fixedReturns'> | MonteCarloOutcome = simulate(patched, {
      mode: 'fixedReturns',
      seed: TOOL_SEED,
      asOf: AS_OF,
    });
    if (direct.mode !== 'fixedReturns') throw new Error('expected a single-run projection');

    const { data, context } = direct.result;
    expect(fromTool.finalPortfolioValue).toBe(data[data.length - 1].portfolio.totalValue);

    const milestones = SimulationDataExtractor.getMilestonesData(data, context.startAge);
    expect(fromTool.retirementAge).toBe(milestones.retirementAge);
  });

  it(`enforces the per-turn tool budget of ${MAX_TOOL_CALLS_PER_TURN}`, async () => {
    const t = convexTest(schema, modules);
    const toolkit = await createToolkit(t, await insertPlan(t));

    for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index++) {
      expect(parse(toolkit.execute('getPlanSummary', {})).error).toBeUndefined();
    }

    const refused = parse(toolkit.execute('getPlanSummary', {}));
    expect(refused.error).toContain('Tool budget exhausted');
    expect(toolkit.callCount()).toBe(MAX_TOOL_CALLS_PER_TURN);
  });

  it(`enforces the per-turn variant budget of ${MAX_VARIANTS_PER_TURN}`, async () => {
    const t = convexTest(schema, modules);
    const toolkit = await createToolkit(t, await insertPlan(t));

    for (let index = 0; index < MAX_VARIANTS_PER_TURN; index++) {
      const result = parse(
        toolkit.execute('simulateVariant', { variantId: `v${index}`, planPatch: { marketAssumptions: { stockReturn: 5 + index } } })
      );
      expect(result.error).toBeUndefined();
    }

    const refused = parse(toolkit.execute('simulateVariant', { variantId: 'one-too-many', planPatch: {} }));
    expect(refused.error).toContain('Variant budget exhausted');
    expect(toolkit.variantIds()).toHaveLength(MAX_VARIANTS_PER_TURN);
    // Re-simulating an existing variant id is allowed: it does not grow the set.
    expect(parse(toolkit.execute('simulateVariant', { variantId: 'v0', planPatch: {} })).error).toBeUndefined();
  });

  it('refuses a patch that does not validate, and refuses to patch the pinned settings', async () => {
    const t = convexTest(schema, modules);
    const toolkit = await createToolkit(t, await insertPlan(t));

    const invalid = parse(
      toolkit.execute('simulateVariant', {
        variantId: 'bad-age',
        planPatch: { timeline: { retirementStrategy: { type: 'fixedAge', retirementAge: 200 } } },
      })
    );
    expect(invalid.error).toContain('did not validate');
    expect(invalid.issues?.length ?? 0).toBeGreaterThan(0);

    const pinned = parse(
      toolkit.execute('simulateVariant', { variantId: 'clock', planPatch: { simulationSettings: { simulationSeed: 42 } } })
    );
    expect(pinned.error).toContain('did not validate');
    expect(JSON.stringify(pinned.issues)).toContain('pins the clock');

    const unknownSection = parse(toolkit.execute('simulateVariant', { variantId: 'nope', planPatch: { helicopter: true } }));
    expect(unknownSection.error).toContain('did not validate');

    // Nothing was simulated, so no variant exists.
    expect(toolkit.variantIds()).toEqual([]);
  });

  it(
    'compares a variant with the baseline through the delta extractor, all zero for an identical patch',
    { timeout: 180_000 },
    async () => {
      const t = convexTest(schema, modules);
      const toolkit = await createToolkit(t, await insertPlan(t));

      expect(parse(toolkit.execute('compareToBaseline', { variantId: 'missing' })).error).toContain('Unknown variant');

      toolkit.execute('simulateVariant', { variantId: 'identical', planPatch: {} });
      const comparison = parse(toolkit.execute('compareToBaseline', { variantId: 'identical' }));

      expect(comparison.deltaMeaning).toBe('a - b');
      expect(comparison.seed).toBe(TOOL_SEED);
      expect(comparison.metrics?.length ?? 0).toBeGreaterThan(0);
      expect(comparison.metrics?.every((metric) => metric.delta === 0)).toBe(true);
      expect(comparison.yearly?.every((year) => year.delta === 0)).toBe(true);
    }
  );

  it('runs Monte Carlo only when asked, with 500 summary trials', { timeout: 60_000 }, async () => {
    const t = convexTest(schema, modules);
    const toolkit = await createToolkit(t, await insertPlan(t));

    const withoutMonteCarlo = parse(toolkit.execute('simulateVariant', { variantId: 'no-mc', planPatch: {} }));
    expect(withoutMonteCarlo.monteCarlo).toBeNull();

    const withMonteCarlo = parse(toolkit.execute('simulateVariant', { variantId: 'with-mc', planPatch: {}, includeMonteCarlo: true }));
    expect(withMonteCarlo.monteCarlo?.trials).toBe(500);
    expect(withMonteCarlo.monteCarlo?.retention).toBe('summary');
    expect(withMonteCarlo.monteCarlo?.successRate ?? -1).toBeGreaterThanOrEqual(0);
    expect(withMonteCarlo.monteCarlo?.seed).toBe(TOOL_SEED);
  });

  it('summarises the baseline plan without writing anything', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const toolkit = await createToolkit(t, planId);

    const summary = parse(toolkit.execute('getPlanSummary', {}));
    expect(summary.plan?.asOf).toBe(AS_OF);
    expect(summary.plan?.seed).toBe(TOOL_SEED);
    expect(summary.plan?.counts.accounts ?? 0).toBeGreaterThan(0);
    expect(typeof summary.baseline?.finalPortfolioValue).toBe('number');

    const plan = await t.run(async (ctx) => ctx.db.get(planId));
    expect(plan?.name).toBe('Tool Plan');
  });

  it('exposes exactly the four tools the plan specifies', () => {
    expect(CHAT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual([
      'getPlanSummary',
      'simulateVariant',
      'compareToBaseline',
      'getTaxAnalytics',
    ]);
  });

  it('is reachable from the Convex runtime the messenger uses', async () => {
    // The action module is what `messages.send` schedules; importing it here proves the tool
    // module graph loads inside the Convex function runtime (no browser or worker globals).
    const chatAction = await import('./use_openai');
    expect(typeof chatAction.streamChat).toBe('function');

    // The gate query exists on the chat surface (it needs auth to answer, so it is not called
    // here; convex-test has no Better-Auth component registered).
    expect(typeof api.messages.canUseTools).toBe('object');
  });
});

describe('getTaxAnalytics (§7-A3, P3-P6)', () => {
  /** The baseline inputs and projection rows the tool reads, computed the way the tool does. */
  async function baseline(t: ReturnType<typeof convexTest>, planId: Doc<'plans'>['_id']) {
    const inputs = await t.run(async (ctx) => {
      const plan = await ctx.db.get(planId);
      if (!plan) throw new Error('plan missing');

      return simulatorFromConvex(plan);
    });
    const outcome = simulate(inputs, { mode: 'fixedReturns' as const, seed: TOOL_SEED, asOf: AS_OF });
    if (outcome.mode !== 'fixedReturns') throw new Error('expected a single run');

    return { inputs, data: outcome.result.data };
  }

  /** The tool analyses the year's LAST row: a year has a row per month, and that is its settled state. */
  function lastIndexFor(data: ReadonlyArray<{ date: string }>, year: number): number {
    for (let index = data.length - 1; index >= 0; index--) if (Number(data[index].date.slice(0, 4)) === year) return index;
    throw new Error(`the projection has no row for ${year}`);
  }

  it('returns exactly what the pure function returns for the same row', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const toolkit = await createToolkit(t, planId);
    const { inputs, data } = await baseline(t, planId);
    const before = await t.run(async (ctx) => ctx.db.get(planId));

    // A mid-run year: its last row is settled and its two-year IRMAA lookback is available.
    const year = Number(data[Math.min(40, data.length - 1)].date.slice(0, 4));
    const expected = analyzeSimulationTaxYear({
      data,
      index: lastIndexFor(data, year),
      filingStatus: inputs.taxSettings.filingStatus,
    });

    const result = JSON.parse(toolkit.execute('getTaxAnalytics', { year })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result.year).toBe(year);
    expect(result.reported).toStrictEqual(expected.reported);
    expect(result.bracketFill).toStrictEqual(expected.bracketFill);
    expect(result.conversionHeadroom).toStrictEqual(expected.conversionHeadroom);
    expect(result.marginalRates).toStrictEqual(expected.marginalRates);
    expect(result.cliffs).toStrictEqual(expected.cliffs);
    expect(result.jurisdictions).toStrictEqual(expected.jurisdictions);
    expect(result.notComputed).toStrictEqual(expected.notComputed);

    // Read-only: the plan is untouched and no variant was created.
    expect(await t.run(async (ctx) => ctx.db.get(planId))).toEqual(before);
    expect(toolkit.variantIds()).toEqual([]);
  });

  it('refuses the projection’s own starting year, which has no settled tax result', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const toolkit = await createToolkit(t, planId);
    const { data } = await baseline(t, planId);

    // Row 0 is the initial state: the engine has not settled a year yet. The tool says so instead
    // of sliding to the next year and answering a question nobody asked.
    const firstYear = Number(data[0].date.slice(0, 4));
    const result = JSON.parse(toolkit.execute('getTaxAnalytics', { year: firstYear })) as { error?: string; reported?: unknown };

    expect(result.error).toMatch(/starting state/);
    expect(result.reported).toBeUndefined();

    // The next year is settled, so the same call against it works.
    const nextYear = Number(data[1].date.slice(0, 4));
    expect((JSON.parse(toolkit.execute('getTaxAnalytics', { year: nextYear })) as { error?: string }).error).toBeUndefined();
  });

  it('refuses a year it cannot analyse instead of guessing one', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const toolkit = await createToolkit(t, planId);

    const fractional = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2029.5 })) as { error?: string };
    expect(fractional.error).toMatch(/whole calendar year/);

    const missing = JSON.parse(toolkit.execute('getTaxAnalytics', {})) as { error?: string };
    expect(missing.error).toMatch(/whole calendar year/);

    // Outside the projection: the error names the span so the model can retry with a real year.
    const outside = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 1900 })) as { error?: string; reported?: unknown };
    expect(outside.error).toMatch(/covers \d{4} to \d{4}/);
    expect(outside.reported).toBeUndefined();
  });

  it('costs one tool call, creates no variant, and stops at the tool budget', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const toolkit = await createToolkit(t, planId);
    const { data } = await baseline(t, planId);
    const year = Number(data[Math.min(10, data.length - 1)].date.slice(0, 4));

    for (let call = 1; call < MAX_TOOL_CALLS_PER_TURN; call++) {
      const result = JSON.parse(toolkit.execute('getTaxAnalytics', { year })) as { error?: string };
      expect(result.error).toBeUndefined();
    }

    // Eleven calls used, eleven counted, and the variant budget untouched.
    expect(toolkit.callCount()).toBe(MAX_TOOL_CALLS_PER_TURN - 1);
    expect(toolkit.variantIds()).toEqual([]);

    // The twelfth is still allowed; the thirteenth is refused, with no numbers attached.
    expect((JSON.parse(toolkit.execute('getTaxAnalytics', { year })) as { error?: string }).error).toBeUndefined();
    const exhausted = JSON.parse(toolkit.execute('getTaxAnalytics', { year })) as { error?: string };
    expect(exhausted.error).toMatch(/Tool budget exhausted/);
  });

  it('describes only the levers the toolkit can run, and reports the ACA cliff as unsupported', () => {
    // The conversion-schedule lever is deferred until P3-P5 is wired: a description that named it
    // would send the model looking for a tool that does not exist.
    for (const tool of CHAT_TOOL_DEFINITIONS) {
      expect(tool.function.description).not.toMatch(/getConversionSchedule|conversion schedule/i);
    }

    const description = CHAT_TOOL_DEFINITIONS.find((tool) => tool.function.name === 'getTaxAnalytics')?.function.description ?? '';
    expect(description).toMatch(/IRMAA/);
    // ACA premium credits are P3-P7b: the analytics returns `supported: false`, so the description
    // must not promise a distance to a cliff the tool cannot measure.
    expect(description).toMatch(/ACA cliff comes back as not evaluated/);
  });
});

describe('tool-calling gate (F4)', () => {
  const original = process.env.OPENAI_TOOLS_ENABLED;

  beforeEach(() => {
    delete process.env.OPENAI_TOOLS_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_TOOLS_ENABLED;
    else process.env.OPENAI_TOOLS_ENABLED = original;
  });

  it('is on by default, and off only when explicitly disabled', () => {
    expect(isToolCallingEnabled()).toBe(true);

    process.env.OPENAI_TOOLS_ENABLED = 'false';
    expect(isToolCallingEnabled()).toBe(false);

    process.env.OPENAI_TOOLS_ENABLED = 'true';
    expect(isToolCallingEnabled()).toBe(true);
  });
});
