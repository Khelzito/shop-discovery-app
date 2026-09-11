-- Shop Analyzer persistence — Prompt 16, Phase B.
--
-- Additive. No earlier migration is edited, no existing object is altered.
--
-- WHY FUNCTIONS AND NOT GRANTS. For one authenticated user at a time,
-- ai-shop-analysis must count that user's recent analyses (quota), check that a
-- submission belongs to them, create and complete an analysis row, and copy the
-- proposal into their submission. service_role holds no table privilege in
-- this project (20260909130000). Granting it SELECT/INSERT/UPDATE on
-- shop_ai_analyses and merchant_submissions would let any code holding that key
-- read or rewrite EVERY user's rows. Three narrow functions instead:
--
--   begin_shop_analysis     quota -> duplicate check -> ownership -> running row
--   complete_shop_analysis  completes THAT user's running row, copies the proposal
--   fail_shop_analysis      marks THAT user's running row failed
--
-- Common properties (pinned by ai/server/shop-analysis-migration.test.ts):
--   * SECURITY DEFINER, owner postgres, `set search_path = ''`;
--   * EXECUTE for service_role only: never PUBLIC, anon or authenticated;
--   * the user id is a parameter the Edge Function takes from a VERIFIED JWT,
--     and every read and write is scoped to it;
--   * no dynamic SQL;
--   * they write public.shop_ai_analyses and public.merchant_submissions only.
--     They read public.profiles and PUBLISHED public.shops. They never write
--     shops, shop_members, shop_verifications, shop_claims, categories or tags;
--     nothing here can publish, verify, approve or grant membership.
--
-- NOT DONE HERE: no table grant to anyone, no policy, no RLS change, no new
-- column, no index, no change to any existing function.
--
-- RATE LIMIT, V1 — per user, enforced atomically in begin_shop_analysis:
--   * 1 analysis running at a time (a run older than 5 minutes is abandoned);
--   * 5 analyses per rolling hour;
--   * 20 analyses per rolling 24 hours;
--   * 200 analyses per rolling hour across all users (cost ceiling).
-- Every attempt that reaches the network counts, blocked and failed ones
-- included: a failing fetch is exactly what a probing attempt looks like. A
-- duplicate hit and a refused submission reach no network and do not count.
--
-- No explicit BEGIN/COMMIT: the CLI already wraps each file in a transaction.

-- ---------------------------------------------------------------------------
-- 1. begin_shop_analysis
-- ---------------------------------------------------------------------------

