// Manual evaluation of SearchIntent extraction against the real provider.
//
// THIS COSTS MONEY. It is never run by `npm test`, lint, typecheck or
// `expo export`, and it refuses to run unless you opt in twice: once with the
// API key, once with an explicit flag.
//
//   OPENAI_API_KEY=sk-... node scripts/evaluate-search-intent.mjs --confirm-paid
//
// Optional:
//   OPENAI_SEARCH_MODEL=gpt-5.6-sol   (default)
//   --only=<case-id-substring>        run a subset
//   --limit=<n>                       cap the number of cases
//
// It prints each extracted intent plus a PASS/FAIL on the `mustNot` invariants
// from the evaluation set — the rules that describe silently hiding shops.
// The `expect` fields are printed for human judgement, not asserted: a model
// is not deterministic, and asserting exact output would only teach us to
// weaken the assertions.
//
// The key is read from the environment and never printed.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm-paid');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '';
const limit = Number.parseInt(
  args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? '',
  10
);

const apiKey = process.env.OPENAI_API_KEY ?? '';
const model = process.env.OPENAI_SEARCH_MODEL ?? 'gpt-5.6-sol';

if (!confirmed) {
  console.error(
    'Refusing to run: this makes real, billable API calls.\n' +
      'Re-run with --confirm-paid once you accept the cost.'
  );
  process.exit(1);
}
if (apiKey.trim().length === 0) {
  console.error('Refusing to run: OPENAI_API_KEY is not set in this shell.');
  process.exit(1);
}

// The evaluation imports the compiled provider, so build it the same way the
// test suite does rather than duplicating a TypeScript loader.
if (!existsSync('dist-test/ai/server/openai-search-intent.js')) {
  console.log('Building ai/ ...');
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.test.json'], {
    stdio: 'inherit',
    shell: true,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const { OpenAiSearchIntentProvider } = await import('../dist-test/ai/server/openai-search-intent.js');
const { EVALUATION_CASES } = await import('../dist-test/ai/server/evaluation-set.js');
const { validateSearchIntent } = await import('../dist-test/ai/server/validation.js');

// The seeded catalogue. Kept in sync with the reference-data migration.
const ALLOWED_CATEGORIES = ['mode', 'sneakers', 'bijoux', 'beaute', 'maison', 'tech', 'sport'];

const provider = new OpenAiSearchIntentProvider({
  apiKey,
  model,
  allowedCategorySlugs: ALLOWED_CATEGORIES,
  timeoutMs: 20_000, // generous: this is a benchmark, not interactive UX
});

const cases = EVALUATION_CASES.filter((c) => (only ? c.id.includes(only) : true)).slice(
  0,
  Number.isFinite(limit) && limit > 0 ? limit : undefined
);

console.log(`Model: ${model}`);
console.log(`Cases: ${cases.length}\n`);

let failures = 0;
let errors = 0;
let totalInput = 0;
let totalOutput = 0;

for (const testCase of cases) {
  process.stdout.write(`\n── ${testCase.id}\n   query: ${testCase.query}\n`);

  let result;
  try {
    result = await provider.parseSearchIntent({
      query: testCase.query,
      ...(testCase.locale ? { locale: testCase.locale } : {}),
      ...(testCase.shippingCountryCode
        ? { shippingCountryCode: testCase.shippingCountryCode }
        : {}),
    });
  } catch (error) {
    errors += 1;
    console.log(`   ERROR  ${error?.name ?? 'unknown'}: ${error?.message ?? ''}`);
    continue;
  }

  const { data: intent, telemetry } = result;
  totalInput += telemetry.inputTokens ?? 0;
  totalOutput += telemetry.outputTokens ?? 0;

  const validation = validateSearchIntent(intent);
  if (!validation.ok) {
    failures += 1;
    console.log(`   FAIL   contract validation: ${validation.issues.join('; ')}`);
    continue;
  }

  console.log(`   hard   categories=${JSON.stringify(intent.hard.categorySlugs)} ` +
    `countries=${JSON.stringify(intent.hard.countryCodes)} ` +
    `shipping=${JSON.stringify(intent.hard.shippingCountryCodes)} ` +
    `audiences=${JSON.stringify(intent.hard.audiences)}`);
  console.log(`          price=[${intent.hard.priceMin ?? '-'}, ${intent.hard.priceMax ?? '-'}] ` +
    `${intent.hard.currency ?? ''} verifiedOnly=${intent.hard.verifiedOnly}`);
  console.log(`   soft   styles=${JSON.stringify(intent.soft.styles)} ` +
    `positioning=${intent.soft.brandPositioning} popularity=${intent.soft.popularity}`);
  console.log(`   semantic: ${intent.semanticQuery}`);
  console.log(`   conf=${intent.confidence} latency=${telemetry.latencyMs}ms ` +
    `tokens=${telemetry.inputTokens ?? '?'}/${telemetry.outputTokens ?? '?'}`);

  const violations = [];
  const must = testCase.mustNot ?? {};
  if (must.hardCategory && intent.hard.categorySlugs.length > 0) {
    violations.push(`invented category ${JSON.stringify(intent.hard.categorySlugs)}`);
  }
  if (must.hardCountry && intent.hard.countryCodes.length > 0) {
    violations.push(`invented country ${JSON.stringify(intent.hard.countryCodes)}`);
  }
  if (must.hardPrice && (intent.hard.priceMin !== null || intent.hard.priceMax !== null)) {
    violations.push(`invented price bound [${intent.hard.priceMin}, ${intent.hard.priceMax}]`);
  }
  if (must.verifiedOnly && intent.hard.verifiedOnly) {
    violations.push('set verifiedOnly');
  }
  for (const slug of intent.hard.categorySlugs) {
    if (!ALLOWED_CATEGORIES.includes(slug)) {
      violations.push(`slug outside the whitelist: ${slug}`);
    }
  }

  if (violations.length > 0) {
    failures += 1;
    console.log(`   FAIL   ${violations.join(' | ')}`);
  } else if (testCase.mustNot) {
    console.log('   PASS   invariants respected');
  }

  if (testCase.expect) {
    console.log(`   expect (review by hand): ${JSON.stringify(testCase.expect)}`);
  }
}

console.log('\n────────────────────────────────');
console.log(`cases: ${cases.length}   invariant failures: ${failures}   provider errors: ${errors}`);
console.log(`tokens: ${totalInput} in / ${totalOutput} out`);
process.exit(failures > 0 ? 1 : 0);
