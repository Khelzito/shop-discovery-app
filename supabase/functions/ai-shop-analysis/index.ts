// Edge Function: POST /ai-shop-analysis — Shop Analyzer V1.
//
// Transport and wiring only. Every decision lives in ai/server and is tested
// under Node:
//
//   ai/server/shop-analysis-handler.ts   auth, payload, quota, persistence, response
//   ai/server/shop-analyzer.ts           robots.txt, safe-fetch, extraction, model
//   ai/server/site/safe-fetch.ts         pinned HTTPS client (no fetch())
//   ai/server/site/deno-transport.ts     Deno.resolveDns / connect / startTls
//
// THREE CREDENTIALS, THREE SCOPES:
//   * the caller's JWT: verified by the gateway (verify_jwt = true) and again
//     by auth.getUser(); also used to read the public taxonomy under RLS;
//   * service_role: used ONLY for the three SECURITY DEFINER RPCs
//     begin/complete/fail_shop_analysis — it has no table privilege;
//   * OPENAI_API_KEY: passed only to the provider adapter.
// None of them is logged or returned.
//
// The shop's site is NEVER fetched with fetch(). fetch() is used by the
// Supabase client and by the OpenAI adapter, both towards fixed, trusted hosts.
//
// Deno runtime. Relative imports carry explicit .ts extensions.

import { createClient } from 'npm:@supabase/supabase-js@^2.109.0';

import { handleShopAnalysisRequest, MAX_REQUEST_BYTES } from '../../../ai/server/shop-analysis-handler.ts';
import {
  createShopAnalysisProvider,
  describeShopAnalysisPlan,
  planShopAnalysisProvider,
} from '../../../ai/server/shop-analysis-config.ts';
import { createRpcShopAnalysisStore } from '../../../ai/server/shop-analysis-persistence.ts';
import { analyzeShopWebsite, taxonomyFromResponses } from '../../../ai/server/shop-analyzer.ts';
import { createDenoTransport } from '../../../ai/server/site/deno-transport.ts';
import { createSafeFetcher } from '../../../ai/server/site/safe-fetch.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};

const plan = planShopAnalysisProvider((name) => Deno.env.get(name));
console.info('[ai-shop-analysis] provider plan', describeShopAnalysisPlan(plan));

// Pinned transport: the IP is chosen and validated by safe-fetch, the TLS name
// is the original hostname, and certificate validation is the runtime default.
const transport = createDenoTransport({
  resolveDns: (hostname, recordType) =>
    recordType === 'A' ? Deno.resolveDns(hostname, 'A') : Deno.resolveDns(hostname, 'AAAA'),
  connect: (options) => Deno.connect(options),
  startTls: (conn, options) => Deno.startTls(conn, { hostname: options.hostname }),
});
const fetcher = createSafeFetcher(transport);

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...headers, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return respond(413, { ok: false, error: { code: 'ai_bad_request', message: 'Requête trop volumineuse.', retryable: false } });
  }

  let body = '';
  if (req.method === 'POST') {
    try {
      body = await req.text();
    } catch {
      return respond(400, { ok: false, error: { code: 'ai_bad_request', message: 'Requête illisible.', retryable: false } });
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !publishableKey) {
    console.error('[ai-shop-analysis] missing platform environment');
    return respond(503, { ok: false, error: { code: 'ai_unavailable', message: 'Service indisponible.', retryable: true } });
  }

  const authorization = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  let provider = null;
  try {
    provider = createShopAnalysisProvider(plan);
  } catch {
    console.warn('[ai-shop-analysis] provider unavailable');
  }

  const result = await handleShopAnalysisRequest(
    { method: req.method, headers: req.headers, body, signal: req.signal },
    {
      authenticate: async () => {
        const { data, error } = await userClient.auth.getUser();
        return error || !data?.user ? null : { id: data.user.id };
      },
      store: admin ? createRpcShopAnalysisStore((fn, params) => admin.rpc(fn, params)) : null,
      loadTaxonomy: async () => {
        const [categories, tags] = await Promise.all([
          userClient.from('categories').select('slug, name').eq('is_active', true),
          userClient.from('tags').select('slug, name, kind'),
        ]);
        // Throws TaxonomyUnavailableError with table, code and HTTP status —
        // the handler logs those, never the message.
        return taxonomyFromResponses(categories, tags);
      },
      analyze: (input) => analyzeShopWebsite(input, { fetcher, provider }),
      log: (level, event, fields) => console[level](`[ai-shop-analysis] ${event}`, fields),
    }
  );

  return respond(result.status, result.body, result.headers);
});
