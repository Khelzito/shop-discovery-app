// Edge Function: POST /ai-search — Search V2.
//
// Orchestration only, no AI logic of its own: it composes
// SearchIntelligenceService (unchanged from V1), EmbeddingService, and one
// SQL function. Every piece it uses is shared with the Node test suite.
//
// It does NOT replace ai-search-intent. That function stays deployed and
// untouched, so an already-installed app keeps working and a rollback is a
// client-side switch rather than a redeploy.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: the semantic arm is optional.
// Every failure below — no provider, provider down, timeout, unusable vector,
// vector query broken — returns `semanticMatches: []` and a status, never an
// error. The response still carries the intent, so the caller falls back to
// exactly the V1 factual search. A search that cannot be enriched is still a
// search; a search that fails is a bug.
//
// TWO CLIENTS, DELIBERATELY:
//   * `supabase` carries the CALLER's token. Auth, categories and analytics
//     run under their own RLS, exactly as in ai-search-intent.
//   * `admin` carries service_role and is used for ONE call: the RPC, which
//     needs to read shop_embeddings (revoked from every client role). It
//     returns shop ids and similarities — never vectors, never rows — and the
//     app then re-reads those shops through its own RLS-governed query. So
//     service_role widens what can be RANKED, never what can be SEEN.
//
// Deno runtime. Relative imports carry explicit .ts extensions.

import { createClient } from 'npm:@supabase/supabase-js@^2.109.0';

import type {
  SearchResponse,
  SemanticArmStatus,
  SemanticMatch,
} from '../../../ai/contracts/endpoints.ts';
import type { AiErrorPayload } from '../../../ai/contracts/errors.ts';
import type { AiCallTelemetry } from '../../../ai/contracts/model.ts';
import type { SearchIntent } from '../../../ai/contracts/search-intent.ts';
import { buildCategoryResolver } from '../../../ai/server/category-vocabulary.ts';
import type { IntentVocabulary } from '../../../ai/server/deterministic-intent.ts';
import { toAiErrorPayload } from '../../../ai/server/errors.ts';
import { resolveCategoryIds, toSearchRow } from '../../../ai/server/persistence.ts';
import {
  createDeterministicProvider,
  createEmbeddingProvider,
  createPrimarySearchProvider,
  describeEmbeddingPlan,
  describePlan,
  planEmbeddingProvider,
  planSearchProvider,
} from '../../../ai/server/provider-config.ts';
import {
  classifyEmbeddingFailure,
  decideSemanticArm,
  expandAudiences,
  nullIfEmpty,
  parseSemanticMatches,
} from '../../../ai/server/semantic-arm.ts';
import { EmbeddingService, SearchIntelligenceService } from '../../../ai/server/services.ts';
import { validateSearchIntentRequest } from '../../../ai/server/validation.ts';

const MAX_BODY_BYTES = 4 * 1024;

/** Candidates asked of pgvector. Bounded again in SQL at 200. */
const SEMANTIC_CANDIDATE_LIMIT = 40;

/**
 * Retrieval cutoff, mirroring SEMANTIC_SIMILARITY_FLOOR in data/search/rank.ts.
 *
 * Passed explicitly on every call. The SQL function defaults it to 0 precisely
 * so this stays the single tunable value: retuning it after measurement means
 * editing the constant and this line, never a migration.
 */
const SEMANTIC_MIN_SIMILARITY = 0.15;

/** Which vectors to search. Only `shop_profile` is written in V1. */
const SEMANTIC_SOURCE_KIND = 'shop_profile';

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
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

type CategoryRow = { id: string; slug: string; name: string };

let categoriesPromise: Promise<CategoryRow[]> | null = null;

