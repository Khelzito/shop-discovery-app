import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const FAVORITES = readFileSync(join(process.cwd(), 'state/favorites.tsx'), 'utf8');
const hydrationEffect = FAVORITES.slice(
  FAVORITES.indexOf('  useEffect(() => {'),
  FAVORITES.indexOf('  const isFavorite')
);

describe('favorites hydration', () => {
  it('hydrates on account changes, not on every optimistic favorite mutation', () => {
    assert.match(hydrationEffect, /\}, \[userId\]\);/);
    assert.doesNotMatch(hydrationEffect, /favoriteIds/);
  });

  it('keeps the account boundary explicit when loading persisted ids', () => {
    assert.match(hydrationEffect, /loadFavoriteIds\(userId\)/);
    assert.match(hydrationEffect, /if \(!userId\) \{[\s\S]*?setFavoriteIds\(new Set\(\)\)/);
  });
});
