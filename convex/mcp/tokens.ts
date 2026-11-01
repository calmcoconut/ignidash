/**
 * Bearer tokens for the MCP endpoint: issuing, listing and revoking them from the settings page,
 * authenticating a request, and recording each tool call.
 *
 * A token is shown to its owner once, at creation. Only its SHA-256 is stored, so a leaked
 * database row does not reveal a usable token.
 */

import { ConvexError, v } from 'convex/values';

import { internalMutation, internalQuery, mutation, query } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { getUserIdOrThrow } from '../utils/auth_utils';

const TOKEN_PREFIX = 'ign_';
const MAX_ACTIVE_TOKENS = 10;
const MAX_NAME_LENGTH = 60;
const MAX_ERROR_LENGTH = 500;
const RECENT_WINDOW_MS = 60_000;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AUDIT_PRUNE_BATCH = 100;
/** Reads at most this many recent audit rows when counting calls: the rate limit only needs to know "over 120". */
const RECENT_COUNT_CAP = 1000;
const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 100;

/** Lowercase hex SHA-256 of `text`, using the Web Crypto API (available in Convex and in Node). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `ign_` followed by 32 random bytes, base64url-encoded without padding. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${TOKEN_PREFIX}${base64url}`;
}

export const createToken = mutation({
  args: { name: v.string(), scope: v.union(v.literal('read'), v.literal('write')) },
  handler: async (ctx, { name, scope }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      throw new ConvexError(`Token name must be 1 to ${MAX_NAME_LENGTH} characters`);
    }

    const rows = await ctx.db
      .query('mcpTokens')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect();
    if (rows.filter((row) => row.revokedAt === undefined).length >= MAX_ACTIVE_TOKENS) {
      throw new ConvexError(`You can have at most ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
    }

    const token = generateToken();
    const prefix = token.slice(0, 8);
    const tokenId = await ctx.db.insert('mcpTokens', {
      userId,
      name: trimmed,
      tokenHash: await sha256Hex(token),
      prefix,
      scope,
      createdAt: Date.now(),
    });

    return { tokenId, token, prefix };
  },
});

export const listTokens = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const rows = await ctx.db
      .query('mcpTokens')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect();

    return (
      rows
        // `_creationTime` breaks ties: two tokens created in the same millisecond keep their order.
        .sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime)
        .map(({ _id, name, prefix, scope, createdAt, lastUsedAt, revokedAt }) => ({
          _id,
          name,
          prefix,
          scope,
          createdAt,
          lastUsedAt,
          revokedAt,
        }))
    );
  },
});

export const revokeToken = mutation({
  args: { tokenId: v.id('mcpTokens') },
  handler: async (ctx, { tokenId }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const token = await ctx.db.get(tokenId);
    if (!token || token.userId !== userId) throw new ConvexError('Token not found');

    if (token.revokedAt === undefined) {
      await ctx.db.patch(tokenId, { revokedAt: Date.now() });
    }
  },
});

export const listAudit = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const { userId } = await getUserIdOrThrow(ctx);

    const requested = Math.floor(limit ?? DEFAULT_AUDIT_LIMIT);
    const take = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);

    const rows = await ctx.db
      .query('mcpAudit')
      .withIndex('by_userId_at', (q) => q.eq('userId', userId))
      .order('desc')
      .take(take);

    const names = new Map<Id<'mcpTokens'>, string>();
    for (const row of rows) {
      if (names.has(row.tokenId)) continue;
      const token = await ctx.db.get(row.tokenId);
      names.set(row.tokenId, token?.name ?? '(deleted token)');
    }

    return rows.map((row) => ({ ...row, tokenName: names.get(row.tokenId) ?? '(deleted token)' }));
  },
});

/** Looks a token up by its hash. Null when it does not exist or has been revoked. */
export const authenticate = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const token: Doc<'mcpTokens'> | null = await ctx.db
      .query('mcpTokens')
      .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
      .unique();
    if (!token || token.revokedAt !== undefined) return null;

    const recent = await ctx.db
      .query('mcpAudit')
      .withIndex('by_tokenId_at', (q) => q.eq('tokenId', token._id).gt('at', Date.now() - RECENT_WINDOW_MS))
      .take(RECENT_COUNT_CAP);

    return {
      tokenId: token._id,
      userId: token.userId,
      scope: token.scope,
      recentCalls: recent.length,
    };
  },
});

/** Writes one audit row, marks the token as used, and prunes a bounded batch of this user's expired rows. */
export const recordCall = internalMutation({
  args: {
    tokenId: v.id('mcpTokens'),
    userId: v.string(),
    tool: v.string(),
    planId: v.optional(v.string()),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { tokenId, userId, tool, planId, ok, error }) => {
    const now = Date.now();

    await ctx.db.insert('mcpAudit', {
      userId,
      tokenId,
      tool,
      planId,
      ok,
      error: error === undefined ? undefined : error.slice(0, MAX_ERROR_LENGTH),
      at: now,
    });

    const token = await ctx.db.get(tokenId);
    if (token && token.userId === userId) {
      await ctx.db.patch(tokenId, { lastUsedAt: now });
    }

    const expired = await ctx.db
      .query('mcpAudit')
      .withIndex('by_userId_at', (q) => q.eq('userId', userId).lt('at', now - AUDIT_RETENTION_MS))
      .take(AUDIT_PRUNE_BATCH);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
  },
});
