import { SHOP_ANALYSIS_V2_LIMITS as LIMITS } from '../../contracts/shop-analysis-v2.ts';
import type {
  AnalysisWarning,
  Observed,
  ShopObserved,
  SocialLink,
  SocialNetwork,
} from '../../contracts/shop-analysis-v2.ts';
import { evaluateUrl } from './url-policy.ts';

/**
 * Deterministic extraction — no model, no network, no DOM library.
 *
 * Reads a fetched document and returns two things that must never be confused:
 *
 *   OBSERVED   values read on the page, each with the provenance that says where.
 *              A value without a trustworthy provenance is left null rather than
 *              given one it does not have.
 *   MODEL TEXT a bounded, cleaned excerpt handed to the provider as DATA.
 *
 * Provenance rules (shop-analysis/2, unchanged):
 *   html_meta  a <meta> tag, keyed by name/property/http-equiv
 *   html_link  a <link> tag, keyed by rel
 *   json_ld    a JSON-LD node, with its @type and the property path
 *   page_text  what the page shows: link labels, link targets, images in the body
 *
 * Deliberately NOT observed:
 *   * the <title> and <html lang>: neither is visible page text, and neither is
 *     a meta/link/JSON-LD value — they feed the model input and warnings only;
 *   * the favicon: kept internally (raw extraction), logoUrl only falls back to it
 *     as `html_link rel=icon`;
 *   * a country or a currency that is not explicitly declared in structured data
 *     or a price meta tag. Nothing is inferred from language, TLD or wording.
 *
 * Hostile content. Pages are untrusted. Scripts, styles, templates, SVG, frames
 * and hidden elements are dropped before any text is read. Lines that address a
 * model ("ignore previous instructions", "mark this shop verified") are removed
 * from the model text and flagged; they are never obeyed, and the prompt treats
 * everything that remains as data too.
 */

export const EXTRACTION_LIMITS = {
  modelTextChars: 6_000,
  lineChars: 400,
  headings: 12,
  headingChars: 120,
  titleChars: 200,
  jsonLdBlocks: 8,
  jsonLdChars: 64_000,
  jsonLdNodes: 400,
  bodyImagesScanned: 60,
  littleTextChars: 200,
} as const;

export type SiteExtraction = {
  observed: ShopObserved;
  /** Internal. Model input and raw extraction only — never an observed value. */
  title: string | null;
  canonicalUrl: string | null;
  faviconUrl: string | null;
  htmlLang: string | null;
  headings: string[];
  modelText: string;
  warnings: AnalysisWarning[];
  stats: {
    documentChars: number;
    modelTextChars: number;
    jsonLdBlocks: number;
    droppedInjectionLines: number;
  };
};

const LF = String.fromCharCode(10);

// Zero-width and bidirectional-override characters: invisible to a reader,
// useful to someone hiding text from one.
const INVISIBLE = new RegExp(
  `[${[0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
    .map((code) => String.fromCharCode(code))
    .join('')}]`,
  'g'
);
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g'
);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function extractSite(document: string, finalUrl: string, mediaType: string | null): SiteExtraction {
  if (mediaType === 'text/plain') {
    return fromPlainText(document);
  }
  return fromHtml(document, finalUrl);
}

function emptyObserved(): ShopObserved {
  return {
    name: null,
    description: null,
    language: null,
    countryCode: null,
    currency: null,
    logoUrl: null,
    imageUrls: [],
    socialLinks: [],
    siteSectionLabels: [],
  };
}

function fromPlainText(document: string): SiteExtraction {
  const text = buildModelText(document.split(/\r\n|\r|\n/));
  const warnings: AnalysisWarning[] = ['no_structured_data'];
  if (text.dropped > 0) warnings.push('possible_prompt_injection');
  if (text.value.length < EXTRACTION_LIMITS.littleTextChars) warnings.push('little_text_js_rendered');
  return {
    observed: emptyObserved(),
    title: null,
    canonicalUrl: null,
    faviconUrl: null,
    htmlLang: null,
    headings: [],
    modelText: text.value,
    warnings,
    stats: {
      documentChars: document.length,
      modelTextChars: text.value.length,
      jsonLdBlocks: 0,
      droppedInjectionLines: text.dropped,
    },
  };
}

