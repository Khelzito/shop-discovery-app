import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Shop } from '../../types/shop';
import { buildHomeSections } from './home-sections';
import { toShop, type ShopRow } from './mapper';

const SHOP_ID = '3f2a9c10-5b1e-4d7a-9f3c-2b8e6a1d4c05';

function row(overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    id: SHOP_ID,
    slug: 'maison-leon',
    name: 'Maison Léon',
    short_description: 'Vestiaire urbain en séries courtes.',
    website_url: 'https://maison-leon.example',
    country_code: 'FR',
    city: 'Roubaix',
    price_level: 2,
    audience: 'unisex',
    published_at: '2026-09-01T10:00:00.000Z',
    shop_images: null,
    shop_categories: null,
    shop_tags: null,
    shop_verifications: null,
    ...overrides,
  };
}

describe('toShop', () => {
  it('maps a full row', () => {
    const shop = toShop(
      row({
        shop_categories: [
          { is_primary: true, categories: { slug: 'mode', name: 'Mode' } },
          { is_primary: false, categories: { slug: 'sneakers', name: 'Sneakers' } },
        ],
        shop_tags: [{ tags: { slug: 'minimaliste', name: 'Minimaliste' } }],
        shop_images: [
          { external_url: 'https://img.example/cover.jpg', storage_path: null, image_type: 'cover', position: 0, alt_text: null },
        ],
        shop_verifications: [{ verification_type: 'domain', verified_at: '2026-08-01T00:00:00Z' }],
      })
    );

    assert.equal(shop.name, 'Maison Léon');
    assert.equal(shop.slug, 'maison-leon');
    assert.equal(shop.shortDescription, 'Vestiaire urbain en séries courtes.');
    assert.equal(shop.city, 'Roubaix');
    assert.equal(shop.priceLevel, 2);
    assert.equal(shop.verified, true);
    assert.equal(shop.images.cover, 'https://img.example/cover.jpg');
  });

  it('preserves the database uuid untouched', () => {
    assert.equal(toShop(row()).id, SHOP_ID);
  });

  it('keeps every nullable column null rather than inventing a value', () => {
    const shop = toShop(
      row({
        short_description: null,
        website_url: null,
        country_code: null,
        city: null,
        price_level: null,
        published_at: null,
      })
    );

    assert.equal(shop.shortDescription, null);
    assert.equal(shop.websiteUrl, null);
    assert.equal(shop.countryCode, null);
    assert.equal(shop.city, null);
    assert.equal(shop.priceLevel, null);
    assert.equal(shop.publishedAt, null);
    assert.equal(shop.primaryCategory, null);
    assert.deepEqual(shop.categories, []);
    assert.deepEqual(shop.tags, []);
  });

  it('treats a whitespace-only string as absent', () => {
    assert.equal(toShop(row({ city: '   ' })).city, null);
  });

  it('rejects an out-of-range price level', () => {
    assert.equal(toShop(row({ price_level: 9 })).priceLevel, null);
    assert.equal(toShop(row({ price_level: 0 })).priceLevel, null);
  });
});

describe('website URL', () => {
  it('keeps a valid https URL', () => {
    assert.equal(toShop(row({ website_url: 'https://a.example' })).websiteUrl, 'https://a.example');
  });

  it('keeps a valid http URL', () => {
    assert.equal(toShop(row({ website_url: 'http://a.example' })).websiteUrl, 'http://a.example');
  });

  it('drops anything that is not http(s), so it can never reach the browser', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://a.example',
      'data:text/html,<script>',
      'not a url',
      '',
      '   ',
    ]) {
      assert.equal(toShop(row({ website_url: url })).websiteUrl, null, `${url} must be rejected`);
    }
  });
});

