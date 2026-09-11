import { supabase } from '@/lib/supabase';
import type { HomeDiscoveryIds, HomeSectionKey } from '@/lib/discovery/home';
import { allHomeIds, diversifyShops, parseHomeDiscoveryRows } from '@/lib/discovery/home';
import { getShopsByIds } from '@/data/shops';
import type { Shop } from '@/types/shop';

export type DiscoverySource = 'home' | 'explore' | 'search' | 'favorites' | 'direct';
export type HomeDiscovery = { forYou: Shop[]; hiddenGems: Shop[]; newest: Shop[] };

export async function getPersonalizedHome(limitEach = 6): Promise<HomeDiscovery> {
  if (!supabase) throw new Error('Supabase is not configured');
  const bounded = Math.max(1, Math.min(Math.trunc(limitEach), 6));
  // Ask for extra candidates so the client can enforce category diversity
  // without randomising or weakening the server ranking.
  const candidateLimit = Math.min(bounded * 2, 12);
  const { data, error } = await supabase.rpc('home_discovery', { p_limit_each: candidateLimit });
  if (error) throw new Error(`Home discovery failed: ${error.code ?? 'unknown'}`);

  const ids = parseHomeDiscoveryRows(data);
  const shops = await getShopsByIds(allHomeIds(ids));
  const byId = new Map(shops.map((shop) => [shop.id, shop]));
  return {
    forYou: diversifyShops(resolve(ids.forYou, byId), bounded),
    hiddenGems: diversifyShops(resolve(ids.hiddenGems, byId), Math.min(bounded, 4)),
    newest: resolve(ids.newest, byId).slice(0, Math.min(bounded, 3)),
  };
}

export async function recordHomeImpressions(ids: HomeDiscoveryIds): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return;

  const rows = [
    ...ids.forYou.map((shop_id) => ({ user_id: userId, shop_id, section: 'for_you' as const })),
    ...ids.hiddenGems.map((shop_id) => ({ user_id: userId, shop_id, section: 'hidden_gems' as const })),
    ...ids.newest.map((shop_id) => ({ user_id: userId, shop_id, section: 'new' as const })),
  ];
  if (rows.length === 0) return;
  const { error } = await supabase.from('home_impressions').insert(rows);
  if (__DEV__ && error) console.warn('[discovery] home impression not recorded', { code: error.code });
}

export async function recordShopView(shopId: string, source: DiscoverySource): Promise<void> {
  await recordEvent('shop_views', shopId, source);
}

export async function recordOutboundClick(shopId: string, source: DiscoverySource): Promise<void> {
  await recordEvent('outbound_clicks', shopId, source);
}

export type SearchInteractionType = 'shop_open' | 'favorite' | 'outbound_click';

export async function recordSearchInteraction(
  searchId: string | null | undefined,
  shopId: string,
  interactionType: SearchInteractionType,
  position: number | null = null
): Promise<void> {
  if (!supabase || !searchId || !UUID.test(searchId)) return;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return;
  const safePosition = typeof position === 'number' && Number.isInteger(position) && position >= 0 ? position : null;
  const { error } = await supabase.from('search_interactions').insert({
    search_id: searchId,
    shop_id: shopId,
    user_id: userId,
    interaction_type: interactionType,
    position: safePosition,
  });
  if (__DEV__ && error) console.warn('[discovery] search interaction not recorded', { code: error.code });
}

async function recordEvent(table: 'shop_views' | 'outbound_clicks', shopId: string, source: DiscoverySource): Promise<void> {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return;
  const { error } = await supabase.from(table).insert({ user_id: userId, shop_id: shopId, source });
  if (__DEV__ && error) console.warn(`[discovery] ${table} not recorded`, { code: error.code });
}

function resolve(ids: readonly string[], byId: ReadonlyMap<string, Shop>): Shop[] {
  return ids.map((id) => byId.get(id)).filter((shop): shop is Shop => shop !== undefined);
}

export function homeIdsFromDiscovery(home: HomeDiscovery): HomeDiscoveryIds {
  return {
    forYou: home.forYou.map((shop) => shop.id),
    hiddenGems: home.hiddenGems.map((shop) => shop.id),
    newest: home.newest.map((shop) => shop.id),
  };
}

export function safeDiscoverySource(value: unknown): DiscoverySource {
  return value === 'home' || value === 'explore' || value === 'search' || value === 'favorites'
    ? value
    : 'direct';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sectionKeyForLabel(value: HomeSectionKey): HomeSectionKey { return value; }
