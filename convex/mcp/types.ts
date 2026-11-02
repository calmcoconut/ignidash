/**
 * Types and typed constructors for MCP tools, prompts and resources.
 *
 * Kept apart from `./registry.ts` so tool modules can import the constructors without an import
 * cycle (the registry imports every tool module).
 */

import type { ObjectType, PropertyValidators } from 'convex/values';

import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';

export type McpScope = 'read' | 'write';

interface ToolBase<Args extends PropertyValidators> {
  /** snake_case, unique across the registry. */
  name: string;
  /** `write` tools are refused to a read-only token. */
  scope: McpScope;
  /** What the AI reads to decide when and how to call the tool. */
  description: string;
  /** Convex validators for the input; also the source of the advertised JSON Schema. */
  args: Args;
}

/** `ctx` already acts as the token's owner (`asUser`), so app handlers can be called directly. */
export interface QueryTool<Args extends PropertyValidators = PropertyValidators> extends ToolBase<Args> {
  kind: 'query';
  run: (ctx: QueryCtx, args: ObjectType<Args>) => Promise<unknown>;
}

export interface MutationTool<Args extends PropertyValidators = PropertyValidators> extends ToolBase<Args> {
  kind: 'mutation';
  run: (ctx: MutationCtx, args: ObjectType<Args>) => Promise<unknown>;
}

/**
 * An action's `ctx.runQuery` does not carry an identity, so an action tool receives `userId` and
 * passes it to internal functions explicitly (e.g. `internal.mcp.exec.planForUser`).
 */
export interface ActionTool<Args extends PropertyValidators = PropertyValidators> extends ToolBase<Args> {
  kind: 'action';
  run: (ctx: ActionCtx, args: ObjectType<Args>, userId: string) => Promise<unknown>;
}

export type McpTool = QueryTool | MutationTool | ActionTool;

/** Typed constructors: the `run` argument is checked against `args`. */
export const defineQueryTool = <Args extends PropertyValidators>(tool: QueryTool<Args>): McpTool => tool as unknown as McpTool;
export const defineMutationTool = <Args extends PropertyValidators>(tool: MutationTool<Args>): McpTool => tool as unknown as McpTool;
export const defineActionTool = <Args extends PropertyValidators>(tool: ActionTool<Args>): McpTool => tool as unknown as McpTool;

export interface McpPrompt {
  name: string;
  description: string;
  /** The prompt's whole text, sent as one user message. */
  text: string;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}
