/**
 * HTTP handlers for the MCP endpoint, routed in `convex/http.ts`:
 *
 *   GET  /mcp/manifest   the tools, prompts and resources this token may see
 *   POST /mcp/tool       { name, input? } runs one tool as the token's owner
 *
 * Every response is JSON. A call that reached a tool returns 200 with `{ ok, result | error }`;
 * the status codes are reserved for the transport: authentication, shape, scope and rate limit.
 */

import { ConvexError } from 'convex/values';

import { internal } from '../_generated/api';
import { httpAction, type ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

import { getTool, buildManifest, scopeAllows } from './registry';
import { sha256Hex } from './tokens';
import type { McpScope } from './types';

const RATE_LIMIT_PER_MINUTE = 120;

interface Caller {
  tokenId: Id<'mcpTokens'>;
  userId: string;
  scope: McpScope;
  recentCalls: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The caller, or the 401 response to send back. */
async function authenticate(ctx: ActionCtx, request: Request): Promise<Caller | Response> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || !match[1].startsWith('ign_')) {
    return json({ error: 'Missing or malformed bearer token' }, 401);
  }

  const caller = await ctx.runQuery(internal.mcp.tokens.authenticate, { tokenHash: await sha256Hex(match[1]) });
  if (!caller) return json({ error: 'Invalid or revoked token' }, 401);

  return caller;
}

/** What a failed tool call reports: a ConvexError's message, or the error's own message. */
function errorText(err: unknown): string {
  if (err instanceof ConvexError && typeof err.data === 'string') return unquote(err.data);
  if (err instanceof Error) return unquote(err.message);
  return String(err);
}

/**
 * A ConvexError thrown inside `ctx.runQuery`/`runMutation` can surface here with its string data
 * JSON-encoded as the message (`"\"Plan not found\""`); the AI should read the plain sentence.
 */
function unquote(message: string): string {
  if (!message.startsWith('"') || !message.endsWith('"')) return message;
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === 'string' ? parsed : message;
  } catch {
    return message;
  }
}

export const manifest = httpAction(async (ctx, request) => {
  const caller = await authenticate(ctx, request);
  if (caller instanceof Response) return caller;

  return json(buildManifest(caller.scope));
});

export const callTool = httpAction(async (ctx, request) => {
  const caller = await authenticate(ctx, request);
  if (caller instanceof Response) return caller;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON: { "name": string, "input"?: object }' }, 400);
  }

  const { name, input } = (body ?? {}) as { name?: unknown; input?: unknown };
  if (typeof name !== 'string' || name === '') {
    return json({ error: 'Body must be JSON: { "name": string, "input"?: object }' }, 400);
  }

  const tool = getTool(name);
  if (!tool) return json({ error: `Unknown tool: ${name}` }, 404);

  const planId =
    typeof input === 'object' && input !== null && typeof (input as { planId?: unknown }).planId === 'string'
      ? (input as { planId: string }).planId
      : undefined;

  const record = (ok: boolean, error?: string) =>
    ctx.runMutation(internal.mcp.tokens.recordCall, {
      tokenId: caller.tokenId,
      userId: caller.userId,
      tool: name,
      planId,
      ok,
      error,
    });

  if (!scopeAllows(caller.scope, tool)) {
    const error = 'This token is read-only';
    await record(false, error);
    return json({ error }, 403);
  }

  if (caller.recentCalls >= RATE_LIMIT_PER_MINUTE) {
    const error = `Rate limit: ${RATE_LIMIT_PER_MINUTE} calls a minute per token`;
    await record(false, error);
    return json({ error }, 429);
  }

  const args = { userId: caller.userId, tool: name, input: input ?? {} };
  try {
    let result: unknown;
    if (tool.kind === 'query') {
      result = await ctx.runQuery(internal.mcp.exec.runQueryTool, args);
    } else if (tool.kind === 'mutation') {
      result = await ctx.runMutation(internal.mcp.exec.runMutationTool, args);
    } else {
      result = await ctx.runAction(internal.mcp.exec.runActionTool, args);
    }
    await record(true);
    return json({ ok: true, result });
  } catch (err) {
    const error = errorText(err);
    await record(false, error);
    return json({ ok: false, error });
  }
});
