import type { AiErrorPayload } from '@/ai/contracts/errors';
import type { SearchIntent } from '@/ai/contracts/search-intent';
import { supabase } from '@/lib/supabase';

/**
 * Client wrapper for the ai-search-intent Edge Function.
 *
 * Imports types only from `@/ai/contracts` — they are erased at build time, so
 * nothing from the AI layer reaches the bundle. `ai/server` is never imported
 * here and could not be: Metro blocks it from resolution entirely.
 *
 * The session token is attached by supabase-js from the stored session; this
 * module never handles a token itself and holds no secret.
 */

const FUNCTION_NAME = 'ai-search-intent';

export type SearchIntentOutcome =
  | { ok: true; intent: SearchIntent; degraded: boolean }
  | { ok: false; error: AiErrorPayload };

/** Shape the Edge Function returns. Narrowed before anything is trusted. */
type FunctionResponse =
  | { ok: true; data: { intent: SearchIntent; degraded: boolean } }
  | { ok: false; error: AiErrorPayload };

const UNAVAILABLE: AiErrorPayload = {
  code: 'ai_unavailable',
  message: 'La recherche intelligente est momentanément indisponible.',
  retryable: true,
};

export async function parseSearchIntent(
  query: string,
  options: { locale?: string; shippingCountryCode?: string } = {}
): Promise<SearchIntentOutcome> {
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

  if (error) {
    // The transport failed, or the function returned a non-2xx. Its body is
    // not reliably available here, so report a safe generic failure rather
    // than surfacing whatever the platform put in the message.
    if (__DEV__) {
      console.warn(`[search-intent] invoke failed: ${error.name}`);
    }
    return { ok: false, error: UNAVAILABLE };
  }

  if (!data || typeof data !== 'object' || !('ok' in data)) {
    return { ok: false, error: UNAVAILABLE };
  }

  if (!data.ok) {
    return { ok: false, error: data.error };
  }

  return { ok: true, intent: data.data.intent, degraded: data.data.degraded };
}
