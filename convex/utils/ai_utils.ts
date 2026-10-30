import type { QueryCtx } from '../_generated/server';
import { api } from '../_generated/api';

/**
 * AI features are available when this deployment has an OpenAI-compatible provider configured.
 * `OPENAI_BASE_URL` points the `openai` SDK at any OpenAI-compatible server (Ollama, vLLM, llama.cpp, …);
 * `OPENAI_ENDPOINT` keeps the Azure OpenAI path working.
 */
export function isAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY && (process.env.OPENAI_BASE_URL || process.env.OPENAI_ENDPOINT));
}

export async function getCanUseAIFeatures(
  ctx: QueryCtx
): Promise<{ canUseAIFeatures: boolean; isAdmin: boolean; isActiveSubscription: boolean }> {
  return ctx.runQuery(api.auth.getCanUseAIFeatures, {});
}
