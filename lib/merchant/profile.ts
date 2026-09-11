import { AUDIENCES } from '../../ai/contracts/common';
import type { Audience } from '../../ai/contracts/common';
import {
  MERCHANT_PROFILE_FIELDS,
  MERCHANT_PROFILE_KEY,
  MERCHANT_PROFILE_LIMITS as LIMITS,
  MERCHANT_PROFILE_VERSION,
  MERCHANT_PROPOSAL_KEY,
} from '../../ai/contracts/shop-analysis-endpoint';
import type {
  MerchantProfile,
  MerchantProfileField,
  MerchantValueOrigin,
} from '../../ai/contracts/shop-analysis-endpoint';
import type { KnownPricePositioning } from '../../ai/contracts/shop-analysis-v2';

/**
 * The review form: from the stored AI proposal to the profile the merchant
 * sends.
 *
 * The proposal is a SUGGESTION. The merchant corrects it, and the result is a
 * request for review — never a published or verified shop. Nothing in here can
 * express verification, trust, status, ownership or publication, and the
 * submission payload is built from an explicit list of keys.
 */

export const KNOWN_PRICES: readonly KnownPricePositioning[] = ['budget', 'mid', 'premium', 'luxury'];

export type MerchantTaxonomy = {
  categories: readonly { slug: string; name: string }[];
  tags: readonly { slug: string; name: string }[];
};

/** Form values. Text is kept raw while typing and cleaned on submit. */
export type ProfileValues = {
  name: string;
  shortDescription: string;
  primaryCategory: string | null;
  secondaryCategories: string[];
  audience: Audience[];
  pricePositioning: KnownPricePositioning | null;
  styles: string[];
  values: string[];
  productTypes: string[];
  tags: string[];
  logoUrl: string | null;
  imageUrls: string[];
};

export type MerchantProfileDraft = {
  websiteUrl: string;
  values: ProfileValues;
  /** What was proposed, to tell a kept suggestion from an edit. */
  initial: ProfileValues;
  /** Only fields that actually received a suggestion. */
  initialOrigins: Partial<Record<MerchantProfileField, Exclude<MerchantValueOrigin, 'merchant'>>>;
  /** Images the site exposed. The merchant may remove some, never add a URL. */
  availableImageUrls: string[];
};

export type ProfileErrors = Partial<Record<MerchantProfileField, string>>;

const HTTPS_URL = /^https:\/\/\S+$/i;

// ---------------------------------------------------------------------------
// Proposal -> draft
// ---------------------------------------------------------------------------

/**
 * Builds the form from whatever `submitted_data.aiProposal` holds.
 *
 * The stored JSON is read defensively: a missing or malformed part becomes an
 * empty field, never an exception, so a merchant can always fill the form by
 * hand. Observed values come from the site; inferred ones from the model.
 */
export function profileDraftFromProposal(proposal: unknown, websiteUrl: string): MerchantProfileDraft {
  const root = asRecord(proposal);
  const observed = asRecord(root?.observed);
  const inferred = asRecord(root?.inferred);
  const origins: MerchantProfileDraft['initialOrigins'] = {};

  const observedText = (key: string, max: number): string | null => {
    const value = asRecord(observed?.[key])?.value;
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
  };
  const observedUrl = (key: string): string | null => {
    const value = asRecord(observed?.[key])?.value;
    return typeof value === 'string' && HTTPS_URL.test(value) ? value : null;
  };
  const inferredValue = (key: string): unknown => asRecord(inferred?.[key])?.value;
  const inferredStrings = (key: string): string[] => {
    const list = inferred?.[key];
    return Array.isArray(list)
      ? uniqueStrings(list.map((entry) => asRecord(entry)?.value).filter((value): value is string => typeof value === 'string'))
      : [];
  };

  const values = emptyValues();

  const name = observedText('name', LIMITS.name);
  if (name !== null) {
    values.name = name;
    origins.name = 'site';
  }

  const aiDescription = inferredValue('shortDescription');
  const siteDescription = observedText('description', LIMITS.shortDescription);
  if (typeof aiDescription === 'string' && aiDescription.trim().length > 0) {
    values.shortDescription = aiDescription.trim();
    origins.shortDescription = 'ai';
  } else if (siteDescription !== null) {
    values.shortDescription = siteDescription;
    origins.shortDescription = 'site';
  }

  const primary = inferredValue('primaryCategory');
  if (typeof primary === 'string' && primary.length > 0) {
    values.primaryCategory = primary;
    origins.primaryCategory = 'ai';
  }

  const suggestedLists: [keyof ProfileValues & MerchantProfileField, string][] = [
    ['secondaryCategories', 'secondaryCategories'],
    ['styles', 'styles'],
    ['values', 'values'],
    ['productTypes', 'productTypes'],
    ['tags', 'tags'],
  ];
  for (const [field, key] of suggestedLists) {
    const list = inferredStrings(key);
    if (list.length > 0) {
      (values[field] as string[]) = list;
      origins[field] = 'ai';
    }
  }

  const audience = inferredValue('audience');
  if (Array.isArray(audience)) {
    const known = audience.filter((item): item is Audience => (AUDIENCES as readonly unknown[]).includes(item));
    if (known.length > 0) {
      values.audience = [...new Set(known)];
      origins.audience = 'ai';
    }
  }

  const price = inferredValue('pricePositioning');
  if ((KNOWN_PRICES as readonly unknown[]).includes(price)) {
    values.pricePositioning = price as KnownPricePositioning;
    origins.pricePositioning = 'ai';
  }

  const logo = observedUrl('logoUrl');
  if (logo !== null) {
    values.logoUrl = logo;
    origins.logoUrl = 'site';
  }

  const images = Array.isArray(observed?.imageUrls)
    ? uniqueStrings(
        observed.imageUrls
          .map((entry) => asRecord(entry)?.value)
          .filter((value): value is string => typeof value === 'string' && HTTPS_URL.test(value))
      ).slice(0, LIMITS.imageUrls)
    : [];
  if (images.length > 0) {
    values.imageUrls = images;
    origins.imageUrls = 'site';
  }

  return {
    websiteUrl,
    values,
    initial: cloneValues(values),
    initialOrigins: origins,
    availableImageUrls: images,
  };
}

