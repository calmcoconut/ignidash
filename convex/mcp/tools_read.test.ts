// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { basicTemplate } from '../templates/basic';
import { EXPORT_SCHEMA_VERSION, parseEnvelopeValue } from '../../src/lib/export/plan-envelope';
import { MAX_TOOL_CALLS_PER_TURN } from '../chat_tools';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it ships with
// `vite/client`, which this suite does not depend on, so the transform's shape is declared locally.
// The glob reaches the whole `convex/` tree (one level up from this file), so every module an action
// or query imports through `internal` resolves. Vite keys files in this directory as `./x.ts` and the
// rest as `../x.ts`; convex-test takes its module root from the first `_generated` key and needs one
// prefix for all of them, so the `./` keys (this directory, `convex/mcp/`) are rewritten to `../mcp/`.
const globbed = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('../**/*.ts');
const modules = Object.fromEntries(
  Object.entries(globbed).map(([path, load]) => [path.startsWith('./') ? `../mcp/${path.slice(2)}` : path, load])
);

const OWNER = 'test-user-123';
const OTHER = 'other-user-456';

function makePlan(userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId, name, ...overrides };
}

async function insertPlan(t: ReturnType<typeof convexTest>, userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => ctx.db.insert('plans', makePlan(userId, name, overrides)));
}

function queryTool(t: ReturnType<typeof convexTest>, userId: string, tool: string, input: unknown = {}) {
  return t.query(internal.mcp.exec.runQueryTool, { userId, tool, input });
}

function actionTool(t: ReturnType<typeof convexTest>, userId: string, tool: string, input: unknown) {
  return t.action(internal.mcp.exec.runActionTool, { userId, tool, input });
}

/** The engine's own headline projection, read through the chat tool, so tests can state it exists. */
type PlanSummary = { plan: { counts: Record<string, number> }; baseline: { success: boolean } };
type AnalyzeResult = { asOf: string; results: { tool: string; result: Record<string, unknown> }[] };

describe('list_plans', () => {
  it('returns only the caller plans, with their counts', async () => {
    const t = convexTest(schema, modules);
    const mine = await insertPlan(t, OWNER, 'Mine');
    await insertPlan(t, OTHER, 'Theirs');

    const rows = (await queryTool(t, OWNER, 'list_plans')) as {
      planId: Id<'plans'>;
      name: string;
      isDefault: boolean;
      hasTimeline: boolean;
      counts: Record<string, number>;
    }[];

    expect(rows.map((row) => row.name)).toEqual(['Mine']);
    expect(rows[0].planId).toBe(mine);
    expect(rows[0].hasTimeline).toBe(true);
    expect(rows[0].counts).toEqual({
      accounts: basicTemplate.accounts.length,
      incomes: basicTemplate.incomes.length,
      expenses: basicTemplate.expenses.length,
      debts: basicTemplate.debts?.length ?? 0,
      physicalAssets: basicTemplate.physicalAssets?.length ?? 0,
    });
  });
});

describe('get_plan', () => {
  it('refuses another user plan', async () => {
    const t = convexTest(schema, modules);
    const theirs = await insertPlan(t, OTHER, 'Theirs');

    await expect(queryTool(t, OWNER, 'get_plan', { planId: theirs })).rejects.toThrow(/not authorized|not found/i);
  });

  it('returns an envelope that the importer accepts', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');

    const result = (await queryTool(t, OWNER, 'get_plan', { planId })) as { planId: string; envelope: unknown };
    const parsed = parseEnvelopeValue(result.envelope);

    expect(result.planId).toBe(planId);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.envelope).toMatchObject({ schemaVersion: EXPORT_SCHEMA_VERSION, kind: 'ignidash-plan' });
  });

  it('names planId when it is missing', async () => {
    const t = convexTest(schema, modules);
    await insertPlan(t, OWNER, 'Mine');

    await expect(queryTool(t, OWNER, 'get_plan', {})).rejects.toThrow(/planId/);
  });
});

