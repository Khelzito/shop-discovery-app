import type { SemanticMatch } from '../contracts/endpoints.ts';
import type { SearchIntent } from '../contracts/search-intent.ts';

/**
 * Whether a query is worth an embedding call.
 *
 * Its own tested function rather than an `if` inside the Edge Function,
 * because this is the one place that decides how much every search costs. A
 * rule buried in a handler is a rule nobody measures.
 *
 * THE RULE, and it is deliberately blunt:
 *
 *   Run the semantic arm unless the query is ALREADY fully expressed by its
 *   hard filters.
 *
 * "sneakers françaises" resolves to a category and a country and carries no
 * judgement — the factual arm answers it exactly, and an embedding would cost
 * a call to confirm what SQL already knows. "une marque minimaliste pour
 * homme" carries `minimaliste`, which no column holds, so it needs a vector.
 *
 * Erring toward running is safe and erring toward skipping is not: a skipped
 * arm silently narrows what the user can find, while a needless one costs
 * roughly two hundredths of a cent and cannot change eligibility, since the
 * hard filters gate both arms.
 */

/** Shorter than this and there is nothing left to embed. */
export const MIN_SEMANTIC_QUERY_CHARS = 3;

export type SemanticArmDecision =
  | { run: true }
  | { run: false; reason: 'empty_semantic_query' | 'fully_factual' };

/** True when the intent expressed anything a database column cannot hold. */
export function hasSoftSignals(intent: SearchIntent): boolean {
  const { soft } = intent;
  return (
    soft.styles.length > 0 ||
    soft.productTypes.length > 0 ||
    soft.values.length > 0 ||
    soft.brandPositioning !== null ||
    soft.popularity !== 'any'
  );
}

export function decideSemanticArm(intent: SearchIntent): SemanticArmDecision {
  if (intent.semanticQuery.trim().length < MIN_SEMANTIC_QUERY_CHARS) {
    return { run: false, reason: 'empty_semantic_query' };
  }

  // A named product type is the strongest possible factual signal: the
  // catalogue holds that category, so retrieval is exact. Combined with no
  // judgement anywhere in the query, there is nothing for a vector to add.
  //
  // Note this checks `categorySlugs` specifically, not "any hard filter". A
  // country alone does not make a query factual — "une marque française" still
  // needs a vector to know what KIND of brand is wanted.
  if (!hasSoftSignals(intent) && intent.hard.categorySlugs.length > 0) {
    return { run: false, reason: 'fully_factual' };
  }

  return { run: true };
}

// ---------------------------------------------------------------------------
// Diagnosing a failed embedding
// ---------------------------------------------------------------------------
//
// `embedding_failed` is the right answer to give the CLIENT — the semantic arm
// is optional and its failure must never surface as an error. It was the wrong
// thing to write in the SERVER LOG, which recorded only `error.name` and so
// could not distinguish a rejected key from an unreachable network from a
// response we refused. Three very different faults, one indistinguishable
// line, and no way to act on any of them.

export const EMBEDDING_FAILURE_CATEGORIES = [
  /** No provider configured or no key. */
  'missing_secret',
  /** The provider answered, with a non-2xx. `status` says which. */
  'provider_http_error',
  /** The provider answered 2xx with something we refused to store. */
  'invalid_provider_response',
  /** A specific invalid response: the vector was the wrong width. */
  'dimension_mismatch',
  /** We never got an answer: transport failure, abort or timeout. */
  'network_error',
  'unknown_error',
] as const;
export type EmbeddingFailureCategory = (typeof EMBEDDING_FAILURE_CATEGORIES)[number];

export type EmbeddingFailure = {
  category: EmbeddingFailureCategory;
  /** Our own AiErrorCode, when the failure came from the AI layer. */
  code: string | null;
  /** The provider's HTTP status, when there was one. */
  status: number | null;
  /** Safe to log. Never a key, never a vector, always bounded. */
  message: string;
};

/** Longest text kept from an error. Enough to identify, too short to dump. */
const MAX_LOG_MESSAGE = 200;

/**
 * Anything shaped like a credential is removed before a message is logged.
 *
 * Belt and braces: this adapter never interpolates the key into a message, so
 * nothing should match. That is exactly why the guard is cheap to keep — the
 * day someone adds a message that does interpolate it, the log stays clean.
 */
