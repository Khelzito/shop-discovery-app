import type { CountryCode, LanguageCode } from './common';
import type { AiErrorPayload } from './errors';
import type { HelpAnswer, HelpQuery } from './help';
import type { SearchIntent } from './search-intent';
import type { ShopAnalysisRecord } from './shop-analysis';

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

/** POST /ai/help */
export type HelpRequest = HelpQuery;
export type HelpResponse = { answer: HelpAnswer };

/** Every endpoint returns either its payload or this. */
export type AiEndpointResponse<T> = { ok: true; data: T } | { ok: false; error: AiErrorPayload };
