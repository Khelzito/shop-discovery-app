// Edge Function: POST /ai-search-intent
//
// The first real end-to-end AI backend path. It deliberately contains no AI
// logic of its own: it is transport, authentication and persistence around
// SearchIntelligenceService, which is shared with the Node test suite.
//
// The provider is chosen from server-only environment variables. With
// OPENAI_API_KEY set it uses OpenAI; without it, or when OpenAI fails, times
// out or answers with something unusable, it falls back to the deterministic
// tier. That floor is what docs/MASTER_SPEC.md §8 requires: an AI outage must
// degrade search, never take it down.
//
// The API key is read here and passed only to the provider adapter. It is
// never logged, never returned, and unreachable from the Expo bundle.
//
// Deno runtime. Relative imports carry explicit .ts extensions because Deno
// requires them; the Node build rewrites them to .js on emit.

import { createClient } from 'npm:@supabase/supabase-js@^2.109.0';

import type { SearchIntentResponse } from '../../../ai/contracts/endpoints.ts';
import type { AiErrorPayload } from '../../../ai/contracts/errors.ts';
import type { AiCallTelemetry } from '../../../ai/contracts/model.ts';
import type { IntentVocabulary } from '../../../ai/server/deterministic-intent.ts';
import { toAiErrorPayload } from '../../../ai/server/errors.ts';
import { resolveCategoryIds, toSearchRow } from '../../../ai/server/persistence.ts';
import {
  createDeterministicProvider,
  createPrimarySearchProvider,
  describePlan,
  planSearchProvider,
} from '../../../ai/server/provider-config.ts';
import { SearchIntelligenceService } from '../../../ai/server/services.ts';
import { validateSearchIntentRequest } from '../../../ai/server/validation.ts';

/** Bodies larger than this are refused before parsing. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Country vocabulary for the deterministic tier.
 *
 * Hardcoded rather than read from the database because there is no countries
 * table: these are language terms, not catalogue data. Categories come from
 * the database, so the parser and the catalogue cannot drift apart.
 */
const COUNTRY_TERMS: IntentVocabulary['countries'] = [
  { code: 'FR', terms: ['france', 'francaise', 'francais', 'francaises'] },
  { code: 'BE', terms: ['belgique', 'belge', 'belges'] },
  { code: 'DE', terms: ['allemagne', 'allemande', 'allemand'] },
  { code: 'ES', terms: ['espagne', 'espagnole', 'espagnol'] },
  { code: 'IT', terms: ['italie', 'italienne', 'italien'] },
  { code: 'NL', terms: ['pays-bas', 'neerlandaise', 'neerlandais'] },
  { code: 'PT', terms: ['portugal', 'portugaise', 'portugais'] },
];

