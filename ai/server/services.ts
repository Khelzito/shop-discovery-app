import type { EmbeddingInput, EmbeddingResult, EmbeddingSourceKind } from '../contracts/embedding';
import type { SearchIntentRequest } from '../contracts/endpoints';
import type { HelpAnswer, HelpContext, HelpQuery, HelpSource } from '../contracts/help';
import type { AiOutcome, AiResult } from '../contracts/model';
import type { RerankCandidate, RerankResult } from '../contracts/rerank';
import { emptySearchIntent } from '../contracts/search-intent';
import type { SearchIntent } from '../contracts/search-intent';
import type { ShopAnalysisRecord } from '../contracts/shop-analysis';
import { AiError, AiUnavailableError, AiValidationError } from './errors';
import type {
  EmbeddingProvider,
  HelpAnswerProvider,
  RerankProvider,
  SearchIntentProvider,
  ShopAnalysisProvider,
} from './providers';
import {
  validateHelpAnswer,
  validateRerankResult,
  validateSearchIntent,
  validateShopAnalysis,
} from './validation';

/**
 * Orchestration layer.
 *
 * These services are thin on purpose. They hold no secret, import nothing from
 * React Native, know nothing about UI, and depend only on the provider
 * interfaces — so a vendor change is a constructor argument, not a rewrite.
 *
 * What they do own is the rule that provider output is never trusted: every
 * response is validated before it leaves this layer, and a response that fails
 * validation is an error, not something to patch up into a plausible shape.
 */

/** Anything the services need from the outside world beyond a provider. */
export type ServiceContext = {
  /** Called with per-call telemetry. Never receives query text or user data. */
  recordTelemetry?: (telemetry: AiResult<unknown>['telemetry']) => void;
};

function record<T>(context: ServiceContext | undefined, result: AiResult<T>): AiResult<T> {
  context?.recordTelemetry?.(result.telemetry);
  return result;
}

