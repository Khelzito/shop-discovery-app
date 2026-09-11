import type { Audience } from '../../ai/contracts/common';
import type { MerchantValueOrigin } from '../../ai/contracts/shop-analysis-endpoint';
import type { KnownPricePositioning } from '../../ai/contracts/shop-analysis-v2';

/** French labels for the merchant review form. */

export const AUDIENCE_LABELS: Record<Audience, string> = {
  women: 'Femme',
  men: 'Homme',
  kids: 'Enfant',
  unisex: 'Mixte',
  all: 'Tous publics',
};

export const PRICE_LABELS: Record<KnownPricePositioning, string> = {
  budget: 'Accessible',
  mid: 'Intermédiaire',
  premium: 'Premium',
  luxury: 'Luxe',
};

/** A discreet hint under a field. A merchant edit needs none. */
export const ORIGIN_HINTS: Record<MerchantValueOrigin, string | null> = {
  ai: 'Suggéré par l’IA',
  site: 'Détecté sur votre site',
  merchant: null,
};
