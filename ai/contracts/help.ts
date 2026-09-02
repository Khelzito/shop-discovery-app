import type { Confidence, LanguageCode } from './common.ts';
import type { ModelMetadata } from './model.ts';

export type HelpQuery = {
  question: string;
  locale: LanguageCode;
};

/**
 * One retrieved passage of official Shop Discovery knowledge.
 * Mirrors a `help_article_embeddings` chunk plus its article.
 */
export type HelpSource = {
  articleId: string;
  articleSlug: string;
  title: string;
  chunkIndex: number;
  /** Similarity score from retrieval. */
  score: number;
  /** The passage itself, so an answer can be checked against it. */
  excerpt: string;
};

/** What retrieval found, before any model is asked to write prose. */
export type HelpContext = {
  query: HelpQuery;
  sources: HelpSource[];
};

/** Why the assistant declined rather than answering. */
export const HELP_REFUSAL_REASONS = [
  /** Retrieval found nothing relevant enough. */
  'no_supporting_source',
  /** The question is outside what Shop Discovery documents. */
  'out_of_scope',
] as const;
export type HelpRefusalReason = (typeof HELP_REFUSAL_REASONS)[number];

/**
 * An answer that can always be traced back to retrieved knowledge.
 *
 * `answered: false` is a first-class outcome, not a failure. The assistant
 * must say it does not know rather than invent a Shop Discovery policy — a
 * fabricated rule about verification or refunds is worse than silence
 * (docs/AI_ARCHITECTURE.md).
 */
export type HelpAnswer = {
  answered: boolean;
  /** Empty when `answered` is false. */
  answer: string;
  /** The passages the answer is grounded in. Empty means it is not grounded. */
  sources: HelpSource[];
  confidence: Confidence;
  refusalReason: HelpRefusalReason | null;
  model: ModelMetadata;
};