function fromHtml(document: string, finalUrl: string): SiteExtraction {
  const scan = scanHtml(document);
  const nodes = flattenJsonLd(scan.jsonLd);
  const organizations = nodes
    .filter((node) => typesOf(node).some((type) => ORGANIZATION_TYPE.test(type)))
    // A Brand describes a label; an Organization or Store describes the shop.
    .sort((a, b) => Number(typesOf(a).includes('Brand')) - Number(typesOf(b).includes('Brand')));
  const websites = nodes.filter((node) => typesOf(node).includes('WebSite'));

  let dropped = 0;
  const meta = (key: string) => scan.metas.get(key)?.find((value) => cleanInline(value).length > 0) ?? null;

  // --- name ---------------------------------------------------------------
  const name =
    fromMeta(meta, 'og:site_name', LIMITS.name) ??
    fromJsonLdText(organizations, 'name', LIMITS.name) ??
    fromJsonLdText(websites, 'name', LIMITS.name) ??
    fromMeta(meta, 'application-name', LIMITS.name);

  // --- description (verbatim) ----------------------------------------------
  const description =
    fromMeta(meta, 'description', LIMITS.observedDescription) ??
    fromMeta(meta, 'og:description', LIMITS.observedDescription) ??
    fromMeta(meta, 'twitter:description', LIMITS.observedDescription) ??
    fromJsonLdText(organizations, 'description', LIMITS.observedDescription) ??
    fromJsonLdText(websites, 'description', LIMITS.observedDescription);

  // --- language: declared metadata only -------------------------------------
  const language =
    languageFromMeta(meta, 'og:locale') ??
    languageFromMeta(meta, 'content-language') ??
    languageFromJsonLd(websites);

  // --- country and currency: explicit declarations only ---------------------
  const countryCode = countryFromJsonLd(organizations);
  const currency = currencyFromMeta(meta) ?? currencyFromJsonLd(nodes);

  // --- logo and icons -------------------------------------------------------
  const linkHref = (rels: readonly string[]) => {
    for (const link of scan.links) {
      if (rels.some((rel) => link.rels.includes(rel))) {
        const url = resolveHttpsUrl(link.href, finalUrl);
        if (url !== null) return url;
      }
    }
    return null;
  };
  const appleTouchIcon = linkHref(['apple-touch-icon', 'apple-touch-icon-precomposed']);
  const icon = linkHref(['icon']);
  const canonicalUrl = linkHref(['canonical']);

  let logoUrl: Observed<string> | null = null;
  for (const node of organizations) {
    const url = resolveHttpsUrl(urlOf(node.logo), finalUrl);
    if (url !== null) {
      logoUrl = { value: url, source: { kind: 'json_ld', type: primaryType(node), path: 'logo' } };
      break;
    }
  }
  if (logoUrl === null && appleTouchIcon !== null) {
    logoUrl = { value: appleTouchIcon, source: { kind: 'html_link', rel: 'apple-touch-icon' } };
  }
  if (logoUrl === null && icon !== null) {
    logoUrl = { value: icon, source: { kind: 'html_link', rel: 'icon' } };
  }

  // --- images ---------------------------------------------------------------
  const imageUrls: Observed<string>[] = [];
  const seenImages = new Set<string>(logoUrl ? [logoUrl.value] : []);
  const addImage = (url: string | null, source: Observed<string>['source']) => {
    if (url === null || seenImages.has(url) || imageUrls.length >= LIMITS.imageUrls) return;
    seenImages.add(url);
    imageUrls.push({ value: url, source });
  };
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image']) {
    for (const value of scan.metas.get(key) ?? []) {
      addImage(resolveHttpsUrl(value, finalUrl), { kind: 'html_meta', key });
    }
  }
  for (const node of [...organizations, ...websites]) {
    for (const value of asList(node.image)) {
      addImage(resolveHttpsUrl(urlOf(value), finalUrl), { kind: 'json_ld', type: primaryType(node), path: 'image' });
    }
  }
  for (const image of scan.images) {
    addImage(resolveHttpsUrl(image, finalUrl), { kind: 'page_text' });
  }

  // --- social links: one per network ----------------------------------------
  const socialLinks: Observed<SocialLink>[] = [];
  const networks = new Set<SocialNetwork>();
  const addSocial = (raw: string | null, source: Observed<SocialLink>['source']) => {
    const url = resolveHttpsUrl(raw, finalUrl);
    const network = url === null ? null : socialNetworkOf(url);
    if (url === null || network === null || networks.has(network) || socialLinks.length >= LIMITS.socialLinks) return;
    networks.add(network);
    socialLinks.push({ value: { network, url }, source });
  };
  for (const node of organizations) {
    for (const value of asList(node.sameAs)) {
      addSocial(typeof value === 'string' ? value : null, { kind: 'json_ld', type: primaryType(node), path: 'sameAs' });
    }
  }
  for (const anchor of scan.anchors) {
    addSocial(anchor.href, { kind: 'page_text' });
  }

  // --- main navigation labels -----------------------------------------------
  const siteSectionLabels: Observed<string>[] = [];
  const seenLabels = new Set<string>();
  for (const anchor of scan.anchors) {
    if (anchor.zone !== 'nav' || siteSectionLabels.length >= LIMITS.siteSectionLabels) continue;
    const label = cleanInline(anchor.text);
    const key = fold(label);
    if (
      label.length < 2 ||
      label.length > LIMITS.siteSectionLabel ||
      !/\p{L}/u.test(label) ||
      /^https?:/i.test(label) ||
      JUNK_LABELS.has(key) ||
      seenLabels.has(key) ||
      looksLikePromptInjection(label)
    ) {
      continue;
    }
    seenLabels.add(key);
    siteSectionLabels.push({ value: label, source: { kind: 'page_text' } });
  }

  // --- model-only material ----------------------------------------------------
  let title = textValue(scan.title, EXTRACTION_LIMITS.titleChars);
  if (title !== null && looksLikePromptInjection(title)) {
    title = null;
    dropped += 1;
  }

  const headings: string[] = [];
  const seenHeadings = new Set<string>();
  for (const raw of scan.headings) {
    const heading = cleanInline(raw);
    const key = fold(heading);
    if (heading.length < 2 || heading.length > EXTRACTION_LIMITS.headingChars || seenHeadings.has(key)) continue;
    if (looksLikePromptInjection(heading)) {
      dropped += 1;
      continue;
    }
    seenHeadings.add(key);
    headings.push(heading);
    if (headings.length >= EXTRACTION_LIMITS.headings) break;
  }

  const text = buildModelText(scan.lines);
  dropped += text.dropped;

  const observed: ShopObserved = {
    name,
    description,
    language,
    countryCode,
    currency,
    logoUrl,
    imageUrls,
    socialLinks,
    siteSectionLabels,
  };

  const warnings: AnalysisWarning[] = [];
  const observedInjection = [name?.value, description?.value].some(
    (value) => value !== undefined && looksLikePromptInjection(value)
  );
  if (dropped > 0 || observedInjection) warnings.push('possible_prompt_injection');
  if (scan.jsonLdBlocks === 0) warnings.push('no_structured_data');
  if (text.value.length < EXTRACTION_LIMITS.littleTextChars) warnings.push('little_text_js_rendered');
  const htmlLang = normalizeLanguage(scan.htmlLang);
  const primaryLanguage = (language?.value ?? htmlLang)?.split('-')[0];
  if (primaryLanguage !== undefined && primaryLanguage !== 'fr') warnings.push('language_not_french');

  return {
    observed,
    title,
    canonicalUrl,
    faviconUrl: icon,
    htmlLang,
    headings,
    modelText: text.value,
    warnings,
    stats: {
      documentChars: document.length,
      modelTextChars: text.value.length,
      jsonLdBlocks: scan.jsonLdBlocks,
      droppedInjectionLines: dropped,
    },
  };
}

