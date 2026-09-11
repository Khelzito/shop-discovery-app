import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyShopAnalysisV2 } from '../contracts/shop-analysis-v2.ts';
import { handleShopAnalysisRequest, MAX_REQUEST_BYTES } from './shop-analysis-handler.ts';
import type { HandlerRequest, ShopAnalysisHandlerDeps } from './shop-analysis-handler.ts';
import {
  buildMerchantProposal,
  createRpcShopAnalysisStore,
  hasForbiddenPersistedKey,
  parseBeginRow,
  ShopAnalysisStoreError,
  toCompleteShopAnalysisParams,
  toFailShopAnalysisParams,
} from './shop-analysis-persistence.ts';
import type {
  BeginOutcome,
  CompleteShopAnalysisParams,
  FailShopAnalysisParams,
  ShopAnalysisStore,
} from './shop-analysis-persistence.ts';
import { validateShopAnalysisV2 } from './shop-analysis-v2.ts';
import type { ExtractionSummary, ShopAnalyzerInput, ShopAnalyzerOutcome } from './shop-analyzer.ts';

const USER_ID = '6f1c1c6e-8a55-4a3e-9e61-1b3c2f6a7d10';
const OTHER_USER = '0b7a8f61-2d5c-4f0e-8d33-5c6b7a8f9e01';
const ANALYSIS_ID = '2a6f4c1e-3b5d-4e7f-8a9b-0c1d2e3f4a5b';
const SUBMISSION_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const SHOP_ID = '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b';
const SECRET = 'sk-live-should-never-appear-0000';
const TARGET = { requestedUrl: 'https://maison-leon.fr/', finalUrl: 'https://maison-leon.fr/', domain: 'maison-leon.fr', redirectCount: 0 };

const SUMMARY: ExtractionSummary = {
  mediaType: 'text/html',
  byteLength: 5120,
  redirectCount: 0,
  title: 'Maison Léon',
  canonicalUrl: 'https://maison-leon.fr/',
  faviconUrl: 'https://maison-leon.fr/favicon.ico',
  htmlLang: 'fr',
  headings: 1,
  modelTextChars: 420,
  jsonLdBlocks: 1,
  droppedInjectionLines: 0,
  removedInferredItems: 2,
  modelOutcome: 'success',
  providerFailure: null,
};

function analyzed(): ShopAnalyzerOutcome {
  const analysis = emptyShopAnalysisV2(TARGET);
  analysis.observed.name = { value: 'Maison Léon', source: { kind: 'html_meta', key: 'og:site_name' } };
  analysis.inferred.primaryCategory = { value: 'mode', confidence: 0.9 };
  analysis.inferred.secondaryCategories = [{ value: 'bijoux', confidence: 0.3 }];
  analysis.inferred.styles = [{ value: 'streetwear', confidence: 0.8 }];
  analysis.inferred.tags = [{ value: 'streetwear', confidence: 0.7 }];
  analysis.inferred.audience = { value: ['unisex'], confidence: 0.6 };
  analysis.inferred.summary = { value: 'Vêtements urbains en petites séries.', confidence: 0.7 };
  analysis.model = { provider: 'openai', model: 'gpt-test', modelVersion: null, contractVersion: 'shop-analysis/2' };
  analysis.degraded = false;
  const validated = validateShopAnalysisV2(analysis);
  assert.ok(validated.ok, JSON.stringify(!validated.ok && validated.issues));
  return { kind: 'analyzed', analysis: validated.value, sourceHash: 'ab'.repeat(32), summary: SUMMARY, telemetry: [] };
}

function blocked(reason: 'robots_disallowed' | 'fetch_blocked', code: string): ShopAnalyzerOutcome {
  const analysis = emptyShopAnalysisV2(TARGET);
  analysis.warnings = [reason];
  return { kind: 'blocked', analysis, reason, code };
}

class FakeStore implements ShopAnalysisStore {
  beginResult: BeginOutcome = { outcome: 'started', analysisId: ANALYSIS_ID, submissionId: SUBMISSION_ID };
  completeResult: boolean | Error = true;
  readonly begins: Parameters<ShopAnalysisStore['begin']>[0][] = [];
  readonly completes: CompleteShopAnalysisParams[] = [];
  readonly fails: FailShopAnalysisParams[] = [];

