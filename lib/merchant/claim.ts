/**
 * Claiming an existing shop — what the app can do with request_shop_claim.
 *
 * The SQL function opens (or rotates) a PENDING claim on a published shop
 * that has no owner, and returns a one-time proof token. It never approves,
 * never verifies and never creates a membership. Checking that the token is
 * really on the merchant's site is not implemented yet (Prompt 17), so the app
 * only shows the token and the pending state — it never pretends to verify.
 */

export type ClaimFailure =
  | 'not_authenticated'
  | 'shop_not_found'
  | 'already_member'
  | 'shop_already_claimed'
  | 'too_many_open_claims'
  | 'unknown';

export const CLAIM_MESSAGES: Record<ClaimFailure, string> = {
  not_authenticated: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  shop_not_found: 'Cette boutique est introuvable.',
  already_member: 'Cette boutique est déjà associée à votre compte.',
  shop_already_claimed: 'Cette boutique est déjà gérée par un autre compte.',
  too_many_open_claims: 'Vous avez trop de demandes en cours. Réessayez plus tard.',
  unknown: 'Une erreur est survenue. Réessayez dans un instant.',
};

const KNOWN_FAILURES: readonly Exclude<ClaimFailure, 'unknown'>[] = [
  'not_authenticated',
  'shop_not_found',
  'already_member',
  'shop_already_claimed',
  'too_many_open_claims',
];

/**
 * The function raises its reason as the exception text (e.g.
 * `shop_already_claimed`), which PostgREST returns as `message`. Anything else
 * is `unknown`: a raw database message is never shown.
 */
export function claimFailureOf(error: { code?: unknown; message?: unknown } | null | undefined): ClaimFailure {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const known = KNOWN_FAILURES.find((failure) => message === failure);
  if (known) {
    return known;
  }
  if (error?.code === '28000') {
    return 'not_authenticated';
  }
  return 'unknown';
}

export type ClaimToken = { claimId: string; token: string; expiresAt: string };

const TOKEN = /^sd-claim-[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrows the RPC result: one row of (claim_id, proof_token, proof_expires_at). */
export function readClaimToken(data: unknown): ClaimToken | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  if (
    typeof record.claim_id !== 'string' ||
    !UUID.test(record.claim_id) ||
    typeof record.proof_token !== 'string' ||
    !TOKEN.test(record.proof_token) ||
    typeof record.proof_expires_at !== 'string' ||
    Number.isNaN(Date.parse(record.proof_expires_at))
  ) {
    return null;
  }
  return { claimId: record.claim_id, token: record.proof_token, expiresAt: record.proof_expires_at };
}

/** The meta tag the merchant adds to their home page. */
export const CLAIM_META_NAME = 'shop-discovery-verification';

export function claimMetaTag(token: string): string | null {
  return TOKEN.test(token) ? `<meta name="${CLAIM_META_NAME}" content="${token}">` : null;
}

const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

/** "18 septembre 2026" — computed, not locale-dependent, so it is testable. */
export function formatClaimDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return null;
  }
  const date = new Date(time);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export type OpenClaim = { id: string; expiresAt: string | null };

/** A pending claim that has not expired yet, from the caller's own claims. */
export function openClaimOf(
  rows: readonly { id?: unknown; status?: unknown; expires_at?: unknown }[],
  now: Date = new Date()
): OpenClaim | null {
  for (const row of rows) {
    if (row.status !== 'pending' || typeof row.id !== 'string') continue;
    const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
    if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) continue;
    return { id: row.id, expiresAt };
  }
  return null;
}
