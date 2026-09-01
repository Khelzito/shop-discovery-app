# AI layer

The architecture of the AI brain, not the brain itself. No provider is called,
no key exists, no embedding is generated, no dimension is chosen.

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
test runner. No test framework was added.
