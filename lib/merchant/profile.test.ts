import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSubmissionUpdate,
  FORBIDDEN_PAYLOAD_KEY,
  MAX_SUBMITTED_DATA_BYTES,
  originOf,
  PROFILE_MESSAGES,
  profileDraftFromProposal,
  validateMerchantProfile,
  type MerchantProfileDraft,
  type MerchantTaxonomy,
} from './profile';

const URL_ = 'https://maison-leon.fr/';
const NOW = new Date('2026-09-11T12:00:00.000Z');

const TAXONOMY: MerchantTaxonomy = {
  categories: [
    { slug: 'mode', name: 'Mode' },
    { slug: 'bijoux', name: 'Bijoux' },
    { slug: 'sneakers', name: 'Sneakers' },
    { slug: 'maison', name: 'Maison' },
    { slug: 'sport', name: 'Sport' },
  ],
  tags: [
    { slug: 'streetwear', name: 'Streetwear' },
    { slug: 'minimaliste', name: 'Minimaliste' },
    { slug: 'vintage', name: 'Vintage' },
    { slug: 'casual', name: 'Casual' },
    { slug: 'premium', name: 'Premium' },
    { slug: 'fait-main', name: 'Fait main' },
  ],
};

function proposal() {
  return {
    proposalVersion: 'shop-analysis/2',
    analyzedAt: '2026-09-11T10:00:00.000Z',
    websiteUrl: URL_,
    domain: 'maison-leon.fr',
    observed: {
      name: { value: 'Maison Léon', source: { kind: 'html_meta', key: 'og:site_name' } },
      description: { value: 'Vêtements urbains coupés en petites séries.', source: { kind: 'html_meta', key: 'description' } },
      language: null,
      countryCode: null,
      currency: null,
      logoUrl: { value: 'https://cdn.maison-leon.fr/logo.png', source: { kind: 'json_ld', type: 'Organization', path: 'logo' } },
      imageUrls: [
        { value: 'https://maison-leon.fr/a.jpg', source: { kind: 'html_meta', key: 'og:image' } },
        { value: 'https://maison-leon.fr/b.jpg', source: { kind: 'page_text' } },
      ],
      socialLinks: [],
      siteSectionLabels: [],
    },
    inferred: {
      shortDescription: { value: 'Streetwear coupé en petites séries.', confidence: 0.8 },
      primaryCategory: { value: 'mode', confidence: 0.9 },
      secondaryCategories: [{ value: 'bijoux', confidence: 0.4 }],
      audience: { value: ['unisex'], confidence: 0.6 },
      pricePositioning: { value: 'mid', confidence: 0.5 },
      styles: [{ value: 'streetwear', confidence: 0.8 }],
      values: [{ value: 'séries limitées', confidence: 0.5 }],
      productTypes: [{ value: 'sweats', confidence: 0.7 }],
      tags: [{ value: 'streetwear', confidence: 0.7 }],
      summary: { value: 'Une marque urbaine.', confidence: 0.7 },
    },
    warnings: [],
    unsupported: ['verification', 'trust_score'],
    degraded: false,
  };
}

function edit(draft: MerchantProfileDraft, patch: Partial<MerchantProfileDraft['values']>): MerchantProfileDraft {
  return { ...draft, values: { ...draft.values, ...patch } };
}