// ---------------------------------------------------------------------------
// HTML scan
// ---------------------------------------------------------------------------

type Zone = 'nav' | 'footer' | 'body';

type Scan = {
  htmlLang: string | null;
  title: string | null;
  metas: Map<string, string[]>;
  links: { rels: string[]; href: string }[];
  anchors: { href: string; text: string; zone: Zone }[];
  images: string[];
  headings: string[];
  lines: string[];
  jsonLd: unknown[];
  jsonLdBlocks: number;
};

/** Elements whose content is never page text. Removed before scanning. */
const IGNORED_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object',
  'embed', 'canvas', 'select', 'button', 'textarea', 'video', 'audio',
] as const;

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl',
  'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

// Alternatives start with distinct characters, so matching stays linear even
// on a hostile document with an unterminated quote.
const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const JSON_LD_SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;

type Frame = {
  tag: string;
  hidden: boolean;
  nav: boolean;
  footer: boolean;
  anchor: { href: string; text: string; zone: Zone } | null;
  heading: { text: string } | null;
  title: boolean;
};

function scanHtml(source: string): Scan {
  const scan: Scan = {
    htmlLang: null,
    title: null,
    metas: new Map(),
    links: [],
    anchors: [],
    images: [],
    headings: [],
    lines: [],
    jsonLd: [],
    jsonLdBlocks: 0,
  };

  // JSON-LD is read before scripts are removed, and never executed: it is
  // parsed as JSON or ignored.
  for (const match of source.matchAll(JSON_LD_SCRIPT)) {
    if (scan.jsonLdBlocks >= EXTRACTION_LIMITS.jsonLdBlocks) break;
    const attributes = parseAttributes(match[1] ?? '');
    if ((attributes.get('type') ?? '').trim().toLowerCase() !== 'application/ld+json') continue;
    const raw = (match[2] ?? '')
      .trim()
      .replace(/^(?:\/\/\s*)?<!\[CDATA\[/, '')
      .replace(/(?:\/\/\s*)?\]\]>$/, '')
      .replace(/^<!--/, '')
      .replace(/-->$/, '')
      .trim();
    if (raw.length === 0 || raw.length > EXTRACTION_LIMITS.jsonLdChars) continue;
    try {
      scan.jsonLd.push(JSON.parse(raw));
      scan.jsonLdBlocks += 1;
    } catch {
      // Not JSON: ignored, never evaluated.
    }
  }

  let html = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    // <!doctype>, <![CDATA[ and <?xml ?> are markup, not text.
    .replace(/<![^>]*>/g, ' ')
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, ' ');
  for (const tag of IGNORED_ELEMENTS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
  }

  const stack: Frame[] = [];
  let hiddenDepth = 0;
  let navDepth = 0;
  let footerDepth = 0;
  let anchor: Frame['anchor'] = null;
  let heading: Frame['heading'] = null;
  let inTitle = false;
  let titleText = '';
  let line = '';

  const flush = () => {
    const text = line.trim();
    if (text.length > 0) scan.lines.push(text);
    line = '';
  };

  const pop = (frame: Frame) => {
    if (frame.hidden) hiddenDepth -= 1;
    if (frame.nav) navDepth -= 1;
    if (frame.footer) footerDepth -= 1;
    if (frame.anchor) {
      if (frame.anchor.href.length > 0) scan.anchors.push(frame.anchor);
      anchor = null;
    }
    if (frame.heading) {
      scan.headings.push(frame.heading.text);
      heading = null;
    }
    if (frame.title) {
      inTitle = false;
      if (scan.title === null) scan.title = titleText;
    }
    if (BLOCK_ELEMENTS.has(frame.tag)) flush();
  };

  for (const match of html.matchAll(TOKEN)) {
    const slash = match[1];
    const rawName = match[2];

    if (rawName === undefined) {
      const text = decodeEntities(match[4] ?? '<');
      if (inTitle) titleText += text;
      if (hiddenDepth > 0) continue;
      if (anchor) anchor.text += text;
      if (heading) heading.text += text;
      if (navDepth === 0 && footerDepth === 0 && !inTitle) line += text;
      continue;
    }

    const name = rawName.toLowerCase();

    if (slash === '/') {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.tag !== name) index -= 1;
      if (index < 0) {
        if (BLOCK_ELEMENTS.has(name)) flush();
        continue;
      }
      while (stack.length > index) pop(stack.pop()!);
      continue;
    }

    const rawAttributes = match[3] ?? '';
    const attributes = parseAttributes(rawAttributes);
    if (BLOCK_ELEMENTS.has(name)) flush();

    switch (name) {
      case 'html':
        scan.htmlLang ??= attributes.get('lang') ?? null;
        break;
      case 'meta': {
        const key = (attributes.get('property') ?? attributes.get('name') ?? attributes.get('http-equiv') ?? attributes.get('itemprop') ?? '')
          .trim()
          .toLowerCase();
        const content = attributes.get('content');
        if (key.length > 0 && key.length <= LIMITS.provenanceToken && content !== undefined) {
          const values = scan.metas.get(key) ?? [];
          if (values.length < 8) values.push(content);
          scan.metas.set(key, values);
        }
        break;
      }
      case 'link': {
        const href = attributes.get('href');
        const rels = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/).filter((rel) => rel.length > 0);
        if (href !== undefined && rels.length > 0 && scan.links.length < 64) {
          scan.links.push({ rels, href });
        }
        break;
      }
      case 'img':
        if (
          hiddenDepth === 0 &&
          navDepth === 0 &&
          footerDepth === 0 &&
          !isHidden(attributes) &&
          scan.images.length < EXTRACTION_LIMITS.bodyImagesScanned
        ) {
          const src = imageSource(attributes);
          if (src !== null) scan.images.push(src);
        }
        break;
    }

    if (VOID_ELEMENTS.has(name) || /\/\s*$/.test(rawAttributes)) {
      continue;
    }

    const hidden = isHidden(attributes);
    const frame: Frame = {
      tag: name,
      hidden,
      nav: name === 'nav' || name === 'header' || (attributes.get('role') ?? '').toLowerCase() === 'navigation',
      footer: name === 'footer',
      anchor: null,
      heading: null,
      title: false,
    };
    if (hidden) hiddenDepth += 1;
    if (frame.nav) navDepth += 1;
    if (frame.footer) footerDepth += 1;

    if (name === 'a' && hiddenDepth === 0) {
      frame.anchor = {
        href: attributes.get('href') ?? '',
        text: '',
        zone: navDepth > 0 ? 'nav' : footerDepth > 0 ? 'footer' : 'body',
      };
      anchor = frame.anchor;
    }
    if (/^h[1-3]$/.test(name) && hiddenDepth === 0 && navDepth === 0 && footerDepth === 0) {
      frame.heading = { text: '' };
      heading = frame.heading;
    }
    if (name === 'title' && scan.title === null) {
      frame.title = true;
      inTitle = true;
      titleText = '';
    }
    stack.push(frame);
  }

  while (stack.length > 0) pop(stack.pop()!);
  flush();
  return scan;
}