create or replace function public.begin_shop_analysis(
  p_user_id uuid,
  p_submission_id uuid,
  p_source_url text,
  p_domain text
)
returns table (
  outcome text,
  analysis_id uuid,
  target_submission_id uuid,
  existing_shop_id uuid,
  retry_after_seconds integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_oldest timestamptz;
  v_existing uuid;
  v_submission uuid;
  v_submission_status text;
  v_analysis uuid;
begin
  if p_user_id is null or not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'invalid_user' using errcode = '22023';
  end if;

  if p_domain is null
     or char_length(p_domain) > 253
     or p_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
    raise exception 'invalid_domain' using errcode = '22023';
  end if;

  -- HTTPS only, and the URL's host must be exactly the domain being checked.
  if p_source_url is null
     or char_length(p_source_url) > 2048
     or p_source_url !~ '^https://'
     or substring(p_source_url from '^https://([^/:?#]+)') is distinct from p_domain then
    raise exception 'invalid_source_url' using errcode = '22023';
  end if;

  -- One begin at a time per user, so two concurrent requests cannot both pass
  -- the quota check. Released at the end of this transaction.
  perform pg_advisory_xact_lock(hashtextextended('shop_analysis:' || p_user_id::text, 0));

  -- A run that never finished (a crashed invocation) stops blocking the user.
  -- It keeps counting against the quota.
  update public.shop_ai_analyses a
     set status = 'failed',
         error_message = 'abandoned',
         analyzed_at = now()
   where a.requested_by = p_user_id
     and a.status = 'running'
     and a.created_at < now() - interval '5 minutes';

  if exists (
    select 1 from public.shop_ai_analyses a
    where a.requested_by = p_user_id and a.status = 'running'
  ) then
    return query select 'already_running'::text, null::uuid, null::uuid, null::uuid, 30;
    return;
  end if;

  select count(*)::integer, min(a.created_at) into v_count, v_oldest
    from public.shop_ai_analyses a
   where a.requested_by = p_user_id
     and a.created_at > now() - interval '1 hour';
  if v_count >= 5 then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::uuid,
      greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::integer);
    return;
  end if;

  select count(*)::integer, min(a.created_at) into v_count, v_oldest
    from public.shop_ai_analyses a
   where a.requested_by = p_user_id
     and a.created_at > now() - interval '24 hours';
  if v_count >= 20 then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::uuid,
      greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer);
    return;
  end if;

  select count(*)::integer into v_count
    from public.shop_ai_analyses a
   where a.created_at > now() - interval '1 hour';
  if v_count >= 200 then
    return query select 'rate_limited'::text, null::uuid, null::uuid, null::uuid, 300;
    return;
  end if;

  -- A published shop on exactly this host: the merchant should claim it, not
  -- submit it again. Published shops are public, so this reveals nothing.
  select s.id into v_existing
    from public.shops s
   where s.status = 'published'
     and lower(substring(s.website_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')) = p_domain
   limit 1;
  if v_existing is not null then
    return query select 'shop_exists'::text, null::uuid, null::uuid, v_existing, null::integer;
    return;
  end if;

  if p_submission_id is not null then
    -- Someone else's submission and a missing one get the same answer.
    select ms.id, ms.status into v_submission, v_submission_status
      from public.merchant_submissions ms
     where ms.id = p_submission_id
       and ms.submitted_by = p_user_id
     for update;
    if v_submission is null then
      return query select 'submission_not_found'::text, null::uuid, null::uuid, null::uuid, null::integer;
      return;
    end if;
    -- The same statuses the merchant may edit themselves.
    if v_submission_status not in ('draft', 'needs_changes') then
      return query select 'submission_locked'::text, null::uuid, v_submission, null::uuid, null::integer;
      return;
    end if;
    update public.merchant_submissions ms
       set website_url = p_source_url
     where ms.id = v_submission
       and ms.website_url is distinct from p_source_url;
  else
    insert into public.merchant_submissions (submitted_by, website_url, status)
    values (p_user_id, p_source_url, 'draft')
    returning id into v_submission;
  end if;

  insert into public.shop_ai_analyses (submission_id, source_url, status, requested_by, analysis_version)
  values (v_submission, p_source_url, 'running', p_user_id, 'shop-analysis/2')
  returning id into v_analysis;

  return query select 'started'::text, v_analysis, v_submission, null::uuid, null::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. complete_shop_analysis
-- ---------------------------------------------------------------------------

create or replace function public.complete_shop_analysis(
  p_analysis_id uuid,
  p_user_id uuid,
  p_summary text,
  p_detected_styles text[],
  p_detected_audience text[],
  p_detected_products text[],
  p_detected_values text[],
  p_detected_price_positioning text,
  p_suggested_categories jsonb,
  p_suggested_tags jsonb,
  p_confidence_score numeric,
  p_model_provider text,
  p_model_name text,
  p_source_hash text,
  p_raw_extraction jsonb,
  p_proposal jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_submission uuid;
  v_updated integer;
begin
  select a.submission_id into v_submission
    from public.shop_ai_analyses a
   where a.id = p_analysis_id
     and a.requested_by = p_user_id
     and a.status = 'running'
   for update;
  if not found then
    raise exception 'analysis_not_running' using errcode = 'P0002';
  end if;

  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_source_hash' using errcode = '22023';
  end if;
  if p_summary is not null and char_length(p_summary) > 1000 then
    raise exception 'invalid_summary' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_detected_styles), 0) > 8
     or coalesce(cardinality(p_detected_products), 0) > 8
     or coalesce(cardinality(p_detected_values), 0) > 8 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  if p_detected_audience is not null
     and not (p_detected_audience <@ array['women', 'men', 'kids', 'unisex', 'all']::text[]) then
    raise exception 'invalid_audience' using errcode = '22023';
  end if;
  if p_model_provider is not null and char_length(p_model_provider) > 64 then
    raise exception 'invalid_model' using errcode = '22023';
  end if;
  if p_model_name is not null and char_length(p_model_name) > 128 then
    raise exception 'invalid_model' using errcode = '22023';
  end if;

  if p_suggested_categories is null or jsonb_typeof(p_suggested_categories) <> 'array' then
    raise exception 'invalid_suggested_categories' using errcode = '22023';
  end if;
  if jsonb_array_length(p_suggested_categories) > 4 then
    raise exception 'invalid_suggested_categories' using errcode = '22023';
  end if;
  if p_suggested_tags is null or jsonb_typeof(p_suggested_tags) <> 'array' then
    raise exception 'invalid_suggested_tags' using errcode = '22023';
  end if;
  if jsonb_array_length(p_suggested_tags) > 5 then
    raise exception 'invalid_suggested_tags' using errcode = '22023';
  end if;

  if p_raw_extraction is null or jsonb_typeof(p_raw_extraction) <> 'object' then
    raise exception 'invalid_raw_extraction' using errcode = '22023';
  end if;
  if octet_length(p_raw_extraction::text) > 131072 then
    raise exception 'invalid_raw_extraction' using errcode = '22023';
  end if;
  if p_proposal is null or jsonb_typeof(p_proposal) <> 'object' then
    raise exception 'invalid_proposal' using errcode = '22023';
  end if;
  if octet_length(p_proposal::text) > 60000 then
    raise exception 'invalid_proposal' using errcode = '22023';
  end if;

  -- Defence in depth behind the application validator: no persisted document
  -- may carry a key naming verification, trust, certification, publication,
  -- approval, ownership, membership or status.
  if p_proposal::text ~* '"[a-z_]*(verif|trust|certif|publish|approv|owner|member|status)[a-z_]*"\s*:'
     or p_raw_extraction::text ~* '"[a-z_]*(verif|trust|certif|publish|approv|owner|member|status)[a-z_]*"\s*:' then
    raise exception 'forbidden_field' using errcode = '22023';
  end if;

  update public.shop_ai_analyses a
     set status = 'completed',
         summary = p_summary,
         detected_styles = p_detected_styles,
         detected_audience = p_detected_audience,
         detected_products = p_detected_products,
         detected_values = p_detected_values,
         detected_price_positioning = p_detected_price_positioning,
         suggested_categories = p_suggested_categories,
         suggested_tags = p_suggested_tags,
         confidence_score = p_confidence_score,
         model_provider = p_model_provider,
         model_name = p_model_name,
         source_hash = p_source_hash,
         raw_extraction = p_raw_extraction,
         error_message = null,
         analyzed_at = now()
   where a.id = p_analysis_id;

  -- The merchant's copy, under one key. Their own edits elsewhere in
  -- submitted_data are preserved. Skipped — not failed — when the submission is
  -- no longer editable or the result would exceed the 64 KiB ceiling.
  update public.merchant_submissions ms
     set submitted_data = (ms.submitted_data - 'aiProposal') || jsonb_build_object('aiProposal', p_proposal)
   where ms.id = v_submission
     and ms.submitted_by = p_user_id
     and ms.status in ('draft', 'needs_changes')
     and octet_length(((ms.submitted_data - 'aiProposal') || jsonb_build_object('aiProposal', p_proposal))::text) <= 65536;
  get diagnostics v_updated = row_count;

  return v_updated = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. fail_shop_analysis
-- ---------------------------------------------------------------------------

create or replace function public.fail_shop_analysis(
  p_analysis_id uuid,
  p_user_id uuid,
  p_error_code text,
  p_raw_extraction jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid_error_code' using errcode = '22023';
  end if;
  if p_raw_extraction is not null then
    if jsonb_typeof(p_raw_extraction) <> 'object' then
      raise exception 'invalid_raw_extraction' using errcode = '22023';
    end if;
    if octet_length(p_raw_extraction::text) > 16384
       or p_raw_extraction::text ~* '"[a-z_]*(verif|trust|certif|publish|approv|owner|member|status)[a-z_]*"\s*:' then
      raise exception 'invalid_raw_extraction' using errcode = '22023';
    end if;
  end if;

  update public.shop_ai_analyses a
     set status = 'failed',
         error_message = p_error_code,
         raw_extraction = p_raw_extraction,
         analyzed_at = now()
   where a.id = p_analysis_id
     and a.requested_by = p_user_id
     and a.status = 'running';
  if not found then
    raise exception 'analysis_not_running' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Ownership and EXECUTE
-- ---------------------------------------------------------------------------
--
-- Owner set explicitly: SECURITY DEFINER runs as the owner, so an implicit
-- owner would make the effective rights an accident of tooling. postgres owns
-- the tables in public and is not subject to their RLS (no FORCE RLS anywhere).

alter function public.begin_shop_analysis(uuid, uuid, text, text) owner to postgres;
alter function public.complete_shop_analysis(uuid, uuid, text, text[], text[], text[], text[], text, jsonb, jsonb, numeric, text, text, text, jsonb, jsonb) owner to postgres;
alter function public.fail_shop_analysis(uuid, uuid, text, jsonb) owner to postgres;

-- A new function is EXECUTE-able by PUBLIC by default. Revoke, then grant to
-- the one server role. The app, anon and authenticated can never call these.
revoke all on function public.begin_shop_analysis(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_shop_analysis(uuid, uuid, text, text[], text[], text[], text[], text, jsonb, jsonb, numeric, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_shop_analysis(uuid, uuid, text, jsonb) from public, anon, authenticated;

grant execute on function public.begin_shop_analysis(uuid, uuid, text, text) to service_role;
grant execute on function public.complete_shop_analysis(uuid, uuid, text, text[], text[], text[], text[], text, jsonb, jsonb, numeric, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_shop_analysis(uuid, uuid, text, jsonb) to service_role;

comment on function public.begin_shop_analysis(uuid, uuid, text, text) is
  'ai-shop-analysis only. Per-user quota, published-duplicate check, submission '
  'ownership, then a running shop_ai_analyses row. SECURITY DEFINER, '
  'service_role only, search_path pinned, no dynamic SQL.';

comment on function public.complete_shop_analysis(uuid, uuid, text, text[], text[], text[], text[], text, jsonb, jsonb, numeric, text, text, text, jsonb, jsonb) is
  'ai-shop-analysis only. Completes the caller''s running analysis and copies the '
  'proposal into submitted_data.aiProposal of their editable submission. Never '
  'publishes, verifies or grants membership. service_role only.';

comment on function public.fail_shop_analysis(uuid, uuid, text, jsonb) is
  'ai-shop-analysis only. Marks the caller''s running analysis failed with a '
  'closed error code. service_role only.';
