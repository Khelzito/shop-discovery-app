-- update_managed_shop keeps what did not change — Prompt 17 fix.
--
-- Found during the iPhone validation of 20260911180000_trust_moderation.sql:
-- saving a shop deleted and re-inserted EVERY category and tag link, so a link
-- the merchant did not touch lost its provenance (source 'admin' became
-- 'merchant') and its created_at, and the shop row was rewritten even when no
-- value differed.
--
-- Links are now reconciled: removed only when no longer chosen, inserted only
-- when new, the primary flag moved in place. The shop row is written only
-- when a value actually differs. A save that changes nothing changes nothing.
--
-- Same signature, same authorisation, same validation, same privileges.
-- Additive: the earlier migration is history and is not edited.
-- No explicit BEGIN/COMMIT: the CLI already wraps each file in a transaction.

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

  -- Written only when a value differs.
  update public.shops s
     set name = v_name,
         short_description = v_description,
         audience = p_audience,
         price_level = p_price_level
   where s.id = p_shop_id
     and (s.name, s.short_description, s.audience, s.price_level)
         is distinct from (v_name, v_description, p_audience, p_price_level);

  -- Categories, reconciled. An unchanged link keeps its source and created_at.
  delete from public.shop_categories sc
   where sc.shop_id = p_shop_id
     and sc.category_id <> all (array_append(v_secondary, v_primary));
  -- Demote before promoting: at most one primary per shop at every step.
  update public.shop_categories sc
     set is_primary = false
   where sc.shop_id = p_shop_id
     and sc.is_primary
     and sc.category_id <> v_primary;
  update public.shop_categories sc
     set is_primary = true
   where sc.shop_id = p_shop_id
     and sc.category_id = v_primary
     and not sc.is_primary;
  insert into public.shop_categories (shop_id, category_id, is_primary, source)
  values (p_shop_id, v_primary, true, 'merchant')
  on conflict do nothing;
  insert into public.shop_categories (shop_id, category_id, is_primary, source)
  select p_shop_id, e.category_id, false, 'merchant'
    from unnest(v_secondary) as e(category_id)
  on conflict do nothing;

  -- Tags, reconciled. Origin tags are declared then verified elsewhere: kept,
  -- never set here.
  delete from public.shop_tags st
   where st.shop_id = p_shop_id
     and st.tag_id <> all (v_tags)
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
  'Unchanged links and values are left untouched. '
  'Never status, slug, URL, publication, claim, verification or membership.';
revoke all on function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) from public, anon, authenticated;
grant execute on function public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[]) to authenticated;
