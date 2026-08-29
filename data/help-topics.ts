export type HelpTopic = {
  id: string;
  /** Row label and screen title. */
  title: string;
  /** One paragraph per entry. Kept short on purpose. */
  paragraphs: readonly string[];
};

/**
 * The two explanatory pages reachable from Aide.
 *
 * Deliberately brief: enough to answer the question, nothing that reads like
 * marketing copy or terms of service.
 */
export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'fonctionnement',
    title: 'Comment fonctionne Shop Discovery ?',
    paragraphs: [
      'Shop Discovery aide à découvrir des boutiques en ligne indépendantes que tu n’aurais probablement pas trouvées autrement.',
      'Aucun achat ne se fait dans l’application. Quand une boutique t’intéresse, tu es redirigé vers son propre site, où la commande et le paiement ont lieu.',
    ],
  },
  {
    id: 'verification',
    title: 'Comment les boutiques sont-elles vérifiées ?',
    paragraphs: [
      'La vérification confirme des informations clés sur une boutique, comme le contrôle de son nom de domaine et son existence légale.',
      'Elle ne peut pas être achetée et ne constitue pas une garantie absolue. Elle indique ce qui a pu être confirmé, rien de plus.',
    ],
  },
];

export function findHelpTopic(id: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.id === id);
}
