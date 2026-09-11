import { createClient } from 'npm:@supabase/supabase-js@^2.109.0';
import type { AssistantResponse } from '../../../ai/contracts/assistant.ts';
import { fallbackAssistantResponse, parseAssistantRequest, selectHelpArticles, type AssistantHelpArticle, type AssistantShopFact } from '../../../ai/server/assistant-grounding.ts';
import { generateAssistantDraft } from '../../../ai/server/openai-assistant.ts';

const MAX_BODY_BYTES = 16 * 1024;
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

type Envelope = { ok: true; data: AssistantResponse } | { ok: false; error: { code: string; message: string; retryable: boolean } };

function json(body: Envelope, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, error: { code: 'ai_bad_request', message: 'Méthode non autorisée.', retryable: false } }, 405);

  const length = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return json({ ok: false, error: { code: 'ai_bad_request', message: 'Requête trop volumineuse.', retryable: false } }, 413);
  }

  let raw = '';
  try { raw = await req.text(); } catch { return json({ ok: false, error: { code: 'ai_bad_request', message: 'Requête illisible.', retryable: false } }, 400); }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, error: { code: 'ai_bad_request', message: 'Requête trop volumineuse.', retryable: false } }, 413);

  let value: unknown;
  try { value = JSON.parse(raw); } catch { return json({ ok: false, error: { code: 'ai_bad_request', message: 'JSON invalide.', retryable: false } }, 400); }
  const request = parseAssistantRequest(value);
  if (!request) return json({ ok: false, error: { code: 'ai_bad_request', message: 'Requête invalide.', retryable: false } }, 400);

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) return json({ ok: false, error: { code: 'ai_unavailable', message: 'Service indisponible.', retryable: true } }, 503);

  const authorization = req.headers.get('Authorization') ?? '';
  const client = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return json({ ok: false, error: { code: 'ai_bad_request', message: 'Authentification requise.', retryable: false } }, 401);

  const shops = await loadShops(client, request.candidateShopIds);
  const articles = await loadHelpArticles(client);
  const help = selectHelpArticles(request.message, articles);

  const apiKey = (Deno.env.get('OPENAI_API_KEY') ?? '').trim();
  if (!apiKey) return json({ ok: true, data: fallbackAssistantResponse(shops, help) });

  try {
    const draft = await generateAssistantDraft({
      apiKey,
      model: (Deno.env.get('OPENAI_ASSISTANT_MODEL') ?? Deno.env.get('OPENAI_SEARCH_MODEL') ?? 'gpt-5.6-sol').trim(),
      timeoutMs: positiveInt(Deno.env.get('OPENAI_ASSISTANT_TIMEOUT_MS'), 8_000),
    }, request, shops, help);
    return json({ ok: true, data: { ...draft, degraded: false } });
  } catch (error) {
    console.warn('[ai-assistant] provider degraded', { reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown' });
    return json({ ok: true, data: fallbackAssistantResponse(shops, help) });
  }
});

async function loadShops(client: ReturnType<typeof createClient>, ids: readonly string[]): Promise<AssistantShopFact[]> {
  if (ids.length === 0) return [];
  const { data, error } = await client
    .from('shops')
    .select('id, name, short_description, country_code, city, price_level, audience')
    .eq('status', 'published')
    .in('id', [...ids])
    .limit(ids.length);
  if (error) {
    console.warn('[ai-assistant] candidate read failed', { code: error.code });
    return [];
  }
  const byId = new Map((data ?? []).map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
    id: String(row!.id),
    name: String(row!.name),
    shortDescription: typeof row!.short_description === 'string' ? row!.short_description : null,
    countryCode: typeof row!.country_code === 'string' ? row!.country_code : null,
    city: typeof row!.city === 'string' ? row!.city : null,
    priceLevel: typeof row!.price_level === 'number' ? row!.price_level : null,
    audience: typeof row!.audience === 'string' ? row!.audience : null,
  }));
}

async function loadHelpArticles(client: ReturnType<typeof createClient>): Promise<AssistantHelpArticle[]> {
  const { data, error } = await client.from('help_articles').select('id, slug, title, content').eq('is_published', true).order('sort_order').limit(20);
  if (error) {
    console.warn('[ai-assistant] help retrieval failed', { code: error.code });
    return [];
  }
  return (data ?? []).map((row) => ({ id: String(row.id), slug: String(row.slug), title: String(row.title), content: String(row.content) }));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
