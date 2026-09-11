import type { EmbeddingBatchResult, EmbeddingInput, EmbeddingResult } from '../contracts/embedding.ts';
import type { SearchIntentRequest } from '../contracts/endpoints.ts';
import type { HelpAnswer, HelpContext } from '../contracts/help.ts';
import type { AiResult } from '../contracts/model.ts';
import type { RerankCandidate, RerankResult } from '../contracts/rerank.ts';
import type { SearchIntent } from '../contracts/search-intent.ts';
import type { ShopAnalysis } from '../contracts/shop-analysis.ts';
import type { ShopInferred, ShopObserved } from '../contracts/shop-analysis-v2.ts';

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

/** A category or tag the model may choose from: the live vocabulary, never a guess. */
export type TaxonomyEntry = { slug: string; name: string };

/**
 * What a shop-analysis/2 model sees.
 *
 * Observed facts and a bounded, cleaned excerpt — never HTML, never a header,
 * never an address, never a secret or a database row. The page text is DATA
 * from a third party and is presented to the model as such.
 */
export type ShopAnalysisModelInput = {
  target: { domain: string; finalUrl: string };
  observed: ShopObserved;
  title: string | null;
  headings: readonly string[];
  pageText: string;
  categories: readonly TaxonomyEntry[];
  tags: readonly TaxonomyEntry[];
  locale: 'fr';
};

/**
 * shop-analysis/2: proposes the INFERRED half of an analysis.
 *
 * The observed half is extracted deterministically before this is called, and
 * the caller re-validates whatever comes back against the full contract, the
 * live taxonomy, and the trust and origin rules. An adapter can therefore be
 * wrong without that error reaching a merchant.
 */
export interface ShopAnalysisV2Provider extends AiProvider {
  inferShopProfile(
    input: ShopAnalysisModelInput,
    options?: AiRequestOptions
  ): Promise<AiResult<ShopInferred>>;
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
