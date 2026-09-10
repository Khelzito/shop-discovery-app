-- Search V2 — the semantic arm.
--
-- Completes 20260828120100_vector_foundation.sql, which deliberately left the
-- embedding dimension open because no model had been chosen. A model has now
-- been chosen, so this migration does the three things that header listed as
-- prerequisites, and adds the one function retrieval needs.
--
-- WHY 1536, and why it is not a preference:
--   pgvector can only build an HNSW or IVFFlat index on a `vector` of at most
--   2000 dimensions. text-embedding-3-small returns 1536 and is indexable;
--   text-embedding-3-large returns 3072 and is not, which would force the
--   `halfvec` type and a half-precision copy. The index limit settles it.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   * It does not widen any RLS policy or grant. shop_embeddings keeps RLS
--     enabled and `revoke all from anon, authenticated` exactly as deployed.
--   * It does not add a SECURITY DEFINER function. The one function here is
--     SECURITY INVOKER and reachable only by service_role.
--   * It does not touch help_article_embeddings. The help assistant does not
--     exist, its chunking is undecided, and fixing its dimension now would
--     lock a choice nothing is ready to make.
--   * It writes no data. Backfilling embeddings spends provider quota and
--     belongs in a script that can be watched and stopped, not in a migration.
--
-- No explicit BEGIN/COMMIT: the Supabase CLI already runs each migration file
-- inside its own transaction, and committing here would end that transaction
-- early. This matches every other migration in this directory.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight — refuse to constrain a column whose rows disagree
-- ---------------------------------------------------------------------------
--
-- `dimensions` was recorded on every row for exactly this moment. The ALTER
-- below would fail on its own, but with a message about one bad row rather
-- than a statement of the problem and what to do about it.
--
-- An empty table passes trivially, which is the expected case: no embedding
-- provider has ever been implemented, so nothing can have written a vector.

do $$
declare
  offending integer;
begin
  select count(*) into offending
  from public.shop_embeddings
  where dimensions <> 1536;

  if offending > 0 then
    raise exception
      'shop_embeddings holds % row(s) whose dimensions <> 1536. Re-embed or delete them before fixing the column type.',
      offending;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Fix the dimension
-- ---------------------------------------------------------------------------

alter table public.shop_embeddings
  alter column embedding type extensions.vector(1536);

comment on column public.shop_embeddings.embedding is
  'L2-normalised 1536-dimension vector. The dimension is fixed rather than '
  'open because pgvector cannot index a vector wider than 2000.';

-- ---------------------------------------------------------------------------
-- 2. Index
-- ---------------------------------------------------------------------------
--
-- HNSW rather than IVFFlat: it needs no training pass, so it is correct on an
-- empty table and stays correct as shops are added one at a time. An IVFFlat
-- index built on today's ten rows would have to be rebuilt.
--
-- Parameters are pgvector's defaults (m = 16, ef_construction = 64). They are
-- adequate well into five figures of rows, and there is no measurement yet
-- that would justify anything else.
--
-- Built non-concurrently on purpose: the table is empty, so the lock is
-- instantaneous. A rebuild on a populated catalogue later should use CREATE
-- INDEX CONCURRENTLY, which cannot run inside a transaction and therefore
-- cannot live in a migration file.
--
-- Honest limitation: a query carrying hard filters post-filters the index
-- results, so a very restrictive filter can return fewer than p_limit rows
-- even when matching shops exist further down the neighbour list. At this
-- catalogue size the planner uses a sequential scan and the result is exact
-- anyway. Revisit with pgvector's iterative scan when it becomes measurable.

create index if not exists shop_embeddings_hnsw_idx
  on public.shop_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 3. The semantic arm
-- ---------------------------------------------------------------------------
--
-- The factual constraints are applied HERE, inside the vector query, not
-- afterwards. That is what keeps similarity from becoming a source of truth:
-- a search that asked for France cannot return a German shop however close
-- its vector is, because that shop never enters the result set. The client
-- repeats the same checks on what comes back (data/search/merge.ts), so a
-- clause lost on either side is caught by the other.
--
-- SECURITY INVOKER, not DEFINER: only service_role executes this, and
-- service_role already reads these tables. A DEFINER function would add an
-- escalation path for no benefit — see 20260901090000.
--
-- Returns ids and a similarity. Never a vector: the app re-reads the shops it
-- is told about through its own RLS-governed query, so this function cannot
-- be used to surface a shop the caller could not already see.
--
-- TWO TRAPS, both deliberate and both easy to reintroduce:
--
--   * `set search_path = ''` means operators are not resolved either. A bare
--     `<=>` would raise "operator does not exist" because pgvector lives in
--     `extensions`. Hence OPERATOR(extensions.<=>), which names the same
--     operator explicitly and still matches vector_cosine_ops, so the index
--     is used exactly as it would be with the bare form.
--
--   * The `p_embedding` parameter is typed `extensions.vector` with NO
--     dimension. PostgreSQL does not enforce type modifiers on function
--     parameters, so writing vector(1536) here would only look like a check.
--     The real enforcement is the column type: comparing a 768-dimension
--     argument against a vector(1536) column raises "different vector
--     dimensions", which is a loud failure rather than a silent bad ranking.