function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function isHidden(attributes: Map<string, string>): boolean {
  return (
    attributes.has('hidden') ||
    (attributes.get('aria-hidden') ?? '').trim().toLowerCase() === 'true' ||
    (attributes.get('type') ?? '').trim().toLowerCase() === 'hidden' ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.get('style') ?? '')
  );
}

function imageSource(attributes: Map<string, string>): string | null {
  const candidates = [
    attributes.get('src'),
    attributes.get('data-src'),
    attributes.get('data-lazy-src'),
    (attributes.get('srcset') ?? '').split(',')[0]?.trim().split(/\s+/)[0],
  ];
  const src = candidates.find((value) => value !== undefined && value.length > 0 && !/^data:/i.test(value.trim()));
  if (src === undefined) return null;
  for (const dimension of ['width', 'height']) {
    const value = Number.parseInt(attributes.get(dimension) ?? '', 10);
    if (Number.isFinite(value) && value < 64) return null;
  }
  if (/(?:pixel|spacer|blank|1x1|tracking|placeholder|loader|spinner)/i.test(src)) return null;
  return src;
}

// ---------------------------------------------------------------------------
// Observed builders
// ---------------------------------------------------------------------------

type MetaReader = (key: string) => string | null;

function fromMeta(meta: MetaReader, key: string, max: number): Observed<string> | null {
  const value = textValue(meta(key), max);
  return value === null ? null : { value, source: { kind: 'html_meta', key } };
}

