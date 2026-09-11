import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MERCHANT_SUBMISSION_STATUSES } from '../../ai/contracts/merchant-trust';
import { submissionStatusView, submissionTitle, toSubmissionSummaries } from './submissions';

const ID_A = '88742c16-8ddd-4177-ada3-6677e3121fd4';
const ID_B = '494a3e32-0000-4000-8000-000000000002';
const SHOP = '78d97b85-0000-4000-8000-000000000009';

describe('submission status for the merchant', () => {
  it('uses the agreed wording and the one action that fits', () => {
    const expected = {
      draft: ['Brouillon', 'edit', false],
      submitted: ['En cours de vérification', null, false],
      processing: ['Vérification en cours', null, false],
      needs_changes: ['Modifications demandées', 'edit', true],
      approved: ['Boutique approuvée', 'manage', false],
      rejected: ['Demande refusée', null, true],
    } as const;
    for (const status of MERCHANT_SUBMISSION_STATUSES) {
      const view = submissionStatusView(status)!;
      assert.deepEqual([view.label, view.action, view.showNote], expected[status], status);
    }
  });

  it('knows nothing of other statuses', () => {
    for (const status of ['published', 'verified', '', null, 3]) {
      assert.equal(submissionStatusView(status), null);
    }
  });

  it('promises no delay', () => {
    for (const status of MERCHANT_SUBMISSION_STATUSES) {
      assert.equal(/\d|heure|jour|semaine|bientôt|rapidement/i.test(submissionStatusView(status)!.description), false, status);
    }
  });
});

describe('submission summaries', () => {
  it('keeps valid rows, newest first, with a readable title', () => {
    const summaries = toSubmissionSummaries([
      { id: ID_A, status: 'draft', website_url: 'https://example.com/', proposed_name: null, review_note: null, shop_id: null, updated_at: '2026-09-10T10:00:00Z' },
      { id: ID_B, status: 'approved', website_url: 'https://www.maison-leon.fr/', proposed_name: '  Maison Léon ', review_note: ' ', shop_id: SHOP, updated_at: '2026-09-11T10:00:00Z' },
      { id: 'nope', status: 'draft', website_url: 'https://x.fr/', updated_at: '2026-09-11T10:00:00Z' },
      { id: ID_A, status: 'published', website_url: 'https://x.fr/', updated_at: '2026-09-11T10:00:00Z' },
      null,
    ]);
    assert.deepEqual(
      summaries.map((summary) => [summary.id, summary.status, submissionTitle(summary), summary.reviewNote, summary.shopId]),
      [
        [ID_B, 'approved', 'Maison Léon', null, SHOP],
        [ID_A, 'draft', 'example.com', null, null],
      ]
    );
  });
});
