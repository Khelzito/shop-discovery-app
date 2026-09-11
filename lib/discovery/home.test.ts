import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allHomeIds, diversifyShops, parseHomeDiscoveryRows } from './home';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('parseHomeDiscoveryRows', () => {
  it('groups, orders and de-duplicates rows across sections', () => {
    const ids = parseHomeDiscoveryRows([
      { section: 'new', shop_id: C, position: 1 },
      { section: 'for_you', shop_id: B, position: 2 },
      { section: 'hidden_gems', shop_id: A, position: 1 },
      { section: 'for_you', shop_id: A, position: 1 },
    ]);
    assert.deepEqual(ids, { forYou: [A, B], hiddenGems: [], newest: [C] });
    assert.deepEqual(allHomeIds(ids), [A, B, C]);
  });

  it('ignores malformed network rows', () => {
    assert.deepEqual(parseHomeDiscoveryRows([{ section: 'for_you', shop_id: 'bad', position: 1 }, null]), {
      forYou: [], hiddenGems: [], newest: [],
    });
  });
});


describe('diversifyShops', () => {
  it('defers consecutive categories while preserving deterministic order', () => {
    const shops = [
      { id: 'a', primaryCategory: { slug: 'mode' } },
      { id: 'b', primaryCategory: { slug: 'mode' } },
      { id: 'c', primaryCategory: { slug: 'maison' } },
      { id: 'd', primaryCategory: { slug: 'sport' } },
    ];
    assert.deepEqual(diversifyShops(shops, 4).map((shop) => shop.id), ['a', 'c', 'd', 'b']);
  });
});
