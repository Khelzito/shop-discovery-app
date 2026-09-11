import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ClaimVerificationStoreError,
  createRpcClaimVerificationStore,
  parseBeginClaimRow,
  parseFinishClaimRow,
} from './claim-verification-store.ts';

const USER = '3843ac2a-0000-4000-8000-000000000001';
const CLAIM = '11111111-2222-4333-8444-555555555555';
const ATTEMPT = '99999999-8888-4777-8666-555555555555';
const SHOP = '78d97b85-0000-4000-8000-000000000009';
const TOKEN = `sd-claim-${'ab'.repeat(32)}`;

function recordingRpc(answer: { data: unknown; error: { code?: string } | null }) {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const rpc = async (fn: string, params: Record<string, unknown>) => {
    calls.push({ fn, params });
    return answer;
  };
  return { calls, rpc };
}

describe('claim verification store — parameters', () => {
  it('begins with the verified user and the claim, nothing else', async () => {
    const { calls, rpc } = recordingRpc({ data: [{ outcome: 'ready', attempt_id: ATTEMPT, website_url: 'https://shop.fr/' }], error: null });
    const result = await createRpcClaimVerificationStore(rpc).begin({ userId: USER, claimId: CLAIM });
    assert.deepEqual(calls, [{ fn: 'begin_claim_verification', params: { p_user_id: USER, p_claim_id: CLAIM } }]);
    assert.deepEqual(result, { outcome: 'ready', attemptId: ATTEMPT, websiteUrl: 'https://shop.fr/' });
  });

  it('records a failure without host or candidates', async () => {
    const { calls, rpc } = recordingRpc({ data: [{ outcome: 'recorded', verified_shop_id: null }], error: null });
    await createRpcClaimVerificationStore(rpc).finish({ attemptId: ATTEMPT, userId: USER, failure: 'fetch_tls_failed' });
    assert.deepEqual(calls[0]!.params, {
      p_attempt_id: ATTEMPT,
      p_user_id: USER,
      p_failure: 'fetch_tls_failed',
      p_final_host: null,
      p_candidates: null,
    });
  });

  it('never forwards an unexpected failure string', async () => {
    const { calls, rpc } = recordingRpc({ data: [{ outcome: 'recorded' }], error: null });
    await createRpcClaimVerificationStore(rpc).finish({ attemptId: ATTEMPT, userId: USER, failure: 'Error: connect 10.0.0.1' });
    assert.equal(calls[0]!.params.p_failure, 'internal_error');
  });

  it('sends what was read: the final host and the candidates', async () => {
    const { calls, rpc } = recordingRpc({ data: [{ outcome: 'verified', verified_shop_id: SHOP }], error: null });
    const result = await createRpcClaimVerificationStore(rpc).finish({ attemptId: ATTEMPT, userId: USER, finalHost: 'www.shop.fr', candidates: [TOKEN] });
    assert.deepEqual(calls[0]!.params, { p_attempt_id: ATTEMPT, p_user_id: USER, p_failure: null, p_final_host: 'www.shop.fr', p_candidates: [TOKEN] });
    assert.deepEqual(result, { outcome: 'verified', shopId: SHOP });
  });

  it('surfaces a database error as its SQLSTATE only', async () => {
    const { rpc } = recordingRpc({ data: null, error: { code: 'P0002' } });
    await assert.rejects(
      createRpcClaimVerificationStore(rpc).finish({ attemptId: ATTEMPT, userId: USER, failure: 'timeout' }),
      (error: unknown) => error instanceof ClaimVerificationStoreError && error.sqlState === 'P0002' && !/10\.0|shop\.fr/.test(error.message)
    );
  });
});

describe('claim verification store — results', () => {
  it('parses every begin outcome strictly', () => {
    assert.deepEqual(parseBeginClaimRow({ outcome: 'rate_limited', retry_after_seconds: 1200 }), { outcome: 'rate_limited', retryAfterSeconds: 1200 });
    assert.deepEqual(parseBeginClaimRow({ outcome: 'already_running', retry_after_seconds: null }), { outcome: 'already_running', retryAfterSeconds: 60 });
    assert.deepEqual(parseBeginClaimRow({ outcome: 'rate_limited', retry_after_seconds: 10_000_000 }), { outcome: 'rate_limited', retryAfterSeconds: 86_400 });
    for (const outcome of ['claim_not_found', 'claim_expired', 'claim_closed', 'already_member', 'shop_already_claimed', 'shop_unavailable']) {
      assert.deepEqual(parseBeginClaimRow({ outcome }), { outcome });
    }
    for (const bad of [null, [], { outcome: 'ready', attempt_id: 'x', website_url: 'https://shop.fr/' }, { outcome: 'ready', attempt_id: ATTEMPT }, { outcome: 'verified' }]) {
      assert.throws(() => parseBeginClaimRow(bad), ClaimVerificationStoreError);
    }
  });

  it('parses every finish outcome strictly', () => {
    for (const outcome of ['token_absent', 'token_mismatch', 'claim_expired', 'claim_closed', 'already_member', 'shop_already_claimed', 'shop_unavailable', 'domain_mismatch', 'recorded']) {
      assert.deepEqual(parseFinishClaimRow({ outcome, verified_shop_id: null }), { outcome });
    }
    assert.throws(() => parseFinishClaimRow({ outcome: 'verified', verified_shop_id: null }), ClaimVerificationStoreError);
    assert.throws(() => parseFinishClaimRow({ outcome: 'approved' }), ClaimVerificationStoreError);
  });
});
