import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Static contract for 20260910120000_merchant_foundation.sql.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. There is no local PostgreSQL on this
 * machine, so these tests cannot execute the migration. They read its SQL and
 * pin the security-relevant statements: which privileges are revoked, which
 * columns are granted, what the new function may and may not do. A change that
 * reopens a hole fails here before anyone reaches `db push`.
 *
 * The runtime truth still has to be checked against the database after the
 * migration is applied, with the verification queries delivered alongside it.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const FILE = '20260910120000_merchant_foundation.sql';

/** Executable SQL only: comments stripped, whitespace collapsed, lowercased. */
function executable(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const raw = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const sql = executable(raw);

function functionBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `function ${name} not found`);
  const bodyStart = sql.indexOf('$$', start);
  const bodyEnd = sql.indexOf('$$', bodyStart + 2);
  return sql.slice(start, bodyEnd + 2);
}

function grantedColumns(statementPrefix: string): string[] {
  const match = new RegExp(`${statementPrefix} \\(([^)]*)\\)`).exec(sql);
  assert.ok(match, `no column grant matching "${statementPrefix}"`);
  return match[1]!.split(',').map((column) => column.trim());
}

describe('migration ordering', () => {
  it('sorts after every migration applied before it', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const earlier = ['20260828120000', '20260828120100', '20260828120200',
      '20260901090000', '20260909120000', '20260909130000'];
    for (const version of earlier) {
      assert.ok(files.some((f) => f.startsWith(`${version}_`)), `${version} missing`);
      assert.ok(`${version}_` < FILE, `${FILE} must sort after ${version}`);
    }
  });

  it('carries no explicit transaction, which the CLI already provides', () => {
    assert.equal(/\bbegin;|\bcommit;/.test(sql), false);
  });
});

describe('merchant_submissions', () => {
  it('revokes the table-wide INSERT before granting columns', () => {
    const revoke = sql.indexOf('revoke insert on public.merchant_submissions from authenticated');
    const grant = sql.indexOf('grant insert (');
    assert.ok(revoke >= 0, 'table-level insert is not revoked');
    assert.ok(grant > revoke, 'column grant must follow the revoke');
  });

  it('grants INSERT on authored content only', () => {
    const columns = grantedColumns('grant insert');
    assert.deepEqual(columns.sort(), ['status', 'submitted_data', 'website_url']);
  });

  it('never lets a client name a server-owned column', () => {
    const columns = grantedColumns('grant insert');
    for (const serverOwned of ['id', 'submitted_by', 'shop_id', 'review_note', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at']) {
      assert.equal(columns.includes(serverOwned), false, serverOwned);
    }
  });

  it('never re-grants INSERT on the whole table', () => {
    assert.equal(/grant insert on public\.merchant_submissions/.test(sql), false);
    assert.equal(/grant (select, )?insert(, \w+)* on public\.merchant_submissions/.test(sql), false);
  });

  it('derives ownership from the caller instead of the request', () => {
    assert.ok(sql.includes('alter column submitted_by set default auth.uid()'));
  });

  it('bounds the client-writable proposal', () => {
    assert.ok(sql.includes("jsonb_typeof(submitted_data) = 'object'"));
    assert.ok(sql.includes('octet_length(submitted_data::text) <= 65536'));
  });
});

describe('shop_claims', () => {
  it('removes every direct client write path', () => {
    assert.ok(sql.includes('revoke insert on public.shop_claims from authenticated'));
    assert.ok(sql.includes('drop policy if exists shop_claims_insert_own on public.shop_claims'));
    assert.equal(/grant [^;]*insert[^;]* on public\.shop_claims/.test(sql), false);
    assert.equal(/grant [^;]*update[^;]* on public\.shop_claims/.test(sql), false);
  });

  it('scopes client reads away from the token hash, evidence and reviewer', () => {
    assert.ok(sql.includes('revoke select on public.shop_claims from authenticated'));
    const columns = grantedColumns('grant select');
    for (const secret of ['proof_token_hash', 'evidence', 'reviewed_by']) {
      assert.equal(columns.includes(secret), false, secret);
    }
    for (const visible of ['id', 'shop_id', 'status', 'expires_at']) {
      assert.ok(columns.includes(visible), visible);
    }
  });

  it('adds the proof columns and the expired status', () => {
    for (const column of ['add column proof_token_hash text', 'add column proof_verified_at timestamptz', 'add column expires_at timestamptz']) {
      assert.ok(sql.includes(column), column);
    }
    assert.ok(sql.includes("check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'expired'))"));
  });

  it('keeps proof state internally consistent', () => {
    for (const constraint of [
      'shop_claims_proof_token_hash_format',
      'shop_claims_verified_requires_token',
      'shop_claims_expired_has_expiry',
      'shop_claims_expiry_after_creation',
      'shop_claims_approved_has_timestamp',
    ]) {
      assert.ok(sql.includes(`add constraint ${constraint}`), constraint);
    }
  });

  it('looks the generated status constraint up instead of guessing its name', () => {
    assert.ok(sql.includes("c.conname = 'shop_claims_status_check'"));
  });
});

// ---------------------------------------------------------------------------
// Statement order
// ---------------------------------------------------------------------------
//
// The first real push of this migration failed on exactly this: a
// column-scoped GRANT named columns that an ALTER TABLE further down had not
// yet created, and PostgreSQL rejected it (42703). Every presence check above
// passed, because the statements were all there — just in the wrong order.
//
// The guard below is deliberately not a SQL parser. It removes the two things
// that could make `;` or `add column` appear where they are not statements —
// dollar-quoted bodies and string literals — then splits on `;` and compares
// only two shapes: `alter table public.T ... add column C` and
// `grant PRIVILEGES (C, ...) on public.T`.

/** Top-level statements, with function bodies and literals neutralised. */
function statementsOf(executableSql: string): string[] {
  return executableSql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "'<body>'")
    .replace(/'(?:[^']|'')*'/g, () => "''")
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Column grants that name a column this same SQL only adds LATER.
 *
 * A granted column that is never added here is assumed to pre-exist and is not
 * reported: the core schema created it, and checking that would require the
 * whole schema history, which is what a fragile parser would try to do.
 */
