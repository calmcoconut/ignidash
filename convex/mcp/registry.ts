/**
 * The MCP tool registry: what `/api/mcp` offers, and how each tool runs.
 *
 * `convex/http.ts` authenticates a token, then hands a call to one of the executors in
 * `./exec.ts` by the tool's `kind`. The executor validates the input against `args` (the same
 * Convex validators the app's functions use, through `zodObjectFromValidators`) and calls `run`
 * with a context that acts as the token's owner.
 *
 * The Next.js route `src/app/api/mcp/route.ts` knows none of this: it asks `GET /mcp/manifest` for
 * the tools, prompts and resources, and forwards each call to `POST /mcp/tool`.
 */

import { z } from 'zod';

import { ConvexError } from 'convex/values';

import { zodObjectFromValidators } from '../../src/lib/export/convex-validator-to-zod';

import type { McpPrompt, McpResource, McpScope, McpTool } from './types';
import { MCP_PROMPTS, MCP_RESOURCES } from './prompts';
import { READ_TOOLS } from './tools_read';
import { WRITE_TOOLS } from './tools_write';

export const MCP_TOOLS: McpTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function getTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** Whether a token of `scope` may call `tool`: write tokens may call everything. */
export function scopeAllows(scope: McpScope, tool: McpTool): boolean {
  return scope === 'write' || tool.scope === 'read';
}

/**
 * Validates a tool input against the tool's own Convex validators.
 *
 * Throws a `ConvexError` naming every failing path, so the AI can correct its call.
 */
export function parseToolInput(tool: McpTool, input: unknown): Record<string, unknown> {
  const result = zodObjectFromValidators(tool.args).safeParse(input ?? {});
  if (result.success) return result.data as Record<string, unknown>;

  const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(input)'}: ${issue.message}`);
  throw new ConvexError(`Invalid input for ${tool.name}: ${issues.join('; ')}`);
}

export interface McpManifest {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  prompts: McpPrompt[];
  resources: McpResource[];
}

/** What a token of `scope` sees: write tools are left out of a read-only token's list. */
export function buildManifest(scope: McpScope): McpManifest {
  return {
    tools: MCP_TOOLS.filter((tool) => scopeAllows(scope, tool)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(zodObjectFromValidators(tool.args), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
    })),
    prompts: MCP_PROMPTS,
    resources: MCP_RESOURCES,
  };
}
