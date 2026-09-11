import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Static contract for 20260911120000_shop_analyzer.sql.
 *
 * Lives under ai/server rather than supabase/ because tsconfig.test.json (a
 * validated Phase A file) compiles ai/** by glob and lists supabase tests one
 * by one. No local PostgreSQL exists: these tests pin the SQL text, and the
 * runtime truth is checked against the database after `db push`.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILE = '20260911120000_shop_analyzer.sql';
const FUNCTIONS = ['begin_shop_analysis', 'complete_shop_analysis', 'fail_shop_analysis'] as const;

const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8')
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase();

function body(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(start, close + 2);
}

const bodies = FUNCTIONS.map(body).join(' ');
const outside = FUNCTIONS.reduce((rest, name) => rest.replace(body(name), ' '), sql);

describe('shop analyzer migration — placement', () => {
  it('sorts after every applied migration', () => {
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();
    assert.equal(files[files.length - 1], FILE);
    assert.ok(files.includes('20260910120000_merchant_foundation.sql'));
  });

  it('carries no explicit transaction', () => {
    assert.equal(/\bbegin;|\bcommit;/.test(outside), false);
  });
});

describe('shop analyzer migration — privilege surface', () => {
  for (const name of FUNCTIONS) {
    it(`${name} is SECURITY DEFINER, search_path pinned, owned by postgres, no dynamic SQL`, () => {
      const text = body(name);
      assert.ok(text.includes('security definer'));
      assert.ok(text.includes("set search_path = ''"));
      assert.equal(/\bexecute\b/.test(text), false);
      assert.ok(new RegExp(`alter function public\\.${name}\\([^)]*\\) owner to postgres;`).test(sql));
    });

    it(`${name} is executable by service_role only`, () => {
      assert.ok(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`).test(sql));
      assert.ok(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`).test(sql));
    });
  }

  it('grants nothing but EXECUTE to service_role — no table privilege, no client role', () => {
    const grants = outside.match(/grant [^;]*;/g) ?? [];
    assert.equal(grants.length, 3);
    for (const grant of grants) {
      assert.match(grant, /^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/);
    }
  });

  it('changes no table, policy, index or RLS setting', () => {
    for (const forbidden of ['create policy', 'alter policy', 'drop policy', 'alter table', 'create table', 'create index', 'row level security', 'security invoker', 'drop ']) {
      assert.equal(sql.includes(forbidden), false, forbidden);
    }
  });
});

describe('shop analyzer migration — what the functions can touch', () => {
  it('writes shop_ai_analyses and merchant_submissions only', () => {
    const written = new Set([
      ...[...bodies.matchAll(/insert into public\.([a-z_]+)/g)].map((match) => match[1]),
      ...[...bodies.matchAll(/update public\.([a-z_]+)/g)].map((match) => match[1]),
    ]);
    assert.deepEqual([...written].sort(), ['merchant_submissions', 'shop_ai_analyses']);
  });

  it('never touches membership, verification, claims or the taxonomy', () => {
    for (const table of ['shop_members', 'shop_verifications', 'shop_claims', 'public.categories', 'public.tags', 'shop_categories', 'shop_tags']) {
      assert.equal(sql.includes(table), false, table);
    }
  });

  it('only reads published shops, and never writes one', () => {
    assert.ok(bodies.includes("from public.shops s where s.status = 'published'"));
    assert.equal(/(insert into|update) public\.shops\b/.test(bodies), false);
  });

  it('never writes an approval, a verification or a publication', () => {
    const statuses = [...bodies.matchAll(/set status = '([a-z_]+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(statuses)].sort(), ['completed', 'failed']);
    for (const value of ["'approved'", "'verified'", "'submitted'"]) {
      assert.equal(bodies.includes(value), false, value);
    }
  });

  it('stores no raw HTML column or payload', () => {
    assert.equal(sql.includes('html'), false);
  });
});

describe('shop analyzer migration — rules', () => {
  const begin = body('begin_shop_analysis');
  const complete = body('complete_shop_analysis');
  const fail = body('fail_shop_analysis');

  it('rate limits per user, atomically, including concurrency and a global ceiling', () => {
    for (const rule of [
      'pg_advisory_xact_lock',
      "a.status = 'running'",
      "interval '5 minutes'",
      "interval '1 hour'",
      'v_count >= 5',
      "interval '24 hours'",
      'v_count >= 20',
      'v_count >= 200',
    ]) {
      assert.ok(begin.includes(rule), rule);
    }
  });

  it('accepts https sources whose host is exactly the checked domain', () => {
    assert.ok(begin.includes("p_source_url !~ '^https://'"));
    assert.ok(begin.includes("substring(p_source_url from '^https://([^/:?#]+)') is distinct from p_domain"));
  });

  it('scopes every submission and analysis access to the verified user', () => {
    assert.ok(begin.includes('ms.submitted_by = p_user_id'));
    assert.ok(begin.includes("v_submission_status not in ('draft', 'needs_changes')"));
    assert.ok(complete.includes('a.requested_by = p_user_id'));
    assert.ok(complete.includes('ms.submitted_by = p_user_id'));
    assert.ok(complete.includes("ms.status in ('draft', 'needs_changes')"));
    assert.ok(fail.includes('a.requested_by = p_user_id'));
  });

  it('copies the proposal under one key, preserving the merchant’s own data, within 64 KiB', () => {
    assert.ok(complete.includes("(ms.submitted_data - 'aiproposal') || jsonb_build_object('aiproposal', p_proposal)"));
    assert.ok(complete.includes('<= 65536'));
  });

  it('refuses forbidden keys in anything it persists', () => {
    const guard = 'verif|trust|certif|publish|approv|owner|member|status';
    assert.ok(complete.includes(guard));
    assert.ok(fail.includes(guard));
  });

  it('completes and fails only a running analysis', () => {
    assert.ok(complete.includes("a.status = 'running'"));
    assert.ok(fail.includes("a.status = 'running'"));
    assert.ok(fail.includes("p_error_code !~ '^[a-z][a-z0-9_]{0,63}$'"));
  });
});
