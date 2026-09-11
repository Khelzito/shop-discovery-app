import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Static contract for 20260911190000_managed_shop_reconcile.sql.
 *
 * The iPhone validation of Prompt 17 showed that saving a shop rewrote every
 * category and tag link, erasing their provenance. This pins the fix — links
 * are reconciled, not replaced — and that nothing else about the function's
 * privilege surface moved. Runtime behaviour is checked with rolled-back
 * probes after `db push`.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILE = '20260911190000_managed_shop_reconcile.sql';
const SIGNATURE = 'public.update_managed_shop(uuid, text, text, text, text[], text[], text, smallint, uuid[])';

const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8')
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const start = sql.indexOf('create or replace function public.update_managed_shop(');
const body = sql.slice(start, sql.indexOf('$$', sql.indexOf('$$', start) + 2) + 2);

describe('managed shop reconcile migration — placement and surface', () => {
  it('sorts right after the trust and moderation migration', () => {
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();
    assert.equal(files.indexOf(FILE), files.indexOf('20260911180000_trust_moderation.sql') + 1);
  });

  it('only replaces update_managed_shop, with the same privileges', () => {
    assert.ok(start >= 0);
    assert.equal(sql.split('create or replace function').length - 1, 1);
    assert.ok(body.includes('security definer'));
    assert.ok(body.includes("set search_path = ''"));
    assert.equal(/\bexecute\b/.test(body), false);
    assert.ok(sql.includes(`alter function ${SIGNATURE} owner to postgres;`));
    assert.ok(sql.includes(`revoke all on function ${SIGNATURE} from public, anon, authenticated;`));
    const grants = sql.match(/grant [^;]*;/g) ?? [];
    assert.deepEqual(grants, [`grant execute on function ${SIGNATURE} to authenticated;`]);
    for (const forbidden of ['create policy', 'alter policy', 'drop policy', 'create table', 'alter table', 'row level security', 'truncate', 'begin;', 'commit;']) {
      assert.equal(sql.includes(forbidden), false, forbidden);
    }
  });

  it('keeps the owner/admin check and the JWT identity', () => {
    assert.ok(body.includes('v_user uuid := auth.uid()'));
    assert.ok(body.includes("m.user_id = v_user and m.role in ('owner', 'admin')"));
  });
});

describe('managed shop reconcile migration — behaviour', () => {
  it('never deletes every link of a shop unconditionally', () => {
    assert.equal(/delete from public\.shop_categories sc where sc\.shop_id = p_shop_id;/.test(body), false);
    assert.ok(body.includes('sc.category_id <> all (array_append(v_secondary, v_primary))'));
    assert.ok(body.includes('st.tag_id <> all (v_tags)'));
  });

  it('inserts only new links and moves the primary flag in place, demoting first', () => {
    assert.equal((body.match(/on conflict do nothing/g) ?? []).length, 3);
    const demote = body.indexOf('set is_primary = false');
    const promote = body.indexOf('set is_primary = true');
    assert.ok(demote >= 0 && promote > demote);
  });

  it('writes the shop row only when a value differs, and only content columns', () => {
    const update = /update public\.shops s set ([^;]*?) where s\.id = p_shop_id and ([^;]*);/.exec(body);
    assert.ok(update);
    assert.deepEqual([...update[1]!.matchAll(/([a-z_]+) =/g)].map((m) => m[1]), ['name', 'short_description', 'audience', 'price_level']);
    assert.ok(update[2]!.includes('is distinct from'));
  });

  it('still protects origin tags and touches no trust table', () => {
    assert.ok(body.includes("t.kind <> 'origin'"));
    assert.equal(/(insert into|update|delete from) public\.shop_members/.test(body), false);
    for (const table of ['shop_verifications', 'shop_claims', 'merchant_submissions']) {
      assert.equal(body.includes(table), false, table);
    }
  });
});