describe('get_schema', () => {
  it('lists the plan sections when no section is given', async () => {
    const t = convexTest(schema, modules);

    const result = (await queryTool(t, OWNER, 'get_schema')) as {
      schemaVersion: number;
      envelope: Record<string, string>;
      sections: string[];
      schema: unknown;
    };

    expect(result.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    // Convex returns object keys sorted, so the set is what matters.
    expect(Object.keys(result.envelope).sort()).toEqual(['exportedAt', 'finances', 'kind', 'plan', 'schemaVersion']);
    expect(result.sections).toEqual(expect.arrayContaining(['timeline', 'incomes', 'accounts', 'expenses', 'simulationSettings']));
    expect(result.schema).toBeTypeOf('object');
  });

  it('returns one section schema when section is given', async () => {
    const t = convexTest(schema, modules);

    const result = (await queryTool(t, OWNER, 'get_schema', { section: 'incomes' })) as { section: string; schema: { type?: string } };

    expect(result.section).toBe('incomes');
    expect(result.schema.type).toBe('array');
  });

  it('throws for an unknown section and lists the valid ones', async () => {
    const t = convexTest(schema, modules);

    await expect(queryTool(t, OWNER, 'get_schema', { section: 'nonsense' })).rejects.toThrow(/Unknown section "nonsense".*incomes/);
  });
});

describe('validate_plan', () => {
  it('reports junk as not ok, with issues', async () => {
    const t = convexTest(schema, modules);

    const result = (await queryTool(t, OWNER, 'validate_plan', { planFile: { kind: 'ignidash-plan' } })) as {
      ok: boolean;
      issues: { path: string; message: string }[];
    };

    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports an exported plan as ok', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');
    const exported = (await queryTool(t, OWNER, 'get_plan', { planId })) as { envelope: unknown };

    const result = (await queryTool(t, OWNER, 'validate_plan', { planFile: exported.envelope })) as { ok: boolean };

    expect(result.ok).toBe(true);
  });
});

describe('analyze_plan', () => {
  it('runs getPlanSummary', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');

    const result = (await actionTool(t, OWNER, 'analyze_plan', {
      planId,
      asOf: '2026-11-01',
      calls: [{ tool: 'getPlanSummary' }],
    })) as AnalyzeResult;

    expect(result.asOf).toBe('2026-11-01');
    expect(result.results[0].tool).toBe('getPlanSummary');
    expect((result.results[0].result as unknown as PlanSummary).baseline.success).toBeTypeOf('boolean');
  });

  it('finds a variant made earlier in the same call', { timeout: 60_000 }, async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');

    const result = (await actionTool(t, OWNER, 'analyze_plan', {
      planId,
      asOf: '2026-11-01',
      calls: [
        {
          tool: 'simulateVariant',
          args: { variantId: 'retire-earlier', planPatch: { timeline: { retirementStrategy: { type: 'fixedAge', retirementAge: 55 } } } },
        },
        { tool: 'compareToBaseline', args: { variantId: 'retire-earlier' } },
      ],
    })) as AnalyzeResult;

    const compare = result.results[1];
    expect(compare.tool).toBe('compareToBaseline');
    expect(compare.result).not.toHaveProperty('error');
  });

  it('refuses another user plan', async () => {
    const t = convexTest(schema, modules);
    const theirs = await insertPlan(t, OTHER, 'Theirs');

    await expect(
      actionTool(t, OWNER, 'analyze_plan', { planId: theirs, asOf: '2026-11-01', calls: [{ tool: 'getPlanSummary' }] })
    ).rejects.toThrow(/Plan not found/);
  });

  it('rejects a malformed asOf', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');

    await expect(actionTool(t, OWNER, 'analyze_plan', { planId, asOf: '11/01/2026', calls: [{ tool: 'getPlanSummary' }] })).rejects.toThrow(
      /asOf must be a calendar date/
    );
  });

  it('rejects an unknown tool and lists the valid ones', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');

    await expect(actionTool(t, OWNER, 'analyze_plan', { planId, calls: [{ tool: 'deleteEverything' }] })).rejects.toThrow(
      /Unknown tool deleteEverything.*getPlanSummary/
    );
  });

  it('rejects more calls than one turn allows', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t, OWNER, 'Mine');
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 1 }, () => ({ tool: 'getPlanSummary' }));

    await expect(actionTool(t, OWNER, 'analyze_plan', { planId, calls })).rejects.toThrow(/at most 12 calls/);
  });
});
