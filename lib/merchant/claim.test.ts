import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLAIM_MESSAGES,
  claimFailureOf,
  claimMetaTag,
  formatClaimDate,
  openClaimOf,
  readClaimToken,
} from './claim';

const TOKEN = `sd-claim-${'a1'.repeat(32)}`;
const CLAIM_ID = '2a6f4c1e-3b5d-4e7f-8a9b-0c1d2e3f4a5b';

describe('claimFailureOf', () => {
  it('maps the reasons request_shop_claim raises', () => {
    for (const reason of ['shop_already_claimed', 'already_member', 'shop_not_found', 'too_many_open_claims', 'not_authenticated'] as const) {
      assert.equal(claimFailureOf({ code: 'P0001', message: reason }), reason);
    }
    assert.equal(claimFailureOf({ code: '28000', message: 'whatever' }), 'not_authenticated');
  });

  it('never passes a raw database message through', () => {
    assert.equal(claimFailureOf({ code: '42501', message: 'permission denied for table shop_claims' }), 'unknown');
    assert.equal(claimFailureOf(null), 'unknown');
    for (const message of Object.values(CLAIM_MESSAGES)) {
      assert.equal(/shop_claims|P0001|sql/i.test(message), false);
    }
  });
});

describe('readClaimToken', () => {
  it('reads the single RPC row', () => {
    assert.deepEqual(
      readClaimToken([{ claim_id: CLAIM_ID, proof_token: TOKEN, proof_expires_at: '2026-09-18T12:00:00+00:00' }]),
      { claimId: CLAIM_ID, token: TOKEN, expiresAt: '2026-09-18T12:00:00+00:00' }
    );
  });

  it('refuses anything else', () => {
    assert.equal(readClaimToken([]), null);
    assert.equal(readClaimToken([{ claim_id: CLAIM_ID, proof_token: 'short', proof_expires_at: '2026-09-18T12:00:00Z' }]), null);
    assert.equal(readClaimToken([{ claim_id: 'x', proof_token: TOKEN, proof_expires_at: '2026-09-18T12:00:00Z' }]), null);
    assert.equal(readClaimToken([{ claim_id: CLAIM_ID, proof_token: TOKEN, proof_expires_at: 'never' }]), null);
  });
});

describe('claimMetaTag', () => {
  it('builds the meta tag only for a well-formed token', () => {
    assert.equal(claimMetaTag(TOKEN), `<meta name="shop-discovery-verification" content="${TOKEN}">`);
    assert.equal(claimMetaTag('"><script>alert(1)</script>'), null);
  });
});

describe('formatClaimDate', () => {
  it('formats a date in French', () => {
    assert.equal(formatClaimDate('2026-09-18T12:00:00.000Z'), '18 septembre 2026');
    assert.equal(formatClaimDate('not a date'), null);
  });
});

describe('openClaimOf', () => {
  const now = new Date('2026-09-11T12:00:00.000Z');

  it('finds a pending claim that has not expired', () => {
    assert.deepEqual(
      openClaimOf(
        [
          { id: 'old', status: 'pending', expires_at: '2026-09-01T00:00:00Z' },
          { id: 'done', status: 'rejected', expires_at: '2026-09-20T00:00:00Z' },
          { id: 'open', status: 'pending', expires_at: '2026-09-18T00:00:00Z' },
        ],
        now
      ),
      { id: 'open', expiresAt: '2026-09-18T00:00:00Z' }
    );
  });

  it('returns null when nothing is open', () => {
    assert.equal(openClaimOf([], now), null);
    assert.equal(openClaimOf([{ id: 'x', status: 'expired', expires_at: null }], now), null);
  });
});
