import { v, ConvexError } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, mutation, internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

import { getPlanForCurrentUserOrThrow } from './utils/plan_utils';
import { getConversationForCurrentUserOrThrow } from './utils/conversation_utils';
import { getUserIdOrThrow } from './utils/auth_utils';
import { getCanUseAIFeatures, isToolCallingEnabled } from './utils/ai_utils';
import { getSystemPrompt, resolveTaxOptimizationTurn, withTaxOptimizationSkill } from './utils/sys_prompt_utils';
import { keyMetricsValidator } from './validators/key_metrics_validator';
import { simulationResultValidator } from './validators/simulation_result_validator';

const MESSAGE_TIMEOUT_MS = 5 * 60 * 1000;
const NUM_MESSAGES_AS_CONTEXT = 11;

export const canUseChat = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => {
    const { canUseAIFeatures } = await getCanUseAIFeatures(ctx);
    return canUseAIFeatures;
  },
});

/** F4: the skill's entry point is only shown when the deployment's model supports tool calling. */
export const canUseTools = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => {
    const { canUseAIFeatures } = await getCanUseAIFeatures(ctx);
    return canUseAIFeatures && isToolCallingEnabled();
  },
});

export const list = query({
  args: { conversationId: v.id('conversations'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { conversationId, paginationOpts }) => {
    await getConversationForCurrentUserOrThrow(ctx, conversationId);

    return await ctx.db
      .query('messages')
      .withIndex('by_conversationId_updatedAt', (q) => q.eq('conversationId', conversationId))
      .order('desc')
      .paginate(paginationOpts);
  },
});

export const send = mutation({
  args: {
    conversationId: v.optional(v.id('conversations')),
    planId: v.id('plans'),
    content: v.string(),
    keyMetrics: v.nullable(keyMetricsValidator),
    simulationResult: v.optional(v.union(v.null(), simulationResultValidator)),
    includeSimData: v.optional(v.boolean()),
    /** §7-A2: open a tax-optimization chat. Only read on conversation creation (see below). */
    taxOptimization: v.optional(v.boolean()),
  },
  handler: async (ctx, { conversationId: currConvId, planId, content, keyMetrics, simulationResult, includeSimData, taxOptimization }) => {
    if (content.length > 4000) throw new ConvexError('Message cannot be longer than 4,000 characters.');

    const [{ userId }, { canUseAIFeatures: canUseChat }] = await Promise.all([getUserIdOrThrow(ctx), getCanUseAIFeatures(ctx)]);

    if (!canUseChat) throw new ConvexError('AI chat is not available on this deployment.');

    const [loadingMessage, plan] = await Promise.all([
      ctx.db
        .query('messages')
        .withIndex('by_userId_updatedAt', (q) => q.eq('userId', userId))
        .filter((q) => q.eq(q.field('isLoading'), true))
        .first(),
      getPlanForCurrentUserOrThrow(ctx, planId),
    ]);
    if (loadingMessage) throw new ConvexError('An AI chat is already in progress. Please wait for it to complete.');

    const updatedAt = Date.now();

    // Also validates that the user owns currConvId when it exists
    const currConv = currConvId ? await getConversationForCurrentUserOrThrow(ctx, currConvId) : null;
    const shouldIncludeSimData = currConv ? currConv.includeSimData : includeSimData;

    // §7-A2: on creation the request decides (and is refused when tool calling is off, F4); on
    // later turns the mode comes from the marker in the stored prompt, because the prompt below is
    // rebuilt from the plan every turn and the stored text is never reused.
    const skillTurn = resolveTaxOptimizationTurn({
      requested: taxOptimization,
      isNewConversation: currConv === null,
      conversation: currConv,
      toolsEnabled: isToolCallingEnabled(),
    });
    if (skillTurn.refusal) throw new ConvexError(skillTurn.refusal);

    const baseSystemPrompt = getSystemPrompt(plan, keyMetrics, shouldIncludeSimData ? simulationResult : null);
    const systemPrompt = skillTurn.enabled ? withTaxOptimizationSkill(baseSystemPrompt) : baseSystemPrompt;

    let newConvId: Id<'conversations'> | null = null;
    if (!currConvId) {
      const title = content.length > 25 ? content.slice(0, 25) + '...' : content;
      newConvId = await ctx.db.insert('conversations', {
        userId,
        planId,
        title,
        updatedAt,
        systemPrompt,
        includeSimData: shouldIncludeSimData,
      });
    }

    const conversationId = (currConvId ?? newConvId)!;

    const userMessageId = await ctx.db.insert('messages', { userId, conversationId, author: 'user', body: content, updatedAt });
    const [assistantMessageId] = await Promise.all([
      ctx.db.insert('messages', { userId, conversationId, author: 'assistant', updatedAt: updatedAt + 1, isLoading: true }),
      ctx.db.patch(conversationId, { updatedAt }),
    ]);

    const messages = await ctx.db
      .query('messages')
      .withIndex('by_conversationId_updatedAt', (q) => q.eq('conversationId', conversationId))
      .order('desc')
      .take(NUM_MESSAGES_AS_CONTEXT);
    messages.reverse();

    await ctx.scheduler.runAfter(0, internal.use_openai.streamChat, {
      userId,
      messages,
      assistantMessageId,
      systemPrompt,
      plan,
      // One date for the whole turn: the tool loop must not read the clock itself (§7-A1).
      asOf: new Date().toISOString().slice(0, 10),
    });

    return { messages, userMessageId, assistantMessageId, conversationId };
  },
});

export const setBody = internalMutation({
  args: {
    messageId: v.id('messages'),
    body: v.string(),
    isLoading: v.optional(v.boolean()),
  },
  handler: async (ctx, { messageId, body, isLoading }) => {
    const updates: { body: string; updatedAt: number; isLoading?: boolean } = { body, updatedAt: Date.now() };
    if (isLoading !== undefined) updates.isLoading = isLoading;

    await ctx.db.patch(messageId, updates);
  },
});

export const setUsage = internalMutation({
  args: {
    messageId: v.id('messages'),
    inputTokens: v.number(),
    cachedInputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
  },
  handler: async (ctx, { messageId, inputTokens, cachedInputTokens, outputTokens, totalTokens }) => {
    if (inputTokens + outputTokens !== totalTokens) {
      console.warn(`Token mismatch for message ${messageId}: ${inputTokens} + ${outputTokens} !== ${totalTokens}`);
    }

    await ctx.db.patch(messageId, { usage: { inputTokens, cachedInputTokens, outputTokens, totalTokens }, updatedAt: Date.now() });
  },
});

export const setIsLoading = internalMutation({
  args: {
    messageId: v.id('messages'),
    isLoading: v.boolean(),
  },
  handler: async (ctx, { messageId, isLoading }) => {
    await ctx.db.patch(messageId, { isLoading, updatedAt: Date.now() });
  },
});

export const cleanupLoadingMessages = internalMutation({
  args: {},
  handler: async (ctx) => {
    const staleLoadingMessages = await ctx.db
      .query('messages')
      .filter((q) => q.and(q.eq(q.field('isLoading'), true), q.lt(q.field('updatedAt'), Date.now() - MESSAGE_TIMEOUT_MS)))
      .collect();

    await Promise.all(
      staleLoadingMessages.map((msg) =>
        ctx.db.patch(msg._id, { isLoading: false, body: msg.body || 'This message timed out. Please try again.', updatedAt: Date.now() })
      )
    );

    if (staleLoadingMessages.length > 0) {
      console.warn(`Cleaned up ${staleLoadingMessages.length} stale loading messages`);
    }
  },
});
