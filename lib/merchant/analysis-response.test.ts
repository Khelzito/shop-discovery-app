import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANALYSIS_MESSAGES, interpretShopAnalysisResponse, retryHint } from './analysis-response';

const SUBMISSION = '88742c16-8ddd-4177-ada3-6677e3121fd4';
const ANALYSIS_ID = '167f58df-d208-43a2-add4-d1c2be111f7d';
const SHOP = '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b';

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 'shop-analysis/2',
    target: { requestedUrl: 'https://maboutique.com/', finalUrl: 'https://maboutique.com/', domain: 'maboutique.com', redirectCount: 0 },
    observed: { name: null, description: null, language: null, countryCode: null, currency: null, logoUrl: null, imageUrls: [], socialLinks: [], siteSectionLabels: [] },
    inferred: { shortDescription: null, primaryCategory: null, secondaryCategories: [], audience: null, pricePositioning: null, styles: [], values: [], productTypes: [], tags: [], summary: null },
    warnings: [],
    unsupported: [],
    model: { provider: 'openai', model: 'gpt', modelVersion: null, contractVersion: 'shop-analysis/2' },
    degraded: false,
    ...overrides,
  };
}

const ok = (data: unknown) => ({ status: 200, body: { ok: true, data }, retryAfter: null });
const fail = (status: number, message = 'Service indisponible.', retryAfter: string | null = null) => ({
  status,
  body: { ok: false, error: { code: 'x', message, retryable: true } },
  retryAfter,
});

describe('interpretShopAnalysisResponse — success', () => {
  it('maps an analyzed outcome with a saved proposal', () => {
    const result = interpretShopAnalysisResponse(
      ok({ outcome: 'analyzed', analysis: analysis(), analysisId: ANALYSIS_ID, submissionId: SUBMISSION, proposalSaved: true })
    );
    assert.equal(result.kind, 'analyzed');
    assert.ok(result.kind === 'analyzed');
    assert.equal(result.submissionId, SUBMISSION);
    assert.equal(result.analysisId, ANALYSIS_ID);
    assert.equal(result.proposalSaved, true);
    assert.equal(result.degraded, false);
    assert.ok(result.analysis !== null);
  });

  it('reports a degraded analysis, and one whose proposal was not saved', () => {
    const result = interpretShopAnalysisResponse(
      ok({ outcome: 'analyzed', analysis: analysis({ degraded: true, model: null, warnings: ['model_unavailable'] }), analysisId: null, submissionId: SUBMISSION, proposalSaved: false })
    );
    assert.ok(result.kind === 'analyzed');
    assert.equal(result.degraded, true);
    assert.equal(result.proposalSaved, false);
    assert.equal(result.analysisId, null);
    assert.deepEqual(result.warnings, ['model_unavailable']);
  });

  it('keeps the flow going without an analysis it cannot read', () => {
    const result = interpretShopAnalysisResponse(
      ok({ outcome: 'analyzed', analysis: { contractVersion: 'other' }, analysisId: ANALYSIS_ID, submissionId: SUBMISSION, proposalSaved: true })
    );
    assert.ok(result.kind === 'analyzed');
    assert.equal(result.analysis, null);
    assert.equal(result.degraded, true);
  });

  for (const [warning, reason] of [
    ['robots_disallowed', 'robots_disallowed'],
    ['fetch_blocked', 'fetch_blocked'],
    ['timeout', 'timeout'],
    ['non_html_content', 'unreadable'],
  ] as const) {
    it(`maps a blocked analysis (${warning}) to manual entry`, () => {
      const result = interpretShopAnalysisResponse(
        ok({ outcome: 'blocked', analysis: analysis({ warnings: [warning], degraded: true, model: null }), analysisId: ANALYSIS_ID, submissionId: SUBMISSION, proposalSaved: false })
      );
      assert.deepEqual(result, { kind: 'blocked', submissionId: SUBMISSION, reason, message: ANALYSIS_MESSAGES[reason] });
    });
  }

  it('maps an existing shop', () => {
    assert.deepEqual(interpretShopAnalysisResponse(ok({ outcome: 'shop_exists', existingShopId: SHOP })), {
      kind: 'shop_exists',
      shopId: SHOP,
    });
  });

  it('refuses malformed successes', () => {
    for (const body of [null, { ok: false }, { ok: true }, { ok: true, data: { outcome: 'published' } }]) {
      const result = interpretShopAnalysisResponse({ status: 200, body, retryAfter: null });
      assert.ok(result.kind === 'error' && result.code === 'unknown', JSON.stringify(body));
    }
    const badIds = interpretShopAnalysisResponse(ok({ outcome: 'shop_exists', existingShopId: 'nope' }));
    assert.ok(badIds.kind === 'error');
    const badSubmission = interpretShopAnalysisResponse(ok({ outcome: 'analyzed', submissionId: 'x' }));
    assert.ok(badSubmission.kind === 'error');
  });
});

