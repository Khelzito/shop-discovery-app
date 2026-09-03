# AI layer

OpenAI is the first concrete provider, behind the same `SearchIntentProvider`
interface everything else depends on. It parses a natural-language query into a
structured `SearchIntent` and nothing more: the intent does **not** retrieve or
rank shops yet — that is the next phase. No embedding is generated and no
dimension is chosen.

The deterministic tier is not going anywhere. It runs when no key is
configured, when OpenAI fails or times out, and when the model returns
something that does not validate. Search degrades; it never stops working.

```
ai/
  contracts/   client-safe. Types, a few constants. No dependency, no secret.
  server/      server-only. Validation, provider interfaces, orchestration.
```

## The boundary

`ai/server` must never be imported from anywhere outside `ai/server` itself
and `supabase/functions`.

Three independent layers enforce this, because no single one is enough:

1. **Metro** (`metro.config.js`) blocks `ai/server` from module resolution, so
   the bundler physically cannot include those files — through an alias, a
   relative path, or a barrel.
2. **ESLint** forbids the import in every file and lifts the rule only for
   `ai/server` and `supabase/functions`, so a new top-level directory is
   covered the day it is created.
3. **`ai/server/boundary.test.ts`** reads the source tree and fails the suite
   if either of the above is bypassed or removed.

This is not a style rule. `ai/server` is where provider adapters and their
credentials will live, and Metro bundles whatever it can reach from the app —
one accidental import would ship an API key inside the app binary. Expo has no
private environment: anything prefixed `EXPO_PUBLIC_` is in the bundle, and
anything else is simply absent at runtime. There is no safe way to hold a
provider key on the client.

The app imports `@/ai/contracts` (types, erased at build time) and talks to the
backend over HTTP.

```
Expo app  ──HTTP──>  trusted backend  ──>  provider adapters  ──>  vendors
   |                        |                      |
@/ai/contracts        ai/server/*            secrets live here
```

## Where the backend goes

Supabase Edge Functions are the right home for this project: the Supabase
project already exists, functions run next to the database, and secrets are set
with `supabase secrets set` rather than living in the repo. Nothing is deployed
yet.

The intended layout, when Prompt 11 creates it:

```
supabase/functions/
  ai-search-intent/index.ts
  ai-shop-analysis/index.ts
  ai-help/index.ts
```

Each imports the contracts and services from `ai/` by relative path. The module
is deliberately dependency-free and uses only relative imports, so the same
files run unchanged under Node, Metro and Deno.

## Public endpoints, and what stays internal

| Operation | Callable by the app | Why |
| --- | --- | --- |
| `POST /ai/search-intent` | yes | The user typed a query; the result shapes their search. |
| `POST /ai/shop-analysis` | yes | A merchant pastes a URL and waits for a proposal. |
| `POST /ai/help` | yes | The user asked a question. |
| embedding | **no** | An open embedding endpoint is a free embedding API paid for with our quota. It runs inside indexing and search. |
| rerank | **no** | A step in the middle of the search pipeline. It has no meaning outside it and is expensive per call. |

`/ai/shop-analysis` takes a URL, never page content: the server fetches and
extracts, so the endpoint cannot be used to launder arbitrary text through a
provider. That also makes it the riskiest endpoint in the system — a server
fetching a user-supplied URL is SSRF by construction. **[ai/SECURITY.md](./SECURITY.md)
lists what must be implemented before it is deployed**, and every item there is
a release blocker.

## What search does today

```
query -> ai-search-intent -> SearchIntent (validated)
      -> intent.hard       -> SQL filters      -> eligible shops
      -> deterministic ranking                 -> ordered results
```

**This is factual retrieval, not semantic search.** Hard constraints become SQL
and decide which shops exist in the answer; ranking only orders what survived,
with a fixed formula and no model in the loop. A query for "quiet luxury"
matches nothing unless those words literally appear in a shop's public text —
the token-overlap heuristic in `data/search/rank.ts` cannot relate "baskets" to
"sneakers", and a test asserts exactly that so the limitation stays visible.

Semantic retrieval over `shop_embeddings` is the next phase and replaces the
heuristic; the contracts already carry `semanticQuery` for it.

Two paths reach the catalogue, on purpose:

| Action | Path | Cost |
| --- | --- | --- |
| Tapping a category chip | direct `categories` filter | free |
| Submitting free text | `ai-search-intent` then retrieval | one model call |

### Constraints deliberately not applied yet

| Constraint | Why |
| --- | --- |
| shipping destination | No shop declares `shipping_country_codes`. |
| independence | Not a hard field in the contract; it is a soft signal. |
| popularity | `shop_views` and `outbound_clicks` are empty, so "lesser known" cannot be measured. |

