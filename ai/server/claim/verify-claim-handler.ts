import type { AiErrorCode } from '../../contracts/errors.ts';
import { isRetryableAiErrorCode } from '../../contracts/errors.ts';
import type { ClaimVerificationOutcome, ClaimVerificationResult } from '../../contracts/merchant-trust.ts';
import type { HandlerLog, HandlerRequest, HandlerResponse } from '../shop-analysis-handler.ts';
import { claimTargetFor } from './claim-domain.ts';
import type { ClaimTarget } from './claim-domain.ts';
import type { ClaimSiteCheck } from './claim-site-check.ts';
import type { BeginClaimVerification, ClaimVerificationStore, FinishClaimVerification } from './claim-verification-store.ts';

/**
 * POST /verify-shop-claim, without Deno.
 *
 *   auth (JWT) → { claimId } → begin (ownership, expiry, owner, limits)
 *   → home page of the shop's exact host, through safe-fetch
 *   → candidate tokens → finish (hash comparison, atomic approval) → outcome
 *
 * The user id comes from the verified token only; the body carries a claim id
 * and nothing else. The client never says "verified": it asks, and the
 * database answers. Responses carry an outcome, never a host, an address, a
 * redirect chain, a token or a hash. Logs carry codes and counts only.
 */

export const MAX_CLAIM_REQUEST_BYTES = 1024;

export type VerifyClaimHandlerDeps = {
  authenticate(authorization: string): Promise<{ id: string } | null>;
  /** Null when the server is missing its service configuration. */
  store: ClaimVerificationStore | null;
  checkSite(input: { target: ClaimTarget; signal?: AbortSignal }): Promise<ClaimSiteCheck>;
  log?: HandlerLog;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleVerifyClaimRequest(
  request: HandlerRequest,
  deps: VerifyClaimHandlerDeps
): Promise<HandlerResponse> {
  const startedAt = Date.now();
  const log: HandlerLog = deps.log ?? (() => undefined);

  if (request.method !== 'POST') {
    return failure(405, 'ai_bad_request', 'Méthode non autorisée.');
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return failure(415, 'ai_bad_request', 'Content-Type application/json attendu.');
  }
  if (new TextEncoder().encode(request.body).length > MAX_CLAIM_REQUEST_BYTES) {
    return failure(413, 'ai_bad_request', 'Requête trop volumineuse.');
  }

  let user: { id: string } | null = null;
  try {
    const authorization = request.headers.get('authorization');
    user = authorization ? await deps.authenticate(authorization) : null;
  } catch {
    user = null;
  }
  if (!user || !UUID.test(user.id)) {
    return failure(401, 'ai_bad_request', 'Authentification requise.');
  }

  const claimId = parseClaimPayload(request.body);
  if (claimId === null) {
    return failure(400, 'ai_bad_request', 'Requête invalide.');
  }

  if (!deps.store) {
    log('error', 'store unavailable', {});
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }
  const store = deps.store;
  const userId = user.id;

  let begin: BeginClaimVerification;
  try {
    begin = await store.begin({ userId, claimId });
  } catch (error) {
    log('error', 'begin failed', diagnosticsOf(error));
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }

  switch (begin.outcome) {
    case 'ready':
      break;
    case 'rate_limited':
    case 'already_running':
      log('info', begin.outcome, { retryAfterSeconds: begin.retryAfterSeconds });
      return {
        status: 429,
        headers: { 'Retry-After': String(begin.retryAfterSeconds) },
        body: {
          ok: false,
          error: {
            code: 'ai_rate_limited',
            message:
              begin.outcome === 'already_running'
                ? 'Une vérification est déjà en cours.'
                : 'Trop de vérifications récentes. Réessayez plus tard.',
            retryable: true,
          },
          outcome: begin.outcome,
          retryAfterSeconds: begin.retryAfterSeconds,
        },
      };
    default:
      log('info', 'refused before check', { outcome: begin.outcome });
      return result(begin.outcome, null);
  }

  const { attemptId } = begin;
  const recordFailure = async (code: string) => {
    try {
      await store.finish({ attemptId, userId, failure: code });
    } catch (error) {
      log('error', 'failure not recorded', diagnosticsOf(error));
    }
  };

  const target = claimTargetFor(begin.websiteUrl);
  if (target === null) {
    await recordFailure('shop_url_rejected');
    log('info', 'shop url rejected', {});
    return result('site_unreachable', null);
  }

  let check: ClaimSiteCheck;
  try {
    check = await deps.checkSite({ target, ...(request.signal ? { signal: request.signal } : {}) });
  } catch (error) {
    await recordFailure('internal_error');
    log('error', 'check crashed', diagnosticsOf(error));
    return failure(503, 'ai_unavailable', 'La vérification a échoué. Réessayez plus tard.');
  }

  if (check.kind === 'failed') {
    await recordFailure(check.code);
    log('info', 'site not read', { outcome: check.outcome, code: check.code, latencyMs: Date.now() - startedAt });
    return result(check.outcome, null);
  }

  let finish: FinishClaimVerification;
  try {
    finish = await store.finish({ attemptId, userId, finalHost: check.finalHost, candidates: check.tokens });
  } catch (error) {
    log('error', 'finish failed', diagnosticsOf(error));
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }

  log('info', 'checked', {
    outcome: finish.outcome,
    metaTags: check.metaTags,
    candidates: check.tokens.length,
    latencyMs: Date.now() - startedAt,
  });

  if (finish.outcome === 'recorded') {
    // Only a failure is ever "recorded"; a read page must get a decision.
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }
  return result(finish.outcome, finish.outcome === 'verified' ? finish.shopId : null);
}

/** Exactly `{ "claimId": "<uuid>" }`. A user id, a status or a flag is refused. */
export function parseClaimPayload(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'claimId') {
    return null;
  }
  const claimId = (parsed as { claimId: unknown }).claimId;
  return typeof claimId === 'string' && UUID.test(claimId) ? claimId.toLowerCase() : null;
}

function result(outcome: ClaimVerificationOutcome, shopId: string | null): HandlerResponse {
  const data: ClaimVerificationResult = { outcome, shopId, retryAfterSeconds: null };
  return { status: 200, headers: {}, body: { ok: true, data } };
}

function failure(status: number, code: AiErrorCode, message: string): HandlerResponse {
  return {
    status,
    headers: {},
    body: { ok: false, error: { code, message, retryable: isRetryableAiErrorCode(code) } },
  };
}

/** Error class and SQLSTATE only — never a message, which can quote a value. */
function diagnosticsOf(error: unknown): Record<string, string> {
  const fields: Record<string, string> = { reason: error instanceof Error ? error.name : 'unknown' };
  if (typeof error === 'object' && error !== null) {
    const sqlState = (error as Record<string, unknown>).sqlState;
    if (typeof sqlState === 'string' && /^[A-Za-z0-9]{5}$/.test(sqlState)) {
      fields.sqlState = sqlState;
    }
  }
  return fields;
}
