-- Trust, verification, moderation and shop management — Prompt 17.
--
-- Additive. Earlier migrations are history and are not edited.
--
-- AI understands. The database verifies. Moderation decides. The merchant
-- manages. The user sees only trusted public state.
--
-- WHAT THIS ADDS
--   1. app_moderators + is_app_moderator()      who may moderate, server-side
--   2. shop_claim_verification_attempts          rate limit + audit of checks
--   3. begin/finish_claim_verification           domain-control proof of a claim
--                                                (service_role only, called by
--                                                the verify-shop-claim function)
--   4. moderation_list_submissions / moderation_get_submission / moderate_submission
--   5. merchant_submissions_reset_review         a resubmission starts clean
--   6. update_managed_shop                       content + classification edits
--   7. shop_reports                              'impersonation', column-scoped
--                                                insert, one open report per user
--
-- WHAT THIS DOES NOT DO
--   * no policy is created, dropped or relaxed; RLS is enabled on both new
--     tables, with no policy at all — only the functions below reach them;
--   * no table privilege for anon or authenticated except the narrowed
--     shop_reports INSERT, and none for service_role;
--   * no trust score, no editable `verified`, no automatic publication outside
--     moderate_submission, no membership outside finish_claim_verification and
--     moderate_submission;
--   * no deletion. The 6 demo shop_verifications rows (provider NULL, empty
--     evidence, seeded by supabase/seed/demo_shops.sql) are left for the
--     Prompt 20 cleanup; every row this migration's functions write carries a
--     provider and evidence, so the two are told apart.
--
-- A NOTE ON DEFAULT PRIVILEGES. This project's default ACL gives anon,
-- authenticated and service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on
-- every new table postgres creates in public, and EXECUTE to PUBLIC on every
-- new function. TRUNCATE ignores RLS. Every table and function below is
-- therefore followed by an explicit `revoke all`. The pre-existing
-- service_role privileges on older tables are documented for Prompt 20 and
-- deliberately not changed here.
--
-- No explicit BEGIN/COMMIT: the CLI already wraps each file in a transaction.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight
-- ---------------------------------------------------------------------------

do $$
declare
  reason_constraint text;
begin
  if to_regclass('public.app_moderators') is not null
     or to_regclass('public.shop_claim_verification_attempts') is not null then
    raise exception 'Prompt 17 tables already exist: this migration appears to have been applied.';
  end if;

  select pg_get_constraintdef(c.oid) into reason_constraint
  from pg_constraint c
  where c.conrelid = 'public.shop_reports'::regclass
    and c.conname = 'shop_reports_reason_check';
  if reason_constraint is null then
    raise exception 'shop_reports_reason_check not found. Inspect public.shop_reports before applying this migration.';
  end if;
  if reason_constraint like '%impersonation%' then
    raise exception 'shop_reports_reason_check already allows impersonation.';
  end if;

  if exists (
    select 1 from public.shop_reports r
    where r.status = 'open' and r.user_id is not null
    group by r.shop_id, r.user_id
    having count(*) > 1
  ) then
    raise exception 'shop_reports holds duplicate open reports; the unique index below cannot be created.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Moderators
-- ---------------------------------------------------------------------------
--
-- Administered in the database only: a row is added by the project owner from
-- the SQL editor. No client can read or write the table, no function grants
-- the role, and nothing reads a role from user-editable auth metadata.

create table public.app_moderators (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);

alter table public.app_moderators enable row level security;
revoke all on table public.app_moderators from public, anon, authenticated, service_role;

comment on table public.app_moderators is
  'Who may moderate merchant submissions. Written by the project owner only; '
  'no client grant, no policy. Read through is_app_moderator().';

create or replace function public.is_app_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_moderators m where m.user_id = (select auth.uid())
  );
$$;

alter function public.is_app_moderator() owner to postgres;
comment on function public.is_app_moderator() is
  'Whether the CALLER is a moderator. Reveals nothing about anyone else.';
revoke all on function public.is_app_moderator() from public, anon, authenticated;
grant execute on function public.is_app_moderator() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Claim verification attempts
-- ---------------------------------------------------------------------------

create table public.shop_claim_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.shop_claims (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'verified', 'failed')),
  -- A closed vocabulary code. Never a host, an address, a token or a message.
  outcome text check (outcome is null or outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint shop_claim_verification_attempts_finished
    check ((status = 'running') = (finished_at is null))
);

create index shop_claim_verification_attempts_claim_idx
  on public.shop_claim_verification_attempts (claim_id, created_at desc);
create index shop_claim_verification_attempts_user_idx
  on public.shop_claim_verification_attempts (user_id, created_at desc);
create index shop_claim_verification_attempts_created_idx
  on public.shop_claim_verification_attempts (created_at desc);

alter table public.shop_claim_verification_attempts enable row level security;
revoke all on table public.shop_claim_verification_attempts from public, anon, authenticated, service_role;

comment on table public.shop_claim_verification_attempts is
  'One row per domain-control check of a claim: rate limit and audit. '
  'Written only by begin/finish_claim_verification.';

