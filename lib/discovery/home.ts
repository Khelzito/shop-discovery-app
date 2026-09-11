export type HomeSectionKey = 'for_you' | 'hidden_gems' | 'new';

export type HomeDiscoveryRow = {
  section: HomeSectionKey;
  shop_id: string;
  position: number;
};

export type HomeDiscoveryIds = {
  forYou: string[];
  hiddenGems: string[];
  newest: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Network-boundary parser. Unknown rows are ignored, duplicates never render twice. */
export function parseHomeDiscoveryRows(value: unknown): HomeDiscoveryIds {
  const result: HomeDiscoveryIds = { forYou: [], hiddenGems: [], newest: [] };
  if (!Array.isArray(value)) return result;

  const seen = new Set<string>();
  const rows = value
    .filter(isRow)
    .sort((a, b) => sectionOrder(a.section) - sectionOrder(b.section) || a.position - b.position);

  for (const row of rows) {
    if (seen.has(row.shop_id)) continue;
    seen.add(row.shop_id);
    if (row.section === 'for_you') result.forYou.push(row.shop_id);
    else if (row.section === 'hidden_gems') result.hiddenGems.push(row.shop_id);
    else result.newest.push(row.shop_id);
  }
  return result;
}

export function allHomeIds(ids: HomeDiscoveryIds): string[] {
  return [...ids.forYou, ...ids.hiddenGems, ...ids.newest];
}

function isRow(value: unknown): value is HomeDiscoveryRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<HomeDiscoveryRow>;
  return (
    (row.section === 'for_you' || row.section === 'hidden_gems' || row.section === 'new') &&
    typeof row.shop_id === 'string' && UUID.test(row.shop_id) &&
    typeof row.position === 'number' && Number.isInteger(row.position) && row.position > 0
  );
}

function sectionOrder(section: HomeSectionKey): number {
  return section === 'for_you' ? 0 : section === 'hidden_gems' ? 1 : 2;
}

/** Category diversity without random reshuffling: defer consecutive repeats. */
export function diversifyShops<T extends { primaryCategory: { slug: string } | null }>(
  shops: readonly T[],
  count: number
): T[] {
  const picked: T[] = [];
  const deferred: T[] = [];
  let last: string | null = null;
  for (const shop of shops) {
    if (picked.length >= count) break;
    const category = shop.primaryCategory?.slug ?? null;
    if (category !== null && category === last) deferred.push(shop);
    else { picked.push(shop); last = category; }
  }
  for (const shop of deferred) {
    if (picked.length >= count) break;
    picked.push(shop);
  }
  return picked;
}