  async begin(input: Parameters<ShopAnalysisStore['begin']>[0]) {
    this.begins.push(input);
    return this.beginResult;
  }
  async complete(params: CompleteShopAnalysisParams) {
    this.completes.push(params);
    if (this.completeResult instanceof Error) throw this.completeResult;
    return this.completeResult;
  }
  async fail(params: FailShopAnalysisParams) {
    this.fails.push(params);
  }
}

function setup(outcome: ShopAnalyzerOutcome | Error = analyzed()) {
  const store = new FakeStore();
  const analyses: ShopAnalyzerInput[] = [];
  const logs: unknown[] = [];
  const authCalls: (string | null)[] = [];
  const deps: ShopAnalysisHandlerDeps = {
    authenticate: async (authorization) => {
      authCalls.push(authorization);
      return authorization === 'Bearer user-token' ? { id: USER_ID } : null;
    },
    store,
    loadTaxonomy: async () => ({ categories: [{ slug: 'mode', name: 'Mode' }], tags: [] }),
    analyze: async (input) => {
      analyses.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    now: () => new Date('2026-09-11T10:00:00.000Z'),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  };
  return { deps, store, analyses, logs, authCalls };
}

function request(body: unknown, headers: Record<string, string> = {}, method = 'POST'): HandlerRequest {
  const all = new Map(
    Object.entries({ authorization: 'Bearer user-token', 'content-type': 'application/json', ...headers })
      .filter(([, value]) => value !== '')
      .map(([name, value]) => [name.toLowerCase(), value])
  );
  return { method, headers: { get: (name) => all.get(name.toLowerCase()) ?? null }, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;
const dataOf = (body: unknown) => (body as { ok: true; data: Record<string, any> }).data;

describe('ai-shop-analysis — authentication and payload', () => {
  it('refuses a request without a JWT before doing anything', async () => {
    const { deps, store, analyses, authCalls } = setup();
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }, { authorization: '' }), deps);
    assert.equal(response.status, 401);
    assert.deepEqual(authCalls, []);
    assert.equal(store.begins.length, 0);
    assert.equal(analyses.length, 0);
  });

  it('refuses a token that does not resolve to a user', async () => {
    const { deps, store } = setup();
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }, { authorization: 'Bearer anon-key' }), deps);
    assert.equal(response.status, 401);
    assert.equal(store.begins.length, 0);
  });

  for (const [label, body] of [
    ['a localhost URL', { websiteUrl: 'https://localhost/' }],
    ['a private IP literal', { websiteUrl: 'https://192.168.0.1/' }],
    ['a javascript URL', { websiteUrl: 'javascript:alert(1)' }],
    ['a non-uuid submission', { websiteUrl: 'https://maison-leon.fr', submissionId: 'nope' }],
    ['a user id in the body', { websiteUrl: 'https://maison-leon.fr', userId: OTHER_USER }],
    ['a verification flag in the body', { websiteUrl: 'https://maison-leon.fr', verified: true }],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const { deps, store } = setup();
      const response = await handleShopAnalysisRequest(request(body), deps);
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'ai_bad_request');
      assert.equal(store.begins.length, 0);
    });
  }

  it('refuses plain http', async () => {
    const { deps, store } = setup();
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'http://maison-leon.fr/' }), deps);
    assert.equal(response.status, 400);
    assert.match((response.body as { error: { message: string } }).error.message, /https/);
    assert.equal(store.begins.length, 0);
  });

  it('refuses invalid JSON, a wrong method, a wrong content type and an oversized body', async () => {
    const { deps } = setup();
    assert.equal((await handleShopAnalysisRequest(request('{nope'), deps)).status, 400);
    assert.equal((await handleShopAnalysisRequest(request({}, {}, 'GET'), deps)).status, 405);
    assert.equal((await handleShopAnalysisRequest(request({}, { 'content-type': 'text/plain' }), deps)).status, 415);
    assert.equal((await handleShopAnalysisRequest(request('x'.repeat(MAX_REQUEST_BYTES + 1)), deps)).status, 413);
  });

  it('takes the user from the token and the URL in canonical https form', async () => {
    const { deps, store } = setup();
    await handleShopAnalysisRequest(request({ websiteUrl: 'Maison-Leon.fr', submissionId: SUBMISSION_ID }), deps);
    assert.deepEqual(store.begins, [{ userId: USER_ID, submissionId: SUBMISSION_ID, sourceUrl: 'https://maison-leon.fr/', domain: 'maison-leon.fr' }]);
  });
});

