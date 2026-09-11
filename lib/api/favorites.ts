import { supabase } from '@/lib/supabase';

export async function loadFavoriteIds(userId: string): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('favorites')
    .select('shop_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? [])
    .map((row) => (typeof row.shop_id === 'string' ? row.shop_id : null))
    .filter((id): id is string => id !== null);
}

export async function setFavorite(userId: string, shopId: string, active: boolean): Promise<void> {
  if (!supabase) return;
  if (active) {
    const { error } = await supabase.from('favorites').upsert(
      { user_id: userId, shop_id: shopId },
      { onConflict: 'user_id,shop_id', ignoreDuplicates: true }
    );
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('favorites').delete().eq('user_id', userId).eq('shop_id', shopId);
  if (error) throw error;
}
