import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import { planDataFields } from './validators/plan_data_fields';
import { assetValidator } from './validators/asset_validator';
import { liabilityValidator } from './validators/liability_validator';
import { userFeedbackValidator } from './validators/user_feedback_validator';

export default defineSchema({
  plans: defineTable({
    userId: v.string(),
    name: v.string(),
    isDefault: v.boolean(),
    ...planDataFields,
  }).index('by_userId', ['userId']),
  planSnapshots: defineTable({
    planId: v.id('plans'),
    userId: v.string(),
    ...planDataFields,
  })
    .index('by_planId', ['planId'])
    .index('by_userId', ['userId']),
  finances: defineTable({
    userId: v.string(),
    assets: v.array(assetValidator),
    liabilities: v.array(liabilityValidator),
  }).index('by_userId', ['userId']),
  conversations: defineTable({
    userId: v.string(),
    planId: v.id('plans'),
    title: v.string(),
    updatedAt: v.number(),
    systemPrompt: v.optional(v.string()),
    includeSimData: v.optional(v.boolean()),
  }).index('by_planId_updatedAt', ['planId', 'updatedAt']),
  messages: defineTable({
    userId: v.string(),
    conversationId: v.id('conversations'),
    author: v.union(v.literal('user'), v.literal('assistant'), v.literal('system')),
    body: v.optional(v.string()),
    usage: v.optional(
      v.object({
        inputTokens: v.number(),
        cachedInputTokens: v.optional(v.number()),
        outputTokens: v.number(),
        totalTokens: v.number(),
      })
    ),
    updatedAt: v.number(),
    ms: v.optional(v.number()),
    isLoading: v.optional(v.boolean()),
  })
    .index('by_conversationId_updatedAt', ['conversationId', 'updatedAt'])
    .index('by_userId_updatedAt', ['userId', 'updatedAt']),
  userFeedback: defineTable({ userId: v.string(), feedback: userFeedbackValidator }).index('by_userId', ['userId']),
  insights: defineTable({
    userId: v.string(),
    planId: v.id('plans'),
    systemPrompt: v.optional(v.string()),
    content: v.string(),
    usage: v.optional(
      v.object({
        inputTokens: v.number(),
        cachedInputTokens: v.optional(v.number()),
        outputTokens: v.number(),
        totalTokens: v.number(),
      })
    ),
    updatedAt: v.number(),
    ms: v.optional(v.number()),
    isLoading: v.optional(v.boolean()),
  })
    .index('by_planId_updatedAt', ['planId', 'updatedAt'])
    .index('by_userId_updatedAt', ['userId', 'updatedAt']),
  onboarding: defineTable({
    userId: v.string(),
    onboardingDialogCompleted: v.boolean(),
  }).index('by_userId', ['userId']),
  /**
   * The manual net-worth journal (contract 3.2): one row per dated snapshot of the balances the
   * operator observed, recorded against the plan whose account ids `balances` names. P4-P7 reads
   * it to overlay actuals on the projection and to compute the deviation band.
   *
   * Additive: it is not part of the plan payload, so it changes no export schema.
   */
  netWorthJournal: defineTable({
    userId: v.string(),
    planId: v.id('plans'),
    /** As recorded: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. A partial date covers its whole period. */
    date: v.string(),
    /**
     * The end of the recorded period as `YYYY-MM-DD`, derived from `date`. P4-P7 interpolates
     * against projection rows by this value, so it is stored rather than re-derived on read, and
     * "one snapshot per day" is enforced on it.
     */
    effectiveDate: v.string(),
    balances: v.record(v.string(), v.number()),
    note: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_userId_planId_effectiveDate', ['userId', 'planId', 'effectiveDate'])
    .index('by_planId', ['planId']),
  /**
   * Personal access tokens for the MCP endpoint (`/api/mcp`). Only the SHA-256 of a token is
   * stored; the plaintext is returned once, by `mcp/tokens:createToken`. Account-level, so not part
   * of any plan export and untouched by `deleteAppData`.
   */
  mcpTokens: defineTable({
    userId: v.string(),
    name: v.string(),
    /** Lowercase hex SHA-256 of the whole token. */
    tokenHash: v.string(),
    /** The token's first 8 characters (`ign_` + 4), shown so tokens can be told apart. */
    prefix: v.string(),
    scope: v.union(v.literal('read'), v.literal('write')),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_userId', ['userId']),
  /** One row per MCP tool call: the audit trail and, counted per token per minute, the rate limit. */
  mcpAudit: defineTable({
    userId: v.string(),
    tokenId: v.id('mcpTokens'),
    tool: v.string(),
    planId: v.optional(v.string()),
    ok: v.boolean(),
    error: v.optional(v.string()),
    at: v.number(),
  })
    .index('by_tokenId_at', ['tokenId', 'at'])
    .index('by_userId_at', ['userId', 'at']),
});