describe('images', () => {
  const image = (url: string, type: string, position: number) => ({
    external_url: url,
    storage_path: null,
    image_type: type,
    position,
    alt_text: null,
  });

  it('falls back to no cover when the shop has no images', () => {
    const shop = toShop(row({ shop_images: [] }));
    assert.equal(shop.images.cover, null);
    assert.deepEqual(shop.images.gallery, []);
  });

  it('prefers the cover image over gallery images', () => {
    const shop = toShop(
      row({
        shop_images: [
          image('https://img.example/g1.jpg', 'gallery', 0),
          image('https://img.example/cover.jpg', 'cover', 5),
        ],
      })
    );
    assert.equal(shop.images.cover, 'https://img.example/cover.jpg');
    assert.deepEqual(shop.images.gallery, ['https://img.example/g1.jpg']);
  });

  it('orders gallery images by position', () => {
    const shop = toShop(
      row({
        shop_images: [
          image('https://img.example/c.jpg', 'gallery', 3),
          image('https://img.example/a.jpg', 'gallery', 1),
          image('https://img.example/b.jpg', 'gallery', 2),
        ],
      })
    );
    assert.equal(shop.images.cover, 'https://img.example/a.jpg');
    assert.deepEqual(shop.images.gallery, ['https://img.example/b.jpg', 'https://img.example/c.jpg']);
  });

  it('promotes the first gallery image when no cover exists', () => {
    const shop = toShop(row({ shop_images: [image('https://img.example/only.jpg', 'gallery', 0)] }));
    assert.equal(shop.images.cover, 'https://img.example/only.jpg');
    assert.deepEqual(shop.images.gallery, []);
  });

  it('skips a storage-backed image, since no bucket is configured yet', () => {
    const shop = toShop(
      row({
        shop_images: [
          { external_url: null, storage_path: 'shops/x/cover.jpg', image_type: 'cover', position: 0, alt_text: null },
        ],
      })
    );
    assert.equal(shop.images.cover, null);
  });

  it('skips a malformed image URL rather than rendering a broken image', () => {
    const shop = toShop(row({ shop_images: [image('not-a-url', 'cover', 0)] }));
    assert.equal(shop.images.cover, null);
  });

  it('excludes logos from the gallery', () => {
    const shop = toShop(
      row({
        shop_images: [
          image('https://img.example/logo.png', 'logo', 0),
          image('https://img.example/g.jpg', 'gallery', 1),
        ],
      })
    );
    assert.equal(shop.images.cover, 'https://img.example/g.jpg');
    assert.deepEqual(shop.images.gallery, []);
  });
});

describe('categories and tags', () => {
  it('puts the primary category first whatever the row order', () => {
    const shop = toShop(
      row({
        shop_categories: [
          { is_primary: false, categories: { slug: 'sneakers', name: 'Sneakers' } },
          { is_primary: true, categories: { slug: 'mode', name: 'Mode' } },
        ],
      })
    );
    assert.equal(shop.primaryCategory?.slug, 'mode');
    assert.deepEqual(
      shop.categories.map((category) => category.slug),
      ['mode', 'sneakers']
    );
  });

  it('falls back to the first category when none is primary', () => {
    const shop = toShop(
      row({
        shop_categories: [
          { is_primary: false, categories: { slug: 'tech', name: 'Tech' } },
          { is_primary: false, categories: { slug: 'bijoux', name: 'Bijoux' } },
        ],
      })
    );
    // Alphabetical once no primary exists, so the label is stable.
    assert.equal(shop.primaryCategory?.slug, 'bijoux');
  });

  it('survives a null embedded relation', () => {
    const shop = toShop(
      row({
        shop_categories: [{ is_primary: true, categories: null }],
        shop_tags: [{ tags: null }],
      })
    );
    assert.deepEqual(shop.categories, []);
    assert.deepEqual(shop.tags, []);
  });

  it('deduplicates repeated categories and tags', () => {
    const shop = toShop(
      row({
        shop_categories: [
          { is_primary: false, categories: { slug: 'mode', name: 'Mode' } },
          { is_primary: false, categories: { slug: 'mode', name: 'Mode' } },
        ],
        shop_tags: [
          { tags: { slug: 'vintage', name: 'Vintage' } },
          { tags: { slug: 'vintage', name: 'Vintage' } },
        ],
      })
    );
    assert.equal(shop.categories.length, 1);
    assert.deepEqual(shop.tags, ['Vintage']);
  });
});

