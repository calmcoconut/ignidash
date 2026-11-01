// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';
import { basicTemplate } from './templates/basic';
import betterAuthSchema from './betterAuth/schema';
import { TAX_OPTIMIZATION_SKILL_MARKER } from './prompts/tax_optimization';
import { TAX_OPTIMIZATION_TOOLS_DISABLED_MESSAGE } from './utils/sys_prompt_utils';
import type { KeyMetrics } from './validators/key_metrics_validator';

const modules = import.meta.glob('./**/*.ts');
const componentModules = import.meta.glob('./betterAuth/**/*.ts');

const TEST_USER = 'test-user-123';

const KEY_METRICS: KeyMetrics = {
  type: 'single',
  success: 1,
  retirementAge: 65,
  yearsToRetirement: 35,
  bankruptcyAge: null,
  yearsToBankruptcy: null,
  portfolioAtRetirement: 1500000,
  lifetimeTaxesAndPenalties: 400000,
  finalPortfolio: 2200000,
  progressToRetirement: 0.4,
};

/** A deployment with an AI provider configured (`getCanUseAIFeatures` reads the environment). */
function testInstance() {
  const t = convexTest(schema, modules);
  t.registerComponent('betterAuth', betterAuthSchema, componentModules);

  return t;
}

async function insertPlan(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.insert('plans', { ...basicTemplate, userId: TEST_USER, name: 'Chat Plan' }));
}

/** The prompt `send` handed to the streaming action on its most recent turn. */
async function lastTurnPrompt(t: ReturnType<typeof convexTest>): Promise<string | undefined> {
  const scheduled = await t.run(async (ctx) => {
    const all = await ctx.db.system.query('_scheduled_functions').collect();

    return all[all.length - 1] as { args?: Array<{ systemPrompt?: string }> } | undefined;
  });

  return scheduled?.args?.[0]?.systemPrompt;
}

/**
 * The streaming action is never run here (fake timers keep it queued), so its placeholder message
 * stays `isLoading`; clear it the way `cleanupLoadingMessages` would, to allow the next turn.
 */
async function finishTurn(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const loading = await ctx.db
      .query('messages')
      .filter((q) => q.eq(q.field('isLoading'), true))
      .collect();

    await Promise.all(loading.map((message) => ctx.db.patch(message._id, { isLoading: false })));
  });
}

describe('messages.send tax-optimization gating (§7-A2)', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const originalTools = process.env.OPENAI_TOOLS_ENABLED;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1';
    delete process.env.OPENAI_TOOLS_ENABLED;

    // `send` schedules the streaming action; fake timers keep it queued so no provider is ever
    // called (the evals are the only place a model runs, and they run on demand).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of [
      ['OPENAI_API_KEY', originalKey],
      ['OPENAI_BASE_URL', originalBaseUrl],
      ['OPENAI_TOOLS_ENABLED', originalTools],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('stores the skill marker on the conversation it creates', async () => {
    const t = testInstance();
    const planId = await insertPlan(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { conversationId } = await asUser.mutation(api.messages.send, {
      planId,
      content: 'Run the tax-optimization skill on my plan.',
      keyMetrics: KEY_METRICS,
      taxOptimization: true,
    });

    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation?.systemPrompt).toContain(TAX_OPTIMIZATION_SKILL_MARKER);

    await finishTurn(t);

    const plainId = (
      await asUser.mutation(api.messages.send, {
        planId,
        content: 'Why is my tax bill high?',
        keyMetrics: KEY_METRICS,
      })
    ).conversationId;

    const plain = await t.run(async (ctx) => ctx.db.get(plainId));
    expect(plain?.systemPrompt).not.toContain(TAX_OPTIMIZATION_SKILL_MARKER);
  });

  it('keeps the skill on later turns, where the prompt is rebuilt from the plan', async () => {
    const t = testInstance();
    const planId = await insertPlan(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { conversationId } = await asUser.mutation(api.messages.send, {
      planId,
      content: 'Run the tax-optimization skill on my plan.',
      keyMetrics: KEY_METRICS,
      taxOptimization: true,
    });

    // No flag on the reply: the stored marker is what keeps the mode.
    await finishTurn(t);
    const followUp = await asUser.mutation(api.messages.send, {
      conversationId,
      planId,
      content: 'Rank them by lifetime taxes.',
      keyMetrics: KEY_METRICS,
    });
    expect(followUp.conversationId).toBe(conversationId);
    expect(followUp.messages.some((message) => message.author === 'user')).toBe(true);
    // The turn's prompt was rebuilt from the plan and still carries the skill.
    expect(await lastTurnPrompt(t)).toContain(TAX_OPTIMIZATION_SKILL_MARKER);

    // And a plain conversation does not become a skill chat when the flag is passed late.
    await finishTurn(t);
    const plainId = (await asUser.mutation(api.messages.send, { planId, content: 'Hello', keyMetrics: KEY_METRICS })).conversationId;

    await finishTurn(t);
    await asUser.mutation(api.messages.send, {
      conversationId: plainId,
      planId,
      content: 'Now optimize my taxes.',
      keyMetrics: KEY_METRICS,
      taxOptimization: true,
    });
    expect(await lastTurnPrompt(t)).not.toContain(TAX_OPTIMIZATION_SKILL_MARKER);

    const plain = await t.run(async (ctx) => ctx.db.get(plainId));
    expect(plain?.systemPrompt).not.toContain(TAX_OPTIMIZATION_SKILL_MARKER);
  });

  it('refuses to create the skill chat when tool calling is off (F4)', async () => {
    process.env.OPENAI_TOOLS_ENABLED = 'false';

    const t = testInstance();
    const planId = await insertPlan(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(
      asUser.mutation(api.messages.send, {
        planId,
        content: 'Run the tax-optimization skill on my plan.',
        keyMetrics: KEY_METRICS,
        taxOptimization: true,
      })
    ).rejects.toThrow(TAX_OPTIMIZATION_TOOLS_DISABLED_MESSAGE);

    // Nothing was written: no conversation, no messages.
    const counts = await t.run(async (ctx) => ({
      conversations: (await ctx.db.query('conversations').collect()).length,
      messages: (await ctx.db.query('messages').collect()).length,
    }));
    expect(counts).toEqual({ conversations: 0, messages: 0 });
  });

  it('still answers plain chat when tool calling is off (F4)', async () => {
    process.env.OPENAI_TOOLS_ENABLED = 'false';

    const t = testInstance();
    const planId = await insertPlan(t);
    const asUser = t.withIdentity({ subject: TEST_USER });

    const { conversationId } = await asUser.mutation(api.messages.send, {
      planId,
      content: 'Why is my tax bill high?',
      keyMetrics: KEY_METRICS,
    });

    const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conversation?.systemPrompt).toBeDefined();
    expect(conversation?.systemPrompt).not.toContain(TAX_OPTIMIZATION_SKILL_MARKER);
  });
});