function columnGrantOrderViolations(executableSql: string): string[] {
  const added: { table: string; column: string; at: number }[] = [];
  const granted: { table: string; column: string; at: number }[] = [];

  statementsOf(executableSql).forEach((statement, at) => {
    const alter = /^alter table (?:only )?public\.([a-z_][a-z0-9_]*) /.exec(statement);
    if (alter) {
      for (const match of statement.matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/g)) {
        added.push({ table: alter[1]!, column: match[1]!, at });
      }
    }
    const grant = /^grant [a-z, ]+ \(([^)]*)\) on (?:table )?public\.([a-z_][a-z0-9_]*) /.exec(statement);
    if (grant) {
      for (const column of grant[1]!.split(',').map((c) => c.trim())) {
        granted.push({ table: grant[2]!, column, at });
      }
    }
  });

  const violations: string[] = [];
  for (const grant of granted) {
    const creation = added.find((a) => a.table === grant.table && a.column === grant.column);
    if (creation && creation.at > grant.at) {
      violations.push(
        `${grant.table}.${grant.column}: granted in statement ${grant.at}, added in statement ${creation.at}`
      );
    }
  }
  return violations;
}

describe('statement order', () => {
  it('grants shop_claims reads only after the proof columns exist', () => {
    const grant = sql.indexOf('grant select (');
    assert.ok(grant >= 0, 'column-scoped select grant not found');
    for (const column of ['add column proof_token_hash', 'add column proof_verified_at', 'add column expires_at']) {
      const addedAt = sql.indexOf(column);
      assert.ok(addedAt >= 0, `${column} not found`);
      assert.ok(grant > addedAt, `${column} must come before the column-scoped grant`);
    }
  });

  it('keeps the select revoke together with its grant, after the columns and before the function', () => {
    const revoke = sql.indexOf('revoke select on public.shop_claims from authenticated');
    const grant = sql.indexOf('grant select (');
    const lastColumn = sql.indexOf('add column expires_at');
    const fn = sql.indexOf('create or replace function public.request_shop_claim');
    assert.ok(lastColumn < revoke, 'revoke must follow the new columns');
    assert.ok(revoke < grant, 'revoke must precede the grant it replaces');
    assert.ok(grant < fn, 'grant must precede request_shop_claim');
  });

  it('has no column grant anywhere that precedes the column it names', () => {
    assert.deepEqual(columnGrantOrderViolations(sql), []);
  });

  describe('the generic guard itself', () => {
    it('reports a grant that names a column added further down', () => {
      const misordered = executable(
        'grant select (id, token) on public.t to authenticated;\nalter table public.t add column token text;'
      );
      assert.deepEqual(columnGrantOrderViolations(misordered), [
        't.token: granted in statement 0, added in statement 1',
      ]);
    });

    it('reproduces the failure of the first push', () => {
      const firstPush = executable(`
        revoke select on public.shop_claims from authenticated;
        grant select (id, reviewed_at, proof_verified_at, expires_at) on public.shop_claims to authenticated;
        alter table public.shop_claims
          add column proof_token_hash text,
          add column proof_verified_at timestamptz,
          add column expires_at timestamptz;
      `);
      assert.equal(columnGrantOrderViolations(firstPush).length, 2);
    });

    it('accepts the corrected order', () => {
      const ordered = executable(
        'alter table public.t add column token text;\ngrant select (id, token) on public.t to authenticated;'
      );
      assert.deepEqual(columnGrantOrderViolations(ordered), []);
    });

    it('does not confuse two tables that share a column name', () => {
      const twoTables = executable(
        'grant select (token) on public.b to authenticated;\nalter table public.a add column token text;'
      );
      assert.deepEqual(columnGrantOrderViolations(twoTables), []);
    });

    it('is not fooled by semicolons or keywords inside literals and function bodies', () => {
      const tricky = executable(`
        comment on table public.t is 'a; add column token text';
        create function public.f() returns void language sql as $$ select 1; alter table public.t add column token text; $$;
        grant select (token) on public.t to authenticated;
      `);
      assert.deepEqual(columnGrantOrderViolations(tricky), []);
    });

    it('ignores grants that are not column-scoped', () => {
      const plain = executable(
        'grant execute on function public.f(uuid) to authenticated;\nalter table public.t add column token text;'
      );
      assert.deepEqual(columnGrantOrderViolations(plain), []);
    });
  });
});

