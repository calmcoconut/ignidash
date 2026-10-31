'use node';

import { ConvexError } from 'convex/values';
import { AzureOpenAI, OpenAI } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { internalAction } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { internal } from './_generated/api';

import { CHAT_TOOL_DEFINITIONS, MAX_TOOL_CALLS_PER_TURN, createChatToolkit } from './chat_tools';
import { isAIConfigured, isToolCallingEnabled } from './utils/ai_utils';
import { simulatorFromConvex } from '../src/lib/utils/data-transformers';

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL;
const azureEndpoint = process.env.OPENAI_ENDPOINT;

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.2-chat';
const INSIGHTS_MODEL = process.env.OPENAI_INSIGHTS_MODEL ?? 'gpt-5.2';

const NOT_CONFIGURED_MESSAGE =
  'AI is not configured for this deployment. Set OPENAI_API_KEY together with OPENAI_BASE_URL (any OpenAI-compatible server) or OPENAI_ENDPOINT (Azure OpenAI).';

/**
 * `OPENAI_BASE_URL` targets any OpenAI-compatible server; otherwise the Azure OpenAI client is used
 * exactly as before, with the model name doubling as the deployment name.
 */
function createClient(model: string, apiVersion: string): OpenAI | null {
  if (!isAIConfigured()) return null;

  if (baseUrl) return new OpenAI({ apiKey, baseURL: baseUrl });

  return new AzureOpenAI({ endpoint: azureEndpoint, apiKey, apiVersion, deployment: model });
}

const openaiChat = createClient(CHAT_MODEL, '2024-04-01-preview');
const openaiInsights = createClient(INSIGHTS_MODEL, '2024-12-01-preview');

type StreamChatParams = {
  userId: string;
  messages: Doc<'messages'>[];
  assistantMessageId: Id<'messages'>;
  systemPrompt: string;
  /** The plan the conversation belongs to; its inputs are what the tools simulate. */
  plan: Doc<'plans'>;
  /** The turn's clock, resolved once in `messages.send` so no tool reads it. */
  asOf: string;
};

/** Token usage summed across the tool rounds of one turn. */
type UsageTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number };

const emptyUsage = (): UsageTotals => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });

type PendingToolCall = { id: string; name: string; arguments: string };

/** Shape the tools accept: named arguments, parsed at the boundary. */
type ToolArguments = Record<string, unknown>;

/** Tool arguments arrive as a JSON string; a malformed one becomes "no arguments", not a throw. */
function parseToolArguments(raw: string): ToolArguments {
  if (raw.trim() === '') return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ToolArguments) : {};
  } catch {
    return {};
  }
}

/**
 * Builds the turn's toolset from the plan's own inputs. If anything about that fails — a plan
 * mid-migration, an unexpected shape — the turn falls back to plain chat: a broken tool graph must
 * never break the conversation.
 */
function createTurnToolkit(plan: Doc<'plans'>, asOf: string) {
  try {
    return createChatToolkit({ inputs: simulatorFromConvex(plan), asOf });
  } catch (error) {
    console.error('Chat tools are unavailable for this turn; continuing with plain chat.', error);
    return null;
  }
}

