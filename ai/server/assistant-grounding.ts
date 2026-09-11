import type {
  AssistantHistoryTurn,
  AssistantMode,
  AssistantRequest,
  AssistantResponse,
} from '../contracts/assistant.ts';

export const ASSISTANT_LIMITS = {
  messageChars: 1000,
  historyTurns: 6,
  historyChars: 1000,
  candidateShops: 8,
  recommendations: 4,
  helpSources: 3,
} as const;

export type AssistantShopFact = {
  id: string;
  name: string;
  shortDescription: string | null;
  countryCode: string | null;
  city: string | null;
  priceLevel: number | null;
  audience: string | null;
};

export type AssistantHelpArticle = {
  id: string;
  slug: string;
  title: string;
  content: string;
};

export type AssistantDraft = {
  mode: AssistantMode;
  reply: string;
  recommendedShopIds: string[];
  citedHelpArticleIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAssistantRequest(value: unknown): AssistantRequest | null {
  if (!isRecord(value)) return null;
  const message = cleanText(value.message, ASSISTANT_LIMITS.messageChars);
  if (!message) return null;

  const ids = Array.isArray(value.candidateShopIds)
    ? value.candidateShopIds.filter((id): id is string => typeof id === 'string' && UUID.test(id))
    : [];
  const candidateShopIds = [...new Set(ids)].slice(0, ASSISTANT_LIMITS.candidateShops);

  const history = Array.isArray(value.history)
    ? value.history
        .map(parseHistoryTurn)
        .filter((turn): turn is AssistantHistoryTurn => turn !== null)
        .slice(-ASSISTANT_LIMITS.historyTurns)
    : [];

  const locale = typeof value.locale === 'string' ? value.locale.slice(0, 10) : undefined;
  const shippingCountryCode =
    typeof value.shippingCountryCode === 'string' && /^[A-Za-z]{2}$/.test(value.shippingCountryCode)
      ? value.shippingCountryCode.toUpperCase()
      : undefined;

  return { message, candidateShopIds, history, locale, shippingCountryCode };
}

function parseHistoryTurn(value: unknown): AssistantHistoryTurn | null {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  const text = cleanText(value.text, ASSISTANT_LIMITS.historyChars);
  return text ? { role: value.role, text } : null;
}

/** Lexical retrieval is intentionally simple until help embeddings are live. */
export function selectHelpArticles(
  question: string,
  articles: readonly AssistantHelpArticle[]
): AssistantHelpArticle[] {
  const query = new Set(tokens(question));
  if (query.size === 0) return [];

  return articles
    .map((article) => {
      const haystack = tokens(`${article.title} ${article.content}`);
      const matches = haystack.filter((token) => query.has(token)).length;
      return { article, score: matches / Math.max(query.size, 1) };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .slice(0, ASSISTANT_LIMITS.helpSources)
    .map((row) => row.article);
}

export function validateAssistantDraft(
  raw: unknown,
  allowedShopIds: readonly string[],
  allowedHelpArticleIds: readonly string[]
): AssistantDraft | null {
  if (!isRecord(raw)) return null;
  if (!['discovery', 'help', 'out_of_scope'].includes(String(raw.mode))) return null;
  const reply = cleanText(raw.reply, 1800);
  if (!reply) return null;

  const shopSet = new Set(allowedShopIds);
  const helpSet = new Set(allowedHelpArticleIds);
  const recommendedShopIds = uniqueStrings(raw.recommendedShopIds)
    .filter((id) => shopSet.has(id))
    .slice(0, ASSISTANT_LIMITS.recommendations);
  const citedHelpArticleIds = uniqueStrings(raw.citedHelpArticleIds)
    .filter((id) => helpSet.has(id));

  const mode = raw.mode as AssistantMode;
  if (mode === 'help' && citedHelpArticleIds.length === 0) return null;
  if (mode === 'out_of_scope' && (recommendedShopIds.length > 0 || citedHelpArticleIds.length > 0)) {
    return null;
  }

  return { mode, reply, recommendedShopIds, citedHelpArticleIds };
}

export function fallbackAssistantResponse(
  shops: readonly AssistantShopFact[],
  help: readonly AssistantHelpArticle[]
): AssistantResponse {
  if (shops.length > 0) {
    const ids = shops.slice(0, 3).map((shop) => shop.id);
    return {
      mode: 'discovery',
      reply: shops.length === 1
        ? 'J’ai trouvé une boutique qui correspond à ta recherche.'
        : `J’ai trouvé ${Math.min(shops.length, 3)} boutiques à regarder en priorité.`,
      recommendedShopIds: ids,
      citedHelpArticleIds: [],
      degraded: true,
    };
  }
  if (help.length > 0) {
    return {
      mode: 'help',
      reply: help[0]!.content.slice(0, 900),
      recommendedShopIds: [],
      citedHelpArticleIds: [help[0]!.id],
      degraded: true,
    };
  }
  return {
    mode: 'out_of_scope',
    reply: "Je n’ai pas assez d’informations fiables pour répondre à ça. Essaie de me demander une boutique, un style ou une question sur Shop Discovery.",
    recommendedShopIds: [],
    citedHelpArticleIds: [],
    degraded: true,
  };
}

export function tokens(value: string): string[] {
  const stop = new Set(['une','des','les','pour','avec','dans','sur','que','qui','quoi','comment','est','sont','the','and','for','with']);
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !stop.has(token));
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 0 && text.length <= max ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
