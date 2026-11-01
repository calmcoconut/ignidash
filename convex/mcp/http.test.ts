// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { basicTemplate } from '../templates/basic';
import { MCP_TOOLS, type McpManifest } from './registry';

// SAFETY: see `tokens.test.ts`. The pattern is root-relative because a relative glob from this
// folder skips `convex/mcp/` itself.
const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('/convex/**/*.ts');

const OWNER = 'test-user-123';

function setup() {
  return convexTest(schema, modules);
}

async function createToken(t: ReturnType<typeof setup>, scope: 'read' | 'write' = 'write') {
  return t.withIdentity({ subject: OWNER }).mutation(api.mcp.tokens.createToken, { name: 'http test', scope });
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe('GET /mcp/manifest', () => {
  it('answers 401 without an Authorization header', async () => {
    const t = setup();
    const response = await t.fetch('/mcp/manifest');

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('answers 401 for a token that does not exist', async () => {
    const t = setup();
    const response = await t.fetch('/mcp/manifest', { headers: bearer('ign_not-a-real-token') });

    expect(response.status).toBe(401);
  });

  it('answers 401 with the malformed-token error for a token without the ign_ prefix', async () => {
    const t = setup();
    const response = await t.fetch('/mcp/manifest', { headers: { authorization: 'Bearer abc123' } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Missing or malformed bearer token' });
  });

  it('answers 200 with the tools for a valid token', async () => {
    const t = setup();
    const created = await createToken(t);

    const response = await t.fetch('/mcp/manifest', { headers: bearer(created.token) });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: unknown[] };
    expect(Array.isArray(body.tools)).toBe(true);
  });
});

describe('POST /mcp/tool', () => {
  const post = (t: ReturnType<typeof setup>, token: string, body: BodyInit) =>
    t.fetch('/mcp/tool', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body,
    });

  it('answers 401 without a token, before reading the body', async () => {
    const t = setup();
    const response = await t.fetch('/mcp/tool', { method: 'POST', body: '{"name":"list_plans"}' });

    expect(response.status).toBe(401);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const t = setup();
    const created = await createToken(t);

    const response = await post(t, created.token, 'not json {');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it('answers 404 for a tool name the registry does not know', async () => {
    const t = setup();
    const created = await createToken(t);

    const response = await post(t, created.token, JSON.stringify({ name: 'no_such_tool', input: {} }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Unknown tool: no_such_tool' });
  });

  it('answers 429 once the token has made 120 calls in the last minute', async () => {
    const t = setup();
    const created = await createToken(t);
    const tokenId = created.tokenId;

    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'list_plans', ok: true, at: now - i });
      }
    });

    const response = await post(t, created.token, JSON.stringify({ name: 'list_plans', input: {} }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Rate limit: 120 calls a minute per token' });
  });

  it('records each authenticated call that reaches a tool, and wraps its outcome in ok/result or ok/error', async () => {
    const t = setup();
    const created = await createToken(t);

    const response = await post(t, created.token, JSON.stringify({ name: 'list_plans', input: {} }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(typeof body.ok).toBe('boolean');

    const audit = await t.run((ctx) => ctx.db.query('mcpAudit').collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'list_plans', ok: body.ok });
  });

  it('answers 200 with ok false and the error text when the tool refuses the input', async () => {
    const t = setup();
    const created = await createToken(t);

    const response = await post(t, created.token, JSON.stringify({ name: 'get_plan', input: { planId: 'not-a-plan-id' } }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});

/**
 * Tokens, read tools and write tools together through the real
 * router, as the Next.js adapter calls them.
 */
describe('the MCP endpoint end to end', () => {
  const post = (t: ReturnType<typeof setup>, token: string, name: string, input: unknown) =>
    t.fetch('/mcp/tool', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name, input }),
    });

  const insertPlan = (t: ReturnType<typeof setup>, userId = OWNER) =>
    t.run((ctx) => ctx.db.insert('plans', { ...basicTemplate, userId, name: 'Plan', isDefault: true }));

  it('advertises every registered tool to a write token, each with an object input schema', async () => {
    const t = setup();
    const { token } = await createToken(t, 'write');

    const body = (await (await t.fetch('/mcp/manifest', { headers: bearer(token) })).json()) as McpManifest;

    expect(body.tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());
    expect(MCP_TOOLS.length).toBeGreaterThan(30);
    for (const tool of body.tools) expect(tool.inputSchema.type, tool.name).toBe('object');
    expect(body.prompts.map((prompt) => prompt.name)).toContain('setup_interview');
    expect(body.resources.map((resource) => resource.uri)).toContain('ignidash://help/limitations');
  });

  it('hides write tools from a read token and refuses them with 403, changing nothing', async () => {
    const t = setup();
    const planId = await insertPlan(t);
    const { token } = await createToken(t, 'read');

    const manifest = (await (await t.fetch('/mcp/manifest', { headers: bearer(token) })).json()) as McpManifest;
    const names = manifest.tools.map((tool) => tool.name);
    expect(names).toContain('list_plans');
    expect(names).toContain('list_journal');
    expect(names).not.toContain('upsert_account');

    const before = await t.run((ctx) => ctx.db.get(planId));
    const response = await post(t, token, 'update_tax_settings', { planId, taxSettings: { filingStatus: 'marriedFilingJointly' } });

    expect(response.status).toBe(403);
    expect(await t.run((ctx) => ctx.db.get(planId))).toEqual(before);
  });

  it('runs a read, a write and an analysis as the token owner', async () => {
    const t = setup();
    const planId = await insertPlan(t);
    const { token } = await createToken(t, 'write');

    const listed = (await (await post(t, token, 'list_plans', {})).json()) as { ok: boolean; result: { planId: string }[] };
    expect(listed.ok).toBe(true);
    expect(listed.result.map((plan) => plan.planId)).toEqual([planId]);

    const fetched = (await (await post(t, token, 'get_plan', { planId })).json()) as { ok: boolean; result: { envelope: unknown } };
    const created = (await (await post(t, token, 'create_plan', { name: 'Copy via MCP', planFile: fetched.result.envelope })).json()) as {
      ok: boolean;
      result: { planId: string };
      error?: string;
    };
    expect(created.error).toBeUndefined();
    const copy = await t.run((ctx) => ctx.db.get(created.result.planId as Id<'plans'>));
    expect(copy).toMatchObject({ userId: OWNER, name: 'Copy via MCP', accounts: basicTemplate.accounts });

    const analysis = (await (
      await post(t, token, 'analyze_plan', { planId, asOf: '2026-11-01', calls: [{ tool: 'getPlanSummary' }] })
    ).json()) as {
      ok: boolean;
      result: { results: { tool: string; result: unknown }[] };
    };
    expect(analysis.ok).toBe(true);
    expect(analysis.result.results[0].tool).toBe('getPlanSummary');
  }, 60_000);

  it("reports another user's plan as the tool's own error text, not a wrapped server error", async () => {
    const t = setup();
    const otherPlan = await insertPlan(t, 'someone-else');
    const { token } = await createToken(t, 'write');

    const body = (await (await post(t, token, 'get_plan', { planId: otherPlan })).json()) as { ok: boolean; error: string };

    expect(body).toEqual({ ok: false, error: 'Not authorized to access this plan' });
  });
});
