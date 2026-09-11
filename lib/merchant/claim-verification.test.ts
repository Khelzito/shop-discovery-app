import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLAIM_VERIFICATION_OUTCOMES } from '../../ai/contracts/merchant-trust';
import { CLAIM_CHECK_MESSAGES, interpretClaimVerificationResponse } from './claim-verification';

const SHOP = '78d97b85-0000-4000-8000-000000000009';

const ok = (outcome: string, shopId: string | null = null) => ({
  status: 200,
  body: { ok: true, data: { outcome, shopId, retryAfterSeconds: null } },
  retryAfter: null,
});

describe('claim verification response', () => {
  it('is verified only with an explicit verified outcome and a shop id', () => {
    assert.deepEqual(interpretClaimVerificationResponse(ok('verified', SHOP)), { kind: 'verified', shopId: SHOP });
    assert.equal(interpretClaimVerificationResponse(ok('verified')).kind, 'failed');
    assert.equal(interpretClaimVerificationResponse({ status: 200, body: { ok: true, data: { verified: true } }, retryAfter: null }).kind, 'failed');
    assert.equal(interpretClaimVerificationResponse(ok('approved', SHOP)).kind, 'failed');
  });

  it('gives every refusal its own short message', () => {
    for (const outcome of CLAIM_VERIFICATION_OUTCOMES.filter((value) => value !== 'verified')) {
      const result = interpretClaimVerificationResponse(ok(outcome));
      assert.deepEqual(result, { kind: 'failed', reason: outcome, message: CLAIM_CHECK_MESSAGES[outcome], retryAfterSeconds: null });
    }
  });

  it('maps transport states', () => {
    const reason = (input: Parameters<typeof interpretClaimVerificationResponse>[0]) => {
      const result = interpretClaimVerificationResponse(input);
      return result.kind === 'failed' ? result.reason : result.kind;
    };
    assert.equal(reason({ status: null, body: null, retryAfter: null }), 'network');
    assert.equal(reason({ status: 401, body: null, retryAfter: null }), 'session_expired');
    assert.equal(reason({ status: 503, body: null, retryAfter: null }), 'unavailable');
    assert.equal(reason({ status: 400, body: null, retryAfter: null }), 'unknown');
    assert.equal(reason({ status: 429, body: { outcome: 'already_running' }, retryAfter: '30' }), 'already_running');
  });

  it('reads the retry delay from the header, then the body', () => {
    const fromHeader = interpretClaimVerificationResponse({ status: 429, body: { outcome: 'rate_limited' }, retryAfter: '1200' });
    assert.equal(fromHeader.kind === 'failed' && fromHeader.retryAfterSeconds, 1200);
    const fromBody = interpretClaimVerificationResponse({ status: 429, body: { outcome: 'rate_limited', retryAfterSeconds: 90 }, retryAfter: null });
    assert.equal(fromBody.kind === 'failed' && fromBody.retryAfterSeconds, 90);
  });

  it('never promises more than domain control, and never leaks detail', () => {
    for (const message of Object.values(CLAIM_CHECK_MESSAGES)) {
      assert.ok(message.length <= 160, message);
      // "certificat HTTPS" is a fact about the connection; "certifiée" would be a trust claim.
      assert.equal(/sûre|fiable|certifiée?\b|arnaque|\d+\.\d+\.\d+|hash|dns|ssl_|stack/i.test(message), false, message);
    }
  });
});
