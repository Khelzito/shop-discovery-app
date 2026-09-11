import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260911200000_discovery_personalization.sql'),
  'utf8'
);

describe('Prompt 18 discovery migration', () => {
  it('revokes default client and service-role table privileges before a narrow insert grant', () => {
    assert.match(SQL, /revoke all on table public\.home_impressions from public, anon, authenticated, service_role;/i);
    assert.match(SQL, /grant insert \(user_id, shop_id, section\) on public\.home_impressions to authenticated;/i);
    assert.doesNotMatch(SQL, /grant\s+(select|update|delete|truncate)[^;]*home_impressions[^;]*authenticated/i);
  });

  it('adds user-recent indexes for the behavioural affinity windows', () => {
    assert.match(SQL, /shop_views_user_recent_idx[\s\S]*?public\.shop_views \(user_id, created_at desc\)/i);
    assert.match(SQL, /outbound_clicks_user_recent_idx[\s\S]*?public\.outbound_clicks \(user_id, created_at desc\)/i);
  });

  it('keeps impressions write-only under RLS and binds them to auth.uid()', () => {
    assert.match(SQL, /alter table public\.home_impressions enable row level security;/i);
    assert.match(SQL, /create policy home_impressions_insert_own[\s\S]*auth\.uid\(\)[\s\S]*user_id/i);
    assert.doesNotMatch(SQL, /create policy[^;]+home_impressions[^;]+for select/i);
  });


  it('bounds global popularity signals to distinct signed-in actors', () => {
    assert.match(SQL, /count\(distinct hi\.user_id\)::numeric as n/i);
    assert.match(SQL, /count\(distinct sv\.user_id\)::numeric as n/i);
    assert.match(SQL, /count\(distinct oc\.user_id\)::numeric \* 3 as weighted/i);
  });

  it('pins home_discovery and only exposes its bounded result to clients', () => {
    assert.match(SQL, /function public\.home_discovery\(p_limit_each integer default 6\)/i);
    assert.match(SQL, /security definer\s+set search_path = ''/i);
    assert.match(SQL, /greatest\(1, least\(coalesce\(p_limit_each, 6\), 12\)\)/i);
    assert.match(SQL, /revoke all on function public\.home_discovery\(integer\) from public;/i);
    assert.match(SQL, /grant execute on function public\.home_discovery\(integer\) to anon, authenticated;/i);
  });

  it('prevents cross-account attribution of search interactions', () => {
    assert.match(SQL, /drop policy if exists search_interactions_insert_own/i);
    assert.match(SQL, /exists \([\s\S]*?public\.searches s[\s\S]*?s\.id = search_id[\s\S]*?s\.user_id = \(select auth\.uid\(\)\)/i);
  });

  it('does not let Home ranking create trust or mutate catalogue state', () => {
    assert.doesNotMatch(SQL, /insert\s+into\s+public\.(shops|shop_verifications|shop_members)/i);
    assert.doesNotMatch(SQL, /update\s+public\.(shops|shop_verifications|shop_members)/i);
    assert.doesNotMatch(SQL, /delete\s+from\s+public\.(shops|shop_verifications|shop_members)/i);
  });

  it('uses only first-party behavioural tables and returns no raw event data', () => {
    for (const table of ['favorites', 'user_interest_categories', 'shop_views', 'outbound_clicks', 'home_impressions']) {
      assert.match(SQL, new RegExp(`public\\.${table}`));
    }
    assert.doesNotMatch(SQL, /ip_address|device_fingerprint|latitude|longitude/i);
    assert.match(SQL, /returns table \(\s*section text,\s*shop_id uuid,\s*"position" integer\s*\)/i);
  });
});
