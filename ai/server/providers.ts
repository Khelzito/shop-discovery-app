import type { EmbeddingBatchResult, EmbeddingInput, EmbeddingResult } from '../contracts/embedding.ts';
import type { SearchIntentRequest } from '../contracts/endpoints.ts';
import type { HelpAnswer, HelpContext } from '../contracts/help.ts';
import type { AiResult } from '../contracts/model.ts';
import type { RerankCandidate, RerankResult } from '../contracts/rerank.ts';
import type { SearchIntent } from '../contracts/search-intent.ts';
import type { ShopAnalysis } from '../contracts/shop-analysis.ts';

/**
 * Provider interfaces.
 *
 * Business logic depends on these and never on a vendor SDK. Swapping one
 * frontier model for another, or an embedding family for another, means
 * writing a new adapter and changing configuration — no service, no contract
 * and no database column changes.
 *
 * Every adapter is expected to be a thin `fetch` wrapper. No provider SDK is
 * installed, and none should be unless one offers something fetch cannot do:
 * SDKs pull large dependency trees, pin their own HTTP stacks, and tend to
 * leak vendor types into call sites, which is precisely what these interfaces
 * exist to prevent.
 */

/** Per-call controls. Enough for timeouts and cancellation, nothing more. */
export type AiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** What every adapter exposes about itself. */
export type AiProvider = {
  /** Stable identifier recorded in telemetry and in the database. */
  readonly id: string;
};

/**
 * Turns a natural-language query into structured intent.
 *
 * Implementations range from a deterministic parser costing nothing to a
 * frontier model. The interface is identical for both, which is what makes a
 * cheap-tier-first strategy possible later without touching callers.
 */
export interface SearchIntentProvider extends AiProvider {
  parseSearchIntent(
    request: SearchIntentRequest,
    options?: AiRequestOptions
  ): Promise<AiResult<SearchIntent>>;
}

/**
 * Reads already-extracted website content and proposes a shop profile.
 *
 * Takes extracted text, not a URL: fetching is a separate server concern with
 * its own robots, timeout and size limits, and keeping it out of the provider
 * means an adapter can never be tricked into fetching something for us.
 */
export interface ShopAnalysisProvider extends AiProvider {
  analyzeShop(
    input: { sourceUrl: string; extractedText: string; imageUrls?: string[] },
    options?: AiRequestOptions
  ): Promise<AiResult<ShopAnalysis>>;
}

/**
 * Produces vectors. The dimension is whatever the model returns and is
 * reported back on every result; nothing in this codebase assumes a size.
 */
export interface EmbeddingProvider extends AiProvider {
  embed(input: EmbeddingInput, options?: AiRequestOptions): Promise<AiResult<EmbeddingResult>>;
  embedBatch(
    inputs: readonly EmbeddingInput[],
    options?: AiRequestOptions
  ): Promise<AiResult<EmbeddingBatchResult>>;
}

/** Reorders candidate shops against the query. */
export interface RerankProvider extends AiProvider {
  rerank(
    input: { query: string; candidates: readonly RerankCandidate[]; topK?: number },
    options?: AiRequestOptions
  ): Promise<AiResult<RerankResult>>;
}

/**
 * Writes an answer from retrieved passages only.
 * Retrieval happens before this: the provider never searches for itself.
 */
export interface HelpAnswerProvider extends AiProvider {
  answer(context: HelpContext, options?: AiRequestOptions): Promise<AiResult<HelpAnswer>>;
}
