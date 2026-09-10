-- Search V2 — make the semantic arm executable.
--
-- Corrective migration. 20260909120000 is history and is not edited.
--
-- WHAT WENT WRONG, stated plainly because the comment it corrects is still in
-- the tree: 20260828120000 asserts that "Supabase grants anon/authenticated
-- broad table privileges by default". That did not hold for this project. The
-- CLI applies migrations through its own login role, not `postgres`, so the
-- ALTER DEFAULT PRIVILEGES that would have granted the client roles never
-- applied. anon and authenticated work only because that migration granted
-- them explicitly, table by table — and `service_role` was never named in a
-- single one of those grants.
--
-- So service_role holds no privilege on any table in `public`. It was proven
-- by a PostgREST 403 on `public.shops`, and it breaks two things:
--
--   1. search_shops_semantic is SECURITY INVOKER, so it runs with the rights
--      of its caller. service_role has none, and every call would fail with
--      "permission denied for table shop_embeddings".
--   2. The embedding backfill cannot write shop_embeddings at all.
--
-- The obvious fix — granting service_role SELECT on shops, shop_categories,
-- categories and shop_verifications — is the one this migration deliberately
-- does NOT apply. It would widen an admin role across the whole catalogue to
-- serve one function and one offline script. Instead the function stops
-- borrowing its caller's rights, and the backfill gets one narrow grant on the
-- one internal table it actually writes.
--
-- Nothing here touches RLS, a policy, or any table other than
-- public.shop_embeddings.

-- ---------------------------------------------------------------------------
-- 1. The function stops depending on its caller's privileges
-- ---------------------------------------------------------------------------
--
-- ALTER rather than CREATE OR REPLACE: the body stays exactly as deployed by
-- 20260909120000. Restating sixty lines here to change one attribute would
-- duplicate the definition across two migrations and invite the two to drift.
-- Everything the body guarantees is preserved by construction —
-- `set search_path = ''`, the `status = 'published'` filter, the hard factual
-- filters, and a return type of nothing but (shop_id, similarity).
--
-- WHY SECURITY DEFINER IS ACCEPTABLE HERE. 20260901090000 spent its length
-- locking SECURITY DEFINER functions down, so reversing that needs a reason
-- rather than a convenience. The reason is that the danger it guarded against
-- does not exist for this function:
--
--   * NO CLIENT ROLE CAN CALL IT. anon and authenticated hold no EXECUTE
--     (re-asserted in section 2 below), so there is no path from the app, and
--     none from anyone holding the publishable key that ships in the bundle.
--
--   * THE CALLER CANNOT CHOOSE WHAT IT READS. There is no dynamic SQL, no
--     table name parameter and no injectable identifier. The function reads
--     four fixed tables and answers one fixed question.
--
--   * IT CANNOT BE REDIRECTED. `set search_path = ''` is already on the
--     function, so every name resolves schema-qualified and a caller's
--     search_path cannot point it at a lookalike table. That is the classic
--     SECURITY DEFINER escalation and it is already closed.
--
--   * IT RETURNS NO SECRET. The output is a shop id and a float. No vector,
--     no row, no column of any table. Ids of PUBLISHED shops are already
--     readable by anon, so the function reveals nothing that a catalogue read
--     does not — it only reveals it in a different order.
--
--   * IT CANNOT REACH AN UNPUBLISHED SHOP. `s.status = 'published'` is
--     hardcoded in the body and takes no parameter.
--
-- The honest cost, stated rather than glossed: elevated rights now apply to a
-- function that would previously have failed closed. If a future migration
-- adds a column, a join or a parameter to it, that change inherits these
-- rights and must be reviewed as privileged code.

alter function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) security definer;

-- Ownership is set explicitly rather than left to whichever role the CLI
-- happened to use. SECURITY DEFINER means "run as the owner", so an implicit
-- owner makes the function's effective privileges an accident of tooling — and
-- an owner that is later dropped would break it. `postgres` owns the tables in
-- `public`, and a table owner is exempt from RLS unless the table is set to
-- FORCE ROW LEVEL SECURITY, which no migration in this project does. So the
-- function can read shop_embeddings despite its RLS being enabled with no
-- policies, without anyone being granted anything.
--
-- If the migration role cannot reassign ownership this statement fails and the
-- whole migration rolls back, which is the correct outcome: a SECURITY DEFINER
-- function with an unexpected owner is worse than no function.
alter function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) owner to postgres;

comment on function public.search_shops_semantic is
  'Semantic candidate retrieval. Returns shop ids and similarity, never '
  'vectors and never rows. SECURITY DEFINER so it does not depend on the '
  'caller holding SELECT across the catalogue; safe because no client role '
  'holds EXECUTE, search_path is pinned to '''', the SQL is static, and '
  'status = ''published'' is hardcoded. service_role only.';

-- ---------------------------------------------------------------------------
-- 2. EXECUTE stays exactly where it was
-- ---------------------------------------------------------------------------
--
-- Re-asserted rather than assumed. ALTER FUNCTION does not change grants, and
-- ALTER ... OWNER TO does not either, so these are already in force — but a
-- SECURITY DEFINER function is precisely the object where "already in force"
-- is not good enough to leave unstated. Re-running them is free and makes the
-- final privilege set readable in one place.

revoke all on function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) from public, anon, authenticated;

grant execute on function public.search_shops_semantic(
  extensions.vector, text, text, text[], text[], text[], numeric, numeric, boolean, integer, real
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The backfill's one grant
-- ---------------------------------------------------------------------------
--
-- The narrowest privilege that lets the embedding backfill do its job:
--
--   * SELECT so it can read source_hash and skip work that is already current.
--     Without it every run would look stale and re-embed the whole catalogue,
--     which is a bill rather than a bug.
--   * INSERT and UPDATE because the write is an upsert on
--     (shop_id, embedding_model, source_kind).
--
-- No DELETE: removing vectors is not something a backfill should be able to
-- do, and dropping a model's rows is a deliberate act for a human at a SQL
-- prompt.
--
-- shop_embeddings is internal by design — no client role may read it, and
-- similarity search returns shops rather than vectors. Granting the server
-- role access to the server-only table is what that role exists for. No
-- catalogue table is touched, and in particular public.shops is not.
--
-- RLS on shop_embeddings stays enabled with no policies, exactly as deployed.
-- service_role carries BYPASSRLS in Supabase, so this grant is what it needed;
-- the policy surface is unchanged for everyone else.

grant select, insert, update on public.shop_embeddings to service_role;
