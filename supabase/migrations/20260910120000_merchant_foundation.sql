-- Merchant foundation — Prompt 16, Phase A.
--
-- Additive and corrective. Earlier migrations are history and are not edited.
--
-- WHAT THIS FIXES. The Prompt 16 audit found that two merchant tables granted
-- INSERT on EVERY column, while their UPDATE grants were carefully column-
-- scoped:
--
--   * merchant_submissions — a client could insert a submission already
--     carrying `shop_id`, `reviewed_by`, `reviewed_at` or `review_note`. The
--     update grant's own comment says those "belong to the reviewer"; the
--     insert path simply was not held to the same rule. An approval step that
--     trusted `shop_id` would have handed a stranger someone else's shop.
--   * shop_claims — a client could insert `evidence`, `method` and reviewer
--     metadata. Status was pinned to 'pending', so no self-approval, but a
--     forged audit trail and client-authored "evidence" are exactly what a
--     claim review must never be shown.
--
-- WHAT THIS ADDS. Proof-of-control columns on shop_claims, a server-side way
-- to open a claim, and referential integrity on shop_ai_analyses.
--
-- WHAT THIS DOES NOT DO:
--   * no network verification of a claim (Phase D);
--   * no approval function (Phase D / submission review);
--   * no Storage (D4);
--   * no new privilege for service_role — see the note at the end;
--   * no change to any policy outside merchant_submissions and shop_claims,
--     and no change to RLS enablement anywhere.
--
-- No explicit BEGIN/COMMIT: the CLI already wraps each file in a transaction.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight — fail loudly on anything this migration would silently break
-- ---------------------------------------------------------------------------

do $$
declare
  status_constraint text;
  orphans integer;
  bad_claims integer;
  bad_submissions integer;
begin
  -- The status CHECK was declared inline, so its name was generated. Replacing
  -- it by a guessed name would, if the guess were wrong, leave the old CHECK in
  -- place alongside the new one — the migration would succeed and 'expired'
  -- would still be rejected. Look it up instead of assuming.
  select pg_get_constraintdef(c.oid) into status_constraint
  from pg_constraint c
  where c.conrelid = 'public.shop_claims'::regclass
    and c.conname = 'shop_claims_status_check';

  if status_constraint is null then
    raise exception
      'shop_claims_status_check not found. Inspect the CHECK constraints on public.shop_claims before applying this migration.';
  end if;
  if status_constraint like '%expired%' then
    raise exception 'shop_claims_status_check already allows expired: this migration appears to have been applied.';
  end if;

  -- A foreign key cannot be added over rows that point nowhere.
  select count(*) into orphans
  from public.shop_ai_analyses a
  where a.submission_id is not null
    and not exists (select 1 from public.merchant_submissions s where s.id = a.submission_id);
  if orphans > 0 then
    raise exception 'shop_ai_analyses holds % row(s) whose submission_id matches no submission.', orphans;
  end if;

  -- Rows that would violate the CHECKs added below.
  select count(*) into bad_claims
  from public.shop_claims c
  where c.status = 'approved' and c.reviewed_at is null;
  if bad_claims > 0 then
    raise exception 'shop_claims holds % approved row(s) with no reviewed_at.', bad_claims;
  end if;

  select count(*) into bad_submissions
  from public.merchant_submissions s
  where jsonb_typeof(s.submitted_data) <> 'object'
     or octet_length(s.submitted_data::text) > 65536;
  if bad_submissions > 0 then
    raise exception 'merchant_submissions holds % row(s) whose submitted_data is not an object under 64 KiB.', bad_submissions;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. merchant_submissions — the client names only its own content
-- ---------------------------------------------------------------------------
--
-- Ownership moves out of the request entirely. `submitted_by` defaults to the
-- caller's uid, and the column is not granted: a client cannot even name it,
-- so it cannot be set to anybody else. The existing RLS WITH CHECK
-- (`auth.uid() = submitted_by`) stays as the second line of defence.

alter table public.merchant_submissions
  alter column submitted_by set default auth.uid();

-- Table-level INSERT must be revoked explicitly: a column-level grant added on
-- top of a table-level one restricts nothing.
revoke insert on public.merchant_submissions from authenticated;

-- Exactly what a merchant authors. Not id, submitted_by, shop_id, review_note,
-- reviewed_by, reviewed_at, created_at or updated_at — each of those is either
-- derived by the database or belongs to the reviewer.
grant insert (website_url, submitted_data, status)
  on public.merchant_submissions to authenticated;

-- Unchanged, restated so the full client privilege set reads in one place:
--   grant select on public.merchant_submissions to authenticated;
--   grant update (website_url, submitted_data, status) ... to authenticated;
-- The insert policy still limits status to draft/submitted, and the update
-- policy still forbids ever writing approved or rejected.