function fromJsonLdText(nodes: readonly JsonNode[], key: string, max: number): Observed<string> | null {
  for (const node of nodes) {
    const value = textValue(firstString(node[key]), max);
    if (value !== null) {
      return { value, source: { kind: 'json_ld', type: primaryType(node), path: key } };
    }
  }
  return null;
}

function languageFromMeta(meta: MetaReader, key: string): Observed<string> | null {
  const value = normalizeLanguage(meta(key));
  return value === null ? null : { value, source: { kind: 'html_meta', key } };
}

function languageFromJsonLd(nodes: readonly JsonNode[]): Observed<string> | null {
  for (const node of nodes) {
    const value = normalizeLanguage(firstString(node.inLanguage));
    if (value !== null) {
      return { value, source: { kind: 'json_ld', type: primaryType(node), path: 'inLanguage' } };
    }
  }
  return null;
}

/** `fr_FR`, `fr-fr`, `FR` → `fr-FR`, `fr-fr`, `fr`. Null for anything else. */
function normalizeLanguage(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.split(',')[0]!.trim().replace(/_/g, '-');
  const match = /^([a-zA-Z]{2,3})((?:-[A-Za-z0-9]{2,8})*)$/.exec(first);
  if (!match) return null;
  const value = `${match[1]!.toLowerCase()}${match[2] ?? ''}`;
  return value.length <= LIMITS.language ? value : null;
}

