import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ClaimTarget } from './claim-domain.ts';
import type { ClaimSiteCheck } from './claim-site-check.ts';
import { ClaimVerificationStoreError } from './claim-verification-store.ts';
import type {
  BeginClaimVerification,
  ClaimVerificationStore,
  FinishClaimVerification,
  FinishInput,
} from './claim-verification-store.ts';
import { handleVerifyClaimRequest, parseClaimPayload } from './verify-claim-handler.ts';
import type { VerifyClaimHandlerDeps } from './verify-claim-handler.ts';

const USER = '3843ac2a-0000-4000-8000-000000000001';
const OTHER_USER = '7256a652-0000-4000-8000-000000000002';
const CLAIM = '11111111-2222-4333-8444-555555555555';
const ATTEMPT = '99999999-8888-4777-8666-555555555555';
const SHOP = '78d97b85-0000-4000-8000-000000000009';
const TOKEN = `sd-claim-${'c3'.repeat(32)}`;

class FakeStore implements ClaimVerificationStore {
  readonly begins: { userId: string; claimId: string }[] = [];
  readonly finishes: FinishInput[] = [];
  constructor(
    private readonly onBegin: BeginClaimVerification | Error,
    private readonly onFinish: FinishClaimVerification | Error = { outcome: 'recorded' }
  ) {}
  async begin(input: { userId: string; claimId: string }) {
    this.begins.push(input);
    if (this.onBegin instanceof Error) throw this.onBegin;
    return this.onBegin;
  }
  async finish(input: FinishInput) {
    this.finishes.push(input);
    if (this.onFinish instanceof Error) throw this.onFinish;
    if ('failure' in input) return { outcome: 'recorded' as const };
    return this.onFinish;
  }
}

const READY: BeginClaimVerification = { outcome: 'ready', attemptId: ATTEMPT, websiteUrl: 'https://maison-leon.fr/' };

function request(body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  const all: Record<string, string> = { 'content-type': 'application/json', authorization: 'Bearer jwt', ...headers };
  return {
    method,
    headers: { get: (name: string) => all[name.toLowerCase()] ?? null },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function deps(
  store: ClaimVerificationStore | null,
  site: ClaimSiteCheck | Error = { kind: 'read', finalHost: 'maison-leon.fr', metaTags: 1, tokens: [TOKEN] }
) {
  const targets: ClaimTarget[] = [];
  const logs: unknown[] = [];
  const value: VerifyClaimHandlerDeps = {
    authenticate: async () => ({ id: USER }),
    store,
    checkSite: async ({ target }) => {
      targets.push(target);
      if (site instanceof Error) throw site;
      return site;
    },
    log: (level, event, fields) => logs.push({ level, event, fields }),
  };
  return { value, targets, logs };
}

describe('verify-shop-claim — request', () => {
  it('refuses other methods, content types and oversized bodies', async () => {
    const { value } = deps(new FakeStore(READY));
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM }, {}, 'GET'), value)).status, 405);
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM }, { 'content-type': 'text/plain' }), value)).status, 415);
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM, pad: 'x'.repeat(2000) }), value)).status, 413);
  });

  it('requires an authenticated caller', async () => {
    const store = new FakeStore(READY);
    const { value } = deps(store);
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM }, { authorization: '' }), value)).status, 401);
    const failing = { ...value, authenticate: async () => { throw new Error('jwt'); } };
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM }), failing)).status, 401);
    assert.equal(store.begins.length, 0);
  });

  it('accepts exactly a claim id — never a user id, a status or a flag', () => {
    assert.equal(parseClaimPayload(JSON.stringify({ claimId: CLAIM.toUpperCase() })), CLAIM);
    for (const body of [
      '{',
      '[]',
      'null',
      JSON.stringify({}),
      JSON.stringify({ claimId: 'not-a-uuid' }),
      JSON.stringify({ claimId: CLAIM, userId: OTHER_USER }),
      JSON.stringify({ claimId: CLAIM, verified: true }),
      JSON.stringify({ claimId: CLAIM, token: TOKEN }),
    ]) {
      assert.equal(parseClaimPayload(body), null, body);
    }
  });

  it('answers 400 to a payload carrying a user id, and asks the store nothing', async () => {
    const store = new FakeStore(READY);
    const response = await handleVerifyClaimRequest(request({ claimId: CLAIM, userId: OTHER_USER }), deps(store).value);
    assert.equal(response.status, 400);
    assert.equal(store.begins.length, 0);
  });

  it('is unavailable without its service configuration', async () => {
    assert.equal((await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(null).value)).status, 503);
  });
});