-- D1 makes submitted_data the carrier of the merchant-readable proposal, and
-- the client can write it. Unbounded client-writable JSON is a storage abuse
-- vector, so it gets a shape and a ceiling. 64 KiB comfortably holds a full
-- shop-analysis/2 payload at its declared limits.
alter table public.merchant_submissions
  add constraint merchant_submissions_submitted_data_shape
  check (jsonb_typeof(submitted_data) = 'object' and octet_length(submitted_data::text) <= 65536);

-- ---------------------------------------------------------------------------
-- 2. shop_claims — no direct client write; proof columns
-- ---------------------------------------------------------------------------

revoke insert on public.shop_claims from authenticated;

-- With the grant gone this policy is unreachable. It is dropped rather than
-- left dormant: a permissive policy waiting for someone to re-grant INSERT is
-- how a revert of this migration would silently reopen the hole.
drop policy if exists shop_claims_insert_own on public.shop_claims;

alter table public.shop_claims
  -- SHA-256, hex. The plaintext token is returned once and never stored.
  add column proof_token_hash text,
  add column proof_verified_at timestamptz,
  add column expires_at timestamptz;

alter table public.shop_claims drop constraint shop_claims_status_check;
alter table public.shop_claims
  add constraint shop_claims_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'expired'));

alter table public.shop_claims
  add constraint shop_claims_proof_token_hash_format
    check (proof_token_hash is null or proof_token_hash ~ '^[0-9a-f]{64}$'),
  -- A proof cannot be verified that was never issued.
  add constraint shop_claims_verified_requires_token
    check (proof_verified_at is null or proof_token_hash is not null),
  -- Only something that could expire can be expired.
  add constraint shop_claims_expired_has_expiry
    check (status <> 'expired' or expires_at is not null),
  add constraint shop_claims_expiry_after_creation
    check (expires_at is null or expires_at > created_at),
  -- D2 auto-approval has no human reviewer, but it still has a moment.
  add constraint shop_claims_approved_has_timestamp
    check (status <> 'approved' or reviewed_at is not null);

comment on column public.shop_claims.proof_token_hash is
  'SHA-256 (hex) of the proof token. The token itself is shown to the claimant '
  'once by request_shop_claim and never stored.';

-- One open claim per (shop, user) is kept, from the core schema. There is
-- deliberately NO "one open claim per shop" rule: that would let whoever asks
-- first block the real owner for the lifetime of their token. Competing claims
-- are resolved at approval, where D2 refuses any shop that already has an owner.

-- Column-scoped reads. The proof token hash and the evidence are server data;
-- the reviewer's identity is not the claimant's business. A client must name
-- the columns it selects — `select=*` is refused.
--
-- ORDER MATTERS. This grant names proof_verified_at and expires_at, so it must
-- come AFTER the alter table that creates them. Placed before it, PostgreSQL
-- refuses the grant (42703) and the whole migration rolls back — which is how
-- the first push of this file failed. supabase/migration-contracts.test.ts
-- now checks the order.
revoke select on public.shop_claims from authenticated;
grant select (
  id, shop_id, requested_by, status, method, review_note,
  reviewed_at, proof_verified_at, expires_at, created_at
) on public.shop_claims to authenticated;
-- shop_claims_select_own (auth.uid() = requested_by) is unchanged.

-- ---------------------------------------------------------------------------
-- 3. request_shop_claim — the only way a client opens a claim
-- ---------------------------------------------------------------------------
--
-- WHY IT EXISTS NOW rather than in Phase D. Section 2 removes the client's
-- direct INSERT. Without a replacement, shop_claims would have no client
-- writer at all, and the proof columns added above would have nothing that
-- populates them — untestable, and a design nobody could review end to end.
-- This function is the replacement, and it is deliberately small:
--
--   * it creates a PENDING claim and a proof token, nothing more;
--   * it performs NO network verification — that is Phase D;
--   * it can never approve, never write evidence, method or reviewer fields,
--     and never create a membership.
--
-- WHY SECURITY DEFINER. The caller has no INSERT on shop_claims, and must be
-- able to learn whether a shop already has an owner without reading
-- shop_members, which they cannot see for shops they do not belong to.
--
-- WHY THAT IS ACCEPTABLE for a function reachable by `authenticated` — a
-- stronger requirement than search_shops_semantic, which only service_role
-- can call:
--   * identity comes from auth.uid() only; there is no user parameter;
--   * the single parameter is a uuid, used only in equality predicates; no
--     dynamic SQL, no identifier from input;
--   * `set search_path = ''`, every name schema-qualified;
--   * it answers only about PUBLISHED shops, which anyone can already list;
--   * the only row it writes is the caller's own pending claim;
--   * it is rate limited per caller.
--
-- The token comes from two gen_random_uuid() calls (strong random source,
-- 244 bits) hashed with core sha256(), so no extension is required.

