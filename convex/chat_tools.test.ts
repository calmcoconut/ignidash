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

  it('exposes exactly the three tools the plan specifies', () => {
    expect(CHAT_TOOL_DEFINITIONS.map((tool) => tool.function.name)).toEqual(['getPlanSummary', 'simulateVariant', 'compareToBaseline']);
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
