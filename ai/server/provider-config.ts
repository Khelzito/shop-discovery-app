import { DeterministicSearchIntentProvider } from './deterministic-intent.ts';
import type { IntentVocabulary } from './deterministic-intent.ts';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_TIMEOUT_MS,
  OpenAiSearchIntentProvider,
} from './openai-search-intent.ts';
import type { CategoryTaxonomy } from './category-vocabulary.ts';
import type { FetchLike } from './openai-search-intent.ts';
import type { SearchIntentProvider } from './providers.ts';

/**
 * Which provider runs, decided from server-only environment variables.
 *
 * Kept as data rather than wiring so the decision is inspectable and testable
 * without a network, and so an environment with no key still starts: the
 * deterministic tier is a valid configuration, not a failure state.
 *
 * No dependency-injection framework. Two providers and one switch do not need
 * one, and every indirection here is a place a secret could get lost.
 */

/** Reads one environment variable. Injected so Deno, Node and tests all work. */
export type EnvReader = (name: string) => string | undefined;

export const DEFAULT_SEARCH_MODEL = 'gpt-5.6-sol';

/** Why the deterministic tier is in use, for logs. Never shown to a user. */
export type DeterministicReason =
  | 'provider_disabled'
  | 'missing_api_key'
  | 'unknown_provider';

export type SearchProviderPlan =
  | {
      kind: 'openai';
      model: string;
      timeoutMs: number;
      maxOutputTokens: number;
      reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
      apiKey: string;
    }
  | { kind: 'deterministic'; reason: DeterministicReason };

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

/**
 * @param env Usually `Deno.env.get`.
 *
 * Defaults to OpenAI so that setting `OPENAI_API_KEY` alone switches the tier
 * on. Without a key it silently plans deterministic — a missing secret must
 * degrade search, never break it.
 */
export function planSearchProvider(env: EnvReader): SearchProviderPlan {
  const requested = (env('AI_SEARCH_PROVIDER') ?? 'openai').trim().toLowerCase();

  if (requested === 'deterministic' || requested === 'none' || requested === 'off') {
    return { kind: 'deterministic', reason: 'provider_disabled' };
  }

  if (requested !== 'openai') {
    return { kind: 'deterministic', reason: 'unknown_provider' };
  }

  const apiKey = (env('OPENAI_API_KEY') ?? '').trim();
  if (apiKey.length === 0) {
    return { kind: 'deterministic', reason: 'missing_api_key' };
  }

  const effort = (env('OPENAI_SEARCH_REASONING_EFFORT') ?? 'low').trim().toLowerCase();

  return {
    kind: 'openai',
    apiKey,
    model: (env('OPENAI_SEARCH_MODEL') ?? '').trim() || DEFAULT_SEARCH_MODEL,
    timeoutMs: positiveInt(env('OPENAI_SEARCH_TIMEOUT_MS'), DEFAULT_OPENAI_TIMEOUT_MS),
    maxOutputTokens: positiveInt(env('OPENAI_MAX_OUTPUT_TOKENS'), DEFAULT_MAX_OUTPUT_TOKENS),
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effort)
      ? (effort as 'minimal' | 'low' | 'medium' | 'high')
      : 'low',
  };
}

/**
 * Builds the primary provider for a plan.
 *
 * Returns null for a deterministic plan, so the caller uses the deterministic
 * provider as primary and has no fallback to arrange.
 */
export function createPrimarySearchProvider(
  plan: SearchProviderPlan,
  context: {
    allowedCategorySlugs: readonly string[];
    categoryTaxonomy?: CategoryTaxonomy;
    fetchImpl?: FetchLike;
  }
): SearchIntentProvider | null {
  if (plan.kind === 'deterministic') {
    return null;
  }

  return new OpenAiSearchIntentProvider({
    apiKey: plan.apiKey,
    model: plan.model,
    allowedCategorySlugs: context.allowedCategorySlugs,
    categoryTaxonomy: context.categoryTaxonomy,
    timeoutMs: plan.timeoutMs,
    maxOutputTokens: plan.maxOutputTokens,
    reasoningEffort: plan.reasoningEffort,
    fetchImpl: context.fetchImpl,
  });
}

export function createDeterministicProvider(
  vocabulary: IntentVocabulary
): DeterministicSearchIntentProvider {
  return new DeterministicSearchIntentProvider(vocabulary);
}

/** Log-safe summary. Deliberately cannot contain the key. */
export function describePlan(plan: SearchProviderPlan): Record<string, string | number> {
  if (plan.kind === 'deterministic') {
    return { provider: 'deterministic', reason: plan.reason };
  }
  return {
    provider: 'openai',
    model: plan.model,
    timeoutMs: plan.timeoutMs,
    reasoningEffort: plan.reasoningEffort,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