Numeric price bounds **are** applied, but null-tolerantly: a shop that declares
no range is never excluded, because "no data" is not "too expensive". No seeded
shop declares one, so today this excludes nothing. Euro amounts are **never**
translated into `price_level` — a level-2 shop is not "under 150 €", and
inventing that mapping would silently hide shops behind an arbitrary threshold.

Audience widens rather than narrows: a menswear query keeps `unisex` and `all`
shops and rewards an exact match in ranking instead, so being wrong costs a
position rather than a result.

## The search pipeline this supports

```
query
  -> SearchIntentProvider          -> SearchIntent (validated)
  -> intent.hard                   -> SQL filters      (presence)
  -> intent.semanticQuery          -> embedding        -> pgvector retrieval
  -> candidates                    -> RerankProvider   (order)
  -> intent.soft + user signals    -> personalisation  (order)
  -> freshness + diversity         -> final results
```

The split between `hard` and `soft` is the load-bearing decision. Hard filters
decide which shops may appear: "ships to France", "under 150 EUR". Soft
preferences only decide the order: "minimalist", "lesser known", "premium
feel". Letting a language model produce hard filters from a judgement would
silently hide good shops over an opinion, which is exactly what
"AI understands, the database verifies" exists to prevent.

## Trust rules encoded here, not left to a prompt

- A `ShopAnalysis` is a proposal. It never verifies, never publishes, never
  overwrites a declared fact.
- `unknown` is a valid answer and is preferred over a confident guess.
- A `HelpAnswer` with no cited source is rejected by validation, not by
  instruction. An invented Shop Discovery policy is worse than silence.
- A reranker returning a shop id it was not given is an error, not something to
  quietly filter out.

## Providers

| Operation | Provider today | Selected by |
| --- | --- | --- |
| search intent | `OpenAiSearchIntentProvider`, falling back to `DeterministicSearchIntentProvider` | `AI_SEARCH_PROVIDER`, `OPENAI_API_KEY` |
| shop analysis | none yet | — |
| embedding | none yet | — |
| rerank | none yet | — |
| help answer | none yet | — |

`ai/server/openai-search-intent.ts` is the only file in the repository that
knows OpenAI exists. A second vendor is a sibling file plus a config value, not
a refactor: `SearchIntelligenceService` depends on the interface.

Server-only configuration, all read inside the Edge Function:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Secret. Absent means the deterministic tier. |
| `AI_SEARCH_PROVIDER` | `openai` | `deterministic` disables the model entirely. |
| `OPENAI_SEARCH_MODEL` | `gpt-5.6-sol` | Model id. |
| `OPENAI_SEARCH_TIMEOUT_MS` | `6000` | Past this, the deterministic tier is better UX. |
| `OPENAI_MAX_OUTPUT_TOKENS` | `2000` | Includes reasoning tokens, so not the size of the JSON. |
| `OPENAI_SEARCH_REASONING_EFFORT` | `low` | Extraction, not deep reasoning. |

None of these is an `EXPO_PUBLIC_` variable, and none can be: the Expo bundle
cannot resolve `ai/server` at all.

## Runtime validation

TypeScript disappears at build time, so every structured response is validated
in `server/validation.ts` before it can reach SQL. Written by hand rather than
with a schema library: it runs server-side only, it has zero dependencies so
the same file works under Node, Metro and Deno without an import map, and there
are five stable schemas. If that count grows a lot, Zod becomes the better
trade and this file is small enough to replace wholesale.

## Security

Deploying any of these endpoints against a real provider or a real network
fetch requires everything in [ai/SECURITY.md](./SECURITY.md): authenticated
requests, rate limits and quotas, input size caps, timeouts and cancellation,
provider cost protection, and — for shop analysis — strict URL validation,
IP-level SSRF blocking including the cloud metadata range, redirect
re-validation, and streamed response limits.

## Tests

```sh
npm test
```

Compiles `ai/` with the existing TypeScript compiler and runs Node's built-in
test runner. No test framework was added. **No test makes a paid API call** —
the provider adapter is exercised through an injected `fetch`.

Quality of the real extraction is a separate, opt-in script that costs money
and refuses to run without two explicit opt-ins:

```sh
OPENAI_API_KEY=... node scripts/evaluate-search-intent.mjs --confirm-paid
```

It runs `ai/server/evaluation-set.ts` — 32 queries covering French, English,
mixed vocabulary, prices, origin-versus-shipping, style-versus-category,
typos and prompt-injection attempts — and reports which ones violated an
invariant.
