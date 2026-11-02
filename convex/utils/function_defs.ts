/**
 * Shared function definitions, so one handler serves both the app and the MCP endpoint.
 *
 * A module that the MCP layer reuses declares its function as a definition first and registers it
 * second:
 *
 *   export const upsertAccountDef = mutationDef({ args: { planId: v.id('plans'), account: accountValidator }, handler: async (ctx, a) => { … } });
 *   export const upsertAccount = mutation(upsertAccountDef);
 *
 * The app calls `api.account.upsertAccount` exactly as before. The MCP layer calls
 * `upsertAccountDef.handler(asUser(ctx, userId), input)` after validating `input` against
 * `upsertAccountDef.args`, so the two paths cannot drift: same validators, same handler, same
 * ownership checks (the handlers read the caller through `ctx.auth`, which `asUser` supplies).
 */

import type { Auth, UserIdentity } from 'convex/server';
import type { ObjectType, PropertyValidators } from 'convex/values';

import type { MutationCtx, QueryCtx } from '../_generated/server';

export interface FunctionDef<Ctx, Args extends PropertyValidators, Result> {
  args: Args;
  handler: (ctx: Ctx, args: ObjectType<Args>) => Promise<Result>;
}

/** Identity helper that types a query definition; pass the result to `query(...)`. */
export function queryDef<Args extends PropertyValidators, Result>(
  def: FunctionDef<QueryCtx, Args, Result>
): FunctionDef<QueryCtx, Args, Result> {
  return def;
}

/** Identity helper that types a mutation definition; pass the result to `mutation(...)`. */
export function mutationDef<Args extends PropertyValidators, Result>(
  def: FunctionDef<MutationCtx, Args, Result>
): FunctionDef<MutationCtx, Args, Result> {
  return def;
}

/** The issuer on identities `asUser` fabricates, so a log or a handler can tell an MCP call apart. */
export const MCP_IDENTITY_ISSUER = 'ignidash-mcp';

/**
 * A copy of `ctx` whose `auth` reports `userId` as the caller.
 *
 * Only for server-side code that has already authenticated `userId` by other means (an MCP token
 * checked in `convex/http.ts`). Everything else on `ctx` is the original object.
 */
export function asUser<Ctx extends { auth: Auth }>(ctx: Ctx, userId: string): Ctx {
  const identity: UserIdentity = {
    subject: userId,
    issuer: MCP_IDENTITY_ISSUER,
    tokenIdentifier: `${MCP_IDENTITY_ISSUER}|${userId}`,
  };
  const auth: Auth = { getUserIdentity: async () => identity };
  return { ...ctx, auth };
}
