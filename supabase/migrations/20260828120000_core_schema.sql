-- Shop Discovery — core schema.
--
-- Three layers of data are kept strictly apart (docs/AI_ARCHITECTURE.md):
--   A. declared / verified facts  -> shops, shop_categories, shop_tags,
--                                    shop_verifications
--   B. AI-inferred interpretation -> shop_ai_analyses (proposals only)
--   C. behavioural signals        -> shop_views, outbound_clicks, searches,
--                                    search_results, search_interactions
--
-- AI never writes into layer A and can never mark a shop verified or
-- published. Those transitions belong to the server/admin context only.
--
-- Conventions
--   * uuid primary keys, `timestamptz` timestamps.
--   * Controlled vocabularies use text + CHECK rather than Postgres enums:
--     every one of them is expected to gain values before launch, and a CHECK
--     is altered in one statement whereas an enum cannot drop or reorder
--     values. This deviates from docs/DATABASE.md, which proposed enums.
--   * RLS is enabled on every table, and table privileges are revoked then
--     re-granted explicitly, so column-level writes can be enforced.
--   * `service_role` bypasses RLS: that is the admin/server context. No
--     client-visible admin role exists, by design.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

create domain public.country_code as text
  check (value ~ '^[A-Z]{2}$');

comment on domain public.country_code is 'ISO 3166-1 alpha-2, uppercase.';

create domain public.currency_code as text
  check (value ~ '^[A-Z]{3}$');

comment on domain public.currency_code is 'ISO 4217, uppercase.';

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text check (char_length(first_name) between 1 and 80),
  country_code public.country_code,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile, 1:1 with auth.users. Never stores credentials.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Mirror the auth user into profiles.
--
-- SECURITY DEFINER with an empty search_path, and every failure swallowed:
-- a raised exception here would abort the sign-up transaction and break
-- authentication, which is a far worse outcome than a missing profile row.
create or replace function public.handle_auth_user_upsert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, first_name)
  values (
    new.id,
    -- Truncated to the column's CHECK bound. An over-long name would raise,
    -- be swallowed below, and silently leave the user without a profile.
    left(nullif(btrim(coalesce(new.raw_user_meta_data ->> 'first_name', '')), ''), 80)
  )
  on conflict (id) do update
    set first_name = excluded.first_name
  where public.profiles.first_name is distinct from excluded.first_name;

  return new;
exception
  when others then
    raise warning 'handle_auth_user_upsert failed for user %: %', new.id, sqlerrm;
    return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_upsert();

create trigger on_auth_user_metadata_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user_upsert();

-- Backfill users that already exist.
insert into public.profiles (id, first_name)
select
  u.id,
  nullif(btrim(coalesce(u.raw_user_meta_data ->> 'first_name', '')), '')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- shops — declared facts only
-- ---------------------------------------------------------------------------

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  website_url text not null check (website_url ~* '^https?://'),
  short_description text check (char_length(short_description) <= 280),
  long_description text check (char_length(long_description) <= 4000),
  country_code public.country_code,
  city text,
  -- Declared shipping destinations. Element-level validation comes from the
  -- domain; an empty array means "not declared", same as null.
  shipping_country_codes public.country_code[],
  price_min numeric(10, 2) check (price_min >= 0),
  price_max numeric(10, 2) check (price_max >= 0),
  currency_code public.currency_code not null default 'EUR',
  -- Coarse band kept alongside the range: the app already filters on it and
  -- most shops will never declare exact prices.
  price_level smallint check (price_level between 1 and 4),
  -- Declared by the merchant, not inferred. AI guesses live in
  -- shop_ai_analyses.detected_audience.
  audience text check (audience in ('women', 'men', 'kids', 'unisex', 'all')),
  is_independent boolean,
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'published', 'suspended', 'rejected')),
  created_by uuid references public.profiles (id) on delete set null,
  claimed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shops_price_range_valid
    check (price_min is null or price_max is null or price_max >= price_min),
  constraint shops_published_has_timestamp
    check (status <> 'published' or published_at is not null)
);

comment on table public.shops is
  'Factual shop record. No editable `verified` column: verification is derived '
  'from public.shop_verifications. `status` is writable only by service_role.';

create unique index shops_slug_key on public.shops (slug);
create unique index shops_website_url_key on public.shops (lower(website_url));
create index shops_status_idx on public.shops (status);
create index shops_published_at_idx on public.shops (published_at desc)
  where status = 'published';
