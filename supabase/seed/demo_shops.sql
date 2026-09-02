-- Demo catalogue for development.
--
-- HOW TO RUN: paste into the Supabase SQL Editor and execute, or pipe it
-- through psql. It is NOT a migration and NOT supabase/seed.sql, on purpose:
--
--   * a migration would carry demo shops into every environment, including
--     production, the first time `db push` runs there;
--   * supabase/seed.sql only runs on `supabase db reset`, which must never be
--     pointed at the linked remote project.
--
-- SAFETY
--   * Idempotent: re-running updates the demo rows and inserts nothing twice.
--   * Non-destructive: there is no DELETE, DROP or TRUNCATE anywhere below.
--     It only ever touches rows whose slug is in the demo list.
--   * Runs as the SQL Editor's privileged role, which is what `status =
--     'published'` requires — no client can publish a shop.
--
-- HONESTY
--   Every shop below is fictional. Names are invented, and every website uses
--   the reserved `.example` TLD so none can resolve to a real business. The
--   photographs are neutral stock images used to judge layout; images showing
--   an identifiable real brand or product were excluded, so nothing here can
--   be mistaken for a real merchant's catalogue (docs/MASTER_SPEC.md §12).

begin;

-- ---------------------------------------------------------------------------
-- Shops
-- ---------------------------------------------------------------------------
--
-- published_at is staggered so "Nouveautés" has a meaningful order instead of
-- ten rows sharing one timestamp.

insert into public.shops (
  slug, name, website_url, short_description, country_code, city,
  price_level, currency_code, audience, is_independent, status, published_at
)
values
  ('maison-leon', 'Maison Léon', 'https://maison-leon.example',
   'Vestiaire urbain coupé et assemblé à Roubaix, en séries courtes et matières lourdes.',
   'FR', 'Roubaix', 2, 'EUR', 'unisex', true, 'published', now() - interval '2 days'),

  ('lune-studio', 'Lune Studio', 'https://lune-studio.example',
   'Bijoux fins en or recyclé, dessinés et façonnés dans un atelier lyonnais.',
   'FR', 'Lyon', 3, 'EUR', 'women', true, 'published', now() - interval '4 days'),

  ('sneaklab', 'SneakLab', 'https://sneaklab.example',
   'Souliers et sneakers en cuir tanné végétal, montés à la main au Portugal.',
   'FR', 'Paris', 3, 'EUR', 'unisex', true, 'published', now() - interval '6 days'),

  ('atelier-noma', 'Atelier Noma', 'https://atelier-noma.example',
   'Mobilier clair et objets de table, chinés et réédités en petite quantité.',
   'FR', 'Nantes', 3, 'EUR', 'all', true, 'published', now() - interval '9 days'),

  ('celeste', 'Céleste', 'https://celeste.example',
   'Soins et maquillage à formules courtes, sans surenchère marketing.',
   'FR', 'Bordeaux', 2, 'EUR', 'women', true, 'published', now() - interval '12 days'),

  ('district', 'District', 'https://district.example',
   'Sélection pointue de marques européennes indépendantes, sans saisonnalité.',
   'BE', 'Bruxelles', 2, 'EUR', 'unisex', true, 'published', now() - interval '15 days'),

  ('studio-arho', 'Studio Arho', 'https://studio-arho.example',
   'Casques et enceintes conçus à Berlin, réparables et sans obsolescence programmée.',
   'DE', 'Berlin', 3, 'EUR', 'all', true, 'published', now() - interval '18 days'),

  ('nord-et-fils', 'Nord & Fils', 'https://nord-et-fils.example',
   'Sacs de ville et petite bagagerie en toile enduite, taillés pour le quotidien.',
   'FR', 'Lille', 1, 'EUR', 'unisex', true, 'published', now() - interval '21 days'),

  ('cadence', 'Cadence', 'https://cadence.example',
   'Vêtements de sport sobres, coupés pour durer plus d''une saison.',
   'FR', 'Annecy', 2, 'EUR', 'unisex', true, 'published', now() - interval '24 days'),

  -- Deliberately without any image: exercises the ImageFrame typographic
  -- fallback against real data rather than only in a test.
  ('verte-rue', 'Verte Rue', 'https://verte-rue.example',
   'Basiques teints naturellement, en coton biologique certifié.',
   'FR', 'Toulouse', 1, 'EUR', 'unisex', true, 'published', now() - interval '27 days')

on conflict (slug) do update set
  name = excluded.name,
  website_url = excluded.website_url,
  short_description = excluded.short_description,
  country_code = excluded.country_code,
  city = excluded.city,
  price_level = excluded.price_level,
  audience = excluded.audience,
  is_independent = excluded.is_independent,
  status = excluded.status,
  published_at = coalesce(public.shops.published_at, excluded.published_at);

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
--
-- Joined by slug against the categories the reference-data migration seeded,
-- so no id is hardcoded and the script cannot invent a category.

insert into public.shop_categories (shop_id, category_id, is_primary, source)
select s.id, c.id, mapping.is_primary, 'admin'
from (values
  ('maison-leon',  'mode',     true),
  ('lune-studio',  'bijoux',   true),
  ('sneaklab',     'sneakers', true),
  ('sneaklab',     'mode',     false),
  ('atelier-noma', 'maison',   true),
  ('celeste',      'beaute',   true),
  ('district',     'mode',     true),
  ('studio-arho',  'tech',     true),
  ('nord-et-fils', 'mode',     true),
  ('cadence',      'sport',    true),
  ('cadence',      'mode',     false),
  ('verte-rue',    'mode',     true)
) as mapping(shop_slug, category_slug, is_primary)
join public.shops s on s.slug = mapping.shop_slug
join public.categories c on c.slug = mapping.category_slug
on conflict (shop_id, category_id) do update set
  is_primary = excluded.is_primary,
  source = excluded.source;

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------

insert into public.shop_tags (shop_id, tag_id, source)
select s.id, t.id, 'admin'
from (values
  ('maison-leon',  'streetwear'),
  ('maison-leon',  'made-in-france'),
  ('maison-leon',  'createur-independant'),
  ('lune-studio',  'minimaliste'),
  ('lune-studio',  'fait-main'),
  ('sneaklab',     'fait-main'),
  ('sneaklab',     'premium'),
  ('atelier-noma', 'minimaliste'),
  ('atelier-noma', 'vintage'),
  ('celeste',      'ecoresponsable'),
  ('district',     'casual'),
  ('studio-arho',  'premium'),
  ('nord-et-fils', 'casual'),
  ('cadence',      'minimaliste'),
  ('verte-rue',    'ecoresponsable'),
  ('verte-rue',    'made-in-france')
) as mapping(shop_slug, tag_slug)
join public.shops s on s.slug = mapping.shop_slug
join public.tags t on t.slug = mapping.tag_slug
on conflict (shop_id, tag_id) do nothing;

-- ---------------------------------------------------------------------------
-- Images
-- ---------------------------------------------------------------------------
--
-- `shop_images` has no natural unique key, so `on conflict` cannot be used.
-- Guarded by NOT EXISTS on (shop, url) instead: re-running inserts nothing and
-- deletes nothing.

insert into public.shop_images (shop_id, external_url, image_type, position, alt_text)
select s.id, mapping.url, mapping.image_type, mapping.position, mapping.alt_text
from (values
  ('maison-leon',  'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Silhouette streetwear devant un mur bleu'),
  ('maison-leon',  'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=900&q=80', 'gallery', 1, 'Intérieur de boutique de prêt-à-porter'),
  ('maison-leon',  'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?auto=format&fit=crop&w=900&q=80', 'gallery', 2, 'Sweat blanc posé à plat'),

  ('lune-studio',  'https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Colliers fins portés'),
  ('lune-studio',  'https://images.unsplash.com/photo-1608042314453-ae338d80c427?auto=format&fit=crop&w=900&q=80', 'gallery', 1, 'Bagues dorées serties de pierres'),
  ('lune-studio',  'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?auto=format&fit=crop&w=900&q=80', 'gallery', 2, 'Bracelet à maillons dorés'),

  ('sneaklab',     'https://images.unsplash.com/photo-1560343090-f0409e92791a?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Soulier en daim vert sur fond rose'),

  ('atelier-noma', 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Salon clair meublé sobrement'),
  ('atelier-noma', 'https://images.unsplash.com/photo-1519710164239-da123dc03ef4?auto=format&fit=crop&w=900&q=80', 'gallery', 1, 'Coin repas blanc avec lampe arquée'),
  ('atelier-noma', 'https://images.unsplash.com/photo-1584589167171-541ce45f1eea?auto=format&fit=crop&w=900&q=80', 'gallery', 2, 'Vases en bois et feuillage'),

  ('celeste',      'https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Produits de maquillage disposés à plat'),

  ('district',     'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Portant de vêtements aux tons neutres'),
  ('district',     'https://images.unsplash.com/photo-1512436991641-6745cdb1723f?auto=format&fit=crop&w=900&q=80', 'gallery', 1, 'Portant de vêtements en boutique'),

  ('studio-arho',  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Casque audio noir sur fond jaune'),

  ('nord-et-fils', 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'Sac à dos bleu marine'),
  ('nord-et-fils', 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=900&q=80', 'gallery', 1, 'Sac à main en cuir rouge'),

  ('cadence',      'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=900&q=80', 'cover',   0, 'T-shirts verts sur un portant')
) as mapping(shop_slug, url, image_type, position, alt_text)
join public.shops s on s.slug = mapping.shop_slug
where not exists (
  select 1 from public.shop_images existing
  where existing.shop_id = s.id and existing.external_url = mapping.url
);

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
--
-- Approved records for a few shops, so the UI shows both states. This is what
-- `verified` is derived from; there is no editable boolean anywhere, and no
-- client can write this table. `evidence` is left empty: these are demo rows,
-- and nothing was actually checked.

insert into public.shop_verifications (shop_id, verification_type, status, verified_at)
select s.id, mapping.verification_type, 'approved', now() - interval '1 day'
from (values
  ('maison-leon',  'domain'),
  ('lune-studio',  'domain'),
  ('lune-studio',  'business'),
  ('sneaklab',     'domain'),
  ('atelier-noma', 'domain'),
  ('celeste',      'domain')
) as mapping(shop_slug, verification_type)
join public.shops s on s.slug = mapping.shop_slug
where not exists (
  select 1 from public.shop_verifications existing
  where existing.shop_id = s.id
    and existing.verification_type = mapping.verification_type
    and existing.status in ('pending', 'approved')
);

commit;

-- Quick check after running:
--   select s.slug, s.status, count(distinct i.id) as images,
--          count(distinct v.id) filter (where v.status = 'approved') as verifications
--   from public.shops s
--   left join public.shop_images i on i.shop_id = s.id
--   left join public.shop_verifications v on v.shop_id = s.id
--   group by s.slug, s.status
--   order by s.slug;