describe('profileDraftFromProposal', () => {
  it('fills the form from observed and inferred values, remembering where each came from', () => {
    const draft = profileDraftFromProposal(proposal(), URL_);
    assert.equal(draft.values.name, 'Maison Léon');
    assert.equal(draft.values.shortDescription, 'Streetwear coupé en petites séries.');
    assert.equal(draft.values.primaryCategory, 'mode');
    assert.deepEqual(draft.values.secondaryCategories, ['bijoux']);
    assert.deepEqual(draft.values.audience, ['unisex']);
    assert.equal(draft.values.pricePositioning, 'mid');
    assert.equal(draft.values.logoUrl, 'https://cdn.maison-leon.fr/logo.png');
    assert.deepEqual(draft.availableImageUrls, ['https://maison-leon.fr/a.jpg', 'https://maison-leon.fr/b.jpg']);
    assert.equal(draft.initialOrigins.name, 'site');
    assert.equal(draft.initialOrigins.shortDescription, 'ai');
    assert.equal(draft.initialOrigins.primaryCategory, 'ai');
    assert.equal(draft.initialOrigins.logoUrl, 'site');
  });

  it('uses the site description when the model proposed none', () => {
    const source = proposal();
    source.inferred.shortDescription = null as never;
    const draft = profileDraftFromProposal(source, URL_);
    assert.equal(draft.values.shortDescription, 'Vêtements urbains coupés en petites séries.');
    assert.equal(draft.initialOrigins.shortDescription, 'site');
  });

  it('never throws on a missing or malformed proposal, and leaves an empty form', () => {
    for (const bad of [null, undefined, 'text', [], { observed: 'x', inferred: 42 }, { inferred: { styles: [{ value: 7 }], audience: { value: ['aliens'] } } }]) {
      const draft = profileDraftFromProposal(bad, URL_);
      assert.equal(draft.values.name, '');
      assert.equal(draft.values.primaryCategory, null);
      assert.deepEqual(draft.values.styles, []);
      assert.deepEqual(draft.values.audience, []);
      assert.deepEqual(draft.initialOrigins, {});
    }
  });

  it('ignores non-https images and logos', () => {
    const source = proposal();
    source.observed.logoUrl.value = 'http://maison-leon.fr/logo.png';
    source.observed.imageUrls[0]!.value = 'javascript:alert(1)';
    const draft = profileDraftFromProposal(source, URL_);
    assert.equal(draft.values.logoUrl, null);
    assert.deepEqual(draft.availableImageUrls, ['https://maison-leon.fr/b.jpg']);
  });
});

describe('originOf', () => {
  it('keeps the suggestion origin only while the value is untouched', () => {
    const draft = profileDraftFromProposal(proposal(), URL_);
    assert.equal(originOf(draft, 'primaryCategory'), 'ai');
    assert.equal(originOf(edit(draft, { primaryCategory: 'bijoux' }), 'primaryCategory'), 'merchant');
    assert.equal(originOf(draft, 'name'), 'site');
    assert.equal(originOf(draft, 'tags'), 'ai');
    assert.equal(originOf(profileDraftFromProposal(null, URL_), 'name'), 'merchant');
  });
});