describe('ai-shop-analysis — quota, ownership, duplicates', () => {
  it('answers 404 for a submission that is not the caller’s, without fetching', async () => {
    const { deps, store, analyses } = setup();
    store.beginResult = { outcome: 'submission_not_found' };
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr', submissionId: SUBMISSION_ID }), deps);
    assert.equal(response.status, 404);
    assert.equal(analyses.length, 0);
  });

  it('answers 409 for a submission under review', async () => {
    const { deps, store, analyses } = setup();
    store.beginResult = { outcome: 'submission_locked', submissionId: SUBMISSION_ID };
    assert.equal((await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr', submissionId: SUBMISSION_ID }), deps)).status, 409);
    assert.equal(analyses.length, 0);
  });

  it('answers 429 with Retry-After when the quota is exceeded or a run is in progress', async () => {
    for (const beginResult of [
      { outcome: 'rate_limited', retryAfterSeconds: 1234 },
      { outcome: 'already_running', retryAfterSeconds: 30 },
    ] as const) {
      const { deps, store, analyses } = setup();
      store.beginResult = beginResult;
      const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
      assert.equal(response.status, 429);
      assert.equal(response.headers['Retry-After'], String(beginResult.retryAfterSeconds));
      assert.equal(errorCode(response.body), 'ai_rate_limited');
      assert.equal(analyses.length, 0);
    }
  });

  it('points to the existing published shop instead of analysing again', async () => {
    const { deps, store, analyses } = setup();
    store.beginResult = { outcome: 'shop_exists', existingShopId: SHOP_ID };
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(dataOf(response.body), { outcome: 'shop_exists', existingShopId: SHOP_ID });
    assert.equal(analyses.length, 0);
  });

  it('answers 503 when the store or the taxonomy is unavailable, before any network access', async () => {
    const noStore = setup();
    noStore.deps.store = null;
    assert.equal((await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), noStore.deps)).status, 503);

    const noTaxonomy = setup();
    noTaxonomy.deps.loadTaxonomy = async () => { throw new Error('down'); };
    assert.equal((await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), noTaxonomy.deps)).status, 503);
    assert.equal(noTaxonomy.store.begins.length, 0);
  });
});

describe('ai-shop-analysis — outcomes', () => {
  it('records a robots block as a failed attempt and returns the degraded analysis', async () => {
    const { deps, store } = setup(blocked('robots_disallowed', 'robots_disallowed'));
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 200);
    const data = dataOf(response.body);
    assert.equal(data.outcome, 'blocked');
    assert.deepEqual(data.analysis.warnings, ['robots_disallowed']);
    assert.equal(data.proposalSaved, false);
    assert.equal(data.analysisId, ANALYSIS_ID);
    assert.deepEqual(store.fails, [{ p_analysis_id: ANALYSIS_ID, p_user_id: USER_ID, p_error_code: 'robots_disallowed', p_raw_extraction: { warnings: ['robots_disallowed'] } }]);
    assert.equal(store.completes.length, 0);
  });

  it('records a fetch failure with its internal code, and shows only the warning', async () => {
    const { deps, store } = setup(blocked('fetch_blocked', 'address_blocked'));
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(store.fails[0]?.p_error_code, 'address_blocked');
    assert.equal(JSON.stringify(response.body).includes('address_blocked'), false);
    assert.deepEqual(dataOf(response.body).analysis.warnings, ['fetch_blocked']);
  });

  it('persists a degraded analysis like any other', async () => {
    const outcome = analyzed();
    if (outcome.kind !== 'analyzed') return;
    const degraded = emptyShopAnalysisV2(TARGET);
    degraded.warnings = ['model_unavailable'];
    const { deps, store } = setup({ ...outcome, analysis: degraded, summary: { ...SUMMARY, modelOutcome: 'provider_failed' } });
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(dataOf(response.body).analysis.degraded, true);
    assert.equal(store.completes[0]?.p_model_provider, null);
    assert.equal(store.completes[0]?.p_confidence_score, null);
  });

  it('persists a success and returns a clean response', async () => {
    const { deps, store, logs } = setup();
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 200);
    const data = dataOf(response.body);
    assert.equal(data.outcome, 'analyzed');
    assert.equal(data.analysisId, ANALYSIS_ID);
    assert.equal(data.submissionId, SUBMISSION_ID);
    assert.equal(data.proposalSaved, true);

    const params = store.completes[0]!;
    assert.equal(params.p_user_id, USER_ID);
    assert.equal(params.p_analysis_id, ANALYSIS_ID);
    assert.deepEqual(params.p_suggested_categories, [{ slug: 'mode', confidence: 0.9, primary: true }, { slug: 'bijoux', confidence: 0.3, primary: false }]);

    const serialized = JSON.stringify(response.body);
    for (const leak of [SECRET, 'service_role', '<html', '93.184.', 'extraction', 'modelOutcome', 'faviconUrl', 'stack']) {
      assert.equal(serialized.includes(leak), false, leak);
    }
    const logged = JSON.stringify(logs);
    assert.equal(logged.includes('maison-leon.fr'), false);
    assert.equal(logged.includes(USER_ID), false);
  });

  it('still answers when persistence fails, without claiming an analysis id', async () => {
    const { deps, store } = setup();
    store.completeResult = new Error('db down');
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 200);
    assert.equal(dataOf(response.body).analysisId, null);
    assert.equal(dataOf(response.body).proposalSaved, false);
    assert.equal(store.fails[0]?.p_error_code, 'persistence_failed');
  });

  it('answers 500 with a generic message when the analyzer crashes, and records it', async () => {
    const { deps, store } = setup(new Error(`boom ${SECRET}`));
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.body).includes(SECRET), false);
    assert.equal(store.fails[0]?.p_error_code, 'internal_error');
  });
});