/** Classifies a failure for telemetry without leaking the provider's message. */
function outcomeOf(error: unknown): AiOutcome {
  if (!(error instanceof AiError)) {
    return 'provider_error';
  }
  switch (error.code) {
    case 'ai_validation_failed':
      return 'validation_failed';
    case 'ai_rate_limited':
      return 'rate_limited';
    case 'ai_timeout':
      return 'timeout';
    case 'ai_unavailable':
      return 'unavailable';
    default:
      return 'provider_error';
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export class SearchIntelligenceService {
  /**
   * @param primary   The tier used first. May be the deterministic parser.
   * @param fallback  Used when `primary` throws. Search must survive an AI
   *                  outage (docs/MASTER_SPEC.md §8), so a failure here
   *                  degrades rather than propagates.
   */
  constructor(
    private readonly primary: SearchIntentProvider,
    private readonly options: { fallback?: SearchIntentProvider; context?: ServiceContext } = {}
  ) {}

  async parse(request: SearchIntentRequest): Promise<{ intent: SearchIntent; degraded: boolean }> {
    try {
      const result = await this.primary.parseSearchIntent(request);
      const validated = validateSearchIntent(result.data);
      if (!validated.ok) {
        throw new AiValidationError(
          'The intent parser returned an unusable structure.',
          validated.issues,
          { provider: this.primary.id }
        );
      }
      record(this.options.context, result);
      return { intent: validated.value, degraded: false };
    } catch (error) {
      // A degraded search is still a search, but it must not be silent:
      // record why the primary tier failed before falling back.
      this.options.context?.recordTelemetry?.({
        operation: 'search_intent',
        provider: this.primary.id,
        model: 'unknown',
        latencyMs: 0,
        outcome: outcomeOf(error),
      });

      const fallback = this.options.fallback;
      if (!fallback) {
        // An empty intent is a valid answer: it means "no constraints", so
        // search still runs, just without structure.
        return { intent: emptySearchIntent(request.query, 'deterministic'), degraded: true };
      }
      const result = await fallback.parseSearchIntent(request);
      const validated = validateSearchIntent(result.data);
      if (!validated.ok) {
        throw new AiValidationError(
          'The fallback intent parser returned an unusable structure.',
          validated.issues,
          { provider: fallback.id }
        );
      }
      record(this.options.context, result);
      return { intent: validated.value, degraded: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Shop intelligence
// ---------------------------------------------------------------------------

export class ShopIntelligenceService {
  constructor(
    private readonly provider: ShopAnalysisProvider,
    private readonly context?: ServiceContext
  ) {}

  /**
   * Produces a proposal. It never publishes, never verifies and never
   * overwrites a declared fact: the caller persists it to `shop_ai_analyses`
   * and a human decides what, if anything, becomes a fact.
   */
  async analyze(input: {
    sourceUrl: string;
    extractedText: string;
    imageUrls?: string[];
    sourceHash?: string | null;
  }): Promise<ShopAnalysisRecord> {
    const result = await this.provider.analyzeShop({
      sourceUrl: input.sourceUrl,
      extractedText: input.extractedText,
      imageUrls: input.imageUrls,
    });

    const validated = validateShopAnalysis(result.data);
    if (!validated.ok) {
      throw new AiValidationError(
        'The shop analysis did not match the expected structure.',
        validated.issues,
        { provider: this.provider.id }
      );
    }

    record(this.context, result);

    return {
      analysis: validated.value,
      model: result.model,
      sourceUrl: input.sourceUrl,
      sourceHash: input.sourceHash ?? null,
      analyzedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export class EmbeddingService {
  constructor(
    private readonly provider: EmbeddingProvider | null,
    private readonly context?: ServiceContext
  ) {}

  /**
   * No dimension is requested or asserted. The result reports what the model
   * produced, and callers persist that alongside the vector.
   */
  async embed(
    input: EmbeddingInput,
    meta: { sourceKind: EmbeddingSourceKind; sourceHash?: string | null }
  ): Promise<{ result: EmbeddingResult; sourceKind: EmbeddingSourceKind }> {
    if (!this.provider) {
      throw new AiUnavailableError('No embedding provider is configured.');
    }
    const result = await this.provider.embed(input);
    record(this.context, result);
    return {
      result: { ...result.data, sourceHash: meta.sourceHash ?? result.data.sourceHash },
      sourceKind: meta.sourceKind,
    };
  }
}

// ---------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------

export class RerankService {
  constructor(
    private readonly provider: RerankProvider | null,
    private readonly context?: ServiceContext
  ) {}

  /**
   * Reranking is an improvement, not a requirement: when no provider is
   * configured or the call fails, the original order is returned so search
   * still answers.
   */
  async rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    topK?: number
  ): Promise<RerankResult | null> {
    if (!this.provider || candidates.length === 0) {
      return null;
    }
    const result = await this.provider.rerank({ query, candidates, topK });
    const validated = validateRerankResult(
      result.data,
      candidates.map((candidate) => candidate.shopId),
      result.model
    );
    if (!validated.ok) {
      throw new AiValidationError('The reranker returned unusable results.', validated.issues, {
        provider: this.provider.id,
      });
    }
    record(this.context, result);
    return validated.value;
  }
}

// ---------------------------------------------------------------------------
// Help assistant
// ---------------------------------------------------------------------------

/** Retrieval is injected: the assistant never searches for itself. */
export type HelpRetriever = (query: HelpQuery) => Promise<HelpSource[]>;

export class HelpAssistantService {
  constructor(
    private readonly retrieve: HelpRetriever,
    private readonly provider: HelpAnswerProvider | null,
    private readonly context?: ServiceContext
  ) {}

  async answer(query: HelpQuery): Promise<HelpAnswer> {
    const sources = await this.retrieve(query);

    // Refusing before calling a model is the cheapest way to guarantee the
    // assistant never invents a Shop Discovery policy.
    if (sources.length === 0 || !this.provider) {
      return {
        answered: false,
        answer: '',
        sources: [],
        confidence: 0,
        refusalReason: 'no_supporting_source',
        model: {
          provider: this.provider?.id ?? 'none',
          model: 'none',
          modelVersion: null,
          contractVersion: 'help/1',
        },
      };
    }

    const context: HelpContext = { query, sources };
    const result = await this.provider.answer(context);
    const validated = validateHelpAnswer(result.data, sources, result.model);
    if (!validated.ok) {
      throw new AiValidationError(
        'The help assistant returned an ungrounded or malformed answer.',
        validated.issues,
        { provider: this.provider.id }
      );
    }
    record(this.context, result);
    return validated.value;
  }
}