create index shops_country_code_idx on public.shops (country_code);
create index shops_shipping_countries_idx
  on public.shops using gin ((shipping_country_codes::text[]));
-- Full-text search over the factual text, French configuration.
-- 'french'::regconfig, not 'french': the text overload of to_tsvector is only
-- STABLE and cannot be indexed.
create index shops_search_idx on public.shops using gin (
  to_tsvector(
    'french'::regconfig,
    coalesce(name, '') || ' ' || coalesce(short_description, '') || ' ' || coalesce(long_description, '')
  )
);

create trigger shops_set_updated_at
  before update on public.shops
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- shop_members — relational ownership, ready for merchant teams
-- ---------------------------------------------------------------------------

create table public.shop_members (
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);

comment on table public.shop_members is
  'Shop authorisation. A shop may have no member at all: the catalogue can '
  'list shops before their merchant joins. Rows are written by service_role '
  'only, so nobody can attach themselves to a shop.';

create index shop_members_user_id_idx on public.shop_members (user_id);

-- Membership lookups used by RLS policies. SECURITY DEFINER so that reading
-- shop_members from inside another table's policy does not recurse into
-- shop_members' own policies.
create or replace function public.is_shop_member(p_shop_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.shop_members m
    where m.shop_id = p_shop_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

-- A shop is readable when it is published, or when the caller belongs to it.
create or replace function public.shop_is_visible(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.shops s
    where s.id = p_shop_id
      and (s.status = 'published' or public.is_shop_member(s.id))
  );
$$;

-- ---------------------------------------------------------------------------
-- categories / tags — canonical vocabulary
-- ---------------------------------------------------------------------------

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  parent_id uuid references public.categories (id) on delete set null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_not_own_parent check (parent_id is null or parent_id <> id)
);

