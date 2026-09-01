-- Least-privilege EXECUTE on SECURITY DEFINER functions.
--
-- Corrective migration. The already-deployed migrations are history and are
-- not edited.
--
-- Two PostgreSQL behaviours decide everything here, and they point opposite
-- ways. Both are documented, not assumed:
--
--   * RLS policy expressions run with the rights of the querying user:
--     "policy expressions are added to the user's query directly … users who
--     are using a given policy must be able to access any tables or functions
--     referenced in the expression or they will simply receive a permission
--     denied error" (CREATE POLICY, Notes). So a role that must satisfy a
--     policy referencing a function MUST hold EXECUTE on it. Revoking blindly
--     would make every shop read fail.
--
--   * Trigger functions are checked at CREATE TRIGGER time, not when the
--     trigger fires (CREATE TRIGGER, Notes). So a trigger-only function can
--     have EXECUTE revoked from every client role and the trigger keeps
--     working.
--
-- The consequence: trigger-only functions get locked down completely, and RLS
-- helpers keep exactly the grants their policies require — no more.
--
-- This migration also removes anon's need for them entirely, by splitting the
-- policies that anon evaluates so they reference no function at all. anon is
-- the role handed to anyone holding the publishable key, which ships inside
-- the app bundle, so it is the one role worth the extra policies.

-- ---------------------------------------------------------------------------
-- 1. Revoke PUBLIC EXECUTE from every SECURITY DEFINER function in `public`
-- ---------------------------------------------------------------------------
--
-- Done dynamically so this also covers functions this project did not create
-- — notably public.rls_auto_enable(), which belongs to the project's
-- "automatically enable RLS on new tables" setting and is invoked by an event
-- trigger. Event triggers, like row triggers, do not check the invoking
-- user's EXECUTE, so revoking is safe.
--
-- Scoped to `public` on purpose. Supabase ships many SECURITY DEFINER
-- functions in auth, storage, realtime and graphql_public that must keep
-- their grants; touching those would break the platform.
--
-- Each revoke is individually guarded: a function owned by another role would
-- raise, and one failure must not abort the migration.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
    order by 1
  loop
    begin
      execute format('revoke all on function %s from public', fn.signature);
      execute format('revoke all on function %s from anon, authenticated', fn.signature);
      raise notice 'security definer locked down: %', fn.signature;
    exception
      when others then
        raise notice 'could not change grants on % (%) — left as is', fn.signature, sqlerrm;
    end;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Trigger-only functions: no client role needs EXECUTE
-- ---------------------------------------------------------------------------
--
-- handle_auth_user_upsert() is reachable only through the two triggers on
-- auth.users. set_updated_at() is reachable only through BEFORE UPDATE
-- triggers. Neither is part of any policy, and no client ever calls them.
-- The owner keeps EXECUTE implicitly, which is what the triggers use.

revoke all on function public.handle_auth_user_upsert() from public, anon, authenticated, service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Remove anon's dependency on the RLS helpers
-- ---------------------------------------------------------------------------
--
-- Five policies referenced a SECURITY DEFINER helper for anon as well as for
-- authenticated. Each is replaced by a pair: an anon policy that reaches the
-- same conclusion with a plain subquery, and an authenticated policy that
-- keeps the helper because it must also consider membership.
--
-- The anon variants are strictly narrower — they resolve to "the shop is
-- published" and can never return a draft — so this removes access rather
-- than adding any. Policies are PERMISSIVE, and a policy declared `to anon`
-- is simply not evaluated for authenticated, so the two cannot interact.

-- shops ---------------------------------------------------------------------
drop policy if exists shops_select_published on public.shops;

create policy shops_select_published_anon on public.shops
  for select to anon
  using (status = 'published');

create policy shops_select_visible_auth on public.shops
  for select to authenticated
  using (status = 'published' or public.is_shop_member(id));

-- shop_categories -----------------------------------------------------------
drop policy if exists shop_categories_select_visible on public.shop_categories;

create policy shop_categories_select_anon on public.shop_categories
  for select to anon
  using (
    exists (
      select 1 from public.shops s
      where s.id = shop_id and s.status = 'published'
    )
  );

create policy shop_categories_select_auth on public.shop_categories
  for select to authenticated
  using (public.shop_is_visible(shop_id));

-- shop_tags -----------------------------------------------------------------
drop policy if exists shop_tags_select_visible on public.shop_tags;

create policy shop_tags_select_anon on public.shop_tags
  for select to anon
  using (
    exists (
      select 1 from public.shops s
      where s.id = shop_id and s.status = 'published'
    )
  );

create policy shop_tags_select_auth on public.shop_tags
  for select to authenticated
  using (public.shop_is_visible(shop_id));

-- shop_images ---------------------------------------------------------------
drop policy if exists shop_images_select_visible on public.shop_images;

create policy shop_images_select_anon on public.shop_images
  for select to anon
  using (
    exists (
      select 1 from public.shops s
      where s.id = shop_id and s.status = 'published'
    )
  );

create policy shop_images_select_auth on public.shop_images
  for select to authenticated
  using (public.shop_is_visible(shop_id));

-- shop_verifications --------------------------------------------------------
-- Row filtering is unchanged; only the visibility test differs by role. The
-- three-column grant from the core migration still applies, so `evidence`
-- remains unreachable either way.
drop policy if exists shop_verifications_select_public on public.shop_verifications;

create policy shop_verifications_select_anon on public.shop_verifications
  for select to anon
  using (
    status = 'approved'
    and (expires_at is null or expires_at > now())
    and exists (
      select 1 from public.shops s
      where s.id = shop_id and s.status = 'published'
    )
  );

create policy shop_verifications_select_auth on public.shop_verifications
  for select to authenticated
  using (
    status = 'approved'
    and (expires_at is null or expires_at > now())
    and public.shop_is_visible(shop_id)
  );

-- ---------------------------------------------------------------------------
-- 4. Grant the RLS helpers to exactly the roles that still need them
-- ---------------------------------------------------------------------------
--
-- After section 3, no anon policy references either function, so anon gets
-- nothing back.
--
-- authenticated must keep both: shops_select_visible_auth,
-- shops_update_by_members and shop_members_select_own_shops reference
-- is_shop_member; the *_select_auth policies and the shop_views,
-- outbound_clicks and shop_reports insert policies reference shop_is_visible.
-- Without EXECUTE those queries would fail with "permission denied for
-- function", which is precisely the trap this migration avoids.
--
-- service_role bypasses RLS and so never needs these to satisfy a policy, but
-- server code may call them directly; granting avoids a confusing failure
-- later and adds no exposure, since service_role is already unrestricted.

grant execute on function public.is_shop_member(uuid, text[]) to authenticated, service_role;
grant execute on function public.shop_is_visible(uuid) to authenticated, service_role;

comment on function public.is_shop_member(uuid, text[]) is
  'RLS helper. SECURITY DEFINER so that reading shop_members from inside '
  'another table''s policy does not recurse into shop_members'' own policy. '
  'Answers only about the calling user, so it cannot probe anyone else.';

comment on function public.shop_is_visible(uuid) is
  'RLS helper. SECURITY DEFINER so it can see draft shops the caller belongs '
  'to. Returns false for both an unpublished shop and a non-existent id, so '
  'it reveals nothing beyond what a published-shop read already reveals.';

comment on function public.handle_auth_user_upsert() is
  'Trigger-only, on auth.users. No client role holds EXECUTE; triggers do not '
  'check the invoking user (CREATE TRIGGER, Notes).';