// Resolved once per isolate and logged once. Both descriptions are key-free by
// construction.
const searchProviderPlan = planSearchProvider((name) => Deno.env.get(name));
const embeddingPlan = planEmbeddingProvider((name) => Deno.env.get(name));
console.info('[ai-search] provider plan', {
  intent: describePlan(searchProviderPlan),
  embedding: describeEmbeddingPlan(embeddingPlan),
});

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
        categoriesPromise = null;
        throw response.error;
      }
      return (response.data ?? []) as CategoryRow[];
    });
  categoriesPromise = pending;
  return pending;
}

function toVocabulary(categories: readonly CategoryRow[]): IntentVocabulary {
  const resolver = buildCategoryResolver(categories);
  return {
    categories: categories.map((category) => ({
      slug: category.slug,
      terms: resolver.termsFor(category.slug),
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

type SemanticOutcome = {
  status: SemanticArmStatus;
  matches: SemanticMatch[];
  model: string | null;
};

/**
 * The semantic arm, in one function that CANNOT throw.
 *
 * Written to swallow rather than propagate on purpose: this is the whole
 * fallback strategy, and expressing it as "every path returns an outcome"
 * makes it impossible to add a code path that takes search down.
 *
 * The hard filters from the intent are forwarded to the RPC, which applies
 * them inside the vector query. That is what stops similarity from becoming a
 * source of truth. The client repeats the same checks (data/search/merge.ts),
 * so a clause lost on either side is caught by the other.
 */
async function runSemanticArm(
  intent: SearchIntent,
  admin: ReturnType<typeof createClient> | null,
  telemetry: AiCallTelemetry[]
): Promise<SemanticOutcome> {
  const decision = decideSemanticArm(intent);
  if (!decision.run) {
    return { status: 'skipped_factual_query', matches: [], model: null };
  }

  if (!admin || embeddingPlan.kind === 'none') {
    return { status: 'no_provider', matches: [], model: null };
  }

  const model = embeddingPlan.model;
  let vector: number[];

  try {
    // Constructed INSIDE the try: it validates the key and can throw, and this
    // function is documented as one that cannot. It previously sat outside,
    // which would have turned a malformed secret into a 500 rather than a
    // degraded search.
    const provider = createEmbeddingProvider(embeddingPlan);
    if (!provider) {
      return { status: 'no_provider', matches: [], model: null };
    }
    const service = new EmbeddingService(provider, {
      recordTelemetry: (entry) => telemetry.push(entry),
    });
    const embedded = await service.embed(
      { modality: 'text', text: intent.semanticQuery },
      { sourceKind: SEMANTIC_SOURCE_KIND }
    );
    vector = embedded.result.vector;
  } catch (error) {
    // The client still gets `embedding_failed` — the semantic arm is optional
    // and its failure must never surface as an error. The LOG gets the whole
    // picture, because "reason: AiProviderError" could not tell a rejected key
    // from an unreachable network and left an outage undiagnosable.
    //
    // Category, our code, the provider's HTTP status, and a sanitized message.
    // No key, no Authorization header, no vector, no query text.
    const failure = classifyEmbeddingFailure(error);
    console.warn('[ai-search] embedding failed', {
      category: failure.category,
      code: failure.code,
      status: failure.status,
      message: failure.message,
      model,
      dimensions: embeddingPlan.dimensions,
    });
    return { status: 'embedding_failed', matches: [], model };
  }

  try {
    const { data, error } = await admin.rpc('search_shops_semantic', {
      p_embedding: JSON.stringify(vector),
      p_embedding_model: model,
      p_source_kind: SEMANTIC_SOURCE_KIND,
      p_category_slugs: nullIfEmpty(intent.hard.categorySlugs),
      p_country_codes: nullIfEmpty(intent.hard.countryCodes.map((code) => code.toUpperCase())),
      // Widened exactly as the factual arm widens it: a menswear query is well
      // served by a unisex shop, so excluding those would hide good results.
      p_audiences: nullIfEmpty(expandAudiences(intent.hard.audiences)),
      p_price_min: intent.hard.priceMin,
      p_price_max: intent.hard.priceMax,
      p_verified_only: intent.hard.verifiedOnly,
      p_limit: SEMANTIC_CANDIDATE_LIMIT,
      p_min_similarity: SEMANTIC_MIN_SIMILARITY,
    });

    if (error) {
      console.warn('[ai-search] vector query failed', { code: error.code });
      return { status: 'retrieval_failed', matches: [], model };
    }

    const matches = parseSemanticMatches(data);
    return {
      status: matches.length > 0 ? 'ok' : 'no_matches',
      matches,
      model,
    };
  } catch (error) {
    console.warn('[ai-search] vector query threw', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { status: 'retrieval_failed', matches: [], model };
  }
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
    return failure({ code: 'ai_bad_request', message: 'Requête illisible.', retryable: false }, 400);
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
    console.warn('[ai-search] rejected request', { issues: validated.issues });
    return failure({ code: 'ai_bad_request', message: 'Requête invalide.', retryable: false }, 400);
  }

  const authorization = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publishableKey =
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');

  if (!supabaseUrl || !publishableKey) {
    console.error('[ai-search] missing platform environment');
    return failure({ code: 'ai_unavailable', message: 'Service indisponible.', retryable: true }, 503);
  }

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

  // Built only if the secret exists. A missing service_role disables the
  // semantic arm; it never fails the request.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin =
    serviceRoleKey.length > 0
      ? createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  try {
    let categories: CategoryRow[] = [];
    try {
      categories = await loadCategories(supabase);
    } catch (error) {
      console.warn('[ai-search] categories unavailable', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }

    const telemetry: AiCallTelemetry[] = [];

    const deterministic = createDeterministicProvider(toVocabulary(categories));
    const primary = createPrimarySearchProvider(searchProviderPlan, {
      allowedCategorySlugs: categories.map((category) => category.slug),
      categoryTaxonomy: categories.map((category) => ({
        slug: category.slug,
        name: category.name,
      })),
    });

    const service = new SearchIntelligenceService(primary ?? deterministic, {
      ...(primary ? { fallback: deterministic } : {}),
      context: { recordTelemetry: (entry) => telemetry.push(entry) },
    });

    const { intent, degraded } = await service.parse(validated.value);

    // Sequential rather than parallel: the vector query needs the intent's
    // hard filters, and embedding needs its semanticQuery. Neither exists
    // before parsing, so there is nothing to overlap.
    const semantic = await runSemanticArm(intent, admin, telemetry);

    const row = toSearchRow(intent, {
      userId: user.id,
      categoryIds: resolveCategoryIds(intent.hard.categorySlugs, categories),
      resultsCount: null,
    });

    const { data: recordedSearch, error: insertError } = await supabase
      .from('searches')
      .insert(row)
      .select('id')
      .maybeSingle();
    if (insertError) {
      console.warn('[ai-search] search not recorded', { code: insertError.code });
    }
    const searchId = typeof recordedSearch?.id === 'string' ? recordedSearch.id : null;

    console.info('[ai-search] ok', {
      latencyMs: Date.now() - startedAt,
      source: intent.source,
      degraded,
      categoriesAvailable: categories.length,
      categorySlugs: intent.hard.categorySlugs,
      countryCodes: intent.hard.countryCodes,
      audiences: intent.hard.audiences,
      verifiedOnly: intent.hard.verifiedOnly,
      semanticStatus: semantic.status,
      semanticMatches: semantic.matches.length,
      calls: telemetry.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        operation: entry.operation,
        outcome: entry.outcome,
        latencyMs: entry.latencyMs,
        inputTokens: entry.inputTokens,
      })),
    });

    const body: SearchResponse = {
      intent,
      degraded,
      searchId,
      semanticMatches: semantic.matches,
      semantic: {
        status: semantic.status,
        model: semantic.model,
        matchCount: semantic.matches.length,
      },
    };
    return json({ ok: true, data: body }, 200);
  } catch (error) {
    console.error('[ai-search] failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return failure(toAiErrorPayload(error), 500);
  }
});
