/**
 * Interest vocabulary for the Preferences screen.
 *
 * The catalogue's real categories now come from the `categories` table via the
 * shop repository, and Explorer reads them from there. This compact static list
 * defines the preference choices shown in the UI; the slugs intentionally match
 * seeded category rows, and signed-in selections are persisted by slug lookup.
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
