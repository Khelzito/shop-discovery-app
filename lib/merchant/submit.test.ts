import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FORBIDDEN_PAYLOAD_KEY, profileDraftFromProposal, type MerchantSubmissionUpdate, type MerchantTaxonomy } from './profile';
import {
  singleFlight,
  SUBMIT_MESSAGES,
  submitOutcomeOf,
  submitReview,
  withoutImages,
  type SubmitOutcome,
} from './submit';

const SUBMISSION = '88742c16-8ddd-4177-ada3-6677e3121fd4';
const URL_ = 'https://maison-leon.fr/';
const NOW = new Date('2026-09-11T12:00:00.000Z');
const TAXONOMY: MerchantTaxonomy = {
  categories: [{ slug: 'mode', name: 'Mode' }],
  tags: [{ slug: 'streetwear', name: 'Streetwear' }],
};
const A = 'https://maison-leon.fr/a.webp';
const B = 'https://maison-leon.fr/b.webp';

function proposal() {
  return {
    observed: {
      name: { value: 'Maison Léon', source: { kind: 'html_meta', key: 'og:site_name' } },
      imageUrls: [
        { value: A, source: { kind: 'page_text' } },
        { value: B, source: { kind: 'page_text' } },
      ],
    },
    inferred: { primaryCategory: { value: 'mode', confidence: 0.9 }, tags: [{ value: 'streetwear', confidence: 0.8 }] },
  };
}

function recorder(outcome: SubmitOutcome | Error = { ok: true }) {
  const calls: { submissionId: string; update: MerchantSubmissionUpdate }[] = [];
  const send = async (submissionId: string, update: MerchantSubmissionUpdate) => {
    calls.push({ submissionId, update });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, send };
}

function input(send: ReturnType<typeof recorder>['send'], overrides: Partial<Parameters<typeof submitReview>[0]> = {}) {
  return {
    submissionId: SUBMISSION,
    submittedData: { aiProposal: proposal(), shop_id: 'forged', verified: true },
    draft: profileDraftFromProposal(proposal(), URL_),
    taxonomy: TAXONOMY,
    now: NOW,
    send,
    ...overrides,
  };
}

describe('submitOutcomeOf — the guarded UPDATE … RETURNING id', () => {
  it('is a success only when a row came back', () => {
    assert.deepEqual(submitOutcomeOf({ data: { id: SUBMISSION }, error: null }), { ok: true });
    assert.deepEqual(submitOutcomeOf({ data: null, error: null }), { ok: false, reason: 'locked' });
  });

  it('separates an expired session, a refusal and any other failure', () => {
    assert.deepEqual(submitOutcomeOf({ data: null, error: { code: 'PGRST301' } }), { ok: false, reason: 'session_expired' });
    assert.deepEqual(submitOutcomeOf({ data: null, error: { code: '42501' } }), { ok: false, reason: 'forbidden' });
    assert.deepEqual(submitOutcomeOf({ data: null, error: { code: '23514' } }), { ok: false, reason: 'failed' });
    assert.deepEqual(submitOutcomeOf({ data: null, error: { code: null } }), { ok: false, reason: 'failed' });
  });
});

describe('submitReview', () => {
  it('sends once, to the existing submission, with submitted_data and status only', async () => {
    const { calls, send } = recorder();
    const result = await submitReview(input(send));

    assert.deepEqual(result, { kind: 'sent' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.submissionId, SUBMISSION);
    const update = calls[0]!.update;
    assert.deepEqual(Object.keys(update).sort(), ['status', 'submitted_data']);
    assert.equal(update.status, 'submitted');
    assert.deepEqual(Object.keys(update.submitted_data).sort(), ['aiProposal', 'merchantProfile']);
    const profile = update.submitted_data.merchantProfile as { websiteUrl: string; name: string };
    assert.equal(profile.websiteUrl, URL_);
    assert.equal(profile.name, 'Maison Léon');
    assert.equal(FORBIDDEN_PAYLOAD_KEY.test(JSON.stringify(update.submitted_data.merchantProfile)), false);
  });

  it('does not send an invalid profile', async () => {
    const { calls, send } = recorder();
    const draft = profileDraftFromProposal(proposal(), URL_);
    draft.values.primaryCategory = null;
    const result = await submitReview(input(send, { draft }));
    assert.equal(result.kind, 'invalid');
    assert.equal(calls.length, 0);
  });

  it('never reports success when the request fails or throws', async () => {
    const thrown = await submitReview(input(recorder(new Error('Network request failed')).send));
    assert.deepEqual(thrown, { kind: 'rejected', message: SUBMIT_MESSAGES.failed });

    const forbidden = await submitReview(input(recorder({ ok: false, reason: 'forbidden' }).send));
    assert.deepEqual(forbidden, { kind: 'rejected', message: SUBMIT_MESSAGES.forbidden });

    const locked = await submitReview(input(recorder({ ok: false, reason: 'locked' }).send));
    assert.deepEqual(locked, { kind: 'rejected', message: SUBMIT_MESSAGES.locked });

    const expired = await submitReview(input(recorder({ ok: false, reason: 'session_expired' }).send));
    assert.deepEqual(expired, { kind: 'rejected', message: SUBMIT_MESSAGES.session_expired });
  });

  it('never submits an image that failed to load', async () => {
    const { calls, send } = recorder();
    await submitReview(input(send, { unavailableImageUrls: [A] }));
    const profile = calls[0]!.update.submitted_data.merchantProfile as { imageUrls: string[]; origins: { imageUrls: string } };
    assert.deepEqual(profile.imageUrls, [B]);
    assert.equal(profile.origins.imageUrls, 'site');
  });
});

describe('withoutImages', () => {
  it('removes failed URLs from the values, the suggestion and the available list', () => {
    const draft = withoutImages(profileDraftFromProposal(proposal(), URL_), [A, B]);
    assert.deepEqual(draft.values.imageUrls, []);
    assert.deepEqual(draft.initial.imageUrls, []);
    assert.deepEqual(draft.availableImageUrls, []);
    assert.equal(draft.initialOrigins.imageUrls, undefined);
  });

  it('returns the draft untouched when nothing failed', () => {
    const original = profileDraftFromProposal(proposal(), URL_);
    assert.equal(withoutImages(original, []), original);
  });
});

describe('singleFlight — double tap', () => {
  it('refuses a second call while the first is in flight, and sends once', async () => {
    const run = singleFlight<{ kind: string }>();
    const { calls, send } = recorder();
    const task = () => submitReview(input(send));

    const first = run(task);
    const second = run(task);
    assert.ok(first !== null);
    assert.equal(second, null);
    await first;
    assert.equal(calls.length, 1);

    const third = run(task);
    assert.ok(third !== null);
    await third;
    assert.equal(calls.length, 2);
  });

  it('releases after a failure too', async () => {
    const run = singleFlight<void>();
    await assert.rejects(run(async () => { throw new Error('boom'); })!);
    assert.ok(run(async () => undefined) !== null);
  });
});
