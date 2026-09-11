import {
  DEFAULT_SHOP_ANALYSIS_MAX_OUTPUT_TOKENS,
  DEFAULT_SHOP_ANALYSIS_TIMEOUT_MS,
  OpenAiShopAnalysisProvider,
} from './openai-shop-analysis.ts';
import type { FetchLike } from './openai-search-intent.ts';
import { DEFAULT_SEARCH_MODEL } from './provider-config.ts';
import type { EnvReader } from './provider-config.ts';
import type { ShopAnalysisV2Provider } from './providers.ts';

/**
 * Which provider analyses shops, from server-only environment variables.
 *
 * Planned apart from search on purpose: the two fail independently, and an
 * analyzer with no provider is a supported state — the merchant still gets the
 * observed half of the form, marked degraded.
 *
 * | Variable                               | Default        |
 * | -------------------------------------- | -------------- |
 * | AI_SHOP_ANALYSIS_PROVIDER              | openai         |
 * | OPENAI_API_KEY                         | — (secret)     |
 * | OPENAI_SHOP_ANALYSIS_MODEL             | gpt-5.6-sol    |
 * | OPENAI_SHOP_ANALYSIS_TIMEOUT_MS        | 25000 (≤ 60000)|
 * | OPENAI_SHOP_ANALYSIS_MAX_OUTPUT_TOKENS | 4000           |
 * | OPENAI_SHOP_ANALYSIS_REASONING_EFFORT  | low            |
 */

export type ShopAnalysisProviderPlan =
  | {
      kind: 'openai';
      apiKey: string;
      model: string;
      timeoutMs: number;
      maxOutputTokens: number;
      reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
    }
  | { kind: 'none'; reason: 'provider_disabled' | 'missing_api_key' | 'unknown_provider' };

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const MAX_TIMEOUT_MS = 60_000;

export function planShopAnalysisProvider(env: EnvReader): ShopAnalysisProviderPlan {
  const requested = (env('AI_SHOP_ANALYSIS_PROVIDER') ?? 'openai').trim().toLowerCase();
  if (requested === 'none' || requested === 'off' || requested === 'disabled') {
    return { kind: 'none', reason: 'provider_disabled' };
  }
  if (requested !== 'openai') {
    return { kind: 'none', reason: 'unknown_provider' };
  }
  const apiKey = (env('OPENAI_API_KEY') ?? '').trim();
  if (apiKey.length === 0) {
    return { kind: 'none', reason: 'missing_api_key' };
  }
  const effort = (env('OPENAI_SHOP_ANALYSIS_REASONING_EFFORT') ?? 'low').trim().toLowerCase();
  return {
    kind: 'openai',
    apiKey,
    model: (env('OPENAI_SHOP_ANALYSIS_MODEL') ?? '').trim() || DEFAULT_SEARCH_MODEL,
    timeoutMs: Math.min(positiveInt(env('OPENAI_SHOP_ANALYSIS_TIMEOUT_MS'), DEFAULT_SHOP_ANALYSIS_TIMEOUT_MS), MAX_TIMEOUT_MS),
    maxOutputTokens: positiveInt(env('OPENAI_SHOP_ANALYSIS_MAX_OUTPUT_TOKENS'), DEFAULT_SHOP_ANALYSIS_MAX_OUTPUT_TOKENS),
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effort)
      ? (effort as (typeof REASONING_EFFORTS)[number])
      : 'low',
  };
}

export function createShopAnalysisProvider(
  plan: ShopAnalysisProviderPlan,
  context: { fetchImpl?: FetchLike } = {}
): ShopAnalysisV2Provider | null {
  if (plan.kind === 'none') {
    return null;
  }
  return new OpenAiShopAnalysisProvider({
    apiKey: plan.apiKey,
    model: plan.model,
    timeoutMs: plan.timeoutMs,
    maxOutputTokens: plan.maxOutputTokens,
    reasoningEffort: plan.reasoningEffort,
    fetchImpl: context.fetchImpl,
  });
}

/** Log-safe. Deliberately cannot contain the key. */
export function describeShopAnalysisPlan(plan: ShopAnalysisProviderPlan): Record<string, string | number> {
  if (plan.kind === 'none') {
    return { provider: 'none', reason: plan.reason };
  }
  return {
    provider: 'openai',
    model: plan.model,
    timeoutMs: plan.timeoutMs,
    maxOutputTokens: plan.maxOutputTokens,
    reasoningEffort: plan.reasoningEffort,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