const COUNTRY_NAMES: Record<string, string> = {
  france: 'FR', belgique: 'BE', belgium: 'BE', suisse: 'CH', switzerland: 'CH',
  luxembourg: 'LU', canada: 'CA', allemagne: 'DE', germany: 'DE', espagne: 'ES',
  spain: 'ES', italie: 'IT', italy: 'IT', portugal: 'PT', 'pays-bas': 'NL',
  netherlands: 'NL', 'royaume-uni': 'GB', 'united kingdom': 'GB',
  'etats-unis': 'US', 'united states': 'US',
};

/** A declared address country: an ISO code, or a country NAME written as such. */
function countryFromJsonLd(nodes: readonly JsonNode[]): Observed<string> | null {
  for (const node of nodes) {
    for (const address of asList(node.address)) {
      if (!isRecord(address)) continue;
      const raw = address.addressCountry;
      const text = typeof raw === 'string' ? raw : isRecord(raw) ? firstString(raw.identifier) ?? firstString(raw.name) : null;
      if (text === null) continue;
      const trimmed = text.trim();
      const code = /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : COUNTRY_NAMES[fold(trimmed)] ?? null;
      if (code !== null) {
        return { value: code, source: { kind: 'json_ld', type: primaryType(node), path: 'address.addressCountry' } };
      }
    }
  }
  return null;
}

function currencyFromMeta(meta: MetaReader): Observed<string> | null {
  for (const key of ['product:price:currency', 'og:price:currency']) {
    const value = (meta(key) ?? '').trim();
    if (/^[A-Za-z]{3}$/.test(value)) {
      return { value: value.toUpperCase(), source: { kind: 'html_meta', key } };
    }
  }
  return null;
}