describe('verify-shop-claim — decisions', () => {
  it('uses the verified user, never anything from the body', async () => {
    const store = new FakeStore(READY, { outcome: 'verified', shopId: SHOP });
    await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(store).value);
    assert.deepEqual(store.begins, [{ userId: USER, claimId: CLAIM }]);
    assert.equal(store.finishes[0]!.userId, USER);
  });

  it('returns refusals decided before the network without touching the site', async () => {
    for (const outcome of ['claim_not_found', 'claim_expired', 'claim_closed', 'already_member', 'shop_already_claimed', 'shop_unavailable'] as const) {
      const store = new FakeStore({ outcome });
      const { value, targets } = deps(store);
      const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), value);
      assert.equal(response.status, 200, outcome);
      assert.deepEqual(response.body, { ok: true, data: { outcome, shopId: null, retryAfterSeconds: null } });
      assert.equal(targets.length, 0);
      assert.equal(store.finishes.length, 0);
    }
  });

  it('rate limits with Retry-After', async () => {
    for (const outcome of ['rate_limited', 'already_running'] as const) {
      const { value, targets } = deps(new FakeStore({ outcome, retryAfterSeconds: 1200 }));
      const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), value);
      assert.equal(response.status, 429);
      assert.equal(response.headers['Retry-After'], '1200');
      assert.equal((response.body as { outcome: string }).outcome, outcome);
      assert.equal(targets.length, 0);
    }
  });

  it('checks the shop host from the database, then lets the database decide', async () => {
    const store = new FakeStore(READY, { outcome: 'verified', shopId: SHOP });
    const { value, targets } = deps(store);
    const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), value);
    assert.deepEqual(targets.map((target) => target.homepageUrl), ['https://maison-leon.fr/']);
    assert.deepEqual(store.finishes, [{ attemptId: ATTEMPT, userId: USER, finalHost: 'maison-leon.fr', candidates: [TOKEN] }]);
    assert.deepEqual(response.body, { ok: true, data: { outcome: 'verified', shopId: SHOP, retryAfterSeconds: null } });
  });

  it('passes the database refusals through unchanged', async () => {
    for (const outcome of ['token_absent', 'token_mismatch', 'domain_mismatch', 'shop_already_claimed', 'claim_expired'] as const) {
      const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(new FakeStore(READY, { outcome })).value);
      assert.deepEqual(response.body, { ok: true, data: { outcome, shopId: null, retryAfterSeconds: null } }, outcome);
    }
  });

  it('records a site failure and returns its short outcome', async () => {
    const store = new FakeStore(READY);
    const site: ClaimSiteCheck = { kind: 'failed', outcome: 'redirect_off_domain', code: 'redirect_off_domain' };
    const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(store, site).value);
    assert.deepEqual(store.finishes, [{ attemptId: ATTEMPT, userId: USER, failure: 'redirect_off_domain' }]);
    assert.deepEqual(response.body, { ok: true, data: { outcome: 'redirect_off_domain', shopId: null, retryAfterSeconds: null } });
  });

  it('never fetches a catalogue URL the policy refuses', async () => {
    const store = new FakeStore({ outcome: 'ready', attemptId: ATTEMPT, websiteUrl: 'https://maison-leon.example' });
    const { value, targets } = deps(store);
    const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), value);
    assert.equal(targets.length, 0);
    assert.deepEqual(store.finishes, [{ attemptId: ATTEMPT, userId: USER, failure: 'shop_url_rejected' }]);
    assert.equal((response.body as { data: { outcome: string } }).data.outcome, 'site_unreachable');
  });

  it('never claims success when the store fails', async () => {
    const begin = await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(new FakeStore(new ClaimVerificationStoreError('begin', '40001'))).value);
    assert.equal(begin.status, 503);
    const finish = await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(new FakeStore(READY, new ClaimVerificationStoreError('finish', 'P0002'))).value);
    assert.equal(finish.status, 503);
    const crashed = await handleVerifyClaimRequest(request({ claimId: CLAIM }), deps(new FakeStore(READY), new Error('boom')).value);
    assert.equal(crashed.status, 503);
  });

  it('keeps the token, the host and any network detail out of responses and logs', async () => {
    const outcomes: (ClaimSiteCheck | Error)[] = [
      { kind: 'read', finalHost: 'maison-leon.fr', metaTags: 1, tokens: [TOKEN] },
      { kind: 'failed', outcome: 'tls_failed', code: 'fetch_tls_failed' },
      new Error(`connect 10.0.0.8 maison-leon.fr ${TOKEN}`),
    ];
    for (const site of outcomes) {
      const { value, logs } = deps(new FakeStore(READY, { outcome: 'token_mismatch' }), site);
      const response = await handleVerifyClaimRequest(request({ claimId: CLAIM }), value);
      const text = JSON.stringify([response, logs]);
      for (const secret of [TOKEN, 'maison-leon', '10.0.0.8', 'hash']) {
        assert.equal(text.includes(secret), false, secret);
      }
    }
  });
});
