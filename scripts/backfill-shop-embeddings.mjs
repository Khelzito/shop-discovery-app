// Backfill of `shop_profile` embeddings.
//
// DRY RUN BY DEFAULT. It refuses to spend anything unless you pass exactly
// --confirm-paid and both server secrets are in your shell.
//
//   node scripts/backfill-shop-embeddings.mjs                 # free, no writes
//   node scripts/backfill-shop-embeddings.mjs --confirm-paid  # real, billable
//
// TWO CLIENTS, ONE PRIVILEGE EACH. This is the correction after a 403:
//
//   * The PUBLIC key reads the catalogue. `shops`, `categories` and `tags`
//     are already granted to anon, and everything embedded is text a visitor
//     can read anyway. Nothing privileged is involved in reading them.
//   * The SERVICE-ROLE key touches `shop_embeddings` and NOTHING else — the
//     one table no client role may see. It is never used for a catalogue read,
//     so no grant on `shops` is needed for this script to work.
//
// The alternative — granting service_role SELECT on `shops` — would widen a
// role's reach across the catalogue to serve one offline script. Splitting the
// two reads costs a few lines and keeps that grant unnecessary.
//
// Environment (exported in YOUR shell, never read from a file, never printed):
//   EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY   from .env, catalogue reads
//   SUPABASE_SERVICE_ROLE_KEY              shop_embeddings only
//   OPENAI_API_KEY                         embeddings only
//
// Options:
//   --limit=<n>            cap the shops considered
//   --batch=<n>            inputs per provider call (default 32, max 96)
//   --force                re-embed even when the stored hash still matches
//   --inspect-embeddings   report what is stored and exit. Read-only, free,
//                          no provider call. Needs the service-role key
//                          because the table is revoked from client roles.
//
// IDEMPOTENCE. Each shop's text is hashed with its version. A shop whose
// stored hash still matches is skipped without a provider call, so re-running
// after a partial failure costs only what is actually missing.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// The script imports the compiled modules, so build them the same way the test
// suite does rather than duplicating a TypeScript loader.
if (
  !existsSync('dist-test/ai/server/embedding-text.js') ||
  !existsSync('dist-test/scripts/backfill-args.js') ||
  !existsSync('dist-test/scripts/postgrest.js') ||
  !existsSync('dist-test/scripts/backfill-plan.js')
) {
  console.log('Building ...');
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.test.json'], {
    stdio: 'inherit',
    shell: true,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const { parseBackfillArgs } = await import('../dist-test/scripts/backfill-args.js');
const { readPostgrestResponse, describeFailure } = await import('../dist-test/scripts/postgrest.js');
const { buildBackfillPlan, indexStoredEmbeddings } = await import('../dist-test/scripts/backfill-plan.js');
const { buildShopEmbeddingText, embeddingSourceHash, EMBEDDING_TEXT_VERSION } =
  await import('../dist-test/ai/server/embedding-text.js');
const { OpenAiEmbeddingProvider, DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = await import(
  '../dist-test/ai/server/openai-embedding.js'
);

// ---------------------------------------------------------------------------
// Arguments — strict, because a silently-ignored flag already cost a key
// ---------------------------------------------------------------------------

const parsed = parseBackfillArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error('Refusing to run:');
  for (const message of parsed.errors) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}
const { confirmed, force, limit, batch: batchSize, inspect } = parsed.value;

const SOURCE_KIND = 'shop_profile';
const MODEL = process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function readDotEnv() {
  try {
    return Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv();
const url = (process.env.SUPABASE_URL ?? dotEnv.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
const publicKey = (dotEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const openAiKey = (process.env.OPENAI_API_KEY ?? '').trim();

if (url.length === 0 || publicKey.length === 0) {
  console.error('Refusing to run: EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.');
  process.exit(1);
}

if (confirmed) {
  const missing = [];
  if (serviceRoleKey.length === 0) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (openAiKey.length === 0) missing.push('OPENAI_API_KEY');
  if (missing.length > 0) {
    console.error(
      `Refusing to run a paid backfill: ${missing.join(', ')} not set in this shell.\n` +
        'Export them yourself; this script never reads them from a file.'
    );
    process.exit(1);
  }
}

/** Catalogue reads. Public key only — no privilege, no grant needed. */
async function publicRest(path, init = {}) {
  return request(path, publicKey, init, 'catalogue');
}

/** shop_embeddings only. Never used for anything else. */
async function adminRest(path, init = {}) {
  if (serviceRoleKey.length === 0) {
    throw new Error('no service-role key');
  }
  if (!path.startsWith('/shop_embeddings')) {
    // A guard rather than a comment: the whole point of splitting the clients
    // is that this one can only ever touch the embeddings table.
    throw new Error(`adminRest refuses ${path}: shop_embeddings only`);
  }
  return request(path, serviceRoleKey, init, 'embeddings');
}

/**
 * One HTTP call, read through the tested parser.
 *
 * Never calls res.json(). A successful write with `Prefer: return=minimal`
 * answers 201 with an EMPTY body, and parsing that as JSON is what previously
 * made ten committed rows report as failures.
 */
async function request(path, key, init, label) {
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });

  // Status, then content-type, then the body as TEXT. In that order, always.
  const body = await res.text();
  const result = readPostgrestResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    body,
  });

  if (!result.ok) {
    const error = new Error(describeFailure(label, result));
    error.status = result.status;
    error.code = result.code;
    throw error;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// --inspect-embeddings — read-only, no provider call, no write
// ---------------------------------------------------------------------------
//
// Answers "what is actually stored?" without touching anything. It exists
// because a write can succeed while the script reports failure, and guessing
// afterwards is worse than looking.
//
// It prints metadata only. The `embedding` column is never selected, so no
// vector can reach the terminal or the scrollback.

if (inspect) {
  if (serviceRoleKey.length === 0) {
    console.error(
      'Refusing to inspect: SUPABASE_SERVICE_ROLE_KEY is not set in this shell.\n' +
        'shop_embeddings is revoked from every client role, which is intended.'
    );
    process.exit(1);
  }

  const rows = await adminRest(
    '/shop_embeddings?select=shop_id,source_kind,embedding_model,embedding_version,dimensions,source_hash,created_at&order=created_at'
  );

  console.log(`\n=== shop_embeddings — ${rows.length} row(s) ===\n`);
  for (const row of rows) {
    console.log(
      `${row.shop_id}  ${row.source_kind}  ${row.embedding_model}  ` +
        `${row.embedding_version ?? '(none)'}  dim=${row.dimensions}  ` +
        `hash=${(row.source_hash ?? '').slice(0, 12)}…`
    );
  }

  const duplicates = new Map();
  for (const row of rows) {
    const key = `${row.shop_id}|${row.embedding_model}|${row.source_kind}`;
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  }
  const repeated = [...duplicates.values()].filter((count) => count > 1).length;
  console.log(`\nduplicates on (shop_id, model, source_kind): ${repeated}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Read the catalogue with the PUBLIC key
// ---------------------------------------------------------------------------

const SELECT = [
  'id',
  'slug',
  'name',
  'short_description',
  'long_description',
  'country_code',
  'city',
  'audience',
  'shop_categories(is_primary,categories(name))',
  'shop_tags(tags(name))',
].join(',');

console.log(`\n=== Backfill ${SOURCE_KIND} — ${confirmed ? 'REAL RUN' : 'DRY RUN'} ===\n`);
console.log(`model       ${MODEL}`);
console.log(`dimensions  ${EMBEDDING_DIMENSIONS}`);
console.log(`source_kind ${SOURCE_KIND}`);
console.log(`version     ${EMBEDDING_TEXT_VERSION}`);
console.log(`catalogue   public key`);
// Which key answers the idempotence question, stated rather than implied.
// "already current : 0" means something completely different depending on
// whether the store could be read at all, and guessing which was the case is
// how a broken comparison passed for an empty cache.
console.log(
  `idempotence ${serviceRoleKey ? 'service_role (privileged read)' : 'UNAVAILABLE — no service-role key'}\n`
);

let shops = await publicRest(`/shops?select=${encodeURIComponent(SELECT)}&status=eq.published&order=slug`);
if (limit > 0) {
  shops = shops.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Read existing vectors with the SERVICE-ROLE key
// ---------------------------------------------------------------------------

let existing = new Map();
let existingKnown = false;

if (serviceRoleKey.length > 0) {
  try {
    // Every column the staleness decision consults is selected. Leaving
    // embedding_version out was how a version mismatch became invisible.
    //
    // No server-side filter on model or source_kind: the comparison happens in
    // buildBackfillPlan, so a row stored under a DIFFERENT model shows up as
    // `model_changed` rather than silently as `missing`. Filtering here would
    // hide exactly the mismatch worth seeing.
    const rows = await adminRest(
      '/shop_embeddings?select=shop_id,source_hash,dimensions,embedding_model,embedding_version,source_kind'
    );
    existing = indexStoredEmbeddings(rows);
    existingKnown = true;
  } catch (error) {
    // A missing grant here is a configuration fact worth naming precisely,
    // not a stack trace. Without it every shop would look stale and a real run
    // would re-embed the whole catalogue on every invocation.
    if (error.status === 403 || error.status === 401) {
      console.error(
        'service_role cannot read public.shop_embeddings.\n' +
          '\n' +
          'This project revokes and re-grants table privileges explicitly, and\n' +
          'service_role was never granted anything on that table. Idempotence and\n' +
          'writes both depend on it. The narrow fix, as a migration:\n' +
          '\n' +
          '  grant select, insert, update on public.shop_embeddings to service_role;\n' +
          '\n' +
          'No client role and no RLS policy is involved, and nothing on public.shops\n' +
          'is touched.\n'
      );
      process.exit(1);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Decide what needs embedding
// ---------------------------------------------------------------------------

const texts = new Map();
const hashes = [];

for (const shop of shops) {
  const source = {
    name: shop.name,
    shortDescription: shop.short_description,
    longDescription: shop.long_description,
    countryCode: shop.country_code,
    city: shop.city,
    audience: shop.audience,
    categories: (shop.shop_categories ?? [])
      .filter((link) => link.categories)
      .map((link) => ({ name: link.categories.name, isPrimary: link.is_primary === true })),
    tags: (shop.shop_tags ?? []).filter((link) => link.tags).map((link) => link.tags.name),
  };

  const text = buildShopEmbeddingText(source);
  const hash = await embeddingSourceHash(EMBEDDING_TEXT_VERSION, text);
  texts.set(shop.id, text);
  hashes.push({ shopId: shop.id, hash });
}

const EXPECTED = {
  model: MODEL,
  sourceKind: SOURCE_KIND,
  version: EMBEDDING_TEXT_VERSION,
  dimensions: EMBEDDING_DIMENSIONS,
};

const plan = buildBackfillPlan(
  { shops: hashes, stored: existing, expected: EXPECTED, force, storeReadable: existingKnown },
  batchSize
);

const bySlug = new Map(shops.map((shop) => [shop.id, shop.slug]));
const planned = plan.planned.map((entry) => ({
  shop: shops.find((s) => s.id === entry.shopId),
  slug: bySlug.get(entry.shopId),
  text: texts.get(entry.shopId),
  hash: entry.hash,
  stale: entry.stale !== null,
  reason: entry.stale,
}));

const todo = planned.filter((entry) => entry.stale);
const skip = planned.filter((entry) => !entry.stale);

console.log(`shops published : ${plan.total}`);
console.log(`already current : ${plan.current}`);
console.log(`would embed     : ${plan.toEmbed}`);
// Calls that WOULD be needed. A dry run stops before the provider is even
// constructed, so this number is arithmetic and never evidence of a call.
console.log(`provider calls  : ${plan.providerCalls} (batch of ${batchSize})\n`);

if (!existingKnown) {
  console.log(
    'NOTE: no service-role key, so shop_embeddings could not be read — that\n' +
      '      lockdown is intended. Every shop is therefore listed as "would\n' +
      '      embed"; a real run re-checks each hash before spending.\n'
  );
}

// The reason is printed, not just the verdict: "stale" with no explanation is
// what let a field-name typo pass for a legitimate cache miss.
for (const entry of planned) {
  const stored = existing.get(entry.shop.id);
  const detail = entry.stale
    ? `${entry.reason}` +
      (stored ? ` (stored ${String(stored.source_hash ?? '').slice(0, 12)}…)` : '')
    : 'current';
  console.log(
    `${entry.stale ? 'EMBED' : 'skip '}  ${entry.slug.padEnd(16)} ` +
      `hash=${entry.hash.slice(0, 12)}…  ${String(entry.text.length).padStart(4)} chars  ${detail}`
  );
}

if (!confirmed) {
  const sample = planned[0];
  if (sample) {
    console.log(`\n--- exact text that would be embedded for "${sample.shop.slug}" ---`);
    console.log(sample.text);
    console.log('--- end ---');
  }
  console.log(
    '\nDry run complete. No provider call was made and nothing was written.\n' +
      'Re-run with --confirm-paid (plus SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY) to execute.'
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------------

const provider = new OpenAiEmbeddingProvider({ apiKey: openAiKey, model: MODEL });
const summary = { embedded: 0, skipped: skip.length, failed: 0 };

for (let start = 0; start < todo.length; start += batchSize) {
  const chunk = todo.slice(start, start + batchSize);
  const label = `${start + 1}-${start + chunk.length}/${todo.length}`;

  let result;
  try {
    result = await provider.embedBatch(chunk.map((entry) => ({ modality: 'text', text: entry.text })));
  } catch (error) {
    // One failed batch must not abandon the rest: the next run re-checks
    // hashes and picks up exactly what is still missing.
    console.error(`batch ${label} FAILED: ${error.name}`);
    summary.failed += chunk.length;
    continue;
  }

  const rows = chunk.map((entry, index) => {
    const vector = result.data.results[index];
    return {
      shop_id: entry.shop.id,
      embedding: JSON.stringify(vector.vector),
      dimensions: vector.dimensions,
      embedding_model: MODEL,
      embedding_version: EMBEDDING_TEXT_VERSION,
      source_hash: entry.hash,
      source_kind: SOURCE_KIND,
    };
  });

  try {
    await adminRest('/shop_embeddings?on_conflict=shop_id,embedding_model,source_kind', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    summary.embedded += rows.length;
    console.log(`batch ${label} written`);
  } catch (error) {
    console.error(`batch ${label} NOT WRITTEN: ${error.message.slice(0, 160)}`);
    summary.failed += rows.length;
  }
}

console.log(
  `\n=== Summary ===\nembedded ${summary.embedded}\nskipped  ${summary.skipped}\nfailed   ${summary.failed}`
);
process.exit(summary.failed > 0 ? 1 : 0);
