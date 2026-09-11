import type { ShopAnalysisEndpointData } from '../../ai/contracts/shop-analysis-endpoint';
import type { AnalysisWarning, ShopAnalysisV2 } from '../../ai/contracts/shop-analysis-v2';

/**
 * Turns whatever ai-shop-analysis answered into something a screen can show.
 *
 * Pure: it receives the HTTP status, the parsed body and the Retry-After
 * header, so every case is tested without a network. The body crossed a
 * network boundary and is narrowed, never trusted. No server message, code or
 * internal detail is ever passed through to the user: every message below is
 * written here.
 */

export type RawAnalysisResponse = {
  /** Null when the request never got an HTTP answer. */
  status: number | null;
  body: unknown;
  retryAfter: string | null;
};

export type AnalysisBlockReason = 'robots_disallowed' | 'fetch_blocked' | 'timeout' | 'unreadable';

export type MerchantAnalysisErrorCode =
  | 'session_expired'
  | 'invalid_url'
  | 'submission_not_found'
  | 'submission_locked'
  | 'rate_limited'
  | 'analysis_running'
  | 'unavailable'
  | 'network'
  | 'unknown';

export type MerchantAnalysisResult =
  | {
      kind: 'analyzed';
      submissionId: string;
      analysisId: string | null;
      proposalSaved: boolean;
      degraded: boolean;
      warnings: AnalysisWarning[];
      /** Kept in memory only, as a fallback when the proposal was not saved. */
      analysis: ShopAnalysisV2 | null;
    }
  | { kind: 'blocked'; submissionId: string; reason: AnalysisBlockReason; message: string }
  | { kind: 'shop_exists'; shopId: string }
  | {
      kind: 'error';
      code: MerchantAnalysisErrorCode;
      message: string;
      retryable: boolean;
      retryAfterSeconds: number | null;
    };

export const ANALYSIS_MESSAGES = {
  session_expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  invalid_url: 'Cette adresse ne peut pas être analysée. Vérifiez-la et réessayez.',
  https_only: 'Seules les adresses https:// peuvent être analysées.',
  submission_not_found: 'Cette demande est introuvable.',
  submission_locked: 'Cette demande a déjà été envoyée et ne peut plus être modifiée.',
  rate_limited: 'Vous avez atteint la limite temporaire d’analyses. Réessayez plus tard.',
  analysis_running: 'Une analyse est déjà en cours. Patientez quelques instants.',
  unavailable: 'L’analyse est momentanément indisponible. Réessayez dans quelques instants.',
  network: 'Connexion impossible. Vérifiez votre connexion internet.',
  unknown: 'Une erreur est survenue. Réessayez dans un instant.',
  robots_disallowed:
    'Ce site ne permet pas son analyse automatique. Vous pourrez saisir les informations manuellement.',
  fetch_blocked:
    'Nous n’avons pas pu lire ce site. Vous pourrez saisir les informations manuellement.',
  timeout:
    'Le site a mis trop de temps à répondre. Vous pourrez saisir les informations manuellement.',
  unreadable:
    'Le contenu de ce site n’a pas pu être lu. Vous pourrez saisir les informations manuellement.',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one server sentence the app distinguishes on. It is ours, set in
// ai/server/shop-analysis-handler.ts, and both 429s stay retryable either way.
const ALREADY_RUNNING_MESSAGE = 'Une analyse est déjà en cours.';

export function interpretShopAnalysisResponse(response: RawAnalysisResponse): MerchantAnalysisResult {
  const { status, body } = response;

  if (status === null) {
    return error('network', true);
  }

  if (status === 200) {
    return interpretSuccess(body);
  }

  switch (status) {
    case 401:
    case 403:
      return error('session_expired', false);
    case 400: {
      const message = errorMessageOf(body);
      return {
        kind: 'error',
        code: 'invalid_url',
        message: message !== null && message.includes('https://') ? ANALYSIS_MESSAGES.https_only : ANALYSIS_MESSAGES.invalid_url,
        retryable: false,
        retryAfterSeconds: null,
      };
    }
    case 404:
      return error('submission_not_found', false);
    case 409:
      return error('submission_locked', false);
    case 429: {
      const retryAfterSeconds = parseRetryAfter(response.retryAfter);
      const running = errorMessageOf(body) === ALREADY_RUNNING_MESSAGE;
      return { ...error(running ? 'analysis_running' : 'rate_limited', true), retryAfterSeconds };
    }
    default:
      return status >= 500 ? error('unavailable', true) : error('unknown', true);
  }
}

function interpretSuccess(body: unknown): MerchantAnalysisResult {
  const envelope = asRecord(body);
  if (envelope?.ok !== true) {
    return error('unknown', true);
  }
  const data = asRecord(envelope.data) as Partial<Record<keyof ShopAnalysisEndpointData, unknown>> & Record<string, unknown> | null;
  if (!data) {
    return error('unknown', true);
  }

  if (data.outcome === 'shop_exists') {
    return isUuid(data.existingShopId) ? { kind: 'shop_exists', shopId: data.existingShopId } : error('unknown', true);
  }

  if (!isUuid(data.submissionId)) {
    return error('unknown', true);
  }
  const analysis = readAnalysis(data.analysis);
  const warnings = analysis?.warnings ?? [];

  if (data.outcome === 'blocked') {
    const reason = blockReasonOf(warnings);
    return { kind: 'blocked', submissionId: data.submissionId, reason, message: ANALYSIS_MESSAGES[reason] };
  }

  if (data.outcome === 'analyzed') {
    return {
      kind: 'analyzed',
      submissionId: data.submissionId,
      analysisId: isUuid(data.analysisId) ? data.analysisId : null,
      proposalSaved: data.proposalSaved === true,
      degraded: analysis?.degraded ?? true,
      warnings,
      analysis,
    };
  }

  return error('unknown', true);
}

function blockReasonOf(warnings: readonly AnalysisWarning[]): AnalysisBlockReason {
  if (warnings.includes('robots_disallowed')) return 'robots_disallowed';
  if (warnings.includes('timeout')) return 'timeout';
  if (warnings.includes('fetch_blocked')) return 'fetch_blocked';
  return 'unreadable';
}

/** Minimal narrowing: the contract version and the two halves must be there. */
function readAnalysis(value: unknown): ShopAnalysisV2 | null {
  const analysis = asRecord(value);
  if (
    !analysis ||
    analysis.contractVersion !== 'shop-analysis/2' ||
    !asRecord(analysis.observed) ||
    !asRecord(analysis.inferred) ||
    !Array.isArray(analysis.warnings)
  ) {
    return null;
  }
  return analysis as unknown as ShopAnalysisV2;
}

function error(code: MerchantAnalysisErrorCode, retryable: boolean): MerchantAnalysisResult & { kind: 'error' } {
  return { kind: 'error', code, message: ANALYSIS_MESSAGES[code], retryable, retryAfterSeconds: null };
}

function errorMessageOf(body: unknown): string | null {
  const message = asRecord(asRecord(body)?.error)?.message;
  return typeof message === 'string' ? message : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,6}$/.test(value.trim())) {
    return null;
  }
  return Number(value.trim());
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** "Réessayez dans 12 min." for a rate limit, when the server said. */
export function retryHint(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) {
    return null;
  }
  if (seconds < 90) {
    return 'Réessayez dans une minute.';
  }
  return `Réessayez dans ${Math.ceil(seconds / 60)} min.`;
}
