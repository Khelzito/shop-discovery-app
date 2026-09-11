import type { AiErrorCode } from '../contracts/errors.ts';
import { isRetryableAiErrorCode } from '../contracts/errors.ts';
import type { ShopAnalysisEndpointData } from '../contracts/shop-analysis-endpoint.ts';
import { validateShopAnalysisRequestV2 } from './shop-analysis-v2.ts';
import { toCompleteShopAnalysisParams, toFailShopAnalysisParams } from './shop-analysis-persistence.ts';
import type { BeginOutcome, FailShopAnalysisParams, ShopAnalysisStore } from './shop-analysis-persistence.ts';
import type { ShopAnalyzerInput, ShopAnalyzerOutcome, ShopTaxonomy } from './shop-analyzer.ts';
import { evaluateUrl } from './site/url-policy.ts';

/**
 * POST /ai-shop-analysis, without Deno.
 *
 * The Edge Function only adapts Request/Response and wires real dependencies;
 * every decision is made here, where it is tested under Node:
 *
 *   auth (JWT) → payload → https URL → taxonomy → begin (quota, duplicate,
 *   ownership, running row) → analyze (robots, safe-fetch, extraction, model,
 *   validation) → complete or fail → cleaned response
 *
 * The user id comes from the verified token and nowhere else. The response is
 * a validated shop-analysis/2 plus identifiers: no HTML, header, address, DNS
 * answer, stack, certificate detail, provider payload or secret. Logs carry
 * codes, counts and latency — never a URL or a hostname.
 */

export const MAX_REQUEST_BYTES = 4 * 1024;

export type AuthenticatedUser = { id: string };

export type HandlerRequest = {
  method: string;
  headers: { get(name: string): string | null };
  body: string;
  signal?: AbortSignal;
};

export type HandlerResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type HandlerLog = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) => void;

export type ShopAnalysisHandlerDeps = {
  /** Resolves the caller from the Authorization header, or null. */
  authenticate(authorization: string | null): Promise<AuthenticatedUser | null>;
  /** Null when the server is missing its service configuration. */
  store: ShopAnalysisStore | null;
  loadTaxonomy(): Promise<ShopTaxonomy>;
  analyze(input: ShopAnalyzerInput): Promise<ShopAnalyzerOutcome>;
  now?: () => Date;
  log?: HandlerLog;
};