create or replace function public.search_shops_semantic(
  p_embedding extensions.vector,
  p_embedding_model text,
  p_source_kind text default 'shop_profile',
  p_category_slugs text[] default null,
  p_country_codes text[] default null,
  p_audiences text[] default null,
  p_price_min numeric default null,
  p_price_max numeric default null,
  p_verified_only boolean default false,
  p_limit integer default 40,
  -- Defaults to 0: no cutoff unless the caller asks for one.
  --
  -- The V1 similarity threshold is a tuning value that lives in exactly one
  -- place, data/search/rank.ts (SEMANTIC_SIMILARITY_FLOOR), and the Edge
  -- Function passes it explicitly. Repeating it as a default here would
  -- create a second source of truth that silently drifts the day the first
  -- one is retuned — and retuning it after measurement is expected.
  p_min_similarity real default 0
)
returns table (shop_id uuid, similarity real)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    s.id as shop_id,
    (1 - (e.embedding OPERATOR(extensions.<=>) p_embedding))::real as similarity
  from public.shop_embeddings e
  join public.shops s on s.id = e.shop_id
  where e.embedding_model = p_embedding_model
    and e.source_kind = p_source_kind
    -- Redundant with the anon RLS policy and kept deliberately: a signed-in
    -- merchant CAN see their own drafts, and discovery must never show them.
    and s.status = 'published'
    -- Country: `= any(...)` never matches null, mirroring the factual arm
    -- where `country_code in (...)` excludes undeclared shops too.
    and (p_country_codes is null or cardinality(p_country_codes) = 0
         or s.country_code = any (p_country_codes))
    -- Audience: an undeclared audience is KEPT. Absence of data is not
    -- evidence of mismatch; exactness is rewarded in ranking instead.
    and (p_audiences is null or cardinality(p_audiences) = 0
         or s.audience is null or s.audience = any (p_audiences))
    -- Price: null-tolerant both ways. "No declared price" must never read as
    -- "too expensive".
    and (p_price_min is null or s.price_max is null or s.price_max >= p_price_min)
    and (p_price_max is null or s.price_min is null or s.price_min <= p_price_max)
    and (p_category_slugs is null or cardinality(p_category_slugs) = 0 or exists (
      select 1
      from public.shop_categories sc
      join public.categories c on c.id = sc.category_id
      where sc.shop_id = s.id
        and c.slug = any (p_category_slugs)
    ))
    and (not p_verified_only or exists (
      select 1
      from public.shop_verifications v
      where v.shop_id = s.id
        and v.status = 'approved'
        and (v.expires_at is null or v.expires_at > now())
    ))
    and (1 - (e.embedding OPERATOR(extensions.<=>) p_embedding)) >= p_min_similarity
  -- s.id breaks ties so two equidistant shops keep a stable order between
  -- runs; the leading key still comes from the index.
  order by e.embedding OPERATOR(extensions.<=>) p_embedding, s.id
  -- Bounded in SQL as well as by the caller, so no argument can turn one
  -- search into an unbounded scan.
  limit greatest(1, least(p_limit, 200));
$$;

comment on function public.search_shops_semantic is
  'Semantic candidate retrieval. Returns shop ids and similarity, never '
  'vectors. Applies the same hard constraints as the factual arm, so '
  'similarity can widen a result set but never bypass a filter. '
  'service_role only: the query vector is produced server-side.';

-- ---------------------------------------------------------------------------
-- 4. Grants — nothing reaches a client role
-- ---------------------------------------------------------------------------
--
-- The REVOKE is not defensive tidiness, it is the security boundary: a newly
-- created function is granted EXECUTE to PUBLIC by default, so without this
-- line anon would be able to call it.
--
-- No client can produce an argument for it — embedding a query needs the
-- server-side provider key — but "cannot construct the input" is not an
-- access control, and a future function returning more than ids should not
-- inherit an open grant.

revoke all on function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) from public, anon, authenticated;

grant execute on function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) to service_role;