export function sanitizeLogMessage(message: string): string {
  const cleaned = message
    .replace(/\b(sk-|sk_|sb_secret_|sb_publishable_)[A-Za-z0-9._-]+/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '<redacted>')
    // A bracketed run of numbers is an embedding, never something to read.
    .replace(/\[\s*-?\d[\d\s.,eE+-]{40,}\]/g, '[vector]')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > MAX_LOG_MESSAGE ? `${cleaned.slice(0, MAX_LOG_MESSAGE)}…` : cleaned;
}

/**
 * Turns whatever was thrown into something a log line can act on.
 *
 * Deliberately does not import the AiError classes: this must classify an
 * error that crossed a module boundary, and duck-typing on `code` and `status`
 * keeps it usable from the Edge Function without dragging the error hierarchy
 * into a runtime dependency it does not otherwise need.
 */
export function classifyEmbeddingFailure(error: unknown): EmbeddingFailure {
  if (typeof error !== 'object' || error === null) {
    return { category: 'unknown_error', code: null, status: null, message: 'unknown' };
  }

  const candidate = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    issues?: unknown;
  };
  const code = typeof candidate.code === 'string' ? candidate.code : null;
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  const message = sanitizeLogMessage(
    typeof candidate.message === 'string' ? candidate.message : 'unknown'
  );

  if (code === 'ai_unavailable') {
    return { category: 'missing_secret', code, status, message };
  }

  if (code === 'ai_validation_failed') {
    // A width mismatch is worth its own category: it means the model or the
    // configured dimension moved, and the column will reject the vector too.
    const issues = Array.isArray(candidate.issues) ? candidate.issues : [];
    const dimensional = issues.some(
      (issue) => typeof issue === 'string' && issue.includes('dimensions')
    );
    return {
      category: dimensional ? 'dimension_mismatch' : 'invalid_provider_response',
      code,
      status,
      message,
    };
  }

  if (code === 'ai_timeout') {
    return { category: 'network_error', code, status, message };
  }

  if (code === 'ai_rate_limited') {
    return { category: 'provider_http_error', code, status: status ?? 429, message };
  }

  if (code === 'ai_provider_error') {
    // The presence of a status is the whole distinction: with one, the
    // provider refused us; without one, we never reached it.
    return {
      category: status === null ? 'network_error' : 'provider_http_error',
      code,
      status,
      message,
    };
  }

  if (code === 'ai_bad_request') {
    return { category: 'invalid_provider_response', code, status, message };
  }

  return { category: 'unknown_error', code, status, message };
}

// ---------------------------------------------------------------------------
// The RPC boundary
// ---------------------------------------------------------------------------
//
// Extracted from the Edge Function so it can be tested under Node. The handler
// itself calls Deno.serve at module scope and is therefore unloadable in a
// test runner — which is exactly why the parts that can silently go wrong live
// here instead.

/**
 * Mirrors `expandAudiences` in data/search/intent-filters.ts.
 *
 * Duplicated rather than imported: that module sits on the client side of the
 * boundary and pulls in the client `Shop` model, which must not reach an Edge
 * Function. The two are kept identical by their tests, not by a shared import.
 */
export function expandAudiences(requested: readonly string[]): string[] {
  if (requested.length === 0) {
    return [];
  }
  return [...new Set([...requested, 'unisex', 'all'])];
}

/**
 * PostgREST array arguments: null means "no constraint".
 *
 * An empty array would NOT mean the same thing to a caller reading the SQL,
 * and the guard clauses in the function test `cardinality(...) = 0` as well —
 * belt and braces, because passing `[]` where `null` was meant is the classic
 * way to accidentally match nothing.
 */
export function nullIfEmpty(values: readonly string[]): string[] | null {
  const cleaned = [...new Set(values.filter((value) => value.trim().length > 0))];
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Narrows the RPC result into contract shape.
 *
 * A malformed row is DROPPED, never repaired and never trusted. A similarity
 * that is not a finite number would flow straight into ranking arithmetic and
 * turn one bad row into a scrambled result page.
 */
export function parseSemanticMatches(data: unknown): SemanticMatch[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const matches: SemanticMatch[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as { shop_id?: unknown; similarity?: unknown };
    if (typeof record.shop_id !== 'string' || record.shop_id.length === 0) {
      continue;
    }
    if (typeof record.similarity !== 'number' || !Number.isFinite(record.similarity)) {
      continue;
    }
    matches.push({ shopId: record.shop_id, similarity: record.similarity });
  }
  return matches;
}
