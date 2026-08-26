import { Platform, type TextStyle } from 'react-native';

/**
 * Typography tokens.
 *
 * V1 uses the platform system font (San Francisco on iOS, Roboto on Android).
 * A custom family such as Inter can be introduced later by changing
 * `fontFamily` here only — components never declare a family themselves.
 */
const fontFamily = Platform.select<TextStyle['fontFamily']>({
  // Leaving this undefined uses the native system font, which is what we want.
  ios: undefined,
  android: undefined,
  default:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
});

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
} as const satisfies Record<string, TextStyle['fontWeight']>;

/**
 * The complete text scale. A component may only pick a variant from this list.
 */
export const typography = {
  /** Screen title. */
  title: {
    fontFamily,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.6,
  },
  /** Section heading such as "Pépites cachées". */
  sectionTitle: {
    fontFamily,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.3,
  },
  /** Shop name on a card or a profile. */
  shopName: {
    fontFamily,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.2,
  },
  /** Default reading text. */
  body: {
    fontFamily,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: fontWeights.regular,
  },
  /** Emphasised body, used sparingly. */
  bodyStrong: {
    fontFamily,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: fontWeights.medium,
  },
  /** Secondary line such as "Streetwear · France". */
  meta: {
    fontFamily,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: fontWeights.regular,
  },
  /** Control and text-action label. */
  label: {
    fontFamily,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: fontWeights.medium,
  },
  /** Primary button label. */
  button: {
    fontFamily,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.1,
  },
  /** Smallest supported size. Never for essential meaning. */
  caption: {
    fontFamily,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: fontWeights.regular,
  },
} as const satisfies Record<string, TextStyle>;

export type TypographyVariant = keyof typeof typography;
