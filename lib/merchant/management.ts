import { MERCHANT_PROFILE_LIMITS as LIMITS } from '../../ai/contracts/shop-analysis-endpoint';
import { MANAGE_SHOP_OUTCOMES, SHOP_CONTENT_EDITOR_ROLES, SHOP_MEMBER_ROLES } from '../../ai/contracts/merchant-trust';
import type { ManageShopOutcome, MerchantShopManagement, ShopMemberRole } from '../../ai/contracts/merchant-trust';
import { hostOfUrl } from './url';
import type { MerchantTaxonomy } from './profile';

/**
 * Managing a shop the merchant belongs to, without React and without Supabase.
 *
 * What can be edited is what the database already lets owners and admins
 * change: content and classification. Status, publication, the domain, claims,
 * verifications and membership are shown, never offered as controls.
 */

export const SHOP_STATUS_LABELS: Record<string, string> = {
  published: 'Publiée',
  draft: 'Brouillon',
  pending_review: 'En cours de vérification',
  suspended: 'Suspendue',
  rejected: 'Refusée',
};

export const SHOP_ROLE_LABELS: Record<ShopMemberRole, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  editor: 'Éditeur',
};

export function canEditShop(role: ShopMemberRole | null): boolean {
  return role !== null && SHOP_CONTENT_EDITOR_ROLES.includes(role);
}

export type ManagedShopImage = { id: string; url: string; type: 'logo' | 'cover' | 'gallery' };

