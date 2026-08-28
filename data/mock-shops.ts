import { demoPhoto } from '@/data/demo-photo';
import type { Shop } from '@/types/shop';

/**
 * The single mock shop catalogue for the visual prototype.
 *
 * Every screen reads its shops from here. Do not declare shop objects inside
 * components, and do not start a second catalogue. This module is replaced by
 * the Supabase read model in a later phase; the exported selectors are the
 * seam.
 *
 * No shop below is a real business: every `website` uses the reserved
 * `.example` TLD. See `data/demo-photo.ts` for the imagery rules.
 */

export const MOCK_SHOPS: readonly Shop[] = [
  {
    id: 'maison-leon',
    name: 'Maison Léon',
    category: 'Streetwear',
    country: 'FR',
    description:
      'Vestiaire urbain coupé et assemblé à Roubaix, en séries courtes et matières lourdes.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1517841905240-472988babdf9'),
      gallery: [
        demoPhoto('photo-1441986300917-64674bd600d8'),
        demoPhoto('photo-1620799140408-edc6dcb6d633'),
      ],
    },
    tags: ['indépendant', 'made in France', 'séries courtes'],
    priceLevel: 2,
    website: 'https://maison-leon.example',
  },
  {
    id: 'lune-studio',
    name: 'Lune Studio',
    category: 'Bijoux',
    country: 'FR',
    description: 'Bijoux fins en or recyclé, dessinés et façonnés dans un atelier lyonnais.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1611652022419-a9419f74343d'),
      gallery: [
        demoPhoto('photo-1608042314453-ae338d80c427'),
        demoPhoto('photo-1602173574767-37ac01994b2a'),
      ],
    },
    tags: ['or recyclé', 'artisanal', 'minimaliste'],
    priceLevel: 3,
    website: 'https://lune-studio.example',
  },
  {
    id: 'sneaklab',
    name: 'SneakLab',
    category: 'Chaussures',
    country: 'FR',
    description: 'Souliers et sneakers en cuir tanné végétal, montés à la main au Portugal.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1560343090-f0409e92791a'),
      gallery: [],
    },
    tags: ['cuir végétal', 'fait main'],
    priceLevel: 3,
    website: 'https://sneaklab.example',
  },
  {
    id: 'ombre-claire',
    name: 'Ombre Claire',
    category: 'Prêt-à-porter',
    country: 'FR',
    description: 'Maille douce et pièces intemporelles pensées pour durer plusieurs saisons.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1556905055-8f358a7a47b2'),
      gallery: [demoPhoto('photo-1620799140408-edc6dcb6d633')],
    },
    tags: ['maille', 'intemporel'],
    priceLevel: 2,
    website: 'https://ombre-claire.example',
  },
  {
    id: 'celeste',
    name: 'Céleste',
    category: 'Beauté',
    country: 'FR',
    description: 'Soins et maquillage à formules courtes, sans surenchère marketing.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1596462502278-27bfdc403348'),
      gallery: [],
    },
    tags: ['clean', 'rechargeable'],
    priceLevel: 2,
    website: 'https://celeste.example',
  },

  // — Pépites cachées —
  {
    id: 'atelier-noma',
    name: 'Atelier Noma',
    category: 'Décoration',
    country: 'FR',
    description: 'Mobilier clair et objets de table, chinés et réédités en petite quantité.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1616486338812-3dadae4b4ace'),
      gallery: [
        demoPhoto('photo-1519710164239-da123dc03ef4'),
        demoPhoto('photo-1584589167171-541ce45f1eea'),
      ],
    },
    tags: ['intérieur', 'pièce unique'],
    priceLevel: 3,
    website: 'https://atelier-noma.example',
  },
  {
    id: 'atelier-vasse',
    name: 'Atelier Vasse',
    category: 'Maroquinerie',
    country: 'FR',
    description: 'Sacs en cuir pleine fleur, numérotés et réparables à vie.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1584917865442-de89df76afd3'),
      gallery: [],
    },
    tags: ['cuir', 'réparable', 'numéroté'],
    priceLevel: 3,
    website: 'https://atelier-vasse.example',
  },
  {
    id: 'sablon',
    name: 'Sablon',
    category: 'Décoration',
    country: 'BE',
    description: 'Luminaires et céramique aux lignes calmes, éditées à Bruxelles.',
    verified: true,
    images: {
      cover: demoPhoto('photo-1519710164239-da123dc03ef4'),
      gallery: [demoPhoto('photo-1584589167171-541ce45f1eea')],
    },
    tags: ['céramique', 'luminaire'],
    priceLevel: 2,
    website: 'https://sablon.example',
  },

  // — Nouveautés —
  {
    id: 'district',
    name: 'District',
    category: 'Prêt-à-porter',
    country: 'BE',
    description: 'Sélection pointue de marques européennes indépendantes, sans saisonnalité.',
    verified: false,
    images: {
      cover: demoPhoto('photo-1490481651871-ab68de25d43d'),
      gallery: [demoPhoto('photo-1512436991641-6745cdb1723f')],
    },
    tags: ['concept store', 'européen'],
    priceLevel: 2,
    website: 'https://district.example',
  },
  {
    id: 'studio-arho',
    name: 'Studio Arho',
    category: 'Audio',
    country: 'DE',
    description: 'Casques et enceintes conçus à Berlin, réparables et sans obsolescence.',
    verified: false,
    images: {
      cover: demoPhoto('photo-1505740420928-5e560c06d30e'),
      gallery: [],
    },
    tags: ['audio', 'réparable'],
    priceLevel: 3,
    website: 'https://studio-arho.example',
  },
  {
    id: 'nord-et-fils',
    name: 'Nord & Fils',
    category: 'Accessoires',
    country: 'FR',
    description: 'Sacs de ville et petite bagagerie en toile enduite, taillés pour le quotidien.',
    verified: false,
    images: {
      cover: demoPhoto('photo-1553062407-98eeb64c6a62'),
      gallery: [],
    },
    tags: ['bagagerie', 'quotidien'],
    priceLevel: 1,
    website: 'https://nord-et-fils.example',
  },
  {
    id: 'verte-rue',
    name: 'Verte Rue',
    category: 'Mode responsable',
    country: 'FR',
    description: 'Basiques teints naturellement, en coton biologique certifié.',
    verified: false,
    // Deliberately without a cover: exercises the ImageFrame typographic
    // fallback inside the real Home experience.
    images: {
      cover: null,
      gallery: [],
    },
    tags: ['coton bio', 'teinture naturelle'],
    priceLevel: 1,
    website: 'https://verte-rue.example',
  },
];

const byId = (id: string): Shop => {
  const shop = MOCK_SHOPS.find((candidate) => candidate.id === id);
  if (!shop) {
    throw new Error(`Unknown mock shop: ${id}`);
  }
  return shop;
};

/**
 * Home selectors.
 *
 * A shop never appears twice on one Home render (docs/MASTER_SPEC.md §7), so
 * the three lists below are disjoint.
 */
export const FOR_YOU_SHOPS: readonly Shop[] = [
  byId('maison-leon'),
  byId('lune-studio'),
  byId('sneaklab'),
  byId('ombre-claire'),
  byId('celeste'),
];

export const HIDDEN_GEM_SHOPS: readonly Shop[] = [
  byId('atelier-noma'),
  byId('atelier-vasse'),
  byId('sablon'),
];

export const NEW_SHOPS: readonly Shop[] = [
  byId('district'),
  byId('studio-arho'),
  byId('nord-et-fils'),
  byId('verte-rue'),
];