create index categories_parent_id_idx on public.categories (parent_id);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  -- Loose grouping so the UI can show style tags apart from value tags.
  kind text not null default 'style'
    check (kind in ('style', 'value', 'audience', 'origin', 'other')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- shop_categories / shop_tags — VALIDATED links only
-- ---------------------------------------------------------------------------
--
-- These tables carry accepted classification. AI suggestions never land here;
-- they stay in shop_ai_analyses.suggested_categories / suggested_tags until a
-- human accepts them, at which point the server inserts a row with
-- source = 'ai_accepted'. Mixing proposals and accepted facts in one table
-- would make "is this shop actually in Mode?" depend on reading a confidence
-- score, which is exactly the confusion this schema is meant to prevent.

create table public.shop_categories (
  shop_id uuid not null references public.shops (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  is_primary boolean not null default false,
  source text not null default 'merchant'
    check (source in ('merchant', 'admin', 'ai_accepted')),
  created_at timestamptz not null default now(),
  primary key (shop_id, category_id)
);

create index shop_categories_category_id_idx on public.shop_categories (category_id);
-- At most one primary category per shop.
create unique index shop_categories_one_primary_idx
  on public.shop_categories (shop_id)
  where is_primary;

create table public.shop_tags (
  shop_id uuid not null references public.shops (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  source text not null default 'merchant'
    check (source in ('merchant', 'admin', 'ai_accepted')),
  created_at timestamptz not null default now(),
  primary key (shop_id, tag_id)
);

create index shop_tags_tag_id_idx on public.shop_tags (tag_id);

-- ---------------------------------------------------------------------------
-- shop_images
-- ---------------------------------------------------------------------------

create table public.shop_images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- Exactly one source: a Storage object, or an approved external URL.
  storage_path text,
  external_url text check (external_url ~* '^https?://'),
  image_type text not null default 'gallery'
    check (image_type in ('logo', 'cover', 'gallery')),
  alt_text text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint shop_images_one_source
    check (num_nonnulls(storage_path, external_url) = 1)
);

create index shop_images_shop_id_idx on public.shop_images (shop_id, position);

-- ---------------------------------------------------------------------------
-- shop_verifications — trusted records, never client-writable
-- ---------------------------------------------------------------------------

create table public.shop_verifications (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  verification_type text not null
    check (verification_type in ('domain', 'business', 'identity', 'email', 'website_security', 'manual_review')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  -- Evidence can contain business and identity material. Never exposed to
  -- clients: no client SELECT policy exists on this table.
  evidence jsonb not null default '{}'::jsonb,
  provider text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_verifications_approved_has_timestamp
    check (status <> 'approved' or verified_at is not null)
);

comment on table public.shop_verifications is
  'Server/admin controlled. Trust cannot be purchased and AI can never write '
  'here. Clients read only the safe projection in shop_public_verifications.';

create index shop_verifications_shop_id_idx on public.shop_verifications (shop_id);
-- One live record per (shop, type); history is kept by expiring rows.
create unique index shop_verifications_current_idx
  on public.shop_verifications (shop_id, verification_type)
  where status in ('pending', 'approved');

create trigger shop_verifications_set_updated_at
  before update on public.shop_verifications
  for each row execute function public.set_updated_at();

-- Safe public projection of verification state.
--
-- SECURITY INVOKER, so it holds no privilege of its own and raises no
-- Security Advisor warning. Safety comes from two independent mechanisms on
-- the base table, both of which also protect a client querying it directly:
--
--   * rows    -> the shop_verifications_select_public policy exposes only
--                approved, unexpired records of shops the caller can see;
--   * columns -> anon/authenticated hold SELECT on exactly three columns.
--                `evidence`, `reviewed_by`, `provider` and `status` are not
--                granted at all, so no query can reach them.
--
-- The view therefore adds no access. It exists so that `select *` returns the
-- three public columns without every caller having to name them.
create view public.shop_public_verifications
with (security_invoker = on)
as
select
  v.shop_id,
  v.verification_type,
  v.verified_at
from public.shop_verifications v;

comment on view public.shop_public_verifications is
  'Read-only projection replacing an editable shops.verified boolean.';

-- ---------------------------------------------------------------------------
-- shop_ai_analyses — layer B, proposals only
-- ---------------------------------------------------------------------------
--
-- Replaces docs/DATABASE.md's `shop_analysis_runs`: one table holds both the
-- run metadata and its structured output, because they are written together
-- and always read together, and splitting them buys nothing.

create table public.shop_ai_analyses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops (id) on delete cascade,
  -- Set while a submission is analysed, before any shop row exists.
  submission_id uuid,
  source_url text not null check (source_url ~* '^https?://'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),

  -- Structured inference. Kept as columns, not one blob, so the parts we
  -- expect to query stay queryable.
  summary text,
  detected_styles text[],
  detected_audience text[],
  detected_products text[],
  detected_values text[],
  detected_price_positioning text
    check (detected_price_positioning in ('budget', 'mid', 'premium', 'luxury', 'unknown')),
  keywords text[],
  -- [{ "slug": "mode", "confidence": 0.82 }, …] — proposals, never facts.
  suggested_categories jsonb not null default '[]'::jsonb,
  suggested_tags jsonb not null default '[]'::jsonb,
  confidence_score numeric(4, 3) check (confidence_score between 0 and 1),

  -- Provenance. The provider stays replaceable: nothing in this schema names
  -- a specific vendor, and no key is ever stored here.
  model_provider text,
  model_name text,
  analysis_version text,
  -- Hash of the extracted source content, so an unchanged site is not
  -- re-analysed and a stale analysis is detectable.
  source_hash text,

  raw_extraction jsonb,
  error_message text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint shop_ai_analyses_has_subject
    check (num_nonnulls(shop_id, submission_id) >= 1)
);

comment on table public.shop_ai_analyses is
  'AI interpretation. Never factual, never a verification result, never a '
  'publication decision. Multiple analyses per shop are kept over time.';

create index shop_ai_analyses_shop_id_idx on public.shop_ai_analyses (shop_id, created_at desc);
create index shop_ai_analyses_submission_id_idx on public.shop_ai_analyses (submission_id);
create index shop_ai_analyses_source_hash_idx on public.shop_ai_analyses (source_hash);

-- ---------------------------------------------------------------------------
-- favorites / preferences — layer C inputs owned by the user
-- ---------------------------------------------------------------------------

create table public.favorites (
  user_id uuid not null references public.profiles (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);

create index favorites_shop_id_idx on public.favorites (shop_id);

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  shipping_country_code public.country_code,
  max_price_level smallint check (max_price_level between 1 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

create table public.user_interest_categories (
  user_id uuid not null references public.profiles (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, category_id)
);

create index user_interest_categories_category_id_idx
  on public.user_interest_categories (category_id);

-- ---------------------------------------------------------------------------
-- Search intelligence — layer C
-- ---------------------------------------------------------------------------

create table public.searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  query_text text not null check (char_length(query_text) <= 500),
  -- Structured AI output. JSONB because its shape is expected to evolve with
  -- the intent parser; it is an interpretation, not a fact.
  parsed_intent jsonb,
  category_ids uuid[],
  country_codes public.country_code[],
  price_min numeric(10, 2) check (price_min >= 0),
  price_max numeric(10, 2) check (price_max >= 0),
  search_mode text not null default 'classic'
    check (search_mode in ('classic', 'natural', 'category')),
  results_count integer check (results_count >= 0),
  created_at timestamptz not null default now()
);

comment on table public.searches is
  'Query text and structured intent only. No IP address, device fingerprint '
  'or location: ranking does not need them (docs/MASTER_SPEC.md §15).';

create index searches_user_id_idx on public.searches (user_id, created_at desc);
create index searches_created_at_idx on public.searches (created_at desc);

-- Included on purpose. Without the positions actually shown, rank quality
-- (CTR@k, MRR) cannot be measured later, and it cannot be reconstructed once
-- the ranking changes. Kept to four narrow columns, written server-side only;
-- switching it off later means simply not writing rows.
create table public.search_results (
  search_id uuid not null references public.searches (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  position smallint not null check (position >= 0),
  ranking_score numeric(8, 5),
  primary key (search_id, shop_id)
);

create index search_results_shop_id_idx on public.search_results (shop_id);

create table public.search_interactions (
  id uuid primary key default gen_random_uuid(),
  search_id uuid references public.searches (id) on delete set null,
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  interaction_type text not null
    check (interaction_type in ('shop_open', 'favorite', 'outbound_click')),
  position smallint check (position >= 0),
  created_at timestamptz not null default now()
);

create index search_interactions_search_id_idx on public.search_interactions (search_id);
create index search_interactions_shop_id_idx on public.search_interactions (shop_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Discovery events — layer C
-- ---------------------------------------------------------------------------

create table public.shop_views (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  source text not null default 'direct'
    check (source in ('home', 'explore', 'search', 'favorites', 'direct')),
  created_at timestamptz not null default now()
);

create index shop_views_shop_id_idx on public.shop_views (shop_id, created_at desc);

create table public.outbound_clicks (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  source text not null default 'direct'
    check (source in ('home', 'explore', 'search', 'favorites', 'direct')),
  created_at timestamptz not null default now()
);

comment on table public.outbound_clicks is
  'Press on "Visiter la boutique". Feeds merchant analytics and ranking.';

create index outbound_clicks_shop_id_idx on public.outbound_clicks (shop_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Merchant workflows
-- ---------------------------------------------------------------------------

create table public.merchant_submissions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references public.profiles (id) on delete cascade,
  website_url text not null check (website_url ~* '^https?://'),
  -- Filled once the submission has produced a shop.
  shop_id uuid references public.shops (id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'processing', 'needs_changes', 'approved', 'rejected')),
  -- The merchant's own corrections to the AI proposal, before a shop exists.
  submitted_data jsonb not null default '{}'::jsonb,
  review_note text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index merchant_submissions_submitted_by_idx
  on public.merchant_submissions (submitted_by, created_at desc);
create index merchant_submissions_status_idx on public.merchant_submissions (status);

create trigger merchant_submissions_set_updated_at
  before update on public.merchant_submissions
  for each row execute function public.set_updated_at();

-- Claiming an existing shop is a different problem from submitting a new one:
-- it needs proof that the claimant controls a shop somebody else listed, and
-- it must not create a shop. Kept separate rather than overloading status
-- values on merchant_submissions.
create table public.shop_claims (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  method text check (method in ('domain', 'email', 'business', 'manual_review')),
  evidence jsonb not null default '{}'::jsonb,
  review_note text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index shop_claims_shop_id_idx on public.shop_claims (shop_id);
create index shop_claims_requested_by_idx on public.shop_claims (requested_by);
-- One open claim per user and shop.
create unique index shop_claims_one_open_idx
  on public.shop_claims (shop_id, requested_by)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- shop_reports — required by docs/MASTER_SPEC.md §11
-- ---------------------------------------------------------------------------

create table public.shop_reports (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  reason text not null
    check (reason in ('scam_suspected', 'counterfeit', 'website_unavailable', 'misleading_information', 'other')),
  description text check (char_length(description) <= 2000),
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index shop_reports_shop_id_idx on public.shop_reports (shop_id);
create index shop_reports_status_idx on public.shop_reports (status);

-- ---------------------------------------------------------------------------
-- help_articles — knowledge base, later the RAG corpus
-- ---------------------------------------------------------------------------

create table public.help_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null,
  content text not null,
  category text not null default 'general'
    check (category in ('general', 'trust', 'merchant', 'account', 'privacy')),
  locale text not null default 'fr' check (locale ~ '^[a-z]{2}$'),
  is_published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index help_articles_published_idx on public.help_articles (is_published, sort_order);

create trigger help_articles_set_updated_at
  before update on public.help_articles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase grants anon/authenticated broad table privileges by default and
-- relies on RLS alone. Revoking first and granting exactly what is needed
-- gives a second, column-level line of defence — notably on shops, where the
-- absence of a grant is what stops a merchant publishing their own shop.

-- NOTE for future migrations: Supabase's default privileges grant client roles
-- full DML on every newly created table in `public`. Default privileges are
-- deliberately left alone here, because changing them makes tables created
-- from the Dashboard fail in confusing ways. The consequence is that EVERY new
-- table must repeat this revoke/grant pair explicitly.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.shops to anon, authenticated;
-- Content columns only. status, published_at, claimed_at, created_by and slug
-- are intentionally absent: only service_role may change them.
--
-- website_url is absent too, and that is a trust decision rather than an
-- oversight: domain verification is bound to this value, so letting a
-- verified merchant repoint it at another domain would carry the approved
-- verification onto a site nobody checked. Changing it goes through review.
grant update (
  name, short_description, long_description, country_code, city,
  shipping_country_codes, price_min, price_max, currency_code, price_level,
  audience, is_independent
) on public.shops to authenticated;

grant select on public.categories to anon, authenticated;
grant select on public.tags to anon, authenticated;
grant select on public.shop_categories to anon, authenticated;
grant select on public.shop_tags to anon, authenticated;
grant select on public.shop_images to anon, authenticated;
grant select on public.shop_members to authenticated;
-- Three columns only. evidence, provider, reviewed_by, status and the
-- timestamps are never granted, so they are unreachable even by a direct
-- query against the base table.
grant select (shop_id, verification_type, verified_at)
  on public.shop_verifications to anon, authenticated;
grant select on public.shop_public_verifications to anon, authenticated;
grant select on public.help_articles to anon, authenticated;

grant select, insert on public.profiles to authenticated;
grant update (first_name, country_code) on public.profiles to authenticated;
grant select, insert, delete on public.favorites to authenticated;
grant select, insert, update on public.user_preferences to authenticated;
grant select, insert, delete on public.user_interest_categories to authenticated;

grant select, insert on public.searches to authenticated;
grant insert on public.search_interactions to authenticated;
grant insert on public.shop_views to authenticated;
grant insert on public.outbound_clicks to authenticated;

grant select, insert on public.merchant_submissions to authenticated;
-- Not reviewed_by / reviewed_at / shop_id: those belong to the reviewer.
grant update (website_url, submitted_data, status) on public.merchant_submissions to authenticated;
grant select, insert on public.shop_claims to authenticated;
grant insert on public.shop_reports to authenticated;

grant execute on function public.is_shop_member(uuid, text[]) to anon, authenticated;
grant execute on function public.shop_is_visible(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.shop_members enable row level security;
alter table public.categories enable row level security;
alter table public.tags enable row level security;
alter table public.shop_categories enable row level security;
alter table public.shop_tags enable row level security;
alter table public.shop_images enable row level security;
alter table public.shop_verifications enable row level security;
alter table public.shop_ai_analyses enable row level security;
alter table public.favorites enable row level security;
alter table public.user_preferences enable row level security;
alter table public.user_interest_categories enable row level security;
alter table public.searches enable row level security;
alter table public.search_results enable row level security;
alter table public.search_interactions enable row level security;
alter table public.shop_views enable row level security;
alter table public.outbound_clicks enable row level security;
alter table public.merchant_submissions enable row level security;
alter table public.shop_claims enable row level security;
alter table public.shop_reports enable row level security;
alter table public.help_articles enable row level security;

-- profiles: strictly own row.
create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
-- Self-healing: if the auth trigger ever failed for a user, they can still
-- create their own row. They can never create anyone else's.
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

-- shops: published to everyone, plus the caller's own shops at any status.
create policy shops_select_published on public.shops
  for select to anon, authenticated
  using (status = 'published' or public.is_shop_member(id));
-- Content edits by owners and admins. Editors get content rights once the
-- merchant UI exists; there is no client insert or delete at all.
create policy shops_update_by_members on public.shops
  for update to authenticated
  using (public.is_shop_member(id, array['owner', 'admin']))
  with check (public.is_shop_member(id, array['owner', 'admin']));

-- shop_members: a member sees their own shop's roster. Writes are service_role
-- only, so no one can grant themselves access.
create policy shop_members_select_own_shops on public.shop_members
  for select to authenticated using (public.is_shop_member(shop_id));

-- Reference vocabulary is public.
create policy categories_select_active on public.categories
  for select to anon, authenticated using (is_active);
create policy tags_select_all on public.tags
  for select to anon, authenticated using (true);

-- Shop-scoped public data follows the shop's visibility.
create policy shop_categories_select_visible on public.shop_categories
  for select to anon, authenticated using (public.shop_is_visible(shop_id));
create policy shop_tags_select_visible on public.shop_tags
  for select to anon, authenticated using (public.shop_is_visible(shop_id));
create policy shop_images_select_visible on public.shop_images
  for select to anon, authenticated using (public.shop_is_visible(shop_id));

-- shop_verifications: read-only, and only the approved, unexpired records of
-- a shop the caller can already see. Combined with the three-column grant
-- above, this is what replaces a `verified` boolean. There is no insert,
-- update or delete policy, and no grant for one: only service_role writes.
create policy shop_verifications_select_public on public.shop_verifications
  for select to anon, authenticated
  using (
    status = 'approved'
    and (expires_at is null or expires_at > now())
    and public.shop_is_visible(shop_id)
  );

-- shop_ai_analyses and search_results: no client policy at all. Every client
-- read and write is denied; service_role bypasses RLS.

-- favorites: strictly the caller's own.
create policy favorites_select_own on public.favorites
  for select to authenticated using ((select auth.uid()) = user_id);
create policy favorites_insert_own on public.favorites
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy favorites_delete_own on public.favorites
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy user_preferences_select_own on public.user_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_preferences_insert_own on public.user_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_preferences_update_own on public.user_preferences
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy user_interests_select_own on public.user_interest_categories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_interests_insert_own on public.user_interest_categories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_interests_delete_own on public.user_interest_categories
  for delete to authenticated using ((select auth.uid()) = user_id);

-- searches: a user may log and re-read their own searches, nobody else's.
create policy searches_select_own on public.searches
  for select to authenticated using ((select auth.uid()) = user_id);
create policy searches_insert_own on public.searches
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Events are append-only and attributed to the caller. No client can read
-- them back; aggregation happens server-side.
create policy search_interactions_insert_own on public.search_interactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy shop_views_insert_own on public.shop_views
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.shop_is_visible(shop_id));
create policy outbound_clicks_insert_own on public.outbound_clicks
  for insert to authenticated
  with check ((select auth.uid()) = user_id and public.shop_is_visible(shop_id));

-- merchant_submissions: the merchant owns the draft and may submit it, but
-- the WITH CHECK forbids them ever writing an approved or rejected status.
create policy merchant_submissions_select_own on public.merchant_submissions
  for select to authenticated using ((select auth.uid()) = submitted_by);
create policy merchant_submissions_insert_own on public.merchant_submissions
  for insert to authenticated
  with check ((select auth.uid()) = submitted_by and status in ('draft', 'submitted'));
create policy merchant_submissions_update_own on public.merchant_submissions
  for update to authenticated
  using ((select auth.uid()) = submitted_by and status in ('draft', 'needs_changes'))
  with check ((select auth.uid()) = submitted_by and status in ('draft', 'submitted'));

-- shop_claims: request and read your own; approval is service_role only.
create policy shop_claims_select_own on public.shop_claims
  for select to authenticated using ((select auth.uid()) = requested_by);
create policy shop_claims_insert_own on public.shop_claims
  for insert to authenticated
  with check ((select auth.uid()) = requested_by and status = 'pending');

-- shop_reports: report a visible shop; reports are not readable by clients,
-- so no reporter can see moderation state or other people's reports.
create policy shop_reports_insert_own on public.shop_reports
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.shop_is_visible(shop_id)
    and status = 'open'
  );

create policy help_articles_select_published on public.help_articles
  for select to anon, authenticated using (is_published);
