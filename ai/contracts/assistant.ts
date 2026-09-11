import type { CountryCode, LanguageCode } from './common.ts';

export const ASSISTANT_MODES = ['discovery', 'help', 'out_of_scope'] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

export type AssistantHistoryTurn = {
  role: 'user' | 'assistant';
  text: string;
};

/**
 * The app proposes candidate ids after its normal hybrid search. The server
 * re-reads every id under the caller's RLS before a model can see it, so the
 * client can influence ranking but cannot launder invented shop facts.
 */
export type AssistantRequest = {
  message: string;
  locale?: LanguageCode;
  shippingCountryCode?: CountryCode;
  candidateShopIds: string[];
  history?: AssistantHistoryTurn[];
};

export type AssistantResponse = {
  mode: AssistantMode;
  reply: string;
  /** Always a subset of the server-verified candidate ids. */
  recommendedShopIds: string[];
  /** Published help articles used for a product-policy answer. */
  citedHelpArticleIds: string[];
  /** True when the provider was unavailable and deterministic fallback answered. */
  degraded: boolean;
};
