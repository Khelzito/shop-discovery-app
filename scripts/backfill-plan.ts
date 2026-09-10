/**
 * Deciding which shops still need an embedding.
 *
 * A tested module rather than a line in the script, because the previous
 * version of that line was wrong in a way that cost money and looked fine:
 *
 *     const stored = existing.get(shop.id);        // a raw PostgREST row
 *     isEmbeddingStale(stored, hash)               // reads stored.sourceHash
 *
 * The row carries `source_hash`; the helper read `sourceHash`. That is
 * `undefined`, which is neither null nor equal to the current hash, so EVERY
 * shop was reported stale. Ten correct, already-stored embeddings would have
 * been re-embedded and re-paid on every run, and the first run could not
 * reveal it because the table was empty.
 *
 * So this module works on the DATABASE shape — snake_case, exactly as
 * PostgREST returns it — and never on a hand-rewritten copy of it. And it
 * returns a REASON rather than a boolean: "stale" with no explanation is what
 * let a field-name typo pass for a legitimate cache miss.
 */

/** A row of `public.shop_embeddings`, as PostgREST returns it. */
export type StoredEmbeddingRow = {
  shop_id: string;
  source_hash?: string | null;
  dimensions?: number | null;
  embedding_model?: string | null;
  embedding_version?: string | null;
  source_kind?: string | null;
};

/** What a current row must agree with. */
export type EmbeddingExpectation = {
  model: string;
  sourceKind: string;
  version: string;
  dimensions: number;
};

export const STALE_REASONS = [
  'missing',
  'model_changed',
  'source_kind_changed',
  'version_changed',
  'dimensions_changed',
  'no_stored_hash',
  'hash_changed',
  'forced',
  'unknown_store',
] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

/**
 * Why a stored embedding must be regenerated, or null when it is current.
 *
 * Checks run cheapest-and-most-diagnostic first, so the reason reported is
 * the most specific true one rather than whichever check happened to be last.
 */
export function embeddingStaleReason(
  stored: StoredEmbeddingRow | null | undefined,
  currentHash: string,
  expected: EmbeddingExpectation
): StaleReason | null {
  if (!stored) {
    return 'missing';
  }
  if (stored.embedding_model !== expected.model) {
    return 'model_changed';
  }
  if (stored.source_kind !== expected.sourceKind) {
    return 'source_kind_changed';
  }
  // The version is already inside the hash, so this is redundant for rows this
  // script wrote. It is kept for rows an OLDER script wrote, which hashed a
  // differently-shaped text and would otherwise be trusted on a hash collision
  // of our own making.
  if (stored.embedding_version !== expected.version) {
    return 'version_changed';
  }
  if (stored.dimensions !== expected.dimensions) {
    return 'dimensions_changed';
  }
  if (typeof stored.source_hash !== 'string' || stored.source_hash.length === 0) {
    return 'no_stored_hash';
  }
  if (stored.source_hash !== currentHash) {
    return 'hash_changed';
  }
  return null;
}

/**
 * Rows keyed by shop id.
 *
 * A row without a usable `shop_id` is dropped rather than keyed under
 * `undefined`, which would silently mark one arbitrary shop as current.
 */
export function indexStoredEmbeddings(
  rows: readonly StoredEmbeddingRow[] | null | undefined
): Map<string, StoredEmbeddingRow> {
  const index = new Map<string, StoredEmbeddingRow>();
  if (!Array.isArray(rows)) {
    return index;
  }
  for (const row of rows) {
    if (row && typeof row.shop_id === 'string' && row.shop_id.length > 0) {
      index.set(row.shop_id, row);
    }
  }
  return index;
}

export type PlannedShop = {
  shopId: string;
  hash: string;
  /** Null when the stored embedding is current. */
  stale: StaleReason | null;
};

export type PlanInput = {
  /** One entry per published shop, with its freshly computed hash. */
  shops: readonly { shopId: string; hash: string }[];
  stored: ReadonlyMap<string, StoredEmbeddingRow>;
  expected: EmbeddingExpectation;
  /** Re-embed everything regardless of what is stored. */
  force?: boolean;
  /**
   * False when the store could not be read at all — no service-role key.
   *
   * Everything is then treated as stale, because "we could not look" is not
   * the same as "it is not there". A real run re-checks before spending.
   */
  storeReadable?: boolean;
};

export type BackfillPlan = {
  planned: PlannedShop[];
  total: number;
  current: number;
  toEmbed: number;
  /**
   * Calls that WOULD be made. A dry run computes this and stops; no provider
   * is ever constructed unless the run is confirmed.
   */
  providerCalls: number;
};

export function buildBackfillPlan(input: PlanInput, batchSize: number): BackfillPlan {
  const storeReadable = input.storeReadable !== false;

  const planned: PlannedShop[] = input.shops.map(({ shopId, hash }) => {
    if (input.force === true) {
      return { shopId, hash, stale: 'forced' };
    }
    if (!storeReadable) {
      return { shopId, hash, stale: 'unknown_store' };
    }
    return {
      shopId,
      hash,
      stale: embeddingStaleReason(input.stored.get(shopId), hash, input.expected),
    };
  });

  const toEmbed = planned.filter((entry) => entry.stale !== null).length;
  const size = Math.max(1, batchSize);

  return {
    planned,
    total: planned.length,
    current: planned.length - toEmbed,
    toEmbed,
    // Zero when nothing is stale — the number this whole module exists to
    // make honest.
    providerCalls: Math.ceil(toEmbed / size),
  };
}
