'use node';

import { ConvexError } from 'convex/values';
import { AzureOpenAI, OpenAI } from 'openai';
import { internalAction } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { internal } from './_generated/api';

import { isAIConfigured } from './utils/ai_utils';

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
};

export const streamChat = internalAction({
  handler: async (ctx, { userId, messages, assistantMessageId, systemPrompt }: StreamChatParams) => {
    if (!openaiChat) {
      const errorMessage = NOT_CONFIGURED_MESSAGE;
      console.error(errorMessage);

      await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body: errorMessage, isLoading: false });
      throw new ConvexError(errorMessage);
    }

    const hasBody = (msg: Doc<'messages'>): msg is Doc<'messages'> & { body: string } => msg.body !== undefined;

    try {
      const stream = await openaiChat.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.filter(hasBody).map((msg) => ({ role: msg.author, content: msg.body })),
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 1024,
      });

      let body = '';
      let lastWriteTime = Date.now();

      for await (const part of stream) {
        if (part.choices.length > 0) {
          const choice = part.choices[0];

          if (choice.finish_reason === 'content_filter') {
            body += '\n\n**[Response was cut short by content filter]**';
          }

          if (choice.delta.content) {
            body += choice.delta.content;
            const now = Date.now();
            if (now - lastWriteTime > 1000) {
              await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body });
              lastWriteTime = now;
            }
          }
        }

        if (part.usage) {
          await ctx.runMutation(internal.messages.setUsage, {
            messageId: assistantMessageId,
            inputTokens: part.usage.prompt_tokens,
            cachedInputTokens: part.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: part.usage.completion_tokens,
            totalTokens: part.usage.total_tokens,
          });
        }
      }

      await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body, isLoading: false });
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        console.error(error);

        const body = `An unexpected error occurred: ${error.message}.`;
        await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body, isLoading: false });
      } else {
        const body = 'An unexpected error occurred. Please try again later.';
        await ctx.runMutation(internal.messages.setBody, { messageId: assistantMessageId, body, isLoading: false });

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

        const content = `An unexpected error occurred: ${error.message}.`;
        await ctx.runMutation(internal.insights.setContent, { insightId, content, isLoading: false });
      } else {
        const content = 'An unexpected error occurred. Please try again later.';
        await ctx.runMutation(internal.insights.setContent, { insightId, content, isLoading: false });

        throw error;
      }
    }
  },
});