export function emptyValues(): ProfileValues {
  return {
    name: '',
    shortDescription: '',
    primaryCategory: null,
    secondaryCategories: [],
    audience: [],
    pricePositioning: null,
    styles: [],
    values: [],
    productTypes: [],
    tags: [],
    logoUrl: null,
    imageUrls: [],
  };
}

/** The origin of a field right now: its suggestion if untouched, else the merchant. */
export function originOf(draft: MerchantProfileDraft, field: MerchantProfileField): MerchantValueOrigin {
  const suggested = draft.initialOrigins[field];
  if (!suggested) {
    return 'merchant';
  }
  return sameValue(draft.values[field], draft.initial[field]) ? suggested : 'merchant';
}

// ---------------------------------------------------------------------------
// Draft -> profile
// ---------------------------------------------------------------------------

export const PROFILE_MESSAGES = {
  nameRequired: 'Indiquez le nom de votre boutique.',
  nameTooLong: `Le nom ne doit pas dépasser ${LIMITS.name} caractères.`,
  descriptionTooLong: `La description ne doit pas dépasser ${LIMITS.shortDescription} caractères.`,
  categoryRequired: 'Choisissez une catégorie principale.',
  categoryUnknown: 'Cette catégorie n’est pas disponible.',
  taxonomyUnavailable: 'Les catégories ne sont pas disponibles. Réessayez.',
  tooManySecondary: `Choisissez au plus ${LIMITS.secondaryCategories} catégories secondaires.`,
  tooManyTags: `Choisissez au plus ${LIMITS.tags} tags.`,
  tooManyItems: `${LIMITS.listItems} éléments maximum.`,
  itemTooLong: `Chaque élément doit faire ${LIMITS.listItem} caractères maximum.`,
} as const;

