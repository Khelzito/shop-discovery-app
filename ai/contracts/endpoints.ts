import type { AssistantRequest, AssistantResponse } from './assistant.ts';
import type { CountryCode, LanguageCode } from './common.ts';
import type { AiErrorPayload } from './errors.ts';
import type { HelpAnswer, HelpQuery } from './help.ts';
import type { SearchIntent } from './search-intent.ts';
import type { ShopAnalysisRecord } from './shop-analysis.ts';

/**
 * Wire contracts for the trusted backend.
 *
 * Only three operations are ever callable by the Expo app. Embedding and
 * reranking are intentionally absent: they are internal steps of a server
 * pipeline, they are expensive, and exposing them would hand an attacker a
 * free embedding endpoint paid for with our provider quota.
 *
 * Nothing here is deployed yet. These types exist so the app and the future
 * Edge Functions are written against the same shape.
 *
 * Before any of these is deployed against a real provider or a real network
 * fetch, read ai/SECURITY.md. It lists the authentication, rate limiting,
 * URL validation, SSRF protection, redirect re-validation, response limits
 * and cost controls that are release blockers rather than improvements —
 * /ai/shop-analysis in particular makes the server fetch a user-supplied URL,
 * which is server-side request forgery unless every one of them is in place.
 */

export const AI_ENDPOINTS = {
  searchIntent: '/ai/search-intent',
  shopAnalysis: '/ai/shop-analysis',
  help: '/ai/help',
  search: '/ai/search',
  assistant: '/ai/assistant',
} as const;

/** POST /ai/search-intent */
export type SearchIntentRequest = {
  query: string;
  locale?: LanguageCode;
  /** Where the user wants delivery, when the app already knows it. */
  shippingCountryCode?: CountryCode;
};

export type SearchIntentResponse = {
  intent: SearchIntent;
  /**
   * True when the query was parsed without a model. The app shows no
   * difference; this is for observability.
   */
  degraded: boolean;
  /** Analytics row written for this query; null if recording failed. */
  searchId: string | null;
};

/**
 * POST /ai/search — Search V2.
 *
 * A superset of /ai/search-intent: same request, and the response still
 * carries `intent` and `degraded` so the factual path is unchanged. What it
 * adds is the semantic arm's candidates.
 *
 * /ai/search-intent is NOT replaced. It stays deployed and untouched so an
 * installed app keeps working, and so a failure confined to embedding or
 * pgvector can be answered by falling back to it.
 */
export type SearchRequest = SearchIntentRequest;

/**
 * One semantically-close shop.
 *
 * An id and a number, deliberately. Vectors never cross this boundary: the
 * app re-reads these shops through its own RLS-governed query, so the server
 * cannot surface a shop the caller could not already see.
 */
export type SemanticMatch = {
  shopId: string;
  /** Cosine similarity in [0, 1]. */
  similarity: number;
};

/**
 * Why the semantic arm produced what it produced.
 *
 * Every value other than `ok` means the search still answered, from the
 * factual arm alone. None of them is an error the user should ever see.
 */
export const SEMANTIC_ARM_STATUSES = [
  /** Ran and returned candidates. */
  'ok',
  /** Ran and matched nothing above the threshold. */
  'no_matches',
  /** Not worth an embedding call: the query is fully expressed by its filters. */
  'skipped_factual_query',
  /** No embedding provider is configured on the server. */
  'no_provider',
  /** The provider failed, timed out or returned something unusable. */
  'embedding_failed',
  /** The vector query itself failed. */
  'retrieval_failed',
] as const;
export type SemanticArmStatus = (typeof SEMANTIC_ARM_STATUSES)[number];

export type SearchResponse = {
  intent: SearchIntent;
  /** True when the intent came from the deterministic tier. */
  degraded: boolean;
  /** Analytics row written for this query; null if recording failed. */
  searchId: string | null;
  /** Empty whenever `semantic.status` is not `ok`. */
  semanticMatches: SemanticMatch[];
  /**
   * Minimal diagnostics. Carries no vector, no secret, no SQL and no internal
   * error text — only what is needed to answer "did the semantic arm run, and
   * against which model".
   */
  semantic: {
    status: SemanticArmStatus;
    /** The embedding model, so a stale-vector mismatch is diagnosable. */
    model: string | null;
    matchCount: number;
  };
};

/**
 * POST /ai/shop-analysis
 *
 * Server-side only in effect: the server fetches and extracts the site. The
 * app supplies a URL and never any page content, so it cannot be used to
 * launder arbitrary text through our provider.
 */
export type ShopAnalysisRequest = {
  websiteUrl: string;
  /** Set when re-analysing an existing submission. */
  submissionId?: string;
};

export type ShopAnalysisResponse = {
  record: ShopAnalysisRecord;
  /** The row id written to `shop_ai_analyses`. */
  analysisId: string;
};

/** POST /ai/assistant */
export type AssistantEndpointRequest = AssistantRequest;
export type AssistantEndpointResponse = AssistantResponse;

/** POST /ai/help */
export type HelpRequest = HelpQuery;
export type HelpResponse = { answer: HelpAnswer };

/** Every endpoint returns either its payload or this. */
export type AiEndpointResponse<T> = { ok: true; data: T } | { ok: false; error: AiErrorPayload };
