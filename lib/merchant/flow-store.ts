import type { ShopAnalysisV2 } from '../../ai/contracts/shop-analysis-v2';
import type { MerchantProfileDraft } from './profile';

/**
 * In-memory state of one merchant flow, as a plain object so its rules are
 * tested under Node. The React provider only holds one instance.
 *
 * Methods are stable arrow properties: a screen can depend on them in an
 * effect without the effect re-running when the state changes.
 *
 * Once a submission is sent it is remembered as such for the rest of the
 * flow: it is never offered for reuse by a new analysis, and a late draft
 * save for it is ignored.
 */

export type LastAnalysis = {
  submissionId: string;
  websiteUrl: string;
  analysis: ShopAnalysisV2 | null;
  proposalSaved: boolean;
};

export class MerchantFlowStore {
  private last: LastAnalysis | null = null;
  private readonly drafts = new Map<string, MerchantProfileDraft>();
  private readonly sent = new Set<string>();

  get lastAnalysis(): LastAnalysis | null {
    return this.last;
  }

  readonly rememberAnalysis = (value: LastAnalysis): void => {
    if (!this.sent.has(value.submissionId)) {
      this.last = value;
    }
  };

  readonly draftFor = (submissionId: string): MerchantProfileDraft | null =>
    this.sent.has(submissionId) ? null : (this.drafts.get(submissionId) ?? null);

  readonly saveDraft = (submissionId: string, draft: MerchantProfileDraft): void => {
    if (!this.sent.has(submissionId)) {
      this.drafts.set(submissionId, draft);
    }
  };

  readonly markSent = (submissionId: string): void => {
    this.sent.add(submissionId);
    this.drafts.delete(submissionId);
    if (this.last?.submissionId === submissionId) {
      this.last = null;
    }
  };

  /** The only submission a new analysis may reuse: the current, unsent one. */
  readonly submissionToReuse = (): string | null =>
    this.last !== null && !this.sent.has(this.last.submissionId) ? this.last.submissionId : null;

  readonly isSent = (submissionId: string): boolean => this.sent.has(submissionId);
}