const CORS_HEADERS: Record<string, string> = {
  // The Expo client is a native app with no browser origin, so there is no
  // origin worth allow-listing. This exists for the web build and for local
  // tooling; it grants nothing on its own, since every request still needs a
  // valid JWT.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

type CategoryRow = { id: string; slug: string; name: string };

/**
 * Categories are read once per isolate rather than per request. They change
 * rarely, and a cold start is the only cost.
 */
let categoriesPromise: Promise<CategoryRow[]> | null = null;

// Resolved once per isolate and logged once, so every request does not repeat
// the same configuration line. The description is key-free by construction.
const searchProviderPlan = planSearchProvider((name) => Deno.env.get(name));
console.info('[ai-search-intent] provider plan', describePlan(searchProviderPlan));

function loadCategories(client: ReturnType<typeof createClient>): Promise<CategoryRow[]> {
  const cached = categoriesPromise;
  if (cached !== null) {
    return cached;
  }

  const pending = client
    .from('categories')
    .select('id, slug, name')
    .eq('is_active', true)
    .then((response: { data: unknown; error: unknown }) => {
      if (response.error) {
        // Do not poison the cache: a transient failure must not disable
        // category matching for the lifetime of the isolate.
        categoriesPromise = null;
        throw response.error;
      }
      return (response.data ?? []) as CategoryRow[];
    });

  categoriesPromise = pending;
  return pending;
}

/** Category label plus slug, so "Prêt-à-porter" and "mode" both match. */
function toVocabulary(categories: readonly CategoryRow[]): IntentVocabulary {
  return {
    categories: categories.map((category) => ({
      slug: category.slug,
      terms: [category.slug, category.name],
    })),
    countries: COUNTRY_TERMS,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function failure(error: AiErrorPayload, status: number): Response {
  return json({ ok: false, error }, status);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const startedAt = Date.now();

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return failure(
      { code: 'ai_bad_request', message: 'Méthode non autorisée.', retryable: false },
      405
    );
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return failure(
      { code: 'ai_bad_request', message: 'Content-Type application/json attendu.', retryable: false },
      415
    );
  }

  // Size cap before parsing. Content-Length is only a hint, so the decoded
  // body is measured too.
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return failure(
      { code: 'ai_bad_request', message: 'Requête trop volumineuse.', retryable: false },
      413
    );
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return failure(
      { code: 'ai_bad_request', message: 'Requête illisible.', retryable: false },
      400
    );
  }

  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return failure(
      { code: 'ai_bad_request', message: 'Requête trop volumineuse.', retryable: false },
      413
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure({ code: 'ai_bad_request', message: 'JSON invalide.', retryable: false }, 400);
  }

  const validated = validateSearchIntentRequest(parsed);
  if (!validated.ok) {
    // The issue list names fields, never values, so a rejected query is not
    // echoed back.
    console.warn('[ai-search-intent] rejected request', { issues: validated.issues });
    return failure(
      { code: 'ai_bad_request', message: 'Requête invalide.', retryable: false },
      400
    );
  }

  // The user is resolved from the JWT only. A user id in the body is ignored,
  // and `verify_jwt` has already rejected anything without a valid token.
  const authorization = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKey =
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');

  if (!supabaseUrl || !publishableKey) {
    console.error('[ai-search-intent] missing platform environment');
    return failure(
      { code: 'ai_unavailable', message: 'Service indisponible.', retryable: true },
      503
    );
  }

  // No service_role anywhere: this client carries the caller's own token, so
  // every query and insert runs under their RLS policies.
  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user ?? null;
  if (userError || !user) {
    return failure(
      { code: 'ai_bad_request', message: 'Authentification requise.', retryable: false },
      401
    );
  }

  try {
    let categories: CategoryRow[] = [];
    try {
      categories = await loadCategories(supabase);
    } catch (error) {
      // Category matching degrades to nothing; the query still parses.
      console.warn('[ai-search-intent] categories unavailable', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }

    // Telemetry carries no query text and no user id, only provider health.
    const telemetry: AiCallTelemetry[] = [];

    const deterministic = createDeterministicProvider(toVocabulary(categories));
    const primary = createPrimarySearchProvider(searchProviderPlan, {
      allowedCategorySlugs: categories.map((category) => category.slug),
    });

    const service = new SearchIntelligenceService(primary ?? deterministic, {
      // With no real provider configured the deterministic tier IS the primary,
      // so there is nothing to fall back to.
      ...(primary ? { fallback: deterministic } : {}),
      context: { recordTelemetry: (entry) => telemetry.push(entry) },
    });

    const { intent, degraded } = await service.parse(validated.value);

    // Controlled analytics. Slugs are resolved against real rows; an
    // unresolvable slug is dropped rather than invented.
    const row = toSearchRow(intent, {
      userId: user.id,
      categoryIds: resolveCategoryIds(intent.hard.categorySlugs, categories),
      resultsCount: null,
    });

    const { error: insertError } = await supabase.from('searches').insert(row);
    if (insertError) {
      // Analytics must never break the answer the user is waiting for.
      console.warn('[ai-search-intent] search not recorded', { code: insertError.code });
    }

    console.info('[ai-search-intent] ok', {
      latencyMs: Date.now() - startedAt,
      source: intent.source,
      degraded,
      categoriesMatched: intent.hard.categorySlugs.length,
      // Provider health only: no prompt, no completion, no query text.
      calls: telemetry.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        outcome: entry.outcome,
        latencyMs: entry.latencyMs,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      })),
    });

    const body: SearchIntentResponse = { intent, degraded };
    return json({ ok: true, data: body }, 200);
  } catch (error) {
    // Nothing internal crosses the boundary: no stack, no filename, no SQL.
    console.error('[ai-search-intent] failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return failure(toAiErrorPayload(error), 500);
  }
});
