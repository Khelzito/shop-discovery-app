import type { AiErrorCode, AiErrorPayload } from '../contracts/errors.ts';
import { isRetryableAiErrorCode } from '../contracts/errors.ts';

/**
 * Server-side AI errors.
 *
 * A provider's own error object never travels further than this file. It is
 * classified into one of our codes, and only a safe message crosses the
 * boundary — provider errors routinely embed request ids, model names, quota
 * details and occasionally echoed input, none of which belongs in a mobile
 * client.
 *
 * `cause` keeps the original for server logs.
 */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  /** Which provider failed. Logged, never returned to a client. */
  readonly provider: string | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    options?: { provider?: string; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = isRetryableAiErrorCode(code);
    this.provider = options?.provider;
  }

  /** The only representation that may leave the server. */
  toPayload(): AiErrorPayload {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** The provider answered, but the output did not match the contract. */
export class AiValidationError extends AiError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[], options?: { provider?: string }) {
    super('ai_validation_failed', message, options);
    this.issues = issues;
  }
}

export class AiProviderError extends AiError {
  constructor(message: string, options?: { provider?: string; cause?: unknown }) {
    super('ai_provider_error', message, options);
  }
}

export class AiRateLimitError extends AiError {
  /** Seconds to wait, when the provider says. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options?: { provider?: string; cause?: unknown; retryAfterSeconds?: number }
  ) {
    super('ai_rate_limited', message, options);
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class AiTimeoutError extends AiError {
  constructor(message: string, options?: { provider?: string; cause?: unknown }) {
    super('ai_timeout', message, options);
  }
}

export class AiUnavailableError extends AiError {
  constructor(message: string, options?: { provider?: string; cause?: unknown }) {
    super('ai_unavailable', message, options);
  }
}

export class AiBadRequestError extends AiError {
  constructor(message: string) {
    super('ai_bad_request', message);
  }
}

/**
 * Turns anything thrown into a payload safe to send to the app.
 * Unknown failures become a generic message so an internal error string can
 * never be rendered in the UI.
 */
export function toAiErrorPayload(error: unknown): AiErrorPayload {
  if (error instanceof AiError) {
    return error.toPayload();
  }
  return {
    code: 'ai_provider_error',
    message: 'Le service est momentanement indisponible.',
    retryable: true,
  };
}
