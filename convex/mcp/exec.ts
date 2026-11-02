/**
 * Executors for MCP tool calls, one per kind of Convex function.
 *
 * Only `convex/http.ts` calls these, after it has authenticated the token and checked its scope.
 * Each validates the input against the tool's own validators, then runs the tool as `userId`.
 */

import { v, ConvexError } from 'convex/values';

import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { asUser } from '../utils/function_defs';

import { getTool, parseToolInput } from './registry';
import type { McpTool } from './types';

const execArgs = { userId: v.string(), tool: v.string(), input: v.any() };

function toolOfKind<K extends McpTool['kind']>(name: string, kind: K): Extract<McpTool, { kind: K }> {
  const tool = getTool(name);
  if (!tool) throw new ConvexError(`Unknown tool: ${name}`);
  if (tool.kind !== kind) throw new ConvexError(`Tool ${name} is a ${tool.kind}, not a ${kind}`);
  return tool as Extract<McpTool, { kind: K }>;
}

export const runQueryTool = internalQuery({
  args: execArgs,
  handler: async (ctx, { userId, tool: name, input }) => {
    const tool = toolOfKind(name, 'query');
    return await tool.run(asUser(ctx, userId), parseToolInput(tool, input));
  },
});

export const runMutationTool = internalMutation({
  args: execArgs,
  handler: async (ctx, { userId, tool: name, input }) => {
    const tool = toolOfKind(name, 'mutation');
    return await tool.run(asUser(ctx, userId), parseToolInput(tool, input));
  },
});

export const runActionTool = internalAction({
  args: execArgs,
  handler: async (ctx, { userId, tool: name, input }): Promise<unknown> => {
    const tool = toolOfKind(name, 'action');
    return await tool.run(ctx, parseToolInput(tool, input), userId);
  },
});

/** A plan, if `userId` owns it. For action tools, whose `ctx.runQuery` carries no identity. */
export const planForUser = internalQuery({
  args: { userId: v.string(), planId: v.id('plans') },
  handler: async (ctx, { userId, planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan || plan.userId !== userId) throw new ConvexError('Plan not found');
    return plan;
  },
});