describe('interpretShopAnalysisResponse — errors', () => {
  it('401 is an expired session', () => {
    const result = interpretShopAnalysisResponse(fail(401));
    assert.ok(result.kind === 'error');
    assert.equal(result.code, 'session_expired');
    assert.equal(result.retryable, false);
  });

  it('400 is an invalid URL, with the https message when the server said https', () => {
    const https = interpretShopAnalysisResponse(fail(400, 'Seules les adresses https:// peuvent être analysées.'));
    assert.ok(https.kind === 'error' && https.message === ANALYSIS_MESSAGES.https_only);
    const other = interpretShopAnalysisResponse(fail(400, 'Requête invalide.'));
    assert.ok(other.kind === 'error' && other.message === ANALYSIS_MESSAGES.invalid_url);
  });

  it('404 and 409 are submission problems', () => {
    assert.ok(interpretShopAnalysisResponse(fail(404)).kind === 'error');
    const locked = interpretShopAnalysisResponse(fail(409));
    assert.ok(locked.kind === 'error' && locked.code === 'submission_locked');
  });

  it('429 is a temporary limit, with Retry-After, or a run already in progress', () => {
    const limited = interpretShopAnalysisResponse(fail(429, 'Trop d’analyses récentes. Réessaie plus tard.', '720'));
    assert.ok(limited.kind === 'error');
    assert.equal(limited.code, 'rate_limited');
    assert.equal(limited.message, ANALYSIS_MESSAGES.rate_limited);
    assert.equal(limited.retryAfterSeconds, 720);
    assert.equal(limited.retryable, true);

    const running = interpretShopAnalysisResponse(fail(429, 'Une analyse est déjà en cours.', '30'));
    assert.ok(running.kind === 'error' && running.code === 'analysis_running');
  });

  it('5xx is a temporary unavailability', () => {
    for (const status of [500, 502, 503, 504]) {
      const result = interpretShopAnalysisResponse(fail(status));
      assert.ok(result.kind === 'error' && result.code === 'unavailable' && result.retryable, String(status));
      assert.equal(result.message, ANALYSIS_MESSAGES.unavailable);
    }
  });

  it('no HTTP answer is a network problem', () => {
    const result = interpretShopAnalysisResponse({ status: null, body: null, retryAfter: null });
    assert.ok(result.kind === 'error' && result.code === 'network');
  });

  it('never shows a server or provider message to the user', () => {
    const leak = 'provider stack trace sk-live-secret 10.0.0.5';
    for (const status of [400, 401, 404, 409, 429, 500, 503]) {
      const result = interpretShopAnalysisResponse(fail(status, leak));
      assert.ok(result.kind === 'error');
      assert.equal(result.message.includes('sk-live'), false);
      assert.equal(result.message.includes('10.0.0.5'), false);
    }
  });
});

describe('retryHint', () => {
  it('turns seconds into a short hint', () => {
    assert.equal(retryHint(null), null);
    assert.equal(retryHint(30), 'Réessayez dans une minute.');
    assert.equal(retryHint(720), 'Réessayez dans 12 min.');
  });
});
