import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBackfillPlan,
  embeddingStaleReason,
  indexStoredEmbeddings,
} from './backfill-plan.ts';
import type { EmbeddingExpectation, StoredEmbeddingRow } from './backfill-plan.ts';

/**
 * The first suite is the regression that matters: ten correct stored
 * embeddings must cost nothing. The previous implementation reported all ten
 * stale because it read `sourceHash` from a row carrying `source_hash`.
 */

const EXPECTED: EmbeddingExpectation = {
  model: 'text-embedding-3-small',
  sourceKind: 'shop_profile',
  version: 'shop_profile/1',
  dimensions: 1536,
};

/** A row shaped exactly as PostgREST returns it — snake_case. */
function storedRow(shopId: string, hash: string, overrides: Partial<StoredEmbeddingRow> = {}) {
  return {
    shop_id: shopId,
    source_hash: hash,
    dimensions: 1536,
    embedding_model: 'text-embedding-3-small',
    embedding_version: 'shop_profile/1',
    source_kind: 'shop_profile',
    ...overrides,
  };
}

const CATALOGUE = Array.from({ length: 10 }, (_, i) => ({
  shopId: `shop-${i}`,
  hash: `hash-${i}`.padEnd(64, '0'),
}));

describe('ten stored embeddings cost nothing', () => {
  const stored = indexStoredEmbeddings(CATALOGUE.map((s) => storedRow(s.shopId, s.hash)));

  it('reports 10 current, 0 to embed, 0 provider calls', () => {
    const plan = buildBackfillPlan({ shops: CATALOGUE, stored, expected: EXPECTED }, 32);

    assert.equal(plan.total, 10);
    assert.equal(plan.current, 10);
    assert.equal(plan.toEmbed, 0);
    assert.equal(plan.providerCalls, 0);
  });

  it('marks every entry as not stale, with no reason', () => {
    const plan = buildBackfillPlan({ shops: CATALOGUE, stored, expected: EXPECTED }, 32);
    assert.deepEqual(
      plan.planned.filter((entry) => entry.stale !== null),
      []
    );
  });

  it('reads source_hash from the database shape, not a camelCase copy', () => {
    // The exact defect: a row whose hash lives under source_hash.
    assert.equal(embeddingStaleReason(storedRow('a', 'abc'), 'abc', EXPECTED), null);
    // And proof the old spelling is not consulted any more.
    const camel = { shop_id: 'a', sourceHash: 'abc' } as unknown as StoredEmbeddingRow;
    assert.notEqual(embeddingStaleReason(camel, 'abc', EXPECTED), null);
  });
});

describe('embeddingStaleReason', () => {
  it('reports a missing row', () => {
    assert.equal(embeddingStaleReason(undefined, 'abc', EXPECTED), 'missing');
    assert.equal(embeddingStaleReason(null, 'abc', EXPECTED), 'missing');
  });

  it('reports a changed hash', () => {
    assert.equal(embeddingStaleReason(storedRow('a', 'old'), 'new', EXPECTED), 'hash_changed');
  });

  it('reports each metadata mismatch specifically', () => {
    const cases: [Partial<StoredEmbeddingRow>, string][] = [
      [{ embedding_model: 'text-embedding-3-large' }, 'model_changed'],
      [{ source_kind: 'shop_ai_summary' }, 'source_kind_changed'],
      [{ embedding_version: 'shop_profile/0' }, 'version_changed'],
      [{ dimensions: 768 }, 'dimensions_changed'],
      [{ source_hash: null }, 'no_stored_hash'],
      [{ source_hash: '' }, 'no_stored_hash'],
    ];
    for (const [override, reason] of cases) {
      assert.equal(
        embeddingStaleReason(storedRow('a', 'abc', override), 'abc', EXPECTED),
        reason,
        JSON.stringify(override)
      );
    }
  });

  it('checks metadata before the hash, so the reason is the specific one', () => {
    const row = storedRow('a', 'old', { dimensions: 768 });
    assert.equal(embeddingStaleReason(row, 'new', EXPECTED), 'dimensions_changed');
  });
});

describe('indexStoredEmbeddings', () => {
  it('keys rows by shop id', () => {
    const index = indexStoredEmbeddings([storedRow('a', 'h1'), storedRow('b', 'h2')]);
    assert.equal(index.size, 2);
    assert.equal(index.get('a')?.source_hash, 'h1');
  });

  it('drops a row with no usable shop_id rather than keying it under undefined', () => {
    const rows = [{ source_hash: 'x' }, { shop_id: '', source_hash: 'y' }, storedRow('c', 'h')];
    const index = indexStoredEmbeddings(rows as StoredEmbeddingRow[]);
    assert.deepEqual([...index.keys()], ['c']);
  });

  it('tolerates a null or non-array response', () => {
    assert.equal(indexStoredEmbeddings(null).size, 0);
    assert.equal(indexStoredEmbeddings(undefined).size, 0);
  });
});

describe('buildBackfillPlan', () => {
  const stored = indexStoredEmbeddings(CATALOGUE.map((s) => storedRow(s.shopId, s.hash)));

  it('embeds everything on an empty store', () => {
    const plan = buildBackfillPlan(
      { shops: CATALOGUE, stored: new Map(), expected: EXPECTED },
      32
    );
    assert.equal(plan.toEmbed, 10);
    assert.equal(plan.providerCalls, 1);
    assert.equal(plan.planned.every((entry) => entry.stale === 'missing'), true);
  });

  it('embeds only what is actually stale', () => {
    const partial = indexStoredEmbeddings(
      CATALOGUE.slice(0, 7).map((s) => storedRow(s.shopId, s.hash))
    );
    const plan = buildBackfillPlan({ shops: CATALOGUE, stored: partial, expected: EXPECTED }, 32);
    assert.equal(plan.current, 7);
    assert.equal(plan.toEmbed, 3);
    assert.equal(plan.providerCalls, 1);
  });

  it('treats an unreadable store as entirely stale rather than entirely current', () => {
    // "We could not look" is not "it is not there" — but it must never be
    // read as "everything is fine", which would skip a real backfill.
    const plan = buildBackfillPlan(
      { shops: CATALOGUE, stored, expected: EXPECTED, storeReadable: false },
      32
    );
    assert.equal(plan.toEmbed, 10);
    assert.equal(plan.planned[0]?.stale, 'unknown_store');
  });

  it('honours --force over a current store', () => {
    const plan = buildBackfillPlan(
      { shops: CATALOGUE, stored, expected: EXPECTED, force: true },
      32
    );
    assert.equal(plan.toEmbed, 10);
    assert.equal(plan.planned[0]?.stale, 'forced');
  });

  it('counts provider calls by batch', () => {
    const empty = new Map();
    assert.equal(buildBackfillPlan({ shops: CATALOGUE, stored: empty, expected: EXPECTED }, 4).providerCalls, 3);
    assert.equal(buildBackfillPlan({ shops: CATALOGUE, stored: empty, expected: EXPECTED }, 10).providerCalls, 1);
    assert.equal(buildBackfillPlan({ shops: [], stored: empty, expected: EXPECTED }, 32).providerCalls, 0);
  });
});
