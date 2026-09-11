import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSubmissionUpdate,
  originOf,
  profileDraftFromProposal,
  profileDraftFromSubmission,
  validateMerchantProfile,
} from './profile';

const URL_A = 'https://cdn.maison-leon.fr/a.jpg';
const URL_B = 'https://cdn.maison-leon.fr/b.jpg';
const LOGO = 'https://cdn.maison-leon.fr/logo.png';

const PROPOSAL = {
  observed: {
    name: { value: 'Maison Léon' },
    logoUrl: { value: LOGO },
    imageUrls: [{ value: URL_A }, { value: URL_B }],
  },
  inferred: {
    primaryCategory: { value: 'mode', confidence: 0.9 },
    tags: [{ value: 'streetwear', confidence: 0.8 }],
  },
};

const TAXONOMY = {
  categories: [{ slug: 'mode', name: 'Mode' }, { slug: 'bijoux', name: 'Bijoux' }],
  tags: [{ slug: 'streetwear', name: 'Streetwear' }, { slug: 'minimaliste', name: 'Minimaliste' }],
};

function merchantProfile(overrides: Record<string, unknown> = {}) {
  return {
    profileVersion: 'merchant-profile/1',
    editedAt: '2026-09-11T10:00:00.000Z',
    websiteUrl: 'https://maison-leon.fr/',
    name: 'Maison Léon Paris',
    shortDescription: 'Vestiaire urbain.',
    primaryCategory: 'mode',
    secondaryCategories: ['bijoux'],
    audience: ['unisex', 'robots'],
    pricePositioning: 'mid',
    styles: ['Urbain'],
    values: [],
    productTypes: ['Sweats'],
    tags: ['minimaliste'],
    logoUrl: 'https://evil.example.com/logo.png',
    imageUrls: [URL_B, 'https://evil.example.com/x.jpg'],
    origins: {},
    ...overrides,
  };
}

describe('needs_changes: editing the request sent back', () => {
  it('starts from the merchant’s last profile, within what the site exposed', () => {
    const draft = profileDraftFromSubmission({ aiProposal: PROPOSAL, merchantProfile: merchantProfile() }, 'https://maison-leon.fr/');
    assert.equal(draft.values.name, 'Maison Léon Paris');
    assert.deepEqual(draft.values.secondaryCategories, ['bijoux']);
    assert.deepEqual(draft.values.audience, ['unisex']);
    assert.equal(draft.values.pricePositioning, 'mid');
    assert.deepEqual(draft.values.tags, ['minimaliste']);
    // A logo or image the site never exposed is dropped.
    assert.equal(draft.values.logoUrl, null);
    assert.deepEqual(draft.values.imageUrls, [URL_B]);
    assert.deepEqual(draft.availableImageUrls, [URL_A, URL_B]);
  });

  it('keeps the suggestions as the reference for origins', () => {
    const draft = profileDraftFromSubmission({ aiProposal: PROPOSAL, merchantProfile: merchantProfile() }, 'https://maison-leon.fr/');
    assert.equal(originOf(draft, 'name'), 'merchant');
    assert.equal(originOf(draft, 'primaryCategory'), 'ai');
  });

  it('is the proposal form when there is no readable profile', () => {
    const expected = profileDraftFromProposal(PROPOSAL, 'https://maison-leon.fr/');
    assert.deepEqual(profileDraftFromSubmission({ aiProposal: PROPOSAL }, 'https://maison-leon.fr/'), expected);
    assert.deepEqual(profileDraftFromSubmission({ aiProposal: PROPOSAL, merchantProfile: merchantProfile({ profileVersion: 'x' }) }, 'https://maison-leon.fr/'), expected);
    assert.deepEqual(profileDraftFromSubmission({}, 'https://maison-leon.fr/', PROPOSAL), expected);
  });

  it('sends again as submitted, with the same two keys only', () => {
    const existing = { aiProposal: PROPOSAL, merchantProfile: merchantProfile(), verified: true, status: 'approved' };
    const draft = profileDraftFromSubmission(existing, 'https://maison-leon.fr/');
    const validated = validateMerchantProfile(draft, TAXONOMY, new Date('2026-09-12T10:00:00Z'));
    assert.ok(validated.ok);
    const payload = buildSubmissionUpdate(existing, validated.profile);
    assert.ok(payload.ok);
    assert.equal(payload.update.status, 'submitted');
    assert.deepEqual(Object.keys(payload.update.submitted_data).sort(), ['aiProposal', 'merchantProfile']);
  });
});
