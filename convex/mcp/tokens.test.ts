// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { sha256Hex } from './tokens';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it ships with
// `vite/client`, and referencing that from here would make `vite` an unlisted dependency, so the
// transform's shape is declared locally instead. The pattern is root-relative: a relative
// `'../**/*.ts'` from this folder skips `convex/mcp/` itself, so `mcp/tokens` would not resolve.
const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('/convex/**/*.ts');

const OWNER = 'test-user-123';
const OTHER = 'other-user-456';

function setup() {
  return convexTest(schema, modules);
}

async function createToken(t: ReturnType<typeof setup>, name = 'Claude Desktop', scope: 'read' | 'write' = 'write', subject = OWNER) {
  return t.withIdentity({ subject }).mutation(api.mcp.tokens.createToken, { name, scope });
}

describe('createToken', () => {
  it('returns an ign_ token, its prefix, and a row id', async () => {
    const t = setup();
    const created = await createToken(t);

    expect(created.token.startsWith('ign_')).toBe(true);
    expect(created.token.length).toBeGreaterThan(40);
    expect(created.prefix).toBe(created.token.slice(0, 8));
    expect(created.tokenId).toBeTruthy();
  });

  it('stores the SHA-256 of the token, never the token itself', async () => {
    const t = setup();
    const created = await createToken(t);

    const row = await t.run((ctx) => ctx.db.get(created.tokenId as Id<'mcpTokens'>));
    expect(row?.tokenHash).toBe(await sha256Hex(created.token));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the plaintext token out of every mcpTokens field', async () => {
    const t = setup();
    const created = await createToken(t);

    const rows = await t.run((ctx) => ctx.db.query('mcpTokens').collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(created.token);
    expect(JSON.stringify(rows)).not.toContain(created.token.slice(4));
  });

  it('refuses a name that is empty after trimming, or longer than 60 characters', async () => {
    const t = setup();
    await expect(createToken(t, '   ')).rejects.toThrow('Token name must be 1 to 60 characters');
    await expect(createToken(t, 'x'.repeat(61))).rejects.toThrow('Token name must be 1 to 60 characters');
  });

  it('refuses an 11th active token, and allows one again once a token is revoked', async () => {
    const t = setup();
    const created: Array<{ tokenId: Id<'mcpTokens'> }> = [];
    for (let i = 0; i < 10; i++) {
      created.push((await createToken(t, `token ${i}`)) as { tokenId: Id<'mcpTokens'> });
    }

    await expect(createToken(t, 'eleventh')).rejects.toThrow('at most 10 active tokens');

    await t.withIdentity({ subject: OWNER }).mutation(api.mcp.tokens.revokeToken, { tokenId: created[0].tokenId });
    await expect(createToken(t, 'eleventh')).resolves.toMatchObject({ token: expect.stringMatching(/^ign_/) });
  });
});

describe('listTokens', () => {
  it('lists only the caller tokens, newest first, without tokenHash', async () => {
    const t = setup();
    await createToken(t, 'first');
    await createToken(t, 'second');
    await createToken(t, 'theirs', 'read', OTHER);

    const rows = await t.withIdentity({ subject: OWNER }).query(api.mcp.tokens.listTokens, {});

    expect(rows.map((row) => row.name)).toEqual(['second', 'first']);
    for (const row of rows) {
      expect(row).not.toHaveProperty('tokenHash');
      expect(row).toHaveProperty('prefix');
      expect(row).toHaveProperty('scope');
    }
  });
});

describe('revokeToken', () => {
  it('stops another user from revoking the token, and says the token was not found', async () => {
    const t = setup();
    const created = await createToken(t);

    await expect(
      t.withIdentity({ subject: OTHER }).mutation(api.mcp.tokens.revokeToken, { tokenId: created.tokenId as Id<'mcpTokens'> })
    ).rejects.toThrow('Token not found');

    const row = await t.run((ctx) => ctx.db.get(created.tokenId as Id<'mcpTokens'>));
    expect(row?.revokedAt).toBeUndefined();
  });

  it('is idempotent for the owner', async () => {
    const t = setup();
    const created = await createToken(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await asOwner.mutation(api.mcp.tokens.revokeToken, { tokenId: created.tokenId as Id<'mcpTokens'> });
    const first = await t.run((ctx) => ctx.db.get(created.tokenId as Id<'mcpTokens'>));
    await asOwner.mutation(api.mcp.tokens.revokeToken, { tokenId: created.tokenId as Id<'mcpTokens'> });
    const second = await t.run((ctx) => ctx.db.get(created.tokenId as Id<'mcpTokens'>));

    expect(first?.revokedAt).toBeTypeOf('number');
    expect(second?.revokedAt).toBe(first?.revokedAt);
  });
});

describe('authenticate', () => {
  it('returns the token owner and scope, and null once the token is revoked', async () => {
    const t = setup();
    const created = await createToken(t, 'laptop', 'read');
    const hash = await sha256Hex(created.token);

    await expect(t.query(internal.mcp.tokens.authenticate, { tokenHash: hash })).resolves.toEqual({
      tokenId: created.tokenId,
      userId: OWNER,
      scope: 'read',
      recentCalls: 0,
    });

    await t.withIdentity({ subject: OWNER }).mutation(api.mcp.tokens.revokeToken, { tokenId: created.tokenId as Id<'mcpTokens'> });
    await expect(t.query(internal.mcp.tokens.authenticate, { tokenHash: hash })).resolves.toBeNull();
  });

  it('returns null for a hash that matches no token', async () => {
    const t = setup();
    await createToken(t);
    await expect(t.query(internal.mcp.tokens.authenticate, { tokenHash: 'a'.repeat(64) })).resolves.toBeNull();
  });

  it('counts only the calls made in the last minute', async () => {
    const t = setup();
    const created = await createToken(t);
    const tokenId = created.tokenId as Id<'mcpTokens'>;
    const now = Date.now();

    await t.run(async (ctx) => {
      for (const at of [now - 5 * 60_000, now - 120_000, now - 61_000, now - 30_000, now - 1_000, now]) {
        await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'list_plans', ok: true, at });
      }
    });

    const caller = await t.query(internal.mcp.tokens.authenticate, { tokenHash: await sha256Hex(created.token) });
    expect(caller?.recentCalls).toBe(3);
  });
});

