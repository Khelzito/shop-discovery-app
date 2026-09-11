import { supabase } from '@/lib/supabase';

export type PersistedPreferences = {
  interests: string[];
  deliveryCountry: string;
};

const DEFAULT_COUNTRY = 'FR';

export async function loadPreferences(userId: string): Promise<PersistedPreferences> {
  if (!supabase) return { interests: [], deliveryCountry: DEFAULT_COUNTRY };

  const [prefs, interests] = await Promise.all([
    supabase.from('user_preferences').select('shipping_country_code').eq('user_id', userId).maybeSingle(),
    supabase
      .from('user_interest_categories')
      .select('categories(slug)')
      .eq('user_id', userId),
  ]);
  if (prefs.error) throw prefs.error;
  if (interests.error) throw interests.error;

  const slugs = (interests.data ?? [])
    .map((row) => {
      const category = row.categories as { slug?: unknown } | { slug?: unknown }[] | null;
      const value = Array.isArray(category) ? category[0]?.slug : category?.slug;
      return typeof value === 'string' ? value : null;
    })
    .filter((slug): slug is string => slug !== null);

  const country = prefs.data?.shipping_country_code;
  return {
    interests: slugs,
    deliveryCountry: typeof country === 'string' && country.length === 2 ? country : DEFAULT_COUNTRY,
  };
}

export async function setInterest(userId: string, slug: string, active: boolean): Promise<void> {
  if (!supabase) return;
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category?.id) throw new Error('Unknown category');

  if (active) {
    const { error } = await supabase.from('user_interest_categories').upsert(
      { user_id: userId, category_id: category.id },
      { onConflict: 'user_id,category_id', ignoreDuplicates: true }
    );
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from('user_interest_categories')
    .delete()
    .eq('user_id', userId)
    .eq('category_id', category.id);
  if (error) throw error;
}

export async function setShippingCountry(userId: string, countryCode: string): Promise<void> {
  if (!supabase) return;
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('Invalid country code');
  const { error } = await supabase.from('user_preferences').upsert(
    { user_id: userId, shipping_country_code: code },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}