describe('request_shop_claim', () => {
  const body = functionBody('request_shop_claim');

  it('is SECURITY DEFINER with a pinned search_path and an explicit owner', () => {
    assert.ok(body.includes('security definer'));
    assert.ok(body.includes("set search_path = ''"));
    assert.ok(sql.includes('alter function public.request_shop_claim(uuid) owner to postgres'));
  });

  it('is callable by authenticated only — never anon, never PUBLIC', () => {
    assert.ok(sql.includes('revoke all on function public.request_shop_claim(uuid) from public, anon, authenticated'));
    assert.ok(sql.includes('grant execute on function public.request_shop_claim(uuid) to authenticated'));
    assert.equal(/grant execute on function public\.request_shop_claim\(uuid\) to [^;]*anon/.test(sql), false);
    assert.equal(/grant execute on function public\.request_shop_claim\(uuid\) to [^;]*public/.test(sql), false);
  });

  it('takes identity from the JWT, not from a parameter', () => {
    assert.ok(body.includes('auth.uid()'));
    assert.ok(body.startsWith('create or replace function public.request_shop_claim(p_shop_id uuid)'));
  });

  it('only ever opens a pending claim', () => {
    assert.ok(body.includes("'pending'"));
    assert.equal(body.includes("'approved'"), false, 'must never approve');
  });

  it('never grants membership, verification or evidence', () => {
    assert.equal(body.includes('insert into public.shop_members'), false);
    assert.equal(body.includes('shop_verifications'), false);
    assert.equal(body.includes('evidence'), false);
    assert.equal(body.includes('reviewed_by'), false);
    assert.equal(/\bmethod\b/.test(body), false);
  });

  it('refuses unpublished, owned and already-joined shops, and rate limits', () => {
    assert.ok(body.includes("s.status = 'published'"));
    assert.ok(body.includes("m.role = 'owner'"));
    assert.ok(body.includes('shop_already_claimed'));
    assert.ok(body.includes('already_member'));
    assert.ok(body.includes('too_many_open_claims'));
  });

  it('stores only a hash of the token', () => {
    assert.ok(body.includes("encode(sha256(convert_to(v_token, 'utf8')), 'hex')"));
    assert.equal(/insert into public\.shop_claims \([^)]*proof_token[,) ]/.test(body), false);
  });

  it('uses no dynamic SQL', () => {
    assert.equal(/\bexecute\b/.test(body), false);
  });
});

describe('shop_ai_analyses', () => {
  it('records the requester and bounds the quota lookup', () => {
    assert.ok(sql.includes('add column requested_by uuid references public.profiles (id) on delete set null'));
    assert.ok(sql.includes('on public.shop_ai_analyses (requested_by, created_at desc)'));
  });

  it('gets a real foreign key to submissions', () => {
    assert.ok(sql.includes('foreign key (submission_id) references public.merchant_submissions (id) on delete cascade'));
  });

  it('gains no client access (D1)', () => {
    assert.equal(/grant [^;]* on public\.shop_ai_analyses/.test(sql), false);
    assert.equal(/create policy [^;]* on public\.shop_ai_analyses/.test(sql), false);
  });
});

describe('nothing widens elsewhere', () => {
  it('creates no policy and disables no RLS', () => {
    assert.equal(/create policy/.test(sql), false);
    assert.equal(/disable row level security|no force row level security/.test(sql), false);
  });

  it('grants nothing to anon or service_role', () => {
    assert.equal(/grant [^;]* to [^;]*\banon\b/.test(sql), false);
    assert.equal(/grant [^;]* to [^;]*\bservice_role\b/.test(sql), false);
  });

  it('touches no catalogue or trust table', () => {
    for (const table of ['public.shops ', 'public.shop_members', 'public.shop_verifications', 'public.shop_categories', 'public.shop_tags']) {
      const outsideFunction = sql.replace(functionBody('request_shop_claim'), '');
      assert.equal(new RegExp(`(alter table|grant [^;]* on|revoke [^;]* on) ${table.replace('.', '\\.')}`).test(outsideFunction), false, table);
    }
  });
});