describe('ai-shop-analysis — diagnosable failures', () => {
  it('logs which taxonomy read failed, with its code and HTTP status, never the message', async () => {
    const { deps, store, logs } = setup();
    deps.loadTaxonomy = async () => {
      throw Object.assign(new Error(`taxonomy read failed: tags ${SECRET}`), {
        name: 'TaxonomyUnavailableError',
        table: 'tags',
        code: 'PGRST301',
        httpStatus: 401,
      });
    };
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 503);
    assert.equal(store.begins.length, 0);
    assert.deepEqual(logs, [
      { level: 'error', event: 'taxonomy unavailable', fields: { reason: 'TaxonomyUnavailableError', table: 'tags', code: 'PGRST301', httpStatus: 401 } },
    ]);
    assert.equal(JSON.stringify(logs).includes(SECRET), false);
  });

  it('logs the SQLSTATE of a failed begin, and drops anything that is not a short code', async () => {
    const { deps, logs } = setup();
    deps.store = new FakeStore();
    deps.store.begin = async () => {
      throw Object.assign(new ShopAnalysisStoreError('begin_shop_analysis', '42501'), { code: `not a code ${SECRET}` });
    };
    const response = await handleShopAnalysisRequest(request({ websiteUrl: 'https://maison-leon.fr' }), deps);
    assert.equal(response.status, 503);
    assert.deepEqual(logs, [
      { level: 'error', event: 'begin failed', fields: { reason: 'ShopAnalysisStoreError', sqlState: '42501' } },
    ]);
  });
});

describe('persistence mapping', () => {
  const outcome = analyzed();
  assert.ok(outcome.kind === 'analyzed');
  const params = toCompleteShopAnalysisParams({
    analysisId: ANALYSIS_ID,
    userId: USER_ID,
    analysis: outcome.analysis,
    sourceHash: outcome.sourceHash,
    summary: SUMMARY,
    analyzedAt: '2026-09-11T10:00:00.000Z',
  });

  it('maps inferred values onto the analysis columns', () => {
    assert.equal(params.p_summary, 'Vêtements urbains en petites séries.');
    assert.deepEqual(params.p_detected_styles, ['streetwear']);
    assert.deepEqual(params.p_detected_audience, ['unisex']);
    assert.deepEqual(params.p_suggested_tags, [{ slug: 'streetwear', confidence: 0.7 }]);
    assert.equal(params.p_detected_price_positioning, null);
    assert.equal(params.p_model_provider, 'openai');
    assert.equal(params.p_confidence_score, 0.667);
  });

  it('copies only the merchant proposal: observed, inferred, warnings', () => {
    assert.deepEqual(Object.keys(params.p_proposal).sort(), [
      'analyzedAt', 'degraded', 'domain', 'inferred', 'observed', 'proposalVersion', 'unsupported', 'warnings', 'websiteUrl',
    ]);
    assert.deepEqual(params.p_proposal, buildMerchantProposal(outcome.analysis, '2026-09-11T10:00:00.000Z'));
  });

  it('never persists a forbidden key, raw HTML, an address or a secret', () => {
    assert.equal(hasForbiddenPersistedKey(params.p_proposal), false);
    assert.equal(hasForbiddenPersistedKey(params.p_raw_extraction), false);
    const serialized = JSON.stringify(params);
    for (const leak of ['<html', '<body', '93.184.', 'content-type', SECRET]) {
      assert.equal(serialized.toLowerCase().includes(leak.toLowerCase()), false, leak);
    }
  });

  it('detects forbidden keys by name, not by value', () => {
    assert.equal(hasForbiddenPersistedKey({ verified: true }), true);
    assert.equal(hasForbiddenPersistedKey({ nested: { shopStatus: 'published' } }), true);
    assert.equal(hasForbiddenPersistedKey({ trustScore: 1 }), true);
    assert.equal(hasForbiddenPersistedKey({ unsupported: ['verification', 'trust_score'] }), false);
  });

  it('writes nothing but the analysis row and the proposal — no verification, membership or publication field exists', () => {
    const names = Object.keys(params);
    for (const name of names) {
      assert.equal(/verif|trust|publish|member|owner|status|shop_id/.test(name), false, name);
    }
  });

  it('refuses an error code outside the closed vocabulary', () => {
    assert.equal(toFailShopAnalysisParams({ analysisId: ANALYSIS_ID, userId: USER_ID, code: 'Bad Code; drop', warnings: [] }).p_error_code, 'internal_error');
  });
});

