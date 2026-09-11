import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canEditShop,
  editValuesOf,
  MANAGEMENT_MESSAGES,
  manageShopResultOf,
  toManagedShop,
  validateShopEdit,
} from './management';

const SHOP = '78d97b85-0000-4000-8000-000000000009';
const IMAGE_A = 'a0000000-0000-4000-8000-000000000001';
const IMAGE_B = 'b0000000-0000-4000-8000-000000000002';

const TAXONOMY = {
  categories: [{ slug: 'mode', name: 'Mode' }, { slug: 'bijoux', name: 'Bijoux' }, { slug: 'maison', name: 'Maison' }, { slug: 'sport', name: 'Sport' }, { slug: 'tech', name: 'Tech' }],
  tags: [{ slug: 'streetwear', name: 'Streetwear' }, { slug: 'minimaliste', name: 'Minimaliste' }],
};

const ROW = {
  id: SHOP,
  slug: 'maison-leon',
  name: 'Maison Léon',
  status: 'published',
  website_url: 'https://www.maison-leon.fr/',
  short_description: 'Vestiaire urbain.',
  audience: 'unisex',
  price_level: 2,
  published_at: '2026-09-11T10:00:00Z',
  shop_categories: [
    { is_primary: false, categories: { slug: 'bijoux' } },
    { is_primary: true, categories: { slug: 'mode' } },
  ],
  shop_tags: [{ tags: { slug: 'streetwear', kind: 'style' } }, { tags: { slug: 'made-in-france', kind: 'origin' } }],
  shop_images: [
    { id: IMAGE_B, external_url: 'https://cdn.maison-leon.fr/b.jpg', image_type: 'gallery', position: 1 },
    { id: IMAGE_A, external_url: 'https://cdn.maison-leon.fr/a.jpg', image_type: 'cover', position: 0 },
  ],
  shop_verifications: [{ verification_type: 'domain', verified_at: '2026-09-11T10:00:00Z' }],
};

describe('managed shop', () => {
  it('lets owners and admins edit, as the existing policy does — not editors', () => {
    assert.equal(canEditShop('owner'), true);
    assert.equal(canEditShop('admin'), true);
    assert.equal(canEditShop('editor'), false);
    assert.equal(canEditShop(null), false);
  });

  it('reads the row, keeping origin tags out of the editable list', () => {
    const shop = toManagedShop(ROW, 'owner')!;
    assert.equal(shop.primaryCategory, 'mode');
    assert.deepEqual(shop.secondaryCategories, ['bijoux']);
    assert.deepEqual(shop.tags, ['streetwear']);
    assert.deepEqual(shop.images.map((image) => [image.id, image.type]), [[IMAGE_A, 'cover'], [IMAGE_B, 'gallery']]);
    assert.equal(shop.domainVerified, true);
    assert.equal(shop.host, 'www.maison-leon.fr');
    assert.equal(toManagedShop(ROW, null), null);
    assert.equal(toManagedShop({ ...ROW, id: 'x' }, 'owner'), null);
  });
});

describe('shop edit', () => {
  it('sends content and classification only', () => {
    const shop = toManagedShop(ROW, 'owner')!;
    const values = { ...editValuesOf(shop), name: '  Maison   Léon Paris ', removedImageIds: [IMAGE_B, 'not-a-uuid'] };
    const result = validateShopEdit(SHOP, values, TAXONOMY);
    assert.ok(result.ok);
    assert.deepEqual(Object.keys(result.params).sort(), [
      'p_audience',
      'p_name',
      'p_price_level',
      'p_primary_category',
      'p_removed_image_ids',
      'p_secondary_categories',
      'p_shop_id',
      'p_short_description',
      'p_tags',
    ]);
    assert.equal(result.params.p_name, 'Maison Léon Paris');
    assert.deepEqual(result.params.p_removed_image_ids, [IMAGE_B]);
    for (const forbidden of ['status', 'slug', 'website', 'published', 'claimed', 'verif', 'member', 'trust']) {
      assert.equal(JSON.stringify(Object.keys(result.params)).includes(forbidden), false, forbidden);
    }
  });

  it('refuses an empty name, no primary category and too many choices', () => {
    const shop = toManagedShop(ROW, 'owner')!;
    const result = validateShopEdit(
      SHOP,
      { ...editValuesOf(shop), name: ' ', primaryCategory: 'inconnue', secondaryCategories: ['bijoux', 'maison', 'sport', 'tech'] },
      TAXONOMY
    );
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.errors, {
      name: MANAGEMENT_MESSAGES.nameRequired,
      primaryCategory: MANAGEMENT_MESSAGES.categoryRequired,
      secondaryCategories: MANAGEMENT_MESSAGES.tooManySecondary,
    });
  });

  it('drops unknown tags and the primary from secondaries', () => {
    const shop = toManagedShop(ROW, 'owner')!;
    const result = validateShopEdit(SHOP, { ...editValuesOf(shop), secondaryCategories: ['mode', 'bijoux'], tags: ['streetwear', 'made-in-france', 'x'] }, TAXONOMY);
    assert.ok(result.ok);
    assert.deepEqual(result.params.p_secondary_categories, ['bijoux']);
    assert.deepEqual(result.params.p_tags, ['streetwear']);
  });

  it('maps the function answer', () => {
    assert.deepEqual(manageShopResultOf({ data: 'updated', error: null }), { ok: true });
    assert.deepEqual(manageShopResultOf({ data: 'shop_locked', error: null }), { ok: false, reason: 'shop_locked', message: MANAGEMENT_MESSAGES.shop_locked });
    const forbidden = manageShopResultOf({ data: null, error: { code: '42501' } });
    assert.equal(!forbidden.ok && forbidden.message, MANAGEMENT_MESSAGES.forbidden);
    const failed = manageShopResultOf({ data: 'published', error: null });
    assert.equal(!failed.ok && failed.reason, 'failed');
  });
});