/** Wire data for a success. Defined in ai/contracts so the app reads the same shape. */
export type { ShopAnalysisEndpointData };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleShopAnalysisRequest(
  request: HandlerRequest,
  deps: ShopAnalysisHandlerDeps
): Promise<HandlerResponse> {
  const startedAt = Date.now();
  const log: HandlerLog = deps.log ?? (() => undefined);

  if (request.method !== 'POST') {
    return failure(405, 'ai_bad_request', 'Méthode non autorisée.');
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return failure(415, 'ai_bad_request', 'Content-Type application/json attendu.');
  }
  if (new TextEncoder().encode(request.body).length > MAX_REQUEST_BYTES) {
    return failure(413, 'ai_bad_request', 'Requête trop volumineuse.');
  }

  // 1. Authentication. Nothing below runs for an anonymous caller.
  let user: AuthenticatedUser | null = null;
  try {
    const authorization = request.headers.get('authorization');
    user = authorization ? await deps.authenticate(authorization) : null;
  } catch {
    user = null;
  }
  if (!user || !UUID.test(user.id)) {
    return failure(401, 'ai_bad_request', 'Authentification requise.');
  }

  // 2. Payload. Unknown keys — a user id, a status, a verification flag — are refused.
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return failure(400, 'ai_bad_request', 'JSON invalide.');
  }
  const validated = validateShopAnalysisRequestV2(parsed);
  if (!validated.ok) {
    // Issues name fields and policy reasons, never the submitted URL.
    log('warn', 'rejected request', { issues: validated.issues });
    return failure(400, 'ai_bad_request', 'Requête invalide.');
  }

  // 3. URL: canonical, and HTTPS only in V1.
  const url = evaluateUrl(validated.value.websiteUrl, { allowSchemeless: true });
  if (!url.ok) {
    return failure(400, 'ai_bad_request', 'Requête invalide.');
  }
  if (url.scheme !== 'https') {
    return failure(400, 'ai_bad_request', 'Seules les adresses https:// peuvent être analysées.');
  }

  if (!deps.store) {
    log('error', 'store unavailable', {});
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }

  let taxonomy: ShopTaxonomy;
  try {
    taxonomy = await deps.loadTaxonomy();
  } catch (error) {
    log('error', 'taxonomy unavailable', diagnosticsOf(error));
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }

  // 4. Quota, duplicate, ownership — atomically, before any network access.
  let begin: BeginOutcome;
  try {
    begin = await deps.store.begin({
      userId: user.id,
      submissionId: validated.value.submissionId ?? null,
      sourceUrl: url.url,
      domain: url.hostname,
    });
  } catch (error) {
    log('error', 'begin failed', diagnosticsOf(error));
    return failure(503, 'ai_unavailable', 'Service indisponible.');
  }

  switch (begin.outcome) {
    case 'rate_limited':
    case 'already_running':
      log('info', begin.outcome, { retryAfterSeconds: begin.retryAfterSeconds });
      return failure(
        429,
        'ai_rate_limited',
        begin.outcome === 'already_running'
          ? 'Une analyse est déjà en cours.'
          : "Trop d'analyses récentes. Réessaie plus tard.",
        { 'Retry-After': String(begin.retryAfterSeconds) }
      );
    case 'submission_not_found':
      return failure(404, 'ai_bad_request', 'Soumission introuvable.');
    case 'submission_locked':
      return failure(409, 'ai_bad_request', 'Cette soumission ne peut plus être modifiée.');
    case 'shop_exists':
      log('info', 'shop exists', {});
      return success({ outcome: 'shop_exists', existingShopId: begin.existingShopId });
    case 'started':
      break;
  }

  const { analysisId, submissionId } = begin;
  const userId = user.id;
  const failRow = async (params: FailShopAnalysisParams): Promise<boolean> => {
    try {
      await deps.store!.fail(params);
      return true;
    } catch (error) {
      log('error', 'fail not recorded', { analysisId, ...diagnosticsOf(error) });
      return false;
    }
  };

  // 5. robots.txt → safe-fetch → extraction → model → validation.
  let outcome: ShopAnalyzerOutcome;
  try {
    outcome = await deps.analyze({ url, taxonomy, ...(request.signal ? { signal: request.signal } : {}) });
  } catch (error) {
    log('error', 'analysis crashed', { analysisId, ...diagnosticsOf(error) });
    await failRow(toFailShopAnalysisParams({ analysisId, userId, code: 'internal_error', warnings: [] }));
    return failure(500, 'ai_provider_error', "L'analyse a échoué. Réessaie plus tard.");
  }

  if (outcome.kind === 'blocked') {
    const recorded = await failRow(
      toFailShopAnalysisParams({ analysisId, userId, code: outcome.code, warnings: outcome.analysis.warnings })
    );
    log('info', 'blocked', { analysisId, reason: outcome.reason, code: outcome.code, latencyMs: Date.now() - startedAt });
    return success({
      outcome: 'blocked',
      analysis: outcome.analysis,
      analysisId: recorded ? analysisId : null,
      submissionId,
      proposalSaved: false,
    });
  }

  // 6. Persistence: the analysis row, then the merchant's copy.
  const analyzedAt = (deps.now?.() ?? new Date()).toISOString();
  let persisted = true;
  let proposalSaved = false;
  try {
    proposalSaved = await deps.store.complete(
      toCompleteShopAnalysisParams({
        analysisId,
        userId,
        analysis: outcome.analysis,
        sourceHash: outcome.sourceHash,
        summary: outcome.summary,
        analyzedAt,
      })
    );
  } catch (error) {
    persisted = false;
    log('error', 'persistence failed', { analysisId, ...diagnosticsOf(error) });
    await failRow(toFailShopAnalysisParams({ analysisId, userId, code: 'persistence_failed', warnings: outcome.analysis.warnings }));
  }

  log('info', 'ok', {
    analysisId,
    latencyMs: Date.now() - startedAt,
    degraded: outcome.analysis.degraded,
    warnings: outcome.analysis.warnings,
    modelOutcome: outcome.summary.modelOutcome,
    providerFailure: outcome.summary.providerFailure,
    removedInferredItems: outcome.summary.removedInferredItems,
    droppedInjectionLines: outcome.summary.droppedInjectionLines,
    persisted,
    proposalSaved,
    calls: outcome.telemetry.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      outcome: entry.outcome,
      latencyMs: entry.latencyMs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    })),
  });

  return success({
    outcome: 'analyzed',
    analysis: outcome.analysis,
    analysisId: persisted ? analysisId : null,
    submissionId,
    proposalSaved,
  });
}

function success(data: ShopAnalysisEndpointData): HandlerResponse {
  return { status: 200, headers: {}, body: { ok: true, data } };
}

function failure(
  status: number,
  code: AiErrorCode,
  message: string,
  headers: Record<string, string> = {}
): HandlerResponse {
  return {
    status,
    headers,
    body: { ok: false, error: { code, message, retryable: isRetryableAiErrorCode(code) } },
  };
}

/**
 * What a failure log line may carry: the error class plus short, closed-shape
 * codes — which taxonomy table, a PostgREST or AI code, an HTTP status, a
 * SQLSTATE. Never a message: messages can quote URLs, rows or credentials.
 * Without these fields a 503 is undiagnosable, which is how the first smoke
 * test failed silently.
 */
function diagnosticsOf(error: unknown): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    reason: error instanceof Error ? error.name : 'unknown',
  };
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Record<string, unknown>;
    for (const key of ['table', 'code', 'sqlState'] as const) {
      const value = candidate[key];
      if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(value)) {
        fields[key] = value;
      }
    }
    if (typeof candidate.httpStatus === 'number' && Number.isInteger(candidate.httpStatus)) {
      fields.httpStatus = candidate.httpStatus;
    }
  }
  return fields;
}