function currencyFromJsonLd(nodes: readonly JsonNode[]): Observed<string> | null {
  for (const node of nodes) {
    const direct = firstString(node.priceCurrency);
    if (direct !== null && /^[A-Za-z]{3}$/.test(direct.trim())) {
      return { value: direct.trim().toUpperCase(), source: { kind: 'json_ld', type: primaryType(node), path: 'priceCurrency' } };
    }
    for (const offer of asList(node.offers)) {
      const nested = isRecord(offer) ? firstString(offer.priceCurrency) : null;
      if (nested !== null && /^[A-Za-z]{3}$/.test(nested.trim())) {
        return { value: nested.trim().toUpperCase(), source: { kind: 'json_ld', type: primaryType(node), path: 'offers.priceCurrency' } };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type JsonNode = Record<string, unknown>;

const ORGANIZATION_TYPE = /^(?:Organization|Corporation|Brand|OnlineBusiness|LocalBusiness|[A-Za-z]*Store)$/;

function flattenJsonLd(roots: readonly unknown[]): JsonNode[] {
  const nodes: JsonNode[] = [];
  const queue: unknown[] = [...roots];
  let visited = 0;
  while (queue.length > 0 && visited < EXTRACTION_LIMITS.jsonLdNodes) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    nodes.push(value);
    if (Array.isArray(value['@graph'])) queue.push(...value['@graph']);
  }
  return nodes;
}

function typesOf(node: JsonNode): string[] {
  return asList(node['@type'])
    .filter((type): type is string => typeof type === 'string')
    .map((type) => type.replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, ''))
    .filter((type) => /^[A-Za-z]{1,64}$/.test(type));
}

function primaryType(node: JsonNode): string {
  const types = typesOf(node);
  return types.find((type) => ORGANIZATION_TYPE.test(type) || type === 'WebSite') ?? types[0] ?? 'Thing';
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstString(value: unknown): string | null {
  for (const item of asList(value)) {
    if (typeof item === 'string') return item;
  }
  return null;
}

function urlOf(value: unknown): string | null {
  for (const item of asList(value)) {
    if (typeof item === 'string') return item;
    if (isRecord(item)) {
      const nested = firstString(item.url) ?? firstString(item.contentUrl);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function isRecord(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// URLs and social networks
// ---------------------------------------------------------------------------

/** Absolute, https, and accepted by the url policy — or null. */
function resolveHttpsUrl(raw: string | null | undefined, base: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > LIMITS.url || /^(?:data|javascript|blob|mailto|tel|about):/i.test(trimmed)) {
    return null;
  }
  let absolute: string;
  try {
    absolute = new URL(trimmed, base).href;
  } catch {
    return null;
  }
  const policy = evaluateUrl(absolute);
  return policy.ok && policy.scheme === 'https' ? policy.url : null;
}

const SOCIAL_HOSTS: readonly (readonly [SocialNetwork, RegExp])[] = [
  ['instagram', /^(?:www\.)?instagram\.com$/],
  ['tiktok', /^(?:www\.)?tiktok\.com$/],
  ['facebook', /^(?:(?:www|m|fr-fr)\.)?facebook\.com$|^(?:www\.)?fb\.com$/],
  ['pinterest', /^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com|fr|de|es|it|ca|co\.uk)$/],
  ['youtube', /^(?:(?:www|m)\.)?youtube\.com$/],
  ['x', /^(?:www\.)?(?:x|twitter)\.com$/],
  ['linkedin', /^(?:(?:www|[a-z]{2,3})\.)?linkedin\.com$/],
];

/** Share buttons, posts and search pages are not the shop's profile. */
const NOT_A_PROFILE = /^\/(?:sharer|share|intent|home|pin\/create|shareArticle|sharing|dialog|plugins|embed|watch|p\/|reel\/|explore|hashtag|search|login|signup)(?:[/.?]|$)/i;

function socialNetworkOf(url: string): SocialNetwork | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname.length <= 1 || NOT_A_PROFILE.test(parsed.pathname)) return null;
  for (const [network, host] of SOCIAL_HOSTS) {
    if (host.test(parsed.hostname)) return network;
  }
  return null;
}

const JUNK_LABELS = new Set([
  'menu', 'fermer', 'close', 'rechercher', 'recherche', 'search', 'panier', 'mon panier',
  'cart', 'basket', 'bag', 'compte', 'mon compte', 'account', 'my account', 'connexion',
  'se connecter', 'login', 'log in', 'sign in', 'inscription', 'sign up', 'wishlist',
  'favoris', 'skip to content', 'aller au contenu', 'passer au contenu', 'accueil', 'home',
  'francais', 'english', 'fr', 'en', 'eur', 'usd',
]);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function buildModelText(lines: readonly string[]): { value: string; dropped: number } {
  const kept: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let dropped = 0;

  for (const raw of lines) {
    let line = cleanInline(decodeEntities(raw))
      // "sale sale sale sale" → "sale"
      .replace(/(^|\s)(\S+)(?:\s+\2){2,}(?=\s|$)/g, '$1$2');
    if (line.length < 3 || !/\p{L}/u.test(line)) continue;
    if (line.length > EXTRACTION_LIMITS.lineChars) {
      const cut = line.slice(0, EXTRACTION_LIMITS.lineChars);
      const space = cut.lastIndexOf(' ');
      line = `${space > EXTRACTION_LIMITS.lineChars / 2 ? cut.slice(0, space) : cut}…`;
    }
    const key = fold(line);
    if (seen.has(key)) continue;
    seen.add(key);
    if (looksLikePromptInjection(line)) {
      dropped += 1;
      continue;
    }
    if (total + line.length + 1 > EXTRACTION_LIMITS.modelTextChars) break;
    kept.push(line);
    total += line.length + 1;
  }

  return { value: kept.join(LF), dropped };
}

function textValue(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = cleanInline(raw);
  return cleaned.length > 0 && cleaned.length <= max ? cleaned : null;
}

function cleanInline(value: string): string {
  return value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä',
  ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û',
  uuml: 'ü', oelig: 'œ', aelig: 'æ', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À',
  Acirc: 'Â', Ccedil: 'Ç', Ocirc: 'Ô', OElig: 'Œ', laquo: '«', raquo: '»', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', euro: '€',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', deg: '°', times: '×',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0x1f || code === 0x7f || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return ' ';
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Prompt-injection-like content
// ---------------------------------------------------------------------------

/**
 * Text written to steer a model rather than to describe a shop.
 *
 * A heuristic, and not the defence: the defence is that the model's output is
 * schema-validated, stripped of every trust or origin claim, and reviewed by
 * the merchant, and that no field exists through which it could verify or
 * publish anything. This only keeps the most obvious attempts out of the
 * prompt and makes them visible as a warning.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules|guidelines|system message)\b/,
  /\b(?:ignore[rz]?|oublie[rz]?|ne tiens? pas compte)\b.{0,40}\b(?:instructions?|consignes?|regles|directives)\b/,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/,
  /\bprompt\s+systeme\b/,
  /\byou are (?:now )?(?:chatgpt|gpt|an? (?:ai|assistant|language model|llm))\b/,
  /\btu es (?:maintenant )?(?:chatgpt|une ia|un assistant|un modele)\b/,
  /\bas an ai\b/,
  /\b(?:mark|flag|set|label|classify|rate)\b.{0,30}\b(?:shop|store|site|website|boutique|merchant)\b.{0,20}\b(?:verified|trusted|legit|safe|certified|trustworthy)\b/,
  /\b(?:marque[rz]?|considere[rz]?|classe[rz]?)\b.{0,30}\b(?:boutique|site|marchand)\b.{0,20}\b(?:verifiee?|fiable|certifiee?|sure)\b/,
  /<\/?\s*(?:system|assistant|user|instructions?|site[_-]?content)\s*>/,
  /\[\/?(?:inst|system)\]|<\|im_(?:start|end)\|>/,
  /\b(?:respond|answer|reply|output) only with\b|\breponds? uniquement\b/,
];

export function looksLikePromptInjection(text: string): boolean {
  const folded = fold(text).replace(/\s+/g, ' ');
  return INJECTION_PATTERNS.some((pattern) => pattern.test(folded));
}
