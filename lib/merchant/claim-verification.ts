import { CLAIM_VERIFICATION_OUTCOMES } from '../../ai/contracts/merchant-trust';
import type { ClaimVerificationOutcome } from '../../ai/contracts/merchant-trust';

/**
 * The answer to "vérifier ma boutique", for the claim screen.
 *
 * The app never decides that a claim is proven: it asks verify-shop-claim,
 * and the database answers. This module only turns the HTTP answer into a
 * result and a short sentence. No host, address, token or network detail is
 * ever shown — the server does not send any.
 */

export type ClaimCheckFailure =
  | Exclude<ClaimVerificationOutcome, 'verified'>
  | 'session_expired'
  | 'unavailable'
  | 'network'
  | 'unknown';

export type ClaimCheckResult =
  | { kind: 'verified'; shopId: string }
  | { kind: 'failed'; reason: ClaimCheckFailure; message: string; retryAfterSeconds: number | null };

export const CLAIM_CHECK_MESSAGES: Record<ClaimCheckFailure, string> = {
  token_absent: 'Nous n’avons pas trouvé la balise sur votre page d’accueil. Vérifiez qu’elle est bien publiée, puis réessayez.',
  token_mismatch: 'La balise trouvée ne correspond pas à cette demande. Utilisez la dernière balise générée.',
  claim_expired: 'Cette balise a expiré. Générez-en une nouvelle.',
  claim_not_found: 'Cette demande est introuvable. Générez une nouvelle balise.',
  claim_closed: 'Cette demande n’est plus active. Générez une nouvelle balise.',
  already_member: 'Cette boutique est déjà associée à votre compte.',
  shop_already_claimed: 'Cette boutique est déjà gérée par un autre compte.',
  shop_unavailable: 'Cette boutique n’est plus disponible.',
  domain_mismatch: 'La page vérifiée n’appartient pas au domaine de la boutique.',
  redirect_off_domain: 'Votre page d’accueil redirige vers un autre domaine. La balise doit être sur le domaine de la boutique.',
  robots_disallowed: 'Votre fichier robots.txt bloque notre vérification. Autorisez ShopDiscoveryBot sur la page d’accueil.',
  site_unreachable: 'Votre site est injoignable pour le moment. Réessayez plus tard.',
  timeout: 'Votre site a mis trop de temps à répondre. Réessayez.',
  tls_failed: 'La connexion sécurisée à votre site a échoué. Vérifiez son certificat HTTPS.',
  too_large: 'Votre page d’accueil est trop volumineuse pour être vérifiée.',
  not_html: 'Votre page d’accueil n’est pas une page web lisible.',
  rate_limited: 'Trop de vérifications récentes. Réessayez plus tard.',
  already_running: 'Une vérification est déjà en cours.',
  session_expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  unavailable: 'La vérification est indisponible pour le moment. Réessayez plus tard.',
  network: 'Connexion impossible. Vérifiez votre réseau et réessayez.',
  unknown: 'Une erreur est survenue. Réessayez dans un instant.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function interpretClaimVerificationResponse(input: {
  status: number | null;
  body: unknown;
  retryAfter: string | null;
}): ClaimCheckResult {
  const body = asRecord(input.body);

  if (input.status === null) {
    return fail('network');
  }

  if (input.status === 200) {
    const data = asRecord(body?.data);
    const outcome = data?.outcome;
    if (body?.ok !== true || !(CLAIM_VERIFICATION_OUTCOMES as readonly unknown[]).includes(outcome)) {
      return fail('unknown');
    }
    if (outcome === 'verified') {
      return typeof data?.shopId === 'string' && UUID.test(data.shopId)
        ? { kind: 'verified', shopId: data.shopId }
        : fail('unknown');
    }
    return fail(outcome as Exclude<ClaimVerificationOutcome, 'verified'>);
  }

  if (input.status === 401) {
    return fail('session_expired');
  }
  if (input.status === 429) {
    const reason = body?.outcome === 'already_running' ? 'already_running' : 'rate_limited';
    return fail(reason, retrySeconds(input.retryAfter, body?.retryAfterSeconds));
  }
  if (input.status >= 500) {
    return fail('unavailable');
  }
  return fail('unknown');
}

function fail(reason: ClaimCheckFailure, retryAfterSeconds: number | null = null): ClaimCheckResult {
  return { kind: 'failed', reason, message: CLAIM_CHECK_MESSAGES[reason], retryAfterSeconds };
}

function retrySeconds(header: string | null, fromBody: unknown): number | null {
  const candidates = [header === null ? Number.NaN : Number(header), typeof fromBody === 'number' ? fromBody : Number.NaN];
  const value = candidates.find((candidate) => Number.isInteger(candidate) && candidate > 0);
  return value === undefined ? null : Math.min(value, 86_400);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
