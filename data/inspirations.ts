import { demoPhoto } from '@/data/demo-photo';
import type { Inspiration } from '@/types/inspiration';

/**
 * Editorial discovery themes shown on Explorer when no search is active.
 *
 * Each one carries the query it stands for, so connecting them to the search
 * results route later is a routing change and nothing more.
 */
export const INSPIRATIONS: readonly Inspiration[] = [
  {
    id: 'createurs-francais',
    title: 'Créateurs français',
    image: demoPhoto('photo-1441984904996-e0b6ba687e04'),
    query: 'créateurs français indépendants',
  },
  {
    id: 'minimaliste',
    title: 'Minimaliste',
    image: demoPhoto('photo-1558769132-cb1aea458c5e'),
    query: 'marques minimalistes',
  },
  {
    id: 'streetwear',
    title: 'Streetwear',
    image: demoPhoto('photo-1503342217505-b0a15ec3261c'),
    query: 'streetwear indépendant',
  },
  {
    id: 'petits-budgets',
    title: 'Petits budgets',
    image: demoPhoto('photo-1489987707025-afc232f7ea0f'),
    query: 'boutiques accessibles',
  },
];
