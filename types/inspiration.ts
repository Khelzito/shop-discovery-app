/**
 * An editorial discovery theme surfaced on Explorer.
 *
 * An inspiration is a curated entry point, not a category: it maps to a
 * search intent that the search service resolves in a later phase.
 */
export type Inspiration = {
  id: string;
  /** Short editorial label shown over the photograph. */
  title: string;
  /** Cover photograph. The theme must read visually, without a description. */
  image: string;
  /** The query this theme stands for, used once search results exist. */
  query: string;
};