-- ---------------------------------------------------------------------------
-- 3a. begin_claim_verification
-- ---------------------------------------------------------------------------
--
-- Called by the verify-shop-claim Edge Function with the user id it read from
-- the verified JWT. Everything that can be decided without the network is
-- decided here, atomically, before the site is contacted.

create or replace function public.begin_claim_verification(p_user_id uuid, p_claim_id uuid)
returns table (outcome text, attempt_id uuid, website_url text, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_claim public.shop_claims%rowtype;
  v_shop_url text;
  v_count integer;
  v_oldest timestamptz;
  v_attempt uuid;
begin
  if p_user_id is null or not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'invalid_user' using errcode = '22023';
  end if;
  if p_claim_id is null then
    return query select 'claim_not_found'::text, null::uuid, null::text, null::integer;
    return;
  end if;

  -- One begin at a time per user, so concurrent requests cannot both pass
  -- the rate limit.
  perform pg_advisory_xact_lock(hashtextextended('claim_verification:' || p_user_id::text, 0));

  -- Someone else's claim and a missing one get the same answer.
  select c.* into v_claim
    from public.shop_claims c
   where c.id = p_claim_id
     and c.requested_by = p_user_id
   for update;
  if not found then
    return query select 'claim_not_found'::text, null::uuid, null::text, null::integer;
    return;
  end if;

  if v_claim.status = 'approved' then
    if exists (select 1 from public.shop_members m where m.shop_id = v_claim.shop_id and m.user_id = p_user_id) then
      return query select 'already_member'::text, null::uuid, null::text, null::integer;
    else
      return query select 'claim_closed'::text, null::uuid, null::text, null::integer;
    end if;
    return;
  end if;
  if v_claim.status = 'expired' then
    return query select 'claim_expired'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  if v_claim.status <> 'pending' or v_claim.proof_token_hash is null or v_claim.expires_at is null then
    return query select 'claim_closed'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  if v_claim.expires_at <= now() then
    update public.shop_claims c set status = 'expired' where c.id = v_claim.id;
    return query select 'claim_expired'::text, null::uuid, null::text, null::integer;
    return;
  end if;

  select s.website_url into v_shop_url
    from public.shops s
   where s.id = v_claim.shop_id
     and s.status = 'published';
  if v_shop_url is null then
    return query select 'shop_unavailable'::text, null::uuid, null::text, null::integer;
    return;
  end if;

  if exists (select 1 from public.shop_members m where m.shop_id = v_claim.shop_id and m.user_id = p_user_id) then
    return query select 'already_member'::text, null::uuid, null::text, null::integer;
    return;
  end if;
  if exists (select 1 from public.shop_members m where m.shop_id = v_claim.shop_id and m.role = 'owner') then
    return query select 'shop_already_claimed'::text, null::uuid, null::text, null::integer;
    return;
  end if;

  -- A check that never finished (a crashed invocation) stops blocking. It
  -- keeps counting against the limits.
  update public.shop_claim_verification_attempts a
     set status = 'failed', outcome = 'abandoned', finished_at = now()
   where a.user_id = p_user_id
     and a.status = 'running'
     and a.created_at < now() - interval '2 minutes';

  if exists (
    select 1 from public.shop_claim_verification_attempts a
    where a.claim_id = v_claim.id and a.status = 'running'
  ) then
    return query select 'already_running'::text, null::uuid, null::text, 30;
    return;
  end if;

  select count(*), min(a.created_at) into v_count, v_oldest
    from public.shop_claim_verification_attempts a
   where a.claim_id = v_claim.id
     and a.created_at > now() - interval '1 hour';
  if v_count >= 5 then
    return query select 'rate_limited'::text, null::uuid, null::text,
      greatest(60, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::integer);
    return;
  end if;

  select count(*), min(a.created_at) into v_count, v_oldest
    from public.shop_claim_verification_attempts a
   where a.user_id = p_user_id
     and a.created_at > now() - interval '1 hour';
  if v_count >= 15 then
    return query select 'rate_limited'::text, null::uuid, null::text,
      greatest(60, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::integer);
    return;
  end if;

  select count(*) into v_count
    from public.shop_claim_verification_attempts a
   where a.created_at > now() - interval '1 hour';
  if v_count >= 300 then
    return query select 'rate_limited'::text, null::uuid, null::text, 600;
    return;
  end if;

  insert into public.shop_claim_verification_attempts (claim_id, user_id)
  values (v_claim.id, p_user_id)
  returning id into v_attempt;

  return query select 'ready'::text, v_attempt, v_shop_url, null::integer;
end;
$$;

alter function public.begin_claim_verification(uuid, uuid) owner to postgres;
comment on function public.begin_claim_verification(uuid, uuid) is
  'Opens a domain-control check of the caller''s pending claim: ownership, '
  'expiry, shop state, existing owner, rate limits. Never approves. service_role only.';
revoke all on function public.begin_claim_verification(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_claim_verification(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3b. finish_claim_verification
-- ---------------------------------------------------------------------------
--
-- The Edge Function passes what it READ on the home page: the host that served
-- it and the candidate tokens found in the verification meta tag — or a
-- failure code when the page could not be read. The expected token exists
-- nowhere on the server; the stored SHA-256 is compared here and never leaves
-- the database.
--
-- On success, in this one transaction: the claim is approved, the caller
-- becomes the shop's owner, the shop records when it was claimed, and ONE
-- verification is issued — type `domain`, meaning domain control, nothing
-- more — valid for a year.

create or replace function public.finish_claim_verification(
  p_attempt_id uuid,
  p_user_id uuid,
  p_failure text,
  p_final_host text,
  p_candidates text[]
)
returns table (outcome text, verified_shop_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_claim_id uuid;
  v_claim public.shop_claims%rowtype;
  v_shop_url text;
  v_shop_host text;
  v_result text;
begin
  select a.claim_id into v_claim_id
    from public.shop_claim_verification_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id
     and a.status = 'running'
   for update;
  if not found then
    raise exception 'attempt_not_running' using errcode = 'P0002';
  end if;

  if p_failure is not null then
    if p_failure !~ '^[a-z][a-z0-9_]{0,63}$' then
      raise exception 'invalid_failure' using errcode = '22023';
    end if;
    update public.shop_claim_verification_attempts a
       set status = 'failed', outcome = p_failure, finished_at = now()
     where a.id = p_attempt_id;
    return query select 'recorded'::text, null::uuid;
    return;
  end if;

  if p_final_host is null
     or char_length(p_final_host) > 253
     or p_final_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
    raise exception 'invalid_final_host' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_candidates), 0) > 8
     or exists (
       select 1 from unnest(coalesce(p_candidates, array[]::text[])) as candidate(value)
       where candidate.value is null or candidate.value !~ '^sd-claim-[0-9a-f]{64}$'
     ) then
    raise exception 'invalid_candidates' using errcode = '22023';
  end if;

  select c.* into v_claim
    from public.shop_claims c
   where c.id = v_claim_id
     and c.requested_by = p_user_id
   for update;

  if not found then
    v_result := 'claim_closed';
  elsif v_claim.status <> 'pending' or v_claim.proof_token_hash is null or v_claim.expires_at is null then
    v_result := 'claim_closed';
  elsif v_claim.expires_at <= now() then
    update public.shop_claims c set status = 'expired' where c.id = v_claim.id;
    v_result := 'claim_expired';
  end if;

  if v_result is null then
    -- Two users proving the same shop at once: one wins, the other sees an owner.
    perform pg_advisory_xact_lock(hashtextextended('shop_ownership:' || v_claim.shop_id::text, 0));

    select s.website_url into v_shop_url
      from public.shops s
     where s.id = v_claim.shop_id
       and s.status = 'published';
    v_shop_host := rtrim(lower(substring(v_shop_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')), '.');

    if v_shop_url is null or v_shop_host is null or v_shop_host = '' then
      v_result := 'shop_unavailable';
    elsif exists (select 1 from public.shop_members m where m.shop_id = v_claim.shop_id and m.user_id = p_user_id) then
      v_result := 'already_member';
    elsif exists (select 1 from public.shop_members m where m.shop_id = v_claim.shop_id and m.role = 'owner') then
      v_result := 'shop_already_claimed';
    elsif not (
      p_final_host = v_shop_host
      or p_final_host = 'www.' || v_shop_host
      or (left(v_shop_host, 4) = 'www.' and strpos(substr(v_shop_host, 5), '.') > 0 and p_final_host = substr(v_shop_host, 5))
    ) then
      -- The exact host or its www sibling, as ai/server/claim/claim-domain.ts.
      v_result := 'domain_mismatch';
    elsif coalesce(cardinality(p_candidates), 0) = 0 then
      v_result := 'token_absent';
    elsif not exists (
      select 1 from unnest(p_candidates) as candidate(value)
      where encode(sha256(convert_to(candidate.value, 'UTF8')), 'hex') = v_claim.proof_token_hash
    ) then
      v_result := 'token_mismatch';
    end if;
  end if;

  if v_result is not null then
    update public.shop_claim_verification_attempts a
       set status = 'failed', outcome = v_result, finished_at = now()
     where a.id = p_attempt_id;
    return query select v_result, null::uuid;
    return;
  end if;

  update public.shop_claims c
     set status = 'approved',
         method = 'domain',
         proof_verified_at = now(),
         reviewed_at = now(),
         evidence = jsonb_build_object('method', 'meta_tag', 'host', p_final_host, 'attempt_id', p_attempt_id)
   where c.id = v_claim.id;

  insert into public.shop_members (shop_id, user_id, role)
  values (v_claim.shop_id, p_user_id, 'owner');

  update public.shops s
     set claimed_at = now()
   where s.id = v_claim.shop_id;

  -- One live record per (shop, type): a previous one is expired, not deleted.
  update public.shop_verifications v
     set status = 'expired'
   where v.shop_id = v_claim.shop_id
     and v.verification_type = 'domain'
     and v.status in ('pending', 'approved');

  insert into public.shop_verifications (shop_id, verification_type, status, evidence, provider, verified_at, expires_at)
  values (
    v_claim.shop_id,
    'domain',
    'approved',
    jsonb_build_object('method', 'meta_tag', 'host', p_final_host, 'claim_id', v_claim.id),
    'shop_discovery_domain_check',
    now(),
    now() + interval '365 days'
  );

  update public.shop_claim_verification_attempts a
     set status = 'verified', outcome = 'verified', finished_at = now()
   where a.id = p_attempt_id;

  return query select 'verified'::text, v_claim.shop_id;
end;
$$;

alter function public.finish_claim_verification(uuid, uuid, text, text, text[]) owner to postgres;
comment on function public.finish_claim_verification(uuid, uuid, text, text, text[]) is
  'Closes a domain-control check. On a matching token served by the shop host: '
  'claim approved, owner membership, claimed_at, one domain verification. '
  'The token hash never leaves the database. service_role only.';
revoke all on function public.finish_claim_verification(uuid, uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function public.finish_claim_verification(uuid, uuid, text, text, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4a. moderation_list_submissions
-- ---------------------------------------------------------------------------

create or replace function public.moderation_list_submissions()
returns table (
  submission_id uuid,
  status text,
  website_url text,
  proposed_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not exists (select 1 from public.app_moderators m where m.user_id = (select auth.uid())) then
    raise exception 'not_moderator' using errcode = '42501';
  end if;

  return query
    select ms.id,
           ms.status,
           ms.website_url,
           case
             when jsonb_typeof(ms.submitted_data -> 'merchantProfile' -> 'name') = 'string'
               then left(ms.submitted_data -> 'merchantProfile' ->> 'name', 120)
           end,
           ms.created_at,
           ms.updated_at
      from public.merchant_submissions ms
     where ms.status in ('submitted', 'processing', 'needs_changes')
     order by ms.updated_at desc
     limit 200;
end;
$$;

alter function public.moderation_list_submissions() owner to postgres;
comment on function public.moderation_list_submissions() is
  'Submissions awaiting review or awaiting the merchant. Moderators only.';
revoke all on function public.moderation_list_submissions() from public, anon, authenticated;
grant execute on function public.moderation_list_submissions() to authenticated;

-- ---------------------------------------------------------------------------
-- 4b. moderation_get_submission
-- ---------------------------------------------------------------------------
--
-- The merchant's profile (untrusted, shown as submitted) next to what the
-- server observed on the site. The submitter is identified by a short
-- reference only.

create or replace function public.moderation_get_submission(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row public.merchant_submissions%rowtype;
  v_host text;
  v_bare text;
  v_raw jsonb;
  v_analyzed_at timestamptz;
  v_analysis_host text;
begin
  if not exists (select 1 from public.app_moderators m where m.user_id = (select auth.uid())) then
    raise exception 'not_moderator' using errcode = '42501';
  end if;

  select ms.* into v_row from public.merchant_submissions ms where ms.id = p_submission_id;
  if not found then
    return null;
  end if;

  v_host := rtrim(lower(substring(v_row.website_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')), '.');
  v_bare := case
    when left(v_host, 4) = 'www.' and strpos(substr(v_host, 5), '.') > 0 then substr(v_host, 5)
    else v_host
  end;

  select a.raw_extraction, a.analyzed_at, rtrim(lower(substring(a.source_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')), '.')
    into v_raw, v_analyzed_at, v_analysis_host
    from public.shop_ai_analyses a
   where a.submission_id = v_row.id
     and a.status = 'completed'
   order by a.analyzed_at desc nulls last, a.created_at desc
   limit 1;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'websiteUrl', v_row.website_url,
    'host', v_host,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at,
    'reviewNote', v_row.review_note,
    'reviewedAt', v_row.reviewed_at,
    'shopId', v_row.shop_id,
    'submitterRef', left(v_row.submitted_by::text, 8),
    'ownSubmission', v_row.submitted_by = (select auth.uid()),
    'hostAlreadyListed', exists (
      select 1 from public.shops s
      where rtrim(lower(substring(s.website_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')), '.') in (v_bare, 'www.' || v_bare)
    ),
    'merchantProfile', case
      when jsonb_typeof(v_row.submitted_data -> 'merchantProfile') = 'object' then v_row.submitted_data -> 'merchantProfile'
    end,
    'analysis', case
      when v_raw is null then null
      else jsonb_build_object(
        'analyzedAt', v_analyzed_at,
        'sameHost', v_analysis_host = v_host,
        'observed', v_raw -> 'observed',
        'inferred', v_raw -> 'inferred',
        'warnings', v_raw -> 'warnings',
        'degraded', v_raw -> 'degraded'
      )
    end
  );
end;
$$;

alter function public.moderation_get_submission(uuid) owner to postgres;
comment on function public.moderation_get_submission(uuid) is
  'One submission for review: merchant profile, server observations, duplicate '
  'hint. Moderators only.';
revoke all on function public.moderation_get_submission(uuid) from public, anon, authenticated;
grant execute on function public.moderation_get_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4c. moderate_submission
-- ---------------------------------------------------------------------------
--
-- submitted_data is UNTRUSTED. On approval this function reads only the keys
-- of merchantProfile it knows, checks every type and bound, resolves category
-- and tag slugs against the live vocabulary, takes images only from what the
-- server itself observed on the same host, and builds the shop from those
-- values. Nothing named verified, trust, published, status, owner or member is
-- ever read from the document. No verification is issued: approval publishes
-- a reviewed listing, it does not certify anything.

create or replace function public.moderate_submission(p_submission_id uuid, p_action text, p_note text)
returns table (outcome text, created_shop_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_moderator uuid := auth.uid();
  v_note text;
  v_row public.merchant_submissions%rowtype;
  v_profile jsonb;
  v_host text;
  v_bare text;
  v_name text;
  v_description text;
  v_primary uuid;
  v_secondary uuid[] := '{}';
  v_tags uuid[] := '{}';
  v_audience text;
  v_count integer;
  v_price smallint;
  v_raw jsonb;
  v_allowed_images text[] := '{}';
  v_observed_logo text;
  v_images text[] := '{}';
  v_logo text;
  v_base text;
  v_slug text;
  v_suffix integer := 1;
  v_shop uuid;
begin
  if v_moderator is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.app_moderators m where m.user_id = v_moderator) then
    raise exception 'not_moderator' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('approve', 'needs_changes', 'reject') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  v_note := nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
  if v_note is not null and (char_length(v_note) > 500 or v_note ~ '[[:cntrl:]]') then
    return query select 'invalid_note'::text, null::uuid;
    return;
  end if;
  if p_action in ('needs_changes', 'reject') and v_note is null then
    return query select 'note_required'::text, null::uuid;
    return;
  end if;

  -- Serialises two moderators, and a double tap, on the same submission.
  select ms.* into v_row
    from public.merchant_submissions ms
   where ms.id = p_submission_id
   for update;
  if not found then
    return query select 'submission_not_found'::text, null::uuid;
    return;
  end if;
  if v_row.submitted_by = v_moderator then
    return query select 'own_submission'::text, null::uuid;
    return;
  end if;
  if v_row.status in ('approved', 'rejected', 'needs_changes') then
    return query select 'already_reviewed'::text, v_row.shop_id;
    return;
  end if;
  if v_row.status not in ('submitted', 'processing') then
    return query select 'not_submitted'::text, null::uuid;
    return;
  end if;

  if p_action in ('needs_changes', 'reject') then
    update public.merchant_submissions ms
       set status = case when p_action = 'reject' then 'rejected' else 'needs_changes' end,
           review_note = v_note,
           reviewed_by = v_moderator,
           reviewed_at = now()
     where ms.id = v_row.id;
    return query select case when p_action = 'reject' then 'rejected' else 'needs_changes' end, null::uuid;
    return;
  end if;

  -- ---- approve: rebuild the shop from validated values only ----------------

  v_profile := v_row.submitted_data -> 'merchantProfile';
  if jsonb_typeof(v_profile) is distinct from 'object'
     or jsonb_typeof(v_profile -> 'profileVersion') is distinct from 'string'
     or v_profile ->> 'profileVersion' <> 'merchant-profile/1' then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;

  v_host := rtrim(lower(substring(v_row.website_url from '^[Hh][Tt][Tt][Pp][Ss]://([^/:?#]+)')), '.');
  if v_row.website_url ~ '\s'
     or char_length(v_row.website_url) > 2048
     or v_host is null
     or char_length(v_host) > 253
     or v_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;
  v_bare := case
    when left(v_host, 4) = 'www.' and strpos(substr(v_host, 5), '.') > 0 then substr(v_host, 5)
    else v_host
  end;

  -- name
  if jsonb_typeof(v_profile -> 'name') is distinct from 'string' then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;
  v_name := btrim(regexp_replace(v_profile ->> 'name', '\s+', ' ', 'g'));
  if char_length(v_name) < 1 or char_length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;

  -- shortDescription
  if v_profile -> 'shortDescription' is null or jsonb_typeof(v_profile -> 'shortDescription') = 'null' then
    v_description := null;
  elsif jsonb_typeof(v_profile -> 'shortDescription') = 'string' then
    v_description := nullif(btrim(regexp_replace(v_profile ->> 'shortDescription', '\s+', ' ', 'g')), '');
    if v_description is not null and (char_length(v_description) > 280 or v_description ~ '[[:cntrl:]]') then
      return query select 'invalid_profile'::text, null::uuid;
      return;
    end if;
  else
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;

  -- primaryCategory: required, active
  if jsonb_typeof(v_profile -> 'primaryCategory') is distinct from 'string' then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;
  select c.id into v_primary
    from public.categories c
   where c.slug = v_profile ->> 'primaryCategory'
     and c.is_active;
  if v_primary is null then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;

  -- secondaryCategories: at most 3 strings; unknown or inactive slugs dropped
  if v_profile -> 'secondaryCategories' is not null and jsonb_typeof(v_profile -> 'secondaryCategories') <> 'null' then
    if jsonb_typeof(v_profile -> 'secondaryCategories') <> 'array'
       or jsonb_array_length(v_profile -> 'secondaryCategories') > 3
       or exists (
         select 1 from jsonb_array_elements(v_profile -> 'secondaryCategories') as e(value)
         where jsonb_typeof(e.value) <> 'string'
       ) then
      return query select 'invalid_profile'::text, null::uuid;
      return;
    end if;
    select coalesce(array_agg(distinct c.id), '{}') into v_secondary
      from jsonb_array_elements_text(v_profile -> 'secondaryCategories') as e(slug)
      join public.categories c on c.slug = e.slug and c.is_active
     where c.id <> v_primary;
  end if;

  -- tags: at most 5 strings; unknown slugs and origin tags dropped
  if v_profile -> 'tags' is not null and jsonb_typeof(v_profile -> 'tags') <> 'null' then
    if jsonb_typeof(v_profile -> 'tags') <> 'array'
       or jsonb_array_length(v_profile -> 'tags') > 5
       or exists (
         select 1 from jsonb_array_elements(v_profile -> 'tags') as e(value)
         where jsonb_typeof(e.value) <> 'string'
       ) then
      return query select 'invalid_profile'::text, null::uuid;
      return;
    end if;
    select coalesce(array_agg(distinct t.id), '{}') into v_tags
      from jsonb_array_elements_text(v_profile -> 'tags') as e(slug)
      join public.tags t on t.slug = e.slug and t.kind <> 'origin';
  end if;

  -- audience: known values only; several collapse to 'all'
  if v_profile -> 'audience' is null or jsonb_typeof(v_profile -> 'audience') = 'null' then
    v_audience := null;
  elsif jsonb_typeof(v_profile -> 'audience') <> 'array'
     or jsonb_array_length(v_profile -> 'audience') > 5
     or exists (
       select 1 from jsonb_array_elements(v_profile -> 'audience') as e(value)
       where jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') not in ('women', 'men', 'kids', 'unisex', 'all')
     ) then
    return query select 'invalid_profile'::text, null::uuid;
    return;
  else
    select count(distinct e.value), min(e.value) into v_count, v_audience
      from jsonb_array_elements_text(v_profile -> 'audience') as e(value);
    v_audience := case when v_count = 0 then null when v_count = 1 then v_audience else 'all' end;
  end if;

  -- pricePositioning -> price_level
  if v_profile -> 'pricePositioning' is null or jsonb_typeof(v_profile -> 'pricePositioning') = 'null' then
    v_price := null;
  elsif jsonb_typeof(v_profile -> 'pricePositioning') = 'string'
        and v_profile ->> 'pricePositioning' in ('budget', 'mid', 'premium', 'luxury') then
    v_price := case v_profile ->> 'pricePositioning'
      when 'budget' then 1 when 'mid' then 2 when 'premium' then 3 else 4
    end;
  else
    return query select 'invalid_profile'::text, null::uuid;
    return;
  end if;

  -- images: only what the server observed, on this same host
  select a.raw_extraction into v_raw
    from public.shop_ai_analyses a
   where a.submission_id = v_row.id
     and a.status = 'completed'
     and rtrim(lower(substring(a.source_url from '^[Hh][Tt][Tt][Pp][Ss]://([^/:?#]+)')), '.') = v_host
   order by a.analyzed_at desc nulls last, a.created_at desc
   limit 1;

  if jsonb_typeof(v_raw -> 'observed' -> 'imageUrls') = 'array' then
    select coalesce(array_agg(e.value ->> 'value'), '{}') into v_allowed_images
      from jsonb_array_elements(v_raw -> 'observed' -> 'imageUrls') as e(value)
     where jsonb_typeof(e.value -> 'value') = 'string'
       and e.value ->> 'value' ~ '^https://'
       and char_length(e.value ->> 'value') <= 2048;
  end if;
  if jsonb_typeof(v_raw -> 'observed' -> 'logoUrl' -> 'value') = 'string'
     and v_raw -> 'observed' -> 'logoUrl' ->> 'value' ~ '^https://'
     and char_length(v_raw -> 'observed' -> 'logoUrl' ->> 'value') <= 2048 then
    v_observed_logo := v_raw -> 'observed' -> 'logoUrl' ->> 'value';
  end if;

  if v_profile -> 'imageUrls' is not null and jsonb_typeof(v_profile -> 'imageUrls') <> 'null' then
    if jsonb_typeof(v_profile -> 'imageUrls') <> 'array'
       or jsonb_array_length(v_profile -> 'imageUrls') > 6
       or exists (
         select 1 from jsonb_array_elements(v_profile -> 'imageUrls') as e(value)
         where jsonb_typeof(e.value) <> 'string'
       ) then
      return query select 'invalid_profile'::text, null::uuid;
      return;
    end if;
    select coalesce(array_agg(x.url order by x.ord), '{}') into v_images
      from (
        select e.url, min(e.ord) as ord
          from jsonb_array_elements_text(v_profile -> 'imageUrls') with ordinality as e(url, ord)
         where e.url = any (v_allowed_images)
         group by e.url
      ) x;
  end if;

  if jsonb_typeof(v_profile -> 'logoUrl') = 'string'
     and v_observed_logo is not null
     and v_profile ->> 'logoUrl' = v_observed_logo then
    v_logo := v_observed_logo;
  end if;

  -- No second listing for the same host or its www sibling, whatever its
  -- status. The lock serialises approvals of the same domain.
  perform pg_advisory_xact_lock(hashtextextended('shop_host:' || v_bare, 0));
  if exists (
    select 1 from public.shops s
    where rtrim(lower(substring(s.website_url from '^[Hh][Tt][Tt][Pp][Ss]?://([^/:?#]+)')), '.') in (v_bare, 'www.' || v_bare)
  ) then
    return query select 'duplicate_shop'::text, null::uuid;
    return;
  end if;

  -- slug from the validated name: accents folded, [a-z0-9-] only
  v_base := regexp_replace(normalize(lower(v_name), NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g');
  v_base := btrim(left(btrim(regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'), '-'), 48), '-');
  if v_base = '' then
    v_base := 'boutique';
  end if;
  v_slug := v_base;
  while exists (select 1 from public.shops s where s.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    if v_suffix > 20 then
      return query select 'slug_unavailable'::text, null::uuid;
      return;
    end if;
    v_slug := v_base || '-' || v_suffix::text;
  end loop;

  begin
    insert into public.shops (
      name, slug, website_url, short_description, audience, price_level,
      status, published_at, created_by, claimed_at
    )
    values (
      v_name, v_slug, v_row.website_url, v_description, v_audience, v_price,
      'published', now(), v_row.submitted_by, now()
    )
    returning id into v_shop;

    insert into public.shop_members (shop_id, user_id, role)
    values (v_shop, v_row.submitted_by, 'owner');

    insert into public.shop_categories (shop_id, category_id, is_primary, source)
    values (v_shop, v_primary, true, 'merchant');
    insert into public.shop_categories (shop_id, category_id, is_primary, source)
    select v_shop, e.category_id, false, 'merchant'
      from unnest(v_secondary) as e(category_id);

    insert into public.shop_tags (shop_id, tag_id, source)
    select v_shop, e.tag_id, 'merchant'
      from unnest(v_tags) as e(tag_id);

    if v_logo is not null then
      insert into public.shop_images (shop_id, external_url, image_type, position, alt_text)
      values (v_shop, v_logo, 'logo', 0, v_name);
    end if;
    insert into public.shop_images (shop_id, external_url, image_type, position)
    select v_shop, e.url, case when e.ord = 1 then 'cover' else 'gallery' end, (e.ord - 1)::integer
      from unnest(v_images) with ordinality as e(url, ord);

    update public.merchant_submissions ms
       set status = 'approved',
           shop_id = v_shop,
           review_note = v_note,
           reviewed_by = v_moderator,
           reviewed_at = now()
     where ms.id = v_row.id;
  exception
    when unique_violation then
      -- A concurrent approval took the slug or the URL first: nothing above
      -- persists, the moderator retries.
      return query select 'conflict'::text, null::uuid;
      return;
  end;

  return query select 'approved'::text, v_shop;
end;
$$;

alter function public.moderate_submission(uuid, text, text) owner to postgres;
comment on function public.moderate_submission(uuid, text, text) is
  'Moderator decision on a submitted request: approve (validated shop, owner '
  'membership, published, no verification), needs_changes or reject. '
  'Moderators only, never on their own submission.';
revoke all on function public.moderate_submission(uuid, text, text) from public, anon, authenticated;
grant execute on function public.moderate_submission(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. A resubmission starts clean
-- ---------------------------------------------------------------------------
--
-- A merchant sends a request again after `needs_changes` through the existing
-- RLS update (needs_changes -> submitted). The previous reviewer's note, name
-- and date describe the old version; they are cleared as the request is sent.

create or replace function public.merchant_submissions_reset_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'submitted' and old.status in ('draft', 'needs_changes') then
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end;
$$;

alter function public.merchant_submissions_reset_review() owner to postgres;
revoke all on function public.merchant_submissions_reset_review() from public, anon, authenticated, service_role;

create trigger merchant_submissions_reset_review
  before update on public.merchant_submissions
  for each row execute function public.merchant_submissions_reset_review();

-- ---------------------------------------------------------------------------
-- 6. update_managed_shop
-- ---------------------------------------------------------------------------
--
-- The owner or an admin of a shop — the roles shops_update_by_members already
-- lets edit content — changes content and classification in one transaction.
-- Exactly the content columns authenticated may already update, plus
-- categories, tags and image removal, which have no client write path. Never
-- the slug, URL, status, publication, claim, verification or membership.

create or replace function public.update_managed_shop(
  p_shop_id uuid,
  p_name text,
  p_short_description text,
  p_primary_category text,
  p_secondary_categories text[],
  p_tags text[],
  p_audience text,
  p_price_level smallint,
  p_removed_image_ids uuid[]
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_status text;
  v_name text;
  v_description text;
  v_primary uuid;
  v_secondary uuid[] := '{}';
  v_tags uuid[] := '{}';
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_shop_id is null or not exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = v_user and m.role in ('owner', 'admin')
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select s.status into v_status from public.shops s where s.id = p_shop_id for update;
  if v_status is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_status not in ('published', 'draft', 'pending_review') then
    return 'shop_locked';
  end if;

  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if char_length(v_name) < 1 or char_length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    return 'invalid';
  end if;
  v_description := nullif(btrim(regexp_replace(coalesce(p_short_description, ''), '\s+', ' ', 'g')), '');
  if v_description is not null and (char_length(v_description) > 280 or v_description ~ '[[:cntrl:]]') then
    return 'invalid';
  end if;
  if p_audience is not null and p_audience not in ('women', 'men', 'kids', 'unisex', 'all') then
    return 'invalid';
  end if;
  if p_price_level is not null and (p_price_level < 1 or p_price_level > 4) then
    return 'invalid';
  end if;
  if coalesce(cardinality(p_secondary_categories), 0) > 3
     or coalesce(cardinality(p_tags), 0) > 5
     or coalesce(cardinality(p_removed_image_ids), 0) > 50 then
    return 'invalid';
  end if;

  select c.id into v_primary from public.categories c where c.slug = p_primary_category and c.is_active;
  if v_primary is null then
    return 'invalid';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_secondary_categories, array[]::text[])) as e(slug)
    where not exists (select 1 from public.categories c where c.slug = e.slug and c.is_active)
  ) then
    return 'invalid';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_tags, array[]::text[])) as e(slug)
    where not exists (select 1 from public.tags t where t.slug = e.slug and t.kind <> 'origin')
  ) then
    return 'invalid';
  end if;

  select coalesce(array_agg(distinct c.id), '{}') into v_secondary
    from unnest(coalesce(p_secondary_categories, array[]::text[])) as e(slug)
    join public.categories c on c.slug = e.slug and c.is_active
   where c.id <> v_primary;
  select coalesce(array_agg(distinct t.id), '{}') into v_tags
    from unnest(coalesce(p_tags, array[]::text[])) as e(slug)
    join public.tags t on t.slug = e.slug and t.kind <> 'origin';

  update public.shops s
     set name = v_name,
         short_description = v_description,
         audience = p_audience,
         price_level = p_price_level
   where s.id = p_shop_id;

  delete from public.shop_categories sc where sc.shop_id = p_shop_id;
  insert into public.shop_categories (shop_id, category_id, is_primary, source)
  values (p_shop_id, v_primary, true, 'merchant');
  insert into public.shop_categories (shop_id, category_id, is_primary, source)
  select p_shop_id, e.category_id, false, 'merchant'
    from unnest(v_secondary) as e(category_id);

  -- Origin tags are declared then verified elsewhere: kept, never set here.
  delete from public.shop_tags st
   where st.shop_id = p_shop_id
     and exists (select 1 from public.tags t where t.id = st.tag_id and t.kind <> 'origin');
  insert into public.shop_tags (shop_id, tag_id, source)
  select p_shop_id, e.tag_id, 'merchant'
    from unnest(v_tags) as e(tag_id)
  on conflict do nothing;

  if coalesce(cardinality(p_removed_image_ids), 0) > 0 then
    delete from public.shop_images i
     where i.shop_id = p_shop_id
       and i.id = any (p_removed_image_ids);
  end if;

  return 'updated';
end;
$$;

alter function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) owner to postgres;
comment on function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) is
  'Content and classification edits by a shop owner or admin, atomically. '
  'Never status, slug, URL, publication, claim, verification or membership.';
revoke all on function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) from public, anon, authenticated;
grant execute on function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. shop_reports
-- ---------------------------------------------------------------------------
--
-- Reports feed moderation; they never suspend a shop, and nothing public is
-- derived from them.

alter table public.shop_reports drop constraint shop_reports_reason_check;
alter table public.shop_reports
  add constraint shop_reports_reason_check
  check (reason in ('scam_suspected', 'counterfeit', 'website_unavailable', 'misleading_information', 'impersonation', 'other'));

-- The reporter is the caller, never a value from the request.
alter table public.shop_reports alter column user_id set default auth.uid();

-- The core schema granted INSERT on every column, so a client could set
-- status, resolved_at or another user's id (the policy caught only some of
-- it). Table-level INSERT must be revoked for the column grant to restrict.
revoke insert on public.shop_reports from authenticated;
grant insert (shop_id, reason, description) on public.shop_reports to authenticated;
-- shop_reports_insert_own (own user_id, visible shop, status open) is unchanged.

-- One open report per user and shop: a second tap is refused, not stored.
create unique index shop_reports_one_open_per_user_idx
  on public.shop_reports (shop_id, user_id)
  where status = 'open';
