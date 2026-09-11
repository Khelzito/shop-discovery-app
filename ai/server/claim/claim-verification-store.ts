import type { RpcCaller } from '../shop-analysis-persistence.ts';

/**
 * Persistence for verify-shop-claim, through two SECURITY DEFINER functions
 * (supabase/migrations/20260911180000_trust_moderation.sql) that only
 * service_role may execute:
 *
 *   begin_claim_verification   ownership, expiry, shop state, owner, limits
 *   finish_claim_verification  hash comparison and, on success, the atomic
 *                              approval: claim, owner membership, claimed_at,
 *                              one domain verification
 *
 * This module shapes parameters and reads results; it never builds SQL, and
 * it never sees the token's hash.
 */

export type BeginRefusal =
  | 'claim_not_found'
  | 'claim_expired'
  | 'claim_closed'
  | 'already_member'
  | 'shop_already_claimed'
  | 'shop_unavailable';

export type BeginClaimVerification =
  | { outcome: 'ready'; attemptId: string; websiteUrl: string }
  | { outcome: 'rate_limited' | 'already_running'; retryAfterSeconds: number }
  | { outcome: BeginRefusal };

export type FinishRefusal =
  | 'token_absent'
  | 'token_mismatch'
  | 'claim_expired'
  | 'claim_closed'
  | 'already_member'
  | 'shop_already_claimed'
  | 'shop_unavailable'
  | 'domain_mismatch';

export type FinishClaimVerification =
  | { outcome: 'verified'; shopId: string }
  | { outcome: 'recorded' }
  | { outcome: FinishRefusal };

export type FinishInput =
  | { attemptId: string; userId: string; failure: string }
  | { attemptId: string; userId: string; finalHost: string; candidates: readonly string[] };

export interface ClaimVerificationStore {
  begin(input: { userId: string; claimId: string }): Promise<BeginClaimVerification>;
  finish(input: FinishInput): Promise<FinishClaimVerification>;
}

/** The error carries the SQLSTATE only: a database message can quote a value. */
export class ClaimVerificationStoreError extends Error {
  constructor(operation: string, readonly sqlState: string | null) {
    super(`${operation} failed${sqlState ? ` (${sqlState})` : ''}`);
    this.name = 'ClaimVerificationStoreError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const BEGIN_REFUSALS: readonly BeginRefusal[] = [
  'claim_not_found',
  'claim_expired',
  'claim_closed',
  'already_member',
  'shop_already_claimed',
  'shop_unavailable',
];

const FINISH_REFUSALS: readonly FinishRefusal[] = [
  'token_absent',
  'token_mismatch',
  'claim_expired',
  'claim_closed',
  'already_member',
  'shop_already_claimed',
  'shop_unavailable',
  'domain_mismatch',
];

export function createRpcClaimVerificationStore(rpc: RpcCaller): ClaimVerificationStore {
  return {
    async begin(input) {
      const { data, error } = await rpc('begin_claim_verification', {
        p_user_id: input.userId,
        p_claim_id: input.claimId,
      });
      if (error) throw new ClaimVerificationStoreError('begin_claim_verification', error.code ?? null);
      return parseBeginClaimRow(Array.isArray(data) ? data[0] : data);
    },

    async finish(input) {
      const failure = 'failure' in input ? (FAILURE_CODE.test(input.failure) ? input.failure : 'internal_error') : null;
      const { data, error } = await rpc('finish_claim_verification', {
        p_attempt_id: input.attemptId,
        p_user_id: input.userId,
        p_failure: failure,
        p_final_host: 'finalHost' in input ? input.finalHost : null,
        p_candidates: 'candidates' in input ? [...input.candidates] : null,
      });
      if (error) throw new ClaimVerificationStoreError('finish_claim_verification', error.code ?? null);
      return parseFinishClaimRow(Array.isArray(data) ? data[0] : data);
    },
  };
}

export function parseBeginClaimRow(row: unknown): BeginClaimVerification {
  const record = asRecord(row);
  if (record) {
    const outcome = record.outcome;
    if (outcome === 'ready') {
      const attemptId = typeof record.attempt_id === 'string' && UUID.test(record.attempt_id) ? record.attempt_id : null;
      const websiteUrl =
        typeof record.website_url === 'string' && record.website_url.length > 0 && record.website_url.length <= 2048
          ? record.website_url
          : null;
      if (attemptId && websiteUrl) return { outcome, attemptId, websiteUrl };
    } else if (outcome === 'rate_limited' || outcome === 'already_running') {
      const retry = record.retry_after_seconds;
      const retryAfterSeconds =
        typeof retry === 'number' && Number.isInteger(retry) && retry > 0 ? Math.min(retry, 86_400) : 60;
      return { outcome, retryAfterSeconds };
    } else if ((BEGIN_REFUSALS as readonly unknown[]).includes(outcome)) {
      return { outcome: outcome as BeginRefusal };
    }
  }
  throw new ClaimVerificationStoreError('begin_claim_verification result', null);
}

export function parseFinishClaimRow(row: unknown): FinishClaimVerification {
  const record = asRecord(row);
  if (record) {
    const outcome = record.outcome;
    if (outcome === 'verified') {
      const shopId = typeof record.verified_shop_id === 'string' && UUID.test(record.verified_shop_id) ? record.verified_shop_id : null;
      if (shopId) return { outcome, shopId };
    } else if (outcome === 'recorded') {
      return { outcome };
    } else if ((FINISH_REFUSALS as readonly unknown[]).includes(outcome)) {
      return { outcome: outcome as FinishRefusal };
    }
  }
  throw new ClaimVerificationStoreError('finish_claim_verification result', null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
