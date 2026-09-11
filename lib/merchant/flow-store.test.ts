import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MerchantFlowStore } from './flow-store';
import { profileDraftFromProposal } from './profile';

const FIRST = '88742c16-8ddd-4177-ada3-6677e3121fd4';
const SECOND = '9fd6fe65-0000-4000-8000-000000000002';

const analysis = (submissionId: string) => ({
  submissionId,
  websiteUrl: 'https://maison-leon.fr/',
  analysis: null,
  proposalSaved: true,
});

describe('MerchantFlowStore', () => {
  it('offers the current submission for reuse by a new analysis in the same flow', () => {
    const store = new MerchantFlowStore();
    assert.equal(store.submissionToReuse(), null);
    store.rememberAnalysis(analysis(FIRST));
    assert.equal(store.submissionToReuse(), FIRST);
    assert.equal(store.lastAnalysis?.submissionId, FIRST);
  });

  it('keeps unsent drafts', () => {
    const store = new MerchantFlowStore();
    const draft = profileDraftFromProposal(null, 'https://maison-leon.fr/');
    store.saveDraft(FIRST, draft);
    assert.equal(store.draftFor(FIRST), draft);
  });

  it('forgets a sent submission completely, and never reuses it', () => {
    const store = new MerchantFlowStore();
    const draft = profileDraftFromProposal(null, 'https://maison-leon.fr/');
    store.rememberAnalysis(analysis(FIRST));
    store.saveDraft(FIRST, draft);

    store.markSent(FIRST);

    assert.equal(store.lastAnalysis, null);
    assert.equal(store.submissionToReuse(), null);
    assert.equal(store.draftFor(FIRST), null);
    assert.equal(store.isSent(FIRST), true);

    // A late save (an effect still running) and a stale analysis are ignored.
    store.saveDraft(FIRST, draft);
    store.rememberAnalysis(analysis(FIRST));
    assert.equal(store.draftFor(FIRST), null);
    assert.equal(store.submissionToReuse(), null);
  });

  it('lets a later analysis start from its own new submission', () => {
    const store = new MerchantFlowStore();
    store.rememberAnalysis(analysis(FIRST));
    store.markSent(FIRST);
    store.rememberAnalysis(analysis(SECOND));
    assert.equal(store.submissionToReuse(), SECOND);
  });

  it('does not clear the current analysis when another submission is marked sent', () => {
    const store = new MerchantFlowStore();
    store.rememberAnalysis(analysis(SECOND));
    store.markSent(FIRST);
    assert.equal(store.submissionToReuse(), SECOND);
  });

  it('keeps its methods stable, so an effect depending on them does not re-run', () => {
    const store = new MerchantFlowStore();
    const { saveDraft, markSent } = store;
    store.rememberAnalysis(analysis(FIRST));
    markSent(FIRST);
    assert.equal(store.saveDraft, saveDraft);
    // Destructured methods keep their instance.
    saveDraft(FIRST, profileDraftFromProposal(null, 'https://maison-leon.fr/'));
    assert.equal(store.draftFor(FIRST), null);
  });
});