describe('recordCall', () => {
  it('writes an audit row, stamps lastUsedAt, and truncates a long error', async () => {
    const t = setup();
    const created = await createToken(t);
    const tokenId = created.tokenId as Id<'mcpTokens'>;

    await t.mutation(internal.mcp.tokens.recordCall, {
      tokenId,
      userId: OWNER,
      tool: 'get_plan',
      planId: 'plan-1',
      ok: false,
      error: 'e'.repeat(800),
    });

    const audit = await t.run((ctx) => ctx.db.query('mcpAudit').collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'get_plan', planId: 'plan-1', ok: false });
    expect(audit[0].error).toHaveLength(500);

    const row = await t.run((ctx) => ctx.db.get(tokenId));
    expect(row?.lastUsedAt).toBeTypeOf('number');
  });

  it('prunes audit rows older than 90 days, and leaves recent ones', async () => {
    const t = setup();
    const created = await createToken(t);
    const tokenId = created.tokenId as Id<'mcpTokens'>;
    const DAY = 24 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'old', ok: true, at: Date.now() - 100 * DAY });
      await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'recent', ok: true, at: Date.now() - 10 * DAY });
    });

    await t.mutation(internal.mcp.tokens.recordCall, { tokenId, userId: OWNER, tool: 'new', ok: true });

    const tools = (await t.run((ctx) => ctx.db.query('mcpAudit').collect())).map((row) => row.tool).sort();
    expect(tools).toEqual(['new', 'recent']);
  });
});

describe('listAudit', () => {
  it('returns the caller rows newest first with the token name, capped by limit', async () => {
    const t = setup();
    const created = await createToken(t, 'laptop');
    const tokenId = created.tokenId as Id<'mcpTokens'>;
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'old', ok: true, at: now - 1000 });
      await ctx.db.insert('mcpAudit', { userId: OWNER, tokenId, tool: 'new', ok: false, error: 'boom', at: now });
      await ctx.db.insert('mcpAudit', { userId: OTHER, tokenId, tool: 'foreign', ok: true, at: now });
    });

    const rows = await t.withIdentity({ subject: OWNER }).query(api.mcp.tokens.listAudit, {});
    expect(rows.map((row) => row.tool)).toEqual(['new', 'old']);
    expect(rows[0]).toMatchObject({ tokenName: 'laptop', error: 'boom' });

    const limited = await t.withIdentity({ subject: OWNER }).query(api.mcp.tokens.listAudit, { limit: 1 });
    expect(limited.map((row) => row.tool)).toEqual(['new']);
  });
});
