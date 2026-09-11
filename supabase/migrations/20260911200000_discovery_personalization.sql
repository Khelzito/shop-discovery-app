-- Prompt 18 — consumer intelligence and Home discovery.
--
-- Behavioural data remains narrow and first-party: no IP, fingerprint or
-- precise location. Clients may append their own Home impressions but cannot
-- read aggregate behaviour. Ranking is server-side so private event tables do
-- not become a client-readable analytics API.

create table public.home_impressions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  section text not null check (section in ('for_you', 'hidden_gems', 'new')),
  created_at timestamptz not null default now()
);

create index home_impressions_user_recent_idx
  on public.home_impressions (user_id, created_at desc);
create index home_impressions_shop_recent_idx
  on public.home_impressions (shop_id, created_at desc);

-- Existing behavioural tables were indexed for shop analytics, not per-user
-- recommendation reads. These two indexes keep the 60/90-day affinity scans
-- bounded as event volume grows.
create index if not exists shop_views_user_recent_idx
  on public.shop_views (user_id, created_at desc);
create index if not exists outbound_clicks_user_recent_idx
  on public.outbound_clicks (user_id, created_at desc);

alter table public.home_impressions enable row level security;

-- Supabase default privileges are intentionally not trusted for new tables.
revoke all on table public.home_impressions from public, anon, authenticated, service_role;
grant insert (user_id, shop_id, section) on public.home_impressions to authenticated;

create policy home_impressions_insert_own on public.home_impressions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and public.shop_is_visible(shop_id)
  );

comment on table public.home_impressions is
  'Home recommendations actually shown to a signed-in user. Used only to reduce repetition and measure exposure; never exposed back to clients.';


-- Tighten the existing append-only interaction policy: a client may only
-- attach an interaction to one of its own search rows (or null for non-search
-- surfaces). This closes a pre-existing cross-user foreign-key attribution
-- gap without widening any table grant.
drop policy if exists search_interactions_insert_own on public.search_interactions;
create policy search_interactions_insert_own on public.search_interactions
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (
      search_id is null
      or exists (
        select 1 from public.searches s
        where s.id = search_id and s.user_id = (select auth.uid())
      )
    )
    and public.shop_is_visible(shop_id)
  );

