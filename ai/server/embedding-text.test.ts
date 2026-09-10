import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AI_EMBEDDING_TEXT_VERSION,
  EMBEDDING_TEXT_VERSION,
  LONG_DESCRIPTION_BUDGET,
  buildShopAiEmbeddingText,
  buildShopEmbeddingText,
  embeddingSourceHash,
} from './embedding-text.ts';
import type { ShopEmbeddingSource } from './embedding-text.ts';

/**
 * The embedded text is the semantic index, so these tests are about
 * reproducibility above all: the same shop must produce the same string
 * regardless of the order the database returned its categories and tags in,
 * because two shops embedded from differently-shaped text are not comparable.
 */

const MAISON_LEON: ShopEmbeddingSource = {
  name: 'Maison Léon',
  shortDescription: 'Vestiaire urbain coupé et assemblé à Roubaix.',
  countryCode: 'FR',
  city: 'Roubaix',
  audience: 'unisex',
  categories: [
    { name: 'Accessoires', isPrimary: false },
    { name: 'Mode', isPrimary: true },
  ],
  tags: ['Streetwear', 'Made in France'],
};

describe('buildShopEmbeddingText', () => {
  it('produces labelled lines in a fixed order', () => {
    assert.equal(
      buildShopEmbeddingText(MAISON_LEON),
      [
        'Nom: Maison Léon',
        'Catégories: Mode, Accessoires',
        'Public: unisex',
        'Pays: FR',
        'Ville: Roubaix',
        'Tags: Made in France, Streetwear',
        'Description: Vestiaire urbain coupé et assemblé à Roubaix.',
      ].join('\n')
    );
  });

  it('is stable when the database returns collections in another order', () => {
    const shuffled: ShopEmbeddingSource = {
      ...MAISON_LEON,
      categories: [
        { name: 'Mode', isPrimary: true },
        { name: 'Accessoires', isPrimary: false },
      ],
      tags: ['Made in France', 'Streetwear'],
    };
    assert.equal(buildShopEmbeddingText(shuffled), buildShopEmbeddingText(MAISON_LEON));
  });

  it('keeps the primary category first', () => {
    const text = buildShopEmbeddingText({
      name: 'Cadence',
      categories: [
        { name: 'Mode', isPrimary: false },
        { name: 'Sport', isPrimary: true },
      ],
    });
    assert.match(text, /^Catégories: Sport, Mode$/m);
  });

  it('omits absent fields entirely rather than emitting empty labels', () => {
    const text = buildShopEmbeddingText({ name: 'Minimal', countryCode: null, city: '   ' });
    assert.equal(text, 'Nom: Minimal');
  });

  it('deduplicates tags and drops blanks', () => {
    const text = buildShopEmbeddingText({
      name: 'Doublons',
      tags: ['Vintage', ' Vintage ', '', '   ', 'Premium'],
    });
    assert.match(text, /^Tags: Premium, Vintage$/m);
  });

  it('collapses newlines so one field stays one line', () => {
    const text = buildShopEmbeddingText({
      name: 'Multi',
      shortDescription: 'Première ligne.\n\nSeconde   ligne.',
    });
    assert.equal(text, 'Nom: Multi\nDescription: Première ligne. Seconde ligne.');
  });

  it('truncates a long description at a word boundary', () => {
    const long = 'mot '.repeat(400).trim();
    const text = buildShopEmbeddingText({ name: 'Bavard', longDescription: long });
    const about = text.split('\n').find((line) => line.startsWith('À propos: '))!;
    const body = about.slice('À propos: '.length);

    assert.ok(body.length <= LONG_DESCRIPTION_BUDGET + 1, `got ${body.length}`);
    assert.ok(body.endsWith('…'));
    assert.equal(body.includes('mo…'), false);
  });

  it('leaves a short description untouched', () => {
    const text = buildShopEmbeddingText({ name: 'Bref', longDescription: 'Trois mots ici.' });
    assert.equal(text, 'Nom: Bref\nÀ propos: Trois mots ici.');
  });

  it('carries no identifier, url or moderation state', () => {
    // Nothing sensitive can leak through similarity if it is never embedded.
    const text = buildShopEmbeddingText(MAISON_LEON);
    for (const forbidden of ['http', 'id-', 'published', 'draft', '@']) {
      assert.equal(text.includes(forbidden), false, `embedded text leaked ${forbidden}`);
    }
  });
});

describe('buildShopAiEmbeddingText', () => {
  it('is built from inferences only, and stays separate from the factual text', () => {
    const text = buildShopAiEmbeddingText({
      summary: 'Marque de vêtements sobres.',
      detectedStyles: ['minimaliste', 'sobre'],
      detectedValues: ['écoresponsable'],
      keywords: ['coton', 'basique'],
    });

    assert.equal(
      text,
      [
        'Résumé: Marque de vêtements sobres.',
        'Styles: minimaliste, sobre',
        'Valeurs: écoresponsable',
        'Mots-clés: basique, coton',
      ].join('\n')
    );
    // No declared fact appears here: the two source kinds cannot be confused.
    assert.equal(text.includes('Pays:'), false);
    assert.equal(text.includes('Nom:'), false);
  });

  it('returns an empty string when nothing was inferred', () => {
    assert.equal(buildShopAiEmbeddingText({}), '');
  });
});

describe('embeddingSourceHash', () => {
  it('is deterministic', async () => {
    const text = buildShopEmbeddingText(MAISON_LEON);
    const a = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, text);
    const b = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, text);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('changes when the text changes', async () => {
    const a = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, 'Nom: A');
    const b = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, 'Nom: B');
    assert.notEqual(a, b);
  });

  it('changes when only the version changes', async () => {
    // A reshaped text invalidates every stored vector, including the ones
    // whose own text did not move.
    const text = buildShopEmbeddingText(MAISON_LEON);
    const a = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, text);
    const b = await embeddingSourceHash(AI_EMBEDDING_TEXT_VERSION, text);
    assert.notEqual(a, b);
  });
});
