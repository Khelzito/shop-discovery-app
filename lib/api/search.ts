import type { SearchResponse, SemanticMatch } from '@/ai/contracts/endpoints';
import type { AiErrorPayload } from '@/ai/contracts/errors';
import type { SearchIntent } from '@/ai/contracts/search-intent';
import { supabase } from '@/lib/supabase';
import { parseSearchIntent } from './search-intent';

/**
 * Client wrapper for the ai-search Edge Function — Search V2.
 *
 * Imports types only from `@/ai/contracts`; they are erased at build time, so
 * nothing from the AI layer reaches the bundle. `ai/server` is never imported
 * here and could not be — Metro blocks it from resolution entirely.
 *
 * THE FALLBACK IS THE POINT. If ai-search is unreachable, not yet deployed, or
 * fails for any reason, this falls back to ai-search-intent and returns an
 * intent with no semantic matches. The caller then runs exactly the V1 search.
 * A user never sees the difference; the only visible effect of V2 being down is
 * that results are less good, which is what degradation should look like.
 */

const FUNCTION_NAME = 'ai-search';

export type SearchOutcome =
  | {
      ok: true;
      intent: SearchIntent;
      degraded: boolean;
      semanticMatches: SemanticMatch[];
      /** Diagnostics for __DEV__ logging. Never rendered. */
      semantic: SearchResponse['semantic'];
    }
  | { ok: false; error: AiErrorPayload };

type FunctionResponse =
  | { ok: true; data: SearchResponse }
  | { ok: false; error: AiErrorPayload };

const UNAVAILABLE: AiErrorPayload = {
  code: 'ai_unavailable',
  message: 'La recherche intelligente est momentanément indisponible.',
  retryable: true,
};

/** What a V1 answer looks like once lifted into the V2 shape. */
function withoutSemantics(
  intent: SearchIntent,
  degraded: boolean,
  status: SearchResponse['semantic']['status']
): SearchOutcome {
  return {
    ok: true,
    intent,
    degraded,
    semanticMatches: [],
    semantic: { status, model: null, matchCount: 0 },
  };
}

export async function searchWithIntent(
  query: string,
  options: { locale?: string; shippingCountryCode?: string } = {}
): Promise<SearchOutcome> {
  if (!supabase) {
    return { ok: false, error: UNAVAILABLE };
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { code: 'ai_bad_request', message: 'Saisis une recherche.', retryable: false },
    };
  }

  const { data, error } = await supabase.functions.invoke<FunctionResponse>(FUNCTION_NAME, {
    body: { query: trimmed, ...options },
  });

  // Transport failure or non-2xx. Rather than failing the search, drop to the
  // V1 endpoint: it is deployed, unchanged, and answers the same question
  // without the semantic arm.
  if (error || !data || typeof data !== 'object' || !('ok' in data)) {
    if (__DEV__) {
      console.warn('[search] ai-search unavailable, falling back to ai-search-intent');
    }
    const v1 = await parseSearchIntent(trimmed, options);
    return v1.ok
      ? withoutSemantics(v1.intent, v1.degraded, 'retrieval_failed')
      : { ok: false, error: v1.error };
  }

  if (!data.ok) {
    return { ok: false, error: data.error };
  }

  const body = data.data;
  return {
    ok: true,
    intent: body.intent,
    degraded: body.degraded,
    // Narrowed rather than trusted: this crossed a network boundary.
    semanticMatches: Array.isArray(body.semanticMatches)
      ? body.semanticMatches.filter(isMatch)
      : [],
    semantic: body.semantic ?? { status: 'no_matches', model: null, matchCount: 0 },
  };
}

function isMatch(value: unknown): value is SemanticMatch {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const match = value as { shopId?: unknown; similarity?: unknown };
  return (
    typeof match.shopId === 'string' &&
    match.shopId.length > 0 &&
    typeof match.similarity === 'number' &&
    Number.isFinite(match.similarity)
  );
}
