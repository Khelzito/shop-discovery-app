import type { AssistantHistoryTurn, AssistantResponse } from '@/ai/contracts/assistant';
import type { AiErrorPayload } from '@/ai/contracts/errors';
import { supabase } from '@/lib/supabase';

const FUNCTION_NAME = 'ai-assistant';

export type AssistantOutcome =
  | { ok: true; data: AssistantResponse }
  | { ok: false; error: AiErrorPayload };

type FunctionEnvelope =
  | { ok: true; data: AssistantResponse }
  | { ok: false; error: AiErrorPayload };

const UNAVAILABLE: AiErrorPayload = {
  code: 'ai_unavailable',
  message: "L’assistant est momentanément indisponible.",
  retryable: true,
};

export async function askAssistant(input: {
  message: string;
  candidateShopIds: readonly string[];
  history?: readonly AssistantHistoryTurn[];
  locale?: string;
  shippingCountryCode?: string;
}): Promise<AssistantOutcome> {
  if (!supabase) return { ok: false, error: UNAVAILABLE };

  const { data, error } = await supabase.functions.invoke<FunctionEnvelope>(FUNCTION_NAME, {
    body: {
      message: input.message.trim(),
      candidateShopIds: [...input.candidateShopIds].slice(0, 8),
      history: (input.history ?? []).slice(-6),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.shippingCountryCode ? { shippingCountryCode: input.shippingCountryCode } : {}),
    },
  });

  if (error || !data || typeof data !== 'object' || !('ok' in data)) {
    return { ok: false, error: UNAVAILABLE };
  }
  if (!data.ok) return { ok: false, error: data.error };
  if (!isAssistantResponse(data.data)) return { ok: false, error: UNAVAILABLE };
  return { ok: true, data: data.data };
}

function isAssistantResponse(value: unknown): value is AssistantResponse {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<AssistantResponse>;
  return (
    (row.mode === 'discovery' || row.mode === 'help' || row.mode === 'out_of_scope') &&
    typeof row.reply === 'string' && row.reply.trim().length > 0 &&
    Array.isArray(row.recommendedShopIds) &&
    row.recommendedShopIds.every((id) => typeof id === 'string') &&
    Array.isArray(row.citedHelpArticleIds) &&
    row.citedHelpArticleIds.every((id) => typeof id === 'string') &&
    typeof row.degraded === 'boolean'
  );
}