create or replace function public.request_shop_claim(p_shop_id uuid)
returns table (claim_id uuid, proof_token text, proof_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_token text;
  v_claim uuid;
  v_expires timestamptz := now() + interval '7 days';
  v_open integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if p_shop_id is null or not exists (
    select 1 from public.shops s where s.id = p_shop_id and s.status = 'published'
  ) then
    -- The same answer for "does not exist" and "not published", so the
    -- function cannot be used to probe for draft shops.
    raise exception 'shop_not_found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.shop_members m where m.shop_id = p_shop_id and m.user_id = v_user
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;

  -- Case 3 of the merchant flow: an owned shop gets no new owner here.
  if exists (
    select 1 from public.shop_members m where m.shop_id = p_shop_id and m.role = 'owner'
  ) then
    raise exception 'shop_already_claimed' using errcode = 'P0001';
  end if;

  -- Retire the caller's own stale pending claims first. The partial unique
  -- index counts status = 'pending', so an expired-but-unmarked row would
  -- otherwise block a fresh request for the same shop.
  update public.shop_claims c
  set status = 'expired'
  where c.requested_by = v_user
    and c.status = 'pending'
    and c.expires_at is not null
    and c.expires_at <= now();

  select count(*) into v_open
  from public.shop_claims c
  where c.requested_by = v_user
    and c.status = 'pending'
    and c.shop_id <> p_shop_id;

  if v_open >= 5 then
    raise exception 'too_many_open_claims' using errcode = 'P0001';
  end if;

  v_token := 'sd-claim-'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  -- Asking again for the same shop ROTATES the token: the plaintext was never
  -- stored, so it cannot be shown twice, and a merchant who lost it must not
  -- be locked out until expiry. Rotation invalidates the previous token.
  insert into public.shop_claims (shop_id, requested_by, status, proof_token_hash, expires_at)
  values (
    p_shop_id,
    v_user,
    'pending',
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_expires
  )
  on conflict (shop_id, requested_by) where status = 'pending'
  do update set
    proof_token_hash = excluded.proof_token_hash,
    expires_at = excluded.expires_at,
    proof_verified_at = null
  returning id into v_claim;

  return query select v_claim, v_token, v_expires;
end;
$$;

alter function public.request_shop_claim(uuid) owner to postgres;

comment on function public.request_shop_claim(uuid) is
  'Opens (or rotates) the caller''s pending claim on a published, unowned shop '
  'and returns a one-time proof token. Never approves, never verifies, never '
  'writes evidence or membership. SECURITY DEFINER, auth.uid() only.';

-- A new function is EXECUTE-able by PUBLIC by default. Revoke first, then
-- grant to exactly the one role that opens claims. anon cannot claim.
revoke all on function public.request_shop_claim(uuid) from public, anon, authenticated;
grant execute on function public.request_shop_claim(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. shop_ai_analyses — provenance of the request, and a real foreign key
-- ---------------------------------------------------------------------------

alter table public.shop_ai_analyses
  -- set null, not cascade: an analysis spent provider money, and its record
  -- stays useful for cost accounting after the requester deletes the account.
  add column requested_by uuid references public.profiles (id) on delete set null;

-- The core schema declared submission_id with no reference, so an analysis
-- could point at a submission that never existed. Cascade: an analysis of a
-- deleted submission is a proposal about nothing.
alter table public.shop_ai_analyses
  add constraint shop_ai_analyses_submission_id_fkey
  foreign key (submission_id) references public.merchant_submissions (id) on delete cascade;

-- The per-user daily quota the analyzer will enforce (ai/SECURITY.md §2).
create index shop_ai_analyses_requested_by_idx
  on public.shop_ai_analyses (requested_by, created_at desc);

-- shop_ai_analyses keeps NO client grant and NO client policy (D1): the
-- merchant reads the proposal from merchant_submissions.submitted_data.

-- ---------------------------------------------------------------------------
-- Deliberately open, for Phase B
-- ---------------------------------------------------------------------------
--
-- service_role holds no table privilege in this project (see 20260909130000).
-- The analyzer will need to INSERT into shop_ai_analyses, count them for the
-- quota, and write merchant_submissions.submitted_data. That is not granted
-- here: whether it becomes narrow grants or SECURITY DEFINER functions is a
-- Phase B decision, and granting it now would give a role access for code
-- that does not exist yet.