describe('verification', () => {
  it('is false when no approved record is visible', () => {
    assert.equal(toShop(row({ shop_verifications: null })).verified, false);
    assert.equal(toShop(row({ shop_verifications: [] })).verified, false);
  });

  it('is true when an approved record is visible', () => {
    const shop = toShop(
      row({ shop_verifications: [{ verification_type: 'business', verified_at: '2026-01-01T00:00:00Z' }] })
    );
    assert.equal(shop.verified, true);
  });
});

describe('the client model exposes nothing internal', () => {
  it('drops any column that is not part of the consumer contract', () => {
    // A row carrying internal columns, as if the select had been widened.
    const contaminated = {
      ...row(),
      status: 'draft',
      created_by: 'some-user-uuid',
      claimed_at: '2026-01-01T00:00:00Z',
      long_description: 'internal',
      shop_verifications: [
        { verification_type: 'identity', verified_at: '2026-01-01T00:00:00Z', evidence: { passport: 'secret' }, reviewed_by: 'admin-uuid' },
      ],
    } as unknown as ShopRow;

    const shop = toShop(contaminated);

    assert.deepEqual(
      Object.keys(shop).sort(),
      [
        'audience',
        'categories',
        'city',
        'countryCode',
        'id',
        'images',
        'name',
        'primaryCategory',
        'priceLevel',
        'publishedAt',
        'shortDescription',
        'slug',
        'tags',
        'verified',
        'websiteUrl',
      ].sort()
    );

    const serialized = JSON.stringify(shop);
    for (const leaked of ['passport', 'secret', 'admin-uuid', 'some-user-uuid', 'draft', 'claimed_at']) {
      assert.equal(serialized.includes(leaked), false, `${leaked} must not reach the client model`);
    }
  });
});

describe('buildHomeSections', () => {
  function shop(id: string, category: string, verified = false): Shop {
    return {
      id,
      slug: id,
      name: id,
      shortDescription: null,
      websiteUrl: null,
      countryCode: 'FR',
      city: null,
      priceLevel: null,
      audience: null,
      categories: [{ slug: category, name: category, isPrimary: true }],
      primaryCategory: { slug: category, name: category, isPrimary: true },
      tags: [],
      images: { cover: null, gallery: [] },
      verified,
      publishedAt: '2026-09-01T00:00:00Z',
    };
  }

  it('never places the same shop in two sections', () => {
    const shops = Array.from({ length: 18 }, (_, index) =>
      shop(`shop-${index}`, ['mode', 'tech', 'bijoux'][index % 3]!, index % 4 === 0)
    );
    const sections = buildHomeSections(shops);
    const ids = [...sections.forYou, ...sections.hiddenGems, ...sections.newest].map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, 'a shop appeared twice on one Home render');
  });

  it('is deterministic', () => {
    const shops = Array.from({ length: 12 }, (_, index) => shop(`shop-${index}`, 'mode'));
    const a = buildHomeSections(shops);
    const b = buildHomeSections(shops);
    assert.deepEqual(a, b);
  });

  it('handles an empty catalogue', () => {
    const sections = buildHomeSections([]);
    assert.deepEqual(sections, { forYou: [], hiddenGems: [], newest: [] });
  });

  it('still fills Nouveautés when the catalogue is tiny', () => {
    const sections = buildHomeSections([shop('a', 'mode'), shop('b', 'tech')]);
    assert.equal(sections.newest.length, 2);
  });

  it('prefers verified shops for Pépites cachées', () => {
    const shops = [
      ...Array.from({ length: 6 }, (_, i) => shop(`new-${i}`, 'mode')),
      shop('plain', 'tech', false),
      shop('trusted', 'bijoux', true),
    ];
    const sections = buildHomeSections(shops);
    assert.equal(sections.hiddenGems[0]?.id, 'trusted');
  });
});