export const streamChat = internalAction({
  handler: async (ctx, { userId: _userId, messages, assistantMessageId, systemPrompt, plan, asOf }: StreamChatParams) => {
    if (!openaiChat) {
      const errorMessage = NOT_CONFIGURED_MESSAGE;
      console.error(errorMessage);

      await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body: errorMessage, isLoading: false });
      throw new ConvexError(errorMessage);
    }

    const hasBody = (msg: Doc<'messages'>): msg is Doc<'messages'> & { body: string } => msg.body !== undefined;

    // F4: with tools disabled the request below is exactly the pre-skill one — no `tools`
    // parameter, no tool loop, same streaming.
    const toolkit = isToolCallingEnabled() ? createTurnToolkit(plan, asOf) : null;

    const conversation: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(hasBody).map((msg): ChatCompletionMessageParam => ({ role: msg.author, content: msg.body })),
    ];

    try {
      let body = '';
      let lastWriteTime = Date.now();
      const usage = emptyUsage();

      for (let round = 0; round <= MAX_TOOL_CALLS_PER_TURN; round++) {
        const callsSoFar = toolkit?.callCount() ?? 0;
        const budgetExhausted = toolkit !== null && callsSoFar >= MAX_TOOL_CALLS_PER_TURN;

        const stream = await openaiChat.chat.completions.create({
          model: CHAT_MODEL,
          messages: conversation,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 1024,
          ...(toolkit
            ? { tools: CHAT_TOOL_DEFINITIONS as ChatCompletionTool[], tool_choice: budgetExhausted ? ('none' as const) : ('auto' as const) }
            : {}),
        });

        let roundContent = '';
        const pendingCalls: PendingToolCall[] = [];

        for await (const part of stream) {
          if (part.choices.length > 0) {
            const choice = part.choices[0];
            const delta = choice.delta;

            if (choice.finish_reason === 'content_filter') {
              body += '\n\n**[Response was cut short by content filter]**';
            }

            if (delta?.content) {
              roundContent += delta.content;
              body += delta.content;

              const now = Date.now();
              if (now - lastWriteTime > 1000) {
                await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body });
                lastWriteTime = now;
              }
            }

            for (const toolCall of delta?.tool_calls ?? []) {
              const index = toolCall.index ?? 0;
              const slot = (pendingCalls[index] ??= { id: '', name: '', arguments: '' });
              if (toolCall.id) slot.id = toolCall.id;
              if (toolCall.function?.name) slot.name += toolCall.function.name;
              if (toolCall.function?.arguments) slot.arguments += toolCall.function.arguments;
            }
          }

          if (part.usage) {
            usage.inputTokens += part.usage.prompt_tokens;
            usage.cachedInputTokens += part.usage.prompt_tokens_details?.cached_tokens ?? 0;
            usage.outputTokens += part.usage.completion_tokens;
            usage.totalTokens += part.usage.total_tokens;
          }
        }

        await ctx.runMutation(internal.messages.setUsage, { messageId: assistantMessageId, ...usage });

        // No tools offered, or the model answered: this round is the final answer.
        if (!toolkit || pendingCalls.length === 0) break;

        conversation.push({
          role: 'assistant',
          content: roundContent === '' ? null : roundContent,
          tool_calls: pendingCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        for (const call of toolkit.callCount() >= MAX_TOOL_CALLS_PER_TURN ? [] : pendingCalls) {
          const result = toolkit.execute(call.name, parseToolArguments(call.arguments));
          conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }

      await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body, isLoading: false });
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        console.error(error);

        const errorBody = `An unexpected error occurred: ${error.message}.`;
        await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body: errorBody, isLoading: false });
      } else {
        const errorBody = 'An unexpected error occurred. Please try again later.';
        await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body: errorBody, isLoading: false });

        throw error;
      }
    }
  },
});

type StreamInsightsParams = {
  userId: string;
  insightId: Id<'insights'>;
  systemPrompt: string;
};

export const streamInsights = internalAction({
  handler: async (ctx, { userId, insightId, systemPrompt }: StreamInsightsParams) => {
    if (!openaiInsights) {
      const errorMessage = NOT_CONFIGURED_MESSAGE;
      console.error(errorMessage);

      await ctx.runMutation(internal.insights.setContent, { insightId, content: errorMessage, isLoading: false });
      throw new ConvexError(errorMessage);
    }

    try {
      const stream = await openaiInsights.chat.completions.create({
        model: INSIGHTS_MODEL,
        messages: [{ role: 'system', content: systemPrompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 8192,
      });

      let content = '';
      let lastWriteTime = Date.now();

      for await (const part of stream) {
        if (part.choices.length > 0) {
          const choice = part.choices[0];

          if (choice.finish_reason === 'content_filter') {
            content += '\n\n**[Response was cut short by content filter]**';
          }

          if (choice.delta.content) {
            content += choice.delta.content;
            const now = Date.now();
            if (now - lastWriteTime > 5000) {
              await ctx.runMutation(internal.insights.setContent, { insightId, content });
              lastWriteTime = now;
            }
          }
        }

        if (part.usage) {
          await ctx.runMutation(internal.insights.setUsage, {
            insightId,
            inputTokens: part.usage.prompt_tokens,
            cachedInputTokens: part.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: part.usage.completion_tokens,
            totalTokens: part.usage.total_tokens,
          });
        }
      }

      await ctx.runMutation(internal.insights.setContent, { insightId, content, isLoading: false });
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        console.error(error);

        const errorContent = `An unexpected error occurred: ${error.message}.`;
        await ctx.runMutation(internal.insights.setContent, { insightId, content: errorContent, isLoading: false });
      } else {
        const errorContent = 'An unexpected error occurred. Please try again later.';
        await ctx.runMutation(internal.insights.setContent, { insightId, content: errorContent, isLoading: false });

        throw error;
      }
    }
  },
});
