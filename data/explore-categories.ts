/**
 * Interest vocabulary for the Preferences screen.
 *
 * The catalogue's real categories now come from the `categories` table via the
 * shop repository, and Explorer reads them from there. This static list
 * survives only because preferences are still local and unpersisted; the slugs
 * match the seeded rows, so moving this screen to the database later changes
 * where the list comes from, not what it means.
 */
export type InterestOption = {
  id: string;
  label: string;
};

export const INTEREST_OPTIONS: readonly InterestOption[] = [
  { id: 'mode', label: 'Mode' },
  { id: 'sneakers', label: 'Sneakers' },
  { id: 'bijoux', label: 'Bijoux' },
  { id: 'beaute', label: 'Beauté' },
  { id: 'maison', label: 'Maison' },
  { id: 'tech', label: 'Tech' },
  { id: 'sport', label: 'Sport' },
];