-- One bounded query returns only section + id + position. The app re-reads shops
-- through its normal RLS-governed repository before rendering them.
create or replace function public.home_discovery(p_limit_each integer default 6)
returns table (
  section text,
  shop_id uuid,
  "position" integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with
  actor as (
    select
      auth.uid() as user_id,
      greatest(1, least(coalesce(p_limit_each, 6), 12)) as lim,
      (
        select up.shipping_country_code
        from public.user_preferences up
        where up.user_id = auth.uid()
      ) as shipping_country_code
  ),
  eligible as (
    select
      s.id,
      s.published_at,
      case when nullif(btrim(coalesce(s.short_description, '')), '') is not null then 1 else 0 end as has_description,
      case when exists (
        select 1 from public.shop_images si
        where si.shop_id = s.id and (si.external_url is not null or si.storage_path is not null)
      ) then 1 else 0 end as has_image,
      case when exists (
        select 1 from public.shop_categories sc where sc.shop_id = s.id
      ) then 1 else 0 end as has_category,
      case when exists (
        select 1
        from public.shop_verifications sv
        where sv.shop_id = s.id
          and sv.status = 'approved'
          and sv.verification_type = 'domain'
          and (sv.expires_at is null or sv.expires_at > now())
      ) then 1 else 0 end as domain_verified,
      case
        when a.shipping_country_code is null then 0.0
        when s.shipping_country_codes is null or cardinality(s.shipping_country_codes) = 0 then 0.05
        when a.shipping_country_code = any(s.shipping_country_codes) then 0.35
        else -0.35
      end::numeric as shipping_fit,
      case when exists (
        select 1 from public.favorites own_favorite
        where own_favorite.user_id = a.user_id and own_favorite.shop_id = s.id
      ) then 1 else 0 end as already_favorited
    from public.shops s
    cross join actor a
    where s.status = 'published'
  ),
  exposure as (
    select signals.shop_id, sum(signals.n)::numeric as exposure_30d
    from (
      select hi.shop_id, count(distinct hi.user_id)::numeric as n
      from public.home_impressions hi
      where hi.created_at >= now() - interval '30 days'
      group by hi.shop_id
      union all
      select sv.shop_id, count(distinct sv.user_id)::numeric as n
      from public.shop_views sv
      where sv.created_at >= now() - interval '30 days'
      group by sv.shop_id
    ) signals
    group by signals.shop_id
  ),
  engagement as (
    select signals.shop_id, sum(signals.weighted)::numeric as engagement_score
    from (
      select oc.shop_id, count(distinct oc.user_id)::numeric * 3 as weighted
      from public.outbound_clicks oc
      where oc.created_at >= now() - interval '30 days'
      group by oc.shop_id
      union all
      select f.shop_id, count(*)::numeric * 2 as weighted
      from public.favorites f
      group by f.shop_id
      union all
      select sv.shop_id, count(distinct sv.user_id)::numeric as weighted
      from public.shop_views sv
      where sv.created_at >= now() - interval '30 days'
      group by sv.shop_id
    ) signals
    group by signals.shop_id
  ),
  explicit_interest as (
    select sc.shop_id, count(*)::numeric * 4 as score
    from actor a
    join public.user_interest_categories ui on ui.user_id = a.user_id
    join public.shop_categories sc on sc.category_id = ui.category_id
    group by sc.shop_id
  ),
  favorite_affinity as (
    select candidate.shop_id, least(count(*)::numeric, 10) * 2 as score
    from actor a
    join public.favorites f on f.user_id = a.user_id
    join public.shop_categories liked on liked.shop_id = f.shop_id
    join public.shop_categories candidate on candidate.category_id = liked.category_id
    where candidate.shop_id <> f.shop_id
    group by candidate.shop_id
  ),
  behaviour_affinity as (
    select candidate.shop_id, least(count(*)::numeric, 20) * 0.35 as score
    from actor a
    join public.shop_views viewed on viewed.user_id = a.user_id and viewed.created_at >= now() - interval '60 days'
    join public.shop_categories seen_cat on seen_cat.shop_id = viewed.shop_id
    join public.shop_categories candidate on candidate.category_id = seen_cat.category_id
    group by candidate.shop_id
  ),
  outbound_affinity as (
    select candidate.shop_id, least(count(*)::numeric, 12) * 0.80 as score
    from actor a
    join public.outbound_clicks clicked on clicked.user_id = a.user_id and clicked.created_at >= now() - interval '90 days'
    join public.shop_categories clicked_cat on clicked_cat.shop_id = clicked.shop_id
    join public.shop_categories candidate on candidate.category_id = clicked_cat.category_id
    group by candidate.shop_id
  ),
  search_affinity as (
    select candidate.shop_id, least(count(*)::numeric, 12) * 0.55 as score
    from actor a
    join public.searches searched on searched.user_id = a.user_id and searched.created_at >= now() - interval '60 days'
    cross join lateral unnest(coalesce(searched.category_ids, '{}'::uuid[])) as searched_category(category_id)
    join public.shop_categories candidate on candidate.category_id = searched_category.category_id
    group by candidate.shop_id
  ),
  recent_seen as (
    select hi.shop_id, count(*)::numeric as seen_count
    from actor a
    join public.home_impressions hi on hi.user_id = a.user_id
    where hi.created_at >= now() - interval '14 days'
    group by hi.shop_id
  ),
  scored as (
    select
      e.id,
      e.published_at,
      e.domain_verified,
      e.shipping_fit,
      e.already_favorited,
      (e.has_description * 0.20 + e.has_image * 0.20 + e.has_category * 0.15 + e.domain_verified * 0.15)::numeric as quality,
      coalesce(x.exposure_30d, 0) as exposure_30d,
      coalesce(g.engagement_score, 0) as engagement_score,
      coalesce(i.score, 0) + coalesce(fa.score, 0) + coalesce(ba.score, 0) + coalesce(oa.score, 0) + coalesce(sa.score, 0) as affinity,
      coalesce(rs.seen_count, 0) as seen_count,
      case
        when e.published_at >= now() - interval '14 days' then 1.0
        when e.published_at >= now() - interval '45 days' then 0.5
        else 0.0
      end::numeric as freshness
    from eligible e
    left join exposure x on x.shop_id = e.id
    left join engagement g on g.shop_id = e.id
    left join explicit_interest i on i.shop_id = e.id
    left join favorite_affinity fa on fa.shop_id = e.id
    left join behaviour_affinity ba on ba.shop_id = e.id
    left join outbound_affinity oa on oa.shop_id = e.id
    left join search_affinity sa on sa.shop_id = e.id
    left join recent_seen rs on rs.shop_id = e.id
  ),
  newest as (
    select s.id,
      row_number() over (
        order by s.published_at desc nulls last, s.quality desc, s.id
      )::integer as pos
    from scored s
    where s.quality >= 0.35
    order by s.published_at desc nulls last, s.quality desc, s.id
    limit (select least(lim, 3) from actor)
  ),
  gems as (
    select s.id,
      row_number() over (
        order by
          s.exposure_30d asc,
          s.domain_verified desc,
          (s.quality + least(s.engagement_score, 12) * 0.08) desc,
          s.published_at asc nulls last,
          s.id
      )::integer as pos
    from scored s
    where s.id not in (select n.id from newest n)
      and s.quality >= 0.35
    order by
      s.exposure_30d asc,
      s.domain_verified desc,
      (s.quality + least(s.engagement_score, 12) * 0.08) desc,
      s.id
    limit (select least(lim, 4) from actor)
  ),
  for_you as (
    select s.id,
      row_number() over (
        order by
          (
            s.affinity
            + least(s.engagement_score, 20) * 0.05
            + s.quality
            + s.freshness * 0.15
            + s.shipping_fit
            - least(s.seen_count, 5) * 0.30
            - s.already_favorited * 1.50
          ) desc,
          s.domain_verified desc,
          s.published_at desc nulls last,
          s.id
      )::integer as pos
    from scored s
    where s.id not in (select n.id from newest n)
      and s.id not in (select g.id from gems g)
    order by
      (
        s.affinity
        + least(s.engagement_score, 20) * 0.05
        + s.quality
        + s.freshness * 0.15
        + s.shipping_fit
        - least(s.seen_count, 5) * 0.30
        - s.already_favorited * 1.50
      ) desc,
      s.id
    limit (select lim from actor)
  )
  select 'for_you'::text, fy.id, fy.pos from for_you fy
  union all
  select 'hidden_gems'::text, g.id, g.pos from gems g
  union all
  select 'new'::text, n.id, n.pos from newest n
  order by 1, 3;
$$;

alter function public.home_discovery(integer) owner to postgres;
revoke all on function public.home_discovery(integer) from public;
grant execute on function public.home_discovery(integer) to anon, authenticated;

comment on function public.home_discovery(integer) is
  'Bounded Home ranking. Uses explicit interests and first-party behaviour for signed-in users; anonymous callers receive the same quality/diversity baseline without private signals.';