describe('RPC store', () => {
  it('calls the three functions with named parameters', async () => {
    const calls: { fn: string; params: Record<string, unknown> }[] = [];
    const store = createRpcShopAnalysisStore(async (fn, params) => {
      calls.push({ fn, params });
      if (fn === 'begin_shop_analysis') {
        return { data: [{ outcome: 'started', analysis_id: ANALYSIS_ID, target_submission_id: SUBMISSION_ID, existing_shop_id: null, retry_after_seconds: null }], error: null };
      }
      return { data: fn === 'complete_shop_analysis' ? true : null, error: null };
    });

    assert.deepEqual(await store.begin({ userId: USER_ID, submissionId: null, sourceUrl: 'https://maison-leon.fr/', domain: 'maison-leon.fr' }), {
      outcome: 'started',
      analysisId: ANALYSIS_ID,
      submissionId: SUBMISSION_ID,
    });
    assert.deepEqual(calls[0], {
      fn: 'begin_shop_analysis',
      params: { p_user_id: USER_ID, p_submission_id: null, p_source_url: 'https://maison-leon.fr/', p_domain: 'maison-leon.fr' },
    });
    assert.equal(await store.complete({ p_analysis_id: ANALYSIS_ID } as CompleteShopAnalysisParams), true);
    await store.fail(toFailShopAnalysisParams({ analysisId: ANALYSIS_ID, userId: USER_ID, code: 'timeout', warnings: ['timeout'] }));
    assert.deepEqual(calls.map((call) => call.fn), ['begin_shop_analysis', 'complete_shop_analysis', 'fail_shop_analysis']);
  });

  it('surfaces the SQLSTATE only, never the database message', async () => {
    const store = createRpcShopAnalysisStore(async () => ({ data: null, error: { code: '42501', message: `permission denied ${SECRET}` } as { code: string } }));
    await assert.rejects(store.begin({ userId: USER_ID, submissionId: null, sourceUrl: 'https://maison-leon.fr/', domain: 'maison-leon.fr' }), (error: unknown) => {
      assert.ok(error instanceof ShopAnalysisStoreError);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.sqlState, '42501');
      return true;
    });
  });

  it('parses every begin outcome strictly', () => {
    assert.deepEqual(parseBeginRow({ outcome: 'rate_limited', retry_after_seconds: 120 }), { outcome: 'rate_limited', retryAfterSeconds: 120 });
    assert.deepEqual(parseBeginRow({ outcome: 'already_running', retry_after_seconds: null }), { outcome: 'already_running', retryAfterSeconds: 60 });
    assert.deepEqual(parseBeginRow({ outcome: 'shop_exists', existing_shop_id: SHOP_ID }), { outcome: 'shop_exists', existingShopId: SHOP_ID });
    assert.deepEqual(parseBeginRow({ outcome: 'submission_not_found' }), { outcome: 'submission_not_found' });
    assert.throws(() => parseBeginRow({ outcome: 'started', analysis_id: 'not-a-uuid', target_submission_id: SUBMISSION_ID }), ShopAnalysisStoreError);
    assert.throws(() => parseBeginRow({ outcome: 'published' }), ShopAnalysisStoreError);
    assert.throws(() => parseBeginRow(null), ShopAnalysisStoreError);
  });
});