export type ManagedShop = {
  id: string;
  slug: string;
  name: string;
  status: string;
  websiteUrl: string;
  host: string | null;
  shortDescription: string | null;
  audience: MerchantShopManagement['audience'];
  priceLevel: MerchantShopManagement['priceLevel'];
  publishedAt: string | null;
  role: ShopMemberRole;
  primaryCategory: string | null;
  secondaryCategories: string[];
  /** Merchant-editable tags. Origin tags are kept server-side and not listed. */
  tags: string[];
  images: ManagedShopImage[];
  domainVerified: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIENCE_VALUES = ['women', 'men', 'kids', 'unisex', 'all'] as const;

export function toMemberRole(value: unknown): ShopMemberRole | null {
  return (SHOP_MEMBER_ROLES as readonly unknown[]).includes(value) ? (value as ShopMemberRole) : null;
}

/** One `shops` row with its embedded relations, as the management select returns it. */
export function toManagedShop(raw: unknown, role: ShopMemberRole | null): ManagedShop | null {
  const row = asRecord(raw);
  if (!row || role === null || typeof row.id !== 'string' || !UUID.test(row.id)) return null;
  if (typeof row.name !== 'string' || typeof row.slug !== 'string' || typeof row.status !== 'string' || typeof row.website_url !== 'string') {
    return null;
  }

  const categories = Array.isArray(row.shop_categories) ? row.shop_categories.map(asRecord) : [];
  const slugOf = (link: Record<string, unknown> | null) => {
    const slug = asRecord(link?.categories)?.slug;
    return typeof slug === 'string' ? slug : null;
  };
  const primary = categories.find((link) => link?.is_primary === true);

  const tags = (Array.isArray(row.shop_tags) ? row.shop_tags : [])
    .map((link) => asRecord(asRecord(link)?.tags))
    .filter((tag) => tag !== null && tag.kind !== 'origin' && typeof tag.slug === 'string')
    .map((tag) => tag!.slug as string);

  const images = (Array.isArray(row.shop_images) ? row.shop_images : [])
    .map(asRecord)
    .filter((image): image is Record<string, unknown> => image !== null)
    .filter((image) => typeof image.id === 'string' && typeof image.external_url === 'string' && /^https?:\/\//i.test(image.external_url))
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map(
      (image): ManagedShopImage => ({
        id: image.id as string,
        url: image.external_url as string,
        type: image.image_type === 'logo' ? 'logo' : image.image_type === 'cover' ? 'cover' : 'gallery',
      })
    );

  const priceLevel = row.price_level;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    websiteUrl: row.website_url,
    host: hostOfUrl(row.website_url),
    shortDescription: typeof row.short_description === 'string' && row.short_description.trim().length > 0 ? row.short_description : null,
    audience: (AUDIENCE_VALUES as readonly unknown[]).includes(row.audience) ? (row.audience as MerchantShopManagement['audience']) : null,
    priceLevel: priceLevel === 1 || priceLevel === 2 || priceLevel === 3 || priceLevel === 4 ? priceLevel : null,
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    role,
    primaryCategory: slugOf(primary ?? null),
    secondaryCategories: categories
      .filter((link) => link?.is_primary !== true)
      .map(slugOf)
      .filter((slug): slug is string => slug !== null),
    tags: [...new Set(tags)],
    images,
    // RLS exposes only approved, unexpired verifications.
    domainVerified: (Array.isArray(row.shop_verifications) ? row.shop_verifications : []).some(
      (verification) => asRecord(verification)?.verification_type === 'domain'
    ),
  };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export type ShopEditValues = Omit<MerchantShopManagement, 'shopId'>;

export function editValuesOf(shop: ManagedShop): ShopEditValues {
  return {
    name: shop.name,
    shortDescription: shop.shortDescription,
    primaryCategory: shop.primaryCategory ?? '',
    secondaryCategories: [...shop.secondaryCategories],
    tags: [...shop.tags],
    audience: shop.audience,
    priceLevel: shop.priceLevel,
    removedImageIds: [],
  };
}

export type ShopEditErrors = Partial<Record<'name' | 'shortDescription' | 'primaryCategory' | 'secondaryCategories' | 'tags', string>>;

export const MANAGEMENT_MESSAGES = {
  nameRequired: 'Indiquez le nom de votre boutique.',
  nameTooLong: `Le nom ne doit pas dépasser ${LIMITS.name} caractères.`,
  descriptionTooLong: `La description ne doit pas dépasser ${LIMITS.shortDescription} caractères.`,
  categoryRequired: 'Choisissez une catégorie principale.',
  tooManySecondary: `Choisissez au plus ${LIMITS.secondaryCategories} catégories secondaires.`,
  tooManyTags: `Choisissez au plus ${LIMITS.tags} tags.`,
  invalid: 'Vérifiez les champs indiqués.',
  updated: 'Modifications enregistrées.',
  shop_locked: 'Cette boutique ne peut pas être modifiée pour le moment.',
  forbidden: 'Votre rôle ne permet pas de modifier cette boutique.',
  session_expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  failed: 'L’enregistrement a échoué. Réessayez dans un instant.',
} as const;

export type UpdateManagedShopParams = {
  p_shop_id: string;
  p_name: string;
  p_short_description: string | null;
  p_primary_category: string;
  p_secondary_categories: string[];
  p_tags: string[];
  p_audience: MerchantShopManagement['audience'];
  p_price_level: MerchantShopManagement['priceLevel'];
  p_removed_image_ids: string[];
};

export function validateShopEdit(
  shopId: string,
  values: ShopEditValues,
  taxonomy: MerchantTaxonomy
): { ok: true; params: UpdateManagedShopParams } | { ok: false; errors: ShopEditErrors } {
  const errors: ShopEditErrors = {};
  const categories = new Set(taxonomy.categories.map((entry) => entry.slug));
  const tagSlugs = new Set(taxonomy.tags.map((entry) => entry.slug));

  const name = values.name.replace(/\s+/g, ' ').trim();
  if (name.length === 0) errors.name = MANAGEMENT_MESSAGES.nameRequired;
  else if (name.length > LIMITS.name) errors.name = MANAGEMENT_MESSAGES.nameTooLong;

  const description = (values.shortDescription ?? '').replace(/\s+/g, ' ').trim();
  if (description.length > LIMITS.shortDescription) errors.shortDescription = MANAGEMENT_MESSAGES.descriptionTooLong;

  if (!categories.has(values.primaryCategory)) errors.primaryCategory = MANAGEMENT_MESSAGES.categoryRequired;

  const secondary = [...new Set(values.secondaryCategories)].filter((slug) => categories.has(slug) && slug !== values.primaryCategory);
  if (secondary.length > LIMITS.secondaryCategories) errors.secondaryCategories = MANAGEMENT_MESSAGES.tooManySecondary;

  const tags = [...new Set(values.tags)].filter((slug) => tagSlugs.has(slug));
  if (tags.length > LIMITS.tags) errors.tags = MANAGEMENT_MESSAGES.tooManyTags;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    params: {
      p_shop_id: shopId,
      p_name: name,
      p_short_description: description.length > 0 ? description : null,
      p_primary_category: values.primaryCategory,
      p_secondary_categories: secondary,
      p_tags: tags,
      p_audience: values.audience,
      p_price_level: values.priceLevel,
      p_removed_image_ids: [...new Set(values.removedImageIds)].filter((id) => UUID.test(id)),
    },
  };
}

export type ManageShopResult =
  | { ok: true }
  | { ok: false; reason: Exclude<ManageShopOutcome, 'updated'> | 'forbidden' | 'session_expired' | 'failed'; message: string };

export function manageShopResultOf(response: { data: unknown; error: { code?: string | null } | null }): ManageShopResult {
  if (response.error) {
    const code = response.error.code ?? '';
    const reason = code === '42501' ? 'forbidden' : code === '28000' || code.startsWith('PGRST30') ? 'session_expired' : 'failed';
    return { ok: false, reason, message: MANAGEMENT_MESSAGES[reason] };
  }
  const outcome = response.data;
  if (outcome === 'updated') return { ok: true };
  if ((MANAGE_SHOP_OUTCOMES as readonly unknown[]).includes(outcome)) {
    const reason = outcome as Exclude<ManageShopOutcome, 'updated'>;
    return { ok: false, reason, message: MANAGEMENT_MESSAGES[reason] };
  }
  return { ok: false, reason: 'failed', message: MANAGEMENT_MESSAGES.failed };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
