/**
 * The error vocabulary shared between server and client.
 *
 * The client never receives a provider's raw error: it receives one of these
 * codes plus a safe message. Provider details stay server-side, where they
 * can be logged without reaching a user or a bundle.
 */

export const AI_ERROR_CODES = [
  /** The provider answered, but the output failed schema validation. */
  'ai_validation_failed',
  /** The provider returned an error we did not classify further. */
  'ai_provider_error',
  /** Provider quota or rate limit. Retryable after a delay. */
  'ai_rate_limited',
  /** We gave up waiting. Retryable. */
  'ai_timeout',
  /** No provider is configured or reachable. Callers should degrade. */
  'ai_unavailable',
  /** The request itself was malformed before any provider was called. */
  'ai_bad_request',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** Wire shape returned by every /ai/* endpoint on failure. */
export type AiErrorPayload = {
  code: AiErrorCode;
  /** Safe to show a user. Never contains provider or key material. */
  message: string;
  /** Whether trying again could plausibly succeed. */
  retryable: boolean;
};

/**
 * Which failures are worth retrying. Kept as data so both the server and a
 * future client-side backoff agree, without duplicating the rule.
 */
export const RETRYABLE_AI_ERROR_CODES: readonly AiErrorCode[] = [
  'ai_rate_limited',
  'ai_timeout',
  'ai_provider_error',
];

export function isRetryableAiErrorCode(code: AiErrorCode): boolean {
  return RETRYABLE_AI_ERROR_CODES.includes(code);
}
