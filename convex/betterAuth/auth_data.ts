import { doc } from 'convex-helpers/validators';
import { v } from 'convex/values';

import schema from './schema';
import { query } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const getCurrentUserSafe = query({
  args: {},
  returns: v.union(v.null(), doc(schema, 'user')),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;

    const userId = identity.subject as Id<'user'>;
    return ctx.db.get(userId);
  },
});