describe('validateMerchantProfile', () => {
  it('cleans and returns the final profile with origins', () => {
    const draft = edit(profileDraftFromProposal(proposal(), URL_), {
      name: '  Maison   Léon  ',
      styles: ['streetwear', 'Streetwear', '  minimal  ', ''],
      secondaryCategories: ['bijoux', 'mode', 'jardinage'],
      tags: ['streetwear', 'made-in-france'],
      imageUrls: ['https://maison-leon.fr/b.jpg', 'https://evil.example/x.jpg'],
    });
    const result = validateMerchantProfile(draft, TAXONOMY, NOW);
    assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
    const profile = result.profile;
    assert.equal(profile.profileVersion, 'merchant-profile/1');
    assert.equal(profile.editedAt, NOW.toISOString());
    assert.equal(profile.websiteUrl, URL_);
    assert.equal(profile.name, 'Maison Léon');
    assert.deepEqual(profile.styles, ['streetwear', 'minimal']);
    assert.deepEqual(profile.secondaryCategories, ['bijoux']);
    assert.deepEqual(profile.tags, ['streetwear']);
    assert.deepEqual(profile.imageUrls, ['https://maison-leon.fr/b.jpg']);
    assert.equal(profile.origins.primaryCategory, 'ai');
    assert.equal(profile.origins.name, 'merchant');
    assert.equal(profile.origins.styles, 'merchant');
  });

  it('keeps only the logo the site exposed', () => {
    const draft = edit(profileDraftFromProposal(proposal(), URL_), { logoUrl: 'https://attacker.example/logo.png' });
    const result = validateMerchantProfile(draft, TAXONOMY, NOW);
    assert.ok(result.ok);
    assert.equal(result.profile.logoUrl, null);
  });

  it('requires a name and bounds its length', () => {
    const draft = profileDraftFromProposal(proposal(), URL_);
    const empty = validateMerchantProfile(edit(draft, { name: '   ' }), TAXONOMY, NOW);
    assert.ok(!empty.ok && empty.errors.name === PROFILE_MESSAGES.nameRequired);
    const long = validateMerchantProfile(edit(draft, { name: 'a'.repeat(121) }), TAXONOMY, NOW);
    assert.ok(!long.ok && long.errors.name === PROFILE_MESSAGES.nameTooLong);
  });

  it('bounds the description', () => {
    const result = validateMerchantProfile(edit(profileDraftFromProposal(proposal(), URL_), { shortDescription: 'x'.repeat(281) }), TAXONOMY, NOW);
    assert.ok(!result.ok && result.errors.shortDescription === PROFILE_MESSAGES.descriptionTooLong);
  });

  it('requires a primary category from the live taxonomy', () => {
    const draft = profileDraftFromProposal(proposal(), URL_);
    const missing = validateMerchantProfile(edit(draft, { primaryCategory: null }), TAXONOMY, NOW);
    assert.ok(!missing.ok && missing.errors.primaryCategory === PROFILE_MESSAGES.categoryRequired);
    const unknown = validateMerchantProfile(edit(draft, { primaryCategory: 'jardinage' }), TAXONOMY, NOW);
    assert.ok(!unknown.ok && unknown.errors.primaryCategory === PROFILE_MESSAGES.categoryUnknown);
    const noTaxonomy = validateMerchantProfile(draft, { categories: [], tags: [] }, NOW);
    assert.ok(!noTaxonomy.ok && noTaxonomy.errors.primaryCategory === PROFILE_MESSAGES.taxonomyUnavailable);
  });

  it('enforces the list limits', () => {
    const draft = profileDraftFromProposal(proposal(), URL_);
    const secondary = validateMerchantProfile(edit(draft, { secondaryCategories: ['bijoux', 'sneakers', 'maison', 'sport'] }), TAXONOMY, NOW);
    assert.ok(!secondary.ok && secondary.errors.secondaryCategories === PROFILE_MESSAGES.tooManySecondary);
    const tags = validateMerchantProfile(edit(draft, { tags: TAXONOMY.tags.map((tag) => tag.slug) }), TAXONOMY, NOW);
    assert.ok(!tags.ok && tags.errors.tags === PROFILE_MESSAGES.tooManyTags);
    const long = validateMerchantProfile(edit(draft, { values: ['x'.repeat(41)] }), TAXONOMY, NOW);
    assert.ok(!long.ok && long.errors.values === PROFILE_MESSAGES.itemTooLong);
    const many = validateMerchantProfile(edit(draft, { productTypes: Array.from({ length: 9 }, (_, i) => `type ${i}`) }), TAXONOMY, NOW);
    assert.ok(!many.ok && many.errors.productTypes === PROFILE_MESSAGES.tooManyItems);
  });
});

describe('buildSubmissionUpdate', () => {
  const profileOf = () => {
    const result = validateMerchantProfile(profileDraftFromProposal(proposal(), URL_), TAXONOMY, NOW);
    assert.ok(result.ok);
    return result.profile;
  };

  it('writes submitted_data and status only, with the proposal and the profile', () => {
    const existing = { aiProposal: proposal(), shop_id: 'forged', verified: true, reviewed_by: 'someone', status: 'approved' };
    const result = buildSubmissionUpdate(existing, profileOf());
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.update).sort(), ['status', 'submitted_data']);
    assert.equal(result.update.status, 'submitted');
    assert.deepEqual(Object.keys(result.update.submitted_data).sort(), ['aiProposal', 'merchantProfile']);
  });

  it('carries no trust, verification, publication, ownership or status key in the profile', () => {
    const result = buildSubmissionUpdate({ aiProposal: proposal() }, profileOf());
    assert.ok(result.ok);
    const profileJson = JSON.stringify(result.update.submitted_data.merchantProfile);
    assert.equal(FORBIDDEN_PAYLOAD_KEY.test(profileJson), false);
    for (const key of ['verified', 'trust', 'published', 'approved', 'shop_id', 'reviewed_by', 'legal_entity', 'certification']) {
      assert.equal(profileJson.includes(`"${key}"`), false, key);
    }
  });

  it('works without a proposal (manual entry)', () => {
    const result = buildSubmissionUpdate({}, profileOf());
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.update.submitted_data), ['merchantProfile']);
  });

  it('drops an oversized proposal rather than the merchant’s profile', () => {
    const huge = { ...proposal(), padding: 'x'.repeat(MAX_SUBMITTED_DATA_BYTES) };
    const result = buildSubmissionUpdate({ aiProposal: huge }, profileOf());
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.update.submitted_data), ['merchantProfile']);
  });
});