export function validateMerchantProfile(
  draft: MerchantProfileDraft,
  taxonomy: MerchantTaxonomy,
  now: Date = new Date()
): { ok: true; profile: MerchantProfile } | { ok: false; errors: ProfileErrors } {
  const errors: ProfileErrors = {};
  const v = draft.values;
  const categorySlugs = new Set(taxonomy.categories.map((entry) => entry.slug));
  const tagSlugs = new Set(taxonomy.tags.map((entry) => entry.slug));

  const name = collapse(v.name);
  if (name.length === 0) errors.name = PROFILE_MESSAGES.nameRequired;
  else if (name.length > LIMITS.name) errors.name = PROFILE_MESSAGES.nameTooLong;

  const description = collapse(v.shortDescription);
  if (description.length > LIMITS.shortDescription) errors.shortDescription = PROFILE_MESSAGES.descriptionTooLong;

  const primary = v.primaryCategory;
  if (categorySlugs.size === 0) errors.primaryCategory = PROFILE_MESSAGES.taxonomyUnavailable;
  else if (primary === null) errors.primaryCategory = PROFILE_MESSAGES.categoryRequired;
  else if (!categorySlugs.has(primary)) errors.primaryCategory = PROFILE_MESSAGES.categoryUnknown;

  const secondary = uniqueStrings(v.secondaryCategories).filter((slug) => categorySlugs.has(slug) && slug !== primary);
  if (secondary.length > LIMITS.secondaryCategories) errors.secondaryCategories = PROFILE_MESSAGES.tooManySecondary;

  const tags = uniqueStrings(v.tags).filter((slug) => tagSlugs.has(slug));
  if (tags.length > LIMITS.tags) errors.tags = PROFILE_MESSAGES.tooManyTags;

  const lists = {} as Record<'styles' | 'values' | 'productTypes', string[]>;
  for (const field of ['styles', 'values', 'productTypes'] as const) {
    const items = uniqueText(v[field]);
    if (items.some((item) => item.length > LIMITS.listItem)) errors[field] = PROFILE_MESSAGES.itemTooLong;
    else if (items.length > LIMITS.listItems) errors[field] = PROFILE_MESSAGES.tooManyItems;
    lists[field] = items;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const audience = [...new Set(v.audience.filter((item) => (AUDIENCES as readonly string[]).includes(item)))];
  const pricePositioning = v.pricePositioning !== null && KNOWN_PRICES.includes(v.pricePositioning) ? v.pricePositioning : null;
  // Only a logo or images the site itself exposed: a client cannot point the
  // profile at an arbitrary URL.
  const logoUrl = v.logoUrl !== null && v.logoUrl === draft.initial.logoUrl ? v.logoUrl : null;
  const imageUrls = uniqueStrings(v.imageUrls).filter((url) => draft.availableImageUrls.includes(url)).slice(0, LIMITS.imageUrls);

  const origins = Object.fromEntries(
    MERCHANT_PROFILE_FIELDS.map((field) => [field, originOf(draft, field)])
  ) as Record<MerchantProfileField, MerchantValueOrigin>;

  return {
    ok: true,
    profile: {
      profileVersion: MERCHANT_PROFILE_VERSION,
      editedAt: now.toISOString(),
      websiteUrl: draft.websiteUrl,
      name,
      shortDescription: description.length > 0 ? description : null,
      primaryCategory: primary as string,
      secondaryCategories: secondary,
      audience,
      pricePositioning,
      styles: lists.styles,
      values: lists.values,
      productTypes: lists.productTypes,
      tags,
      logoUrl,
      imageUrls,
      origins,
    },
  };
}

// ---------------------------------------------------------------------------
// Submission payload
// ---------------------------------------------------------------------------

/** merchant_submissions.submitted_data CHECK: an object of at most 64 KiB. */
export const MAX_SUBMITTED_DATA_BYTES = 65_536;

/** Key names no merchant document may carry. Mirrors the server guard. */
export const FORBIDDEN_PAYLOAD_KEY = /"[A-Za-z_]*(?:verif|trust|certif|publish|approv|owner|member|status)[A-Za-z_]*"\s*:/i;

export type MerchantSubmissionUpdate = {
  submitted_data: Record<string, unknown>;
  status: 'submitted';
};

/**
 * The only write the app makes to send a request.
 *
 * Two top-level keys: the server's proposal, kept for the reviewer, and the
 * merchant's profile. Nothing else from the existing document is carried
 * over. `status` goes to `submitted`, the one value the update policy allows
 * besides `draft`; the client grant covers website_url, submitted_data and
 * status only, so reviewer and shop fields are unreachable regardless.
 */
export function buildSubmissionUpdate(
  existingSubmittedData: unknown,
  profile: MerchantProfile
): { ok: true; update: MerchantSubmissionUpdate } | { ok: false; error: string } {
  const proposal = asRecord(existingSubmittedData)?.[MERCHANT_PROPOSAL_KEY];
  const withProposal: Record<string, unknown> = {
    ...(asRecord(proposal) ? { [MERCHANT_PROPOSAL_KEY]: proposal } : {}),
    [MERCHANT_PROFILE_KEY]: profile,
  };

  // Too large with the proposal: the analysis row still holds it server-side,
  // so the merchant's own profile wins.
  const submitted_data =
    byteLength(withProposal) <= MAX_SUBMITTED_DATA_BYTES ? withProposal : { [MERCHANT_PROFILE_KEY]: profile };

  if (byteLength(submitted_data) > MAX_SUBMITTED_DATA_BYTES) {
    return { ok: false, error: 'Votre fiche est trop volumineuse. Raccourcissez certains champs.' };
  }
  if (FORBIDDEN_PAYLOAD_KEY.test(JSON.stringify({ [MERCHANT_PROFILE_KEY]: profile }))) {
    return { ok: false, error: 'Votre fiche contient un champ non autorisé.' };
  }

  return { ok: true, update: { submitted_data, status: 'submitted' } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

/** Trimmed, collapsed, deduplicated case-insensitively, blanks removed. */
function uniqueText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = collapse(raw);
    const key = value.toLocaleLowerCase('fr-FR');
    if (value.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneValues(values: ProfileValues): ProfileValues {
  return JSON.parse(JSON.stringify(values)) as ProfileValues;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
