import { reportOutcomeOf, type ReportInsert, type ReportOutcome } from '@/lib/merchant/report';
import { supabase } from '@/lib/supabase';

/**
 * Sends a report: shop, reason and optional details — the three columns the
 * client is granted. The database sets the reporter from the session, keeps
 * the status `open`, and refuses a second open report on the same shop.
 */
export async function reportShop(insert: ReportInsert): Promise<ReportOutcome> {
  if (!supabase) {
    return 'failed';
  }
  const { error } = await supabase.from('shop_reports').insert(insert);
  if (error && __DEV__) {
    console.warn('[report] insert failed', { code: error.code ?? null });
  }
  return reportOutcomeOf(error);
}
