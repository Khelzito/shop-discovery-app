/**
 * Provider and model provenance, plus the observability envelope.
 *
 * Nothing here names a vendor. `provider` and `model` are free-form strings
 * precisely so that swapping OpenAI for Anthropic, or one embedding family
 * for another, is a configuration change rather than a type change.
 */

/** The AI operations this system will perform. */
export const AI_OPERATIONS = [
  'search_intent',
  'shop_analysis',
  'embedding',
  'rerank',
  'help_answer',
] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

/**
 * Which model produced a result.
 *
 * Maps onto `shop_ai_analyses`: provider -> model_provider, model ->
 * model_name, contractVersion -> analysis_version.
 */
export type ModelMetadata = {
  /** e.g. the vendor or gateway identifier. Never hardcoded in domain logic. */
  provider: string;
  /** The model identifier as the provider names it. */
  model: string;
  /** Provider-side model revision, when one is exposed. */
  modelVersion: string | null;
  /**
   * Version of *our* contract, not the vendor's. Bumped when the shape or
   * meaning of the structured output changes, so old rows stay interpretable.
   */
  contractVersion: string;
};

export type AiOutcome =
  | 'success'
  | 'validation_failed'
  | 'provider_error'
  | 'timeout'
  | 'rate_limited'
  | 'unavailable';

/**
 * What is worth recording about a call.
 *
 * Deliberately carries no query text, no prompt, no completion and no user
 * identifier. Search analytics already has its own controlled home in the
 * `searches` table; this exists to answer "is the provider healthy and what
 * does it cost", nothing more.
 */
export type AiCallTelemetry = {
  operation: AiOperation;
  provider: string;
  model: string;
  latencyMs: number;
  outcome: AiOutcome;
  /** Only when the provider reports them. */
  inputTokens?: number;
  outputTokens?: number;
  /** Computed by us from a price table, never taken from the provider. */
  estimatedCostUsd?: number;
};

/** Every provider call returns its payload alongside its provenance. */
export type AiResult<T> = {
  data: T;
  model: ModelMetadata;
  telemetry: AiCallTelemetry;
};
