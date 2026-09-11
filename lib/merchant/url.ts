/**
 * The shop address a merchant types, checked before any network call.
 *
 * A first filter that gives a clear message, not the security boundary: the
 * server runs its full URL policy, DNS and address checks again on whatever is
 * sent. No `URL` global here — React Native's implementation is incomplete —
 * so the check is a strict pattern instead.
 */

export const MAX_SHOP_URL_LENGTH = 2048;

export const SHOP_URL_MESSAGES = {
  required: 'Ajoutez l’adresse de votre boutique.',
  httpsOnly: 'Seules les adresses https:// sont acceptées.',
  invalid: 'Cette adresse ne semble pas valide. Exemple : https://maboutique.com',
  tooLong: 'Cette adresse est trop longue.',
} as const;

export type ShopUrlCheck =
  | { ok: true; url: string; hostname: string }
  | { ok: false; error: string };

// Letters from any script are accepted: the server converts them to punycode.
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const NOT_PUBLIC = /(^|\.)(localhost|local|internal|lan|test|invalid|example)$/;

export function checkShopUrl(input: string): ShopUrlCheck {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: SHOP_URL_MESSAGES.required };
  }
  if (trimmed.length > MAX_SHOP_URL_LENGTH) {
    return { ok: false, error: SHOP_URL_MESSAGES.tooLong };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: SHOP_URL_MESSAGES.invalid };
  }

  let rest: string;
  if (/^https:\/\//i.test(trimmed)) {
    rest = trimmed.slice('https://'.length);
  } else if (/^http:\/\//i.test(trimmed)) {
    return { ok: false, error: SHOP_URL_MESSAGES.httpsOnly };
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^:/?#]+\.[^:/?#]+(?:[/?#]|$)/.test(trimmed)) {
    // javascript:, ftp://, mailto: … — anything that is a scheme, not a host.
    return { ok: false, error: SHOP_URL_MESSAGES.invalid };
  } else {
    // "maboutique.com" means https://maboutique.com.
    rest = trimmed;
  }

  const parts = /^([^/?#]+)([/?#].*)?$/.exec(rest);
  if (!parts) {
    return { ok: false, error: SHOP_URL_MESSAGES.invalid };
  }
  const authority = parts[1]!;
  // Credentials, ports and IP literals are never a shop's public address.
  if (authority.includes('@') || authority.includes(':') || authority.startsWith('[')) {
    return { ok: false, error: SHOP_URL_MESSAGES.invalid };
  }

  let hostname = authority.toLowerCase();
  if (hostname.endsWith('.')) {
    hostname = hostname.slice(0, -1);
  }
  const labels = hostname.split('.');
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !LABEL.test(label)) ||
    /^[0-9]+$/.test(labels[labels.length - 1]!) ||
    NOT_PUBLIC.test(hostname)
  ) {
    return { ok: false, error: SHOP_URL_MESSAGES.invalid };
  }

  const tail = (parts[2] ?? '').split('#')[0]!;
  const path = tail.length === 0 ? '/' : tail.startsWith('/') ? tail : `/${tail}`;

  return { ok: true, url: `https://${hostname}${path}`, hostname };
}

/** Lowercased host of an http(s) URL, without a trailing dot; null otherwise. */
export function hostOfUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^https?:\/\/([^/?#:@]+)(?::[0-9]+)?(?:[/?#]|$)/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const host = match[1]!.toLowerCase();
  return host.endsWith('.') ? host.slice(0, -1) : host;
}
