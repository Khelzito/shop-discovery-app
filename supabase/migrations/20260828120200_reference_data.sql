-- Canonical reference data.
--
-- This is not test data: categories, tags and help articles are part of the
-- product and belong in every environment, so they live in a migration rather
-- than in supabase/seed.sql (which only runs on a local `db reset`).
--
-- Every statement is idempotent, so re-running is safe.

-- Categories — the vocabulary already used by the app's Explorer filter, with
-- the same slugs, so application code and database agree.
insert into public.categories (slug, name, sort_order) values
  ('mode',     'Mode',     10),
  ('sneakers', 'Sneakers', 20),
  ('bijoux',   'Bijoux',   30),
  ('beaute',   'Beauté',   40),
  ('maison',   'Maison',   50),
  ('tech',     'Tech',     60),
  ('sport',    'Sport',    70)
on conflict (slug) do update
  set name = excluded.name,
      sort_order = excluded.sort_order;

-- Tags — the discovery vocabulary. Kept small on purpose; tags are meant to
-- grow from real shops, not from a guessed taxonomy.
insert into public.tags (slug, name, kind) values
  ('minimaliste',          'Minimaliste',          'style'),
  ('streetwear',           'Streetwear',           'style'),
  ('vintage',              'Vintage',              'style'),
  ('casual',               'Casual',               'style'),
  ('premium',              'Premium',              'style'),
  ('luxe-accessible',      'Luxe accessible',      'style'),
  ('ecoresponsable',       'Écoresponsable',       'value'),
  ('createur-independant', 'Créateur indépendant', 'value'),
  ('fait-main',            'Fait main',            'value'),
  ('made-in-france',       'Made in France',       'origin')
on conflict (slug) do update
  set name = excluded.name,
      kind = excluded.kind;

-- Help articles — the same two explanations the app already ships in
-- data/help-topics.ts, now with a database home so the future assistant can
-- retrieve them instead of improvising product rules.
insert into public.help_articles (slug, title, content, category, is_published, sort_order) values
  (
    'comment-fonctionne-shop-discovery',
    'Comment fonctionne Shop Discovery ?',
    'Shop Discovery aide à découvrir des boutiques en ligne indépendantes que tu n''aurais probablement pas trouvées autrement.' || E'\n\n' ||
    'Aucun achat ne se fait dans l''application. Quand une boutique t''intéresse, tu es redirigé vers son propre site, où la commande et le paiement ont lieu.',
    'general',
    true,
    10
  ),
  (
    'comment-les-boutiques-sont-verifiees',
    'Comment les boutiques sont-elles vérifiées ?',
    'La vérification confirme des informations clés sur une boutique, comme le contrôle de son nom de domaine et son existence légale.' || E'\n\n' ||
    'Elle ne peut pas être achetée et ne constitue pas une garantie absolue. Elle indique ce qui a pu être confirmé, rien de plus.',
    'trust',
    true,
    20
  )
on conflict (slug) do update
  set title = excluded.title,
      content = excluded.content,
      category = excluded.category,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;
