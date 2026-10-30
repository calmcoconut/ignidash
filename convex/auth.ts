import { v } from 'convex/values';
import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex } from '@convex-dev/better-auth/plugins';
import { requireRunMutationCtx } from '@convex-dev/better-auth/utils';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';
import { createAuthMiddleware } from 'better-auth/api';

import { components, internal } from './_generated/api';
import { DataModel } from './_generated/dataModel';
import { query } from './_generated/server';
import authSchema from './betterAuth/schema';
import authConfig from './auth.config';
import { isAIConfigured } from './utils/ai_utils';
import { createEmailAndPasswordOptions, createSignUpLockHook, isSignUpAllowed } from './utils/auth_hardening';

const baseURL = process.env.SITE_URL ?? 'http://localhost:3000';
/** Where `/reset-password` lives: the break-glass link the operator copies out of the logs. */
const appUrl = process.env.SITE_URL ?? 'http://localhost:3000';

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: {
    schema: authSchema,
  },
});

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const allowSignUp = isSignUpAllowed(process.env);
  const signUpLockHook = createSignUpLockHook(allowSignUp);

  return {
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60 * 24 * 7,
        strategy: 'jwt',
        refreshCache: true,
      },
    },
    baseURL,
    database: authComponent.adapter(ctx),
    // Account creation is locked unless ALLOW_SIGNUP=true (P5.3). The hook is the backstop for
    // providers that bypass `disableSignUp`, such as a configured Google sign-in.
    databaseHooks: signUpLockHook ? { user: { create: { before: signUpLockHook } } } : undefined,
    emailAndPassword: createEmailAndPasswordOptions({
      allowSignUp,
      appUrl,
      // The container's stderr. On Unraid: `docker logs ignidash | grep ignidash-auth`.
      write: (line) => console.error(line),
    }),
    socialProviders: {
      ...(process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET && {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }),
    },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'user',
          input: false,
        },
      },
      changeEmail: {
        // No email transport is available on a self-hosted deployment, so email changes are disabled.
        enabled: false,
      },
      deleteUser: {
        enabled: true,
        afterDelete: async (user, request) => {
          console.log(`Account deleted for user ${user.id}`);

          try {
            await requireRunMutationCtx(ctx).runMutation(internal.app_data.deleteAppDataForUser, { userId: user.id });
          } catch (error) {
            console.error('Error deleting user data from Convex:', error);
          }
        },
      },
    },
    plugins: [convex({ authConfig, jwksRotateOnTokenGenerationError: true, jwt: { expirationSeconds: 60 * 60 * 24 } })],
    hooks: {
      after: createAuthMiddleware(async (authCtx) => {
        const newSession = authCtx.context.newSession;
        if (!newSession) return;

        authCtx.context.session = newSession;

        try {
          await requireRunMutationCtx(ctx).runMutation(internal.plans.internalGetOrCreateDefaultPlan, {
            userId: newSession.user.id,
            userName: newSession.user.name,
          });
        } catch (error) {
          console.error('Error creating default plan for new user:', error);
        }
      }),
    },
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};

export const getCurrentUserSafe = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(components.betterAuth.auth_data.getCurrentUserSafe, {});
  },
});

export const getCanUseAIFeatures = query({
  args: {},
  returns: v.object({
    canUseAIFeatures: v.boolean(),
    isAdmin: v.boolean(),
    isActiveSubscription: v.boolean(),
  }),
  handler: async (ctx): Promise<{ canUseAIFeatures: boolean; isAdmin: boolean; isActiveSubscription: boolean }> => {
    const user = await ctx.runQuery(components.betterAuth.auth_data.getCurrentUserSafe, {});
    const isAdmin = user?.role === 'admin';

    // Billing has been removed, so there is no subscription state to read.
    return { canUseAIFeatures: isAIConfigured(), isAdmin, isActiveSubscription: false };
  },
});

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];
