import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Static contract for 20260911180000_trust_moderation.sql (Prompt 17).
 *
 * No local PostgreSQL exists: these tests pin the security-relevant SQL text,
 * and the runtime behaviour is checked against the database after `db push`
 * with rolled-back probes. Lives under ai/server for the same reason as
 * shop-analysis-migration.test.ts: tsconfig.test.json compiles ai/** by glob.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILE = '20260911180000_trust_moderation.sql';

const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8')
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const DEFINER_FUNCTIONS = {
  is_app_moderator: { signature: '', role: 'authenticated' },
  begin_claim_verification: { signature: 'uuid, uuid', role: 'service_role' },
  finish_claim_verification: { signature: 'uuid, uuid, text, text, text[]', role: 'service_role' },
  moderation_list_submissions: { signature: '', role: 'authenticated' },
  moderation_get_submission: { signature: 'uuid', role: 'authenticated' },
  moderate_submission: { signature: 'uuid, text, text', role: 'authenticated' },
  update_managed_shop: { signature: 'uuid, text, text, text, text[], text[], text, smallint, uuid[]', role: 'authenticated' },
} as const;

function body(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(start, close + 2);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('trust migration — placement', () => {
  it('sorts right after the shop analyzer migration', () => {
    const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();
    assert.equal(files.indexOf(FILE), files.indexOf('20260911120000_shop_analyzer.sql') + 1);
  });

  it('carries no explicit transaction', () => {
    const outside = Object.keys(DEFINER_FUNCTIONS).reduce((rest, name) => rest.replace(body(name), ' '), sql);
    assert.equal(/\bbegin;|\bcommit;/.test(outside), false);
  });
});

describe('trust migration — privilege surface', () => {
  for (const [name, { signature, role }] of Object.entries(DEFINER_FUNCTIONS)) {
    const call = `public.${name}(${signature})`;

    it(`${name}: SECURITY DEFINER, pinned search_path, owned by postgres, no dynamic SQL`, () => {
      const text = body(name);
      assert.ok(text.includes('security definer'));
      assert.ok(text.includes("set search_path = ''"));
      assert.equal(/\bexecute\b/.test(text.replace('execute function', '')), false);
      assert.ok(sql.includes(`alter function ${call} owner to postgres;`));
    });

    it(`${name}: EXECUTE revoked from PUBLIC/anon/authenticated, granted to ${role} only`, () => {
      assert.ok(sql.includes(`revoke all on function ${call} from public, anon, authenticated;`));
      const grants = [...sql.matchAll(new RegExp(`grant execute on function ${escape(call)} to ([a-z_, ]+);`, 'g'))].map((m) => m[1]);
      assert.deepEqual(grants, [role]);
    });
  }

  it('grants nothing to anon or PUBLIC, and no table privilege but the narrowed report insert', () => {
    const grants = sql.match(/grant [^;]*;/g) ?? [];
    for (const grant of grants) {
      assert.equal(/\bto [^;]*\b(anon|public)\b;/.test(grant.replace(/public\.[a-z_]+/g, '')), false, grant);
      if (!grant.startsWith('grant execute on function')) {
        assert.equal(grant, 'grant insert (shop_id, reason, description) on public.shop_reports to authenticated;');
      }
    }
  });

  it('creates two tables with RLS on, no policy, and every default privilege revoked', () => {
    for (const table of ['app_moderators', 'shop_claim_verification_attempts']) {
      assert.ok(sql.includes(`create table public.${table} (`), table);
      assert.ok(sql.includes(`alter table public.${table} enable row level security;`), table);
      assert.ok(sql.includes(`revoke all on table public.${table} from public, anon, authenticated, service_role;`), table);
    }
    for (const forbidden of ['create policy', 'alter policy', 'drop policy', 'disable row level security', 'no force row level security', 'truncate', 'drop table']) {
      assert.equal(sql.includes(forbidden), false, forbidden);
    }
  });

  it('deletes nothing that carries trust, ownership or history', () => {
    assert.equal(/delete from public\.(shops|shop_members|shop_claims|merchant_submissions|shop_verifications|shop_ai_analyses|profiles)\b/.test(sql), false);
    const deletes = [...sql.matchAll(/delete from public\.([a-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(deletes)].sort(), ['shop_categories', 'shop_images', 'shop_tags']);
    for (const table of deletes) {
      assert.ok(body('update_managed_shop').includes(`delete from public.${table}`), table);
    }
  });

  it('issues a verification in exactly one place, and membership in exactly two', () => {
    assert.equal(sql.split('insert into public.shop_verifications').length - 1, 1);
    assert.ok(body('finish_claim_verification').includes('insert into public.shop_verifications'));
    assert.equal(sql.split('insert into public.shop_members').length - 1, 2);
    assert.ok(body('finish_claim_verification').includes('insert into public.shop_members'));
    assert.ok(body('moderate_submission').includes('insert into public.shop_members'));
  });
});

describe('trust migration — claim verification', () => {
  const begin = body('begin_claim_verification');
  const finish = body('finish_claim_verification');

  it('begin scopes the claim to the verified user, checks expiry and owners, and rate limits', () => {
    for (const rule of [
      'c.requested_by = p_user_id',
      'for update',
      'pg_advisory_xact_lock',
      'v_claim.expires_at <= now()',
      "m.role = 'owner'",
      "a.status = 'running'",
      'v_count >= 5',
      'v_count >= 15',
      'v_count >= 300',
      "interval '1 hour'",
    ]) {
      assert.ok(begin.includes(rule), rule);
    }
  });

  it('begin never approves, verifies or grants membership', () => {
    assert.equal(begin.includes("set status = 'approved'"), false);
    for (const table of ['insert into public.shop_members', 'shop_verifications', 'proof_token_hash =']) {
      assert.equal(begin.includes(table), false, table);
    }
  });

  it('finish compares the stored hash of candidates and never returns the hash', () => {
    assert.ok(finish.includes("encode(sha256(convert_to(candidate.value, 'utf8')), 'hex') = v_claim.proof_token_hash"));
    assert.ok(finish.includes('returns table (outcome text, verified_shop_id uuid)'));
    assert.equal(/return query select[^;]*proof_token_hash/.test(finish), false);
    assert.ok(finish.includes("candidate.value !~ '^sd-claim-[0-9a-f]{64}$'"));
    assert.ok(finish.includes('cardinality(p_candidates), 0) > 8'));
  });

  it('finish binds the proof to the shop host or its www sibling', () => {
    assert.ok(finish.includes('p_final_host = v_shop_host'));
    assert.ok(finish.includes("p_final_host = 'www.' || v_shop_host"));
    assert.ok(finish.includes("left(v_shop_host, 4) = 'www.' and strpos(substr(v_shop_host, 5), '.') > 0"));
  });

  it('finish grants ownership only after every check, atomically, with a narrow verification', () => {
    const lastCheck = finish.indexOf("v_result := 'token_mismatch'");
    for (const write of ["set status = 'approved'", 'insert into public.shop_members', 'set claimed_at = now()', 'insert into public.shop_verifications']) {
      assert.ok(finish.indexOf(write) > lastCheck, write);
    }
    assert.ok(finish.indexOf("pg_advisory_xact_lock(hashtextextended('shop_ownership:'") < finish.indexOf("v_result := 'shop_already_claimed'"));
    assert.ok(finish.includes("'domain', 'approved'"));
    assert.ok(finish.includes("'shop_discovery_domain_check'"));
    assert.ok(finish.includes("now() + interval '365 days'"));
    assert.ok(finish.includes("values (v_claim.shop_id, p_user_id, 'owner')"));
  });

  it('finish records failures as closed-vocabulary codes only', () => {
    assert.ok(finish.includes("p_failure !~ '^[a-z][a-z0-9_]{0,63}$'"));
    assert.ok(sql.includes("outcome ~ '^[a-z][a-z0-9_]{0,63}$'"));
  });
});

describe('trust migration — moderation', () => {
  const moderate = body('moderate_submission');

  it('every moderation function checks the moderator server-side first', () => {
    for (const name of ['moderation_list_submissions', 'moderation_get_submission', 'moderate_submission']) {
      const text = body(name);
      // Statements only: the declare block names row types, which read nothing.
      const statements = text.slice(text.search(/ begin (?!;)/));
      const check = statements.indexOf('from public.app_moderators m where m.user_id =');
      assert.ok(check >= 0, name);
      assert.ok(check < statements.indexOf('merchant_submissions'), name);
      assert.ok(text.includes("raise exception 'not_moderator' using errcode = '42501'"), name);
    }
  });

  it('locks the submission, refuses own and already reviewed requests', () => {
    assert.ok(moderate.includes('where ms.id = p_submission_id for update'));
    assert.ok(moderate.includes('v_row.submitted_by = v_moderator'));
    assert.ok(moderate.includes("v_row.status in ('approved', 'rejected', 'needs_changes')"));
    assert.ok(moderate.includes("v_row.status not in ('submitted', 'processing')"));
  });

  it('reads only known merchantProfile keys — never a trust, status or publication key', () => {
    const keys = [...moderate.matchAll(/v_profile ->>? '([a-z_]+)'/g)].map((m) => m[1]);
    const allowed = ['profileversion', 'name', 'shortdescription', 'primarycategory', 'secondarycategories', 'tags', 'audience', 'pricepositioning', 'imageurls', 'logourl'];
    for (const key of new Set(keys)) {
      assert.ok(allowed.includes(key!), key);
    }
    assert.deepEqual([...new Set([...moderate.matchAll(/submitted_data -> '([a-z_]+)'/g)].map((m) => m[1]))], ['merchantprofile']);
  });

  it('validates against the live vocabulary and takes images only from server observations', () => {
    assert.ok(moderate.includes('c.is_active'));
    assert.ok(moderate.includes("t.kind <> 'origin'"));
    assert.ok(moderate.includes("v_raw -> 'observed' -> 'imageurls'"));
    assert.ok(moderate.includes('e.url = any (v_allowed_images)'));
    assert.ok(moderate.includes('from public.shop_ai_analyses a'));
  });

  it('refuses a duplicate host under a lock before creating anything', () => {
    const lock = moderate.indexOf("pg_advisory_xact_lock(hashtextextended('shop_host:' || v_bare, 0))");
    assert.ok(lock >= 0);
    assert.ok(lock < moderate.indexOf("'duplicate_shop'"));
    assert.ok(moderate.indexOf("'duplicate_shop'") < moderate.indexOf('insert into public.shops'));
    assert.ok(moderate.includes('when unique_violation then'));
  });

  it('publishes only on approval, issues no verification, and records the reviewer', () => {
    assert.equal(sql.split("'published', now()").length - 1, 1);
    assert.ok(moderate.includes("'published', now(), v_row.submitted_by, now()"));
    assert.equal(moderate.includes('shop_verifications'), false);
    assert.ok(moderate.includes('reviewed_by = v_moderator'));
  });

  it('requires a note to ask for changes or refuse', () => {
    assert.ok(moderate.includes("p_action in ('needs_changes', 'reject') and v_note is null"));
    assert.ok(moderate.includes('char_length(v_note) > 500'));
  });

  it('a resubmission clears the previous review, in a trigger that is not SECURITY DEFINER', () => {
    const trigger = body('merchant_submissions_reset_review');
    assert.equal(trigger.includes('security definer'), false);
    assert.ok(trigger.includes("new.status = 'submitted' and old.status in ('draft', 'needs_changes')"));
    for (const field of ['new.review_note := null', 'new.reviewed_by := null', 'new.reviewed_at := null']) {
      assert.ok(trigger.includes(field), field);
    }
    assert.ok(sql.includes('revoke all on function public.merchant_submissions_reset_review() from public, anon, authenticated, service_role;'));
  });
});

describe('trust migration — shop management and reports', () => {
  const manage = body('update_managed_shop');

  it('requires the owner or admin role from shop_members and the caller from the JWT', () => {
    assert.ok(manage.includes('v_user uuid := auth.uid()'));
    assert.ok(manage.includes("m.user_id = v_user and m.role in ('owner', 'admin')"));
  });

  it('updates content only — never status, slug, URL, publication or claim', () => {
    const update = /update public\.shops s set ([^;]*?) where s\.id = p_shop_id;/.exec(manage);
    assert.ok(update);
    const columns = [...update[1]!.matchAll(/([a-z_]+) =/g)].map((m) => m[1]);
    assert.deepEqual(columns, ['name', 'short_description', 'audience', 'price_level']);
    // Membership is READ for the role check, never written.
    assert.equal(/(insert into|update|delete from) public\.shop_members/.test(manage), false);
    for (const table of ['shop_verifications', 'shop_claims', 'merchant_submissions']) {
      assert.equal(manage.includes(table), false, table);
    }
  });

  it('keeps origin tags out of merchant hands', () => {
    assert.ok(manage.includes("t.kind <> 'origin'"));
  });

  it('narrows report inserts to authored columns and one open report per user', () => {
    const revoke = sql.indexOf('revoke insert on public.shop_reports from authenticated;');
    const grant = sql.indexOf('grant insert (shop_id, reason, description) on public.shop_reports to authenticated;');
    assert.ok(revoke >= 0 && grant > revoke);
    assert.ok(sql.includes('alter table public.shop_reports alter column user_id set default auth.uid();'));
    assert.ok(sql.includes("on public.shop_reports (shop_id, user_id) where status = 'open';"));
    assert.ok(sql.includes("'impersonation'"));
  });
});
