import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODERATION_OUTCOMES } from '../../ai/contracts/merchant-trust';
import { checkModerationNote, MODERATION_MESSAGES, moderationResultOf, toModerationDetail, toModerationList } from './moderation';

const SUB_A = '88742c16-8ddd-4177-ada3-6677e3121fd4';
const SUB_B = '494a3e32-0000-4000-8000-000000000002';
const SHOP = '78d97b85-0000-4000-8000-000000000009';

describe('moderation note', () => {
  it('is optional to approve and required to ask for changes or refuse', () => {
    assert.equal(checkModerationNote('approve', ''), null);
    assert.equal(checkModerationNote('needs_changes', '   '), MODERATION_MESSAGES.note_required);
    assert.equal(checkModerationNote('reject', ''), MODERATION_MESSAGES.note_required);
    assert.equal(checkModerationNote('reject', 'Site inaccessible.'), null);
    assert.equal(checkModerationNote('approve', 'x'.repeat(501)), MODERATION_MESSAGES.invalid_note);
  });
});

describe('moderation result', () => {
  it('reports decisions and refusals from the function, never a raw error', () => {
    assert.deepEqual(moderationResultOf({ data: [{ outcome: 'approved', created_shop_id: SHOP }], error: null }), {
      ok: true,
      outcome: 'approved',
      shopId: SHOP,
      message: MODERATION_MESSAGES.approved,
    });
    assert.equal(moderationResultOf({ data: [{ outcome: 'needs_changes', created_shop_id: null }], error: null }).ok, true);
    for (const outcome of MODERATION_OUTCOMES.filter((value) => !['approved', 'needs_changes', 'rejected'].includes(value))) {
      const result = moderationResultOf({ data: [{ outcome }], error: null });
      assert.deepEqual([result.ok, result.outcome], [false, outcome]);
    }
    assert.equal(moderationResultOf({ data: null, error: { code: '42501' } }).outcome, 'not_moderator');
    assert.equal(moderationResultOf({ data: null, error: { code: '40001' } }).outcome, 'failed');
    assert.equal(moderationResultOf({ data: [{ outcome: 'published' }], error: null }).outcome, 'failed');
  });
});

describe('moderation list', () => {
  it('separates the queue from requests waiting on the merchant, oldest first', () => {
    const list = toModerationList([
      { submission_id: SUB_A, status: 'submitted', website_url: 'https://example.com/', proposed_name: 'Example', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-11T09:00:00Z' },
      { submission_id: SUB_B, status: 'submitted', website_url: 'https://b.fr/', proposed_name: null, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-10T09:00:00Z' },
      { submission_id: SHOP, status: 'needs_changes', website_url: 'https://c.fr/', proposed_name: 'C', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-10T09:00:00Z' },
      { submission_id: 'x', status: 'submitted', created_at: '', updated_at: '' },
      { submission_id: SUB_A, status: 'approved', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-10T09:00:00Z' },
    ]);
    assert.deepEqual(list.toReview.map((item) => [item.id, item.host]), [[SUB_B, 'b.fr'], [SUB_A, 'example.com']]);
    assert.deepEqual(list.awaitingMerchant.map((item) => item.id), [SHOP]);
  });
});

describe('moderation detail', () => {
  it('shows a hostile profile as plain values, without its trust claims', () => {
    const detail = toModerationDetail({
      id: SUB_A,
      status: 'submitted',
      websiteUrl: 'https://example.com/',
      submitterRef: '3843ac2a-ffff',
      ownSubmission: false,
      hostAlreadyListed: true,
      merchantProfile: {
        name: '  Example\n Domain ',
        verified: true,
        trustScore: 100,
        status: 'published',
        audience: ['women', 'robots'],
        imageUrls: ['https://cdn.example.com/a.jpg', 'http://insecure.example.com/b.jpg', 'javascript:alert(1)'],
        tags: ['streetwear', 42],
      },
      analysis: {
        sameHost: true,
        observed: { name: { value: 'Example Domain' }, imageUrls: [{ value: 'https://cdn.example.com/a.jpg' }] },
        inferred: { primaryCategory: { value: 'mode', confidence: 0.9 } },
        warnings: ['low_confidence'],
      },
    })!;
    assert.equal(detail.profile?.name, 'Example Domain');
    assert.deepEqual(detail.profile?.audience, ['women']);
    assert.deepEqual(detail.profile?.imageUrls, ['https://cdn.example.com/a.jpg']);
    assert.deepEqual(detail.profile?.tags, ['streetwear']);
    assert.equal(detail.submitterRef, '3843ac2a');
    assert.equal(detail.hostAlreadyListed, true);
    assert.equal(detail.suggested?.primaryCategory, 'mode');
    assert.equal(JSON.stringify(detail).includes('trustScore'), false);
    assert.equal(JSON.stringify(detail.profile).includes('published'), false);
  });

  it('refuses a malformed document', () => {
    for (const value of [null, [], { id: 'x', websiteUrl: 'https://a.fr', status: 'submitted' }, { id: SUB_A, status: 'submitted' }]) {
      assert.equal(toModerationDetail(value), null);
    }
  });
});
