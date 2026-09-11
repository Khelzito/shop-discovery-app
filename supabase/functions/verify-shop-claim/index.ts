// Edge Function: POST /verify-shop-claim — domain-control proof of a claim.
//
// Transport and wiring only. Every decision lives in ai/server and is tested
// under Node:
//
//   ai/server/claim/verify-claim-handler.ts      auth, payload, outcomes
//   ai/server/claim/claim-site-check.ts          exact host, robots, safe-fetch
//   ai/server/claim/meta-token.ts                deterministic meta tag scan
//   ai/server/claim/claim-verification-store.ts  begin/finish RPCs
//   ai/server/site/safe-fetch.ts                 pinned HTTPS client (no fetch())
//
// TWO CREDENTIALS, TWO SCOPES:
//   * the caller's JWT: verified by the gateway (verify_jwt = true) and again
//     by auth.getUser(). The user id comes from it and nowhere else;
//   * service_role: used ONLY for begin_claim_verification and
//     finish_claim_verification — it holds no table privilege.
// Neither is logged or returned. The claim token's hash never leaves the
// database, and this function never learns the expected token.
//
// Deno runtime. Relative imports carry explicit .ts extensions.

import { createClient } from 'npm:@supabase/supabase-js@^2.109.0';

import { checkClaimOnSite } from '../../../ai/server/claim/claim-site-check.ts';
import { createRpcClaimVerificationStore } from '../../../ai/server/claim/claim-verification-store.ts';
import { handleVerifyClaimRequest, MAX_CLAIM_REQUEST_BYTES } from '../../../ai/server/claim/verify-claim-handler.ts';
import { createDenoTransport } from '../../../ai/server/site/deno-transport.ts';
import { createSafeFetcher } from '../../../ai/server/site/safe-fetch.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Access-Control-Max-Age': '86400',
};

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
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLAIM_REQUEST_BYTES) {
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
    console.error('[verify-shop-claim] missing platform environment');
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

  const result = await handleVerifyClaimRequest(
    { method: req.method, headers: req.headers, body, signal: req.signal },
    {
      authenticate: async () => {
        const { data, error } = await userClient.auth.getUser();
        return error || !data?.user ? null : { id: data.user.id };
      },
      store: admin ? createRpcClaimVerificationStore((fn, params) => admin.rpc(fn, params)) : null,
      checkSite: (input) => checkClaimOnSite(input, { fetcher }),
      log: (level, event, fields) => console[level](`[verify-shop-claim] ${event}`, fields),
    }
  );

  return respond(result.status, result.body, result.headers);
});
