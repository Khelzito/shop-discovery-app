/**
 * Single entry point for design tokens.
 *
 * Components must import tokens from `@/theme` and never hard-code a color,
 * font size, spacing value or radius (see docs/MASTER_SPEC.md §16).
 */
import { colors } from './colors';
import { layout } from './layout';
import { radii } from './radii';
import { spacing } from './spacing';
import { typography } from './typography';

export { colors, type ColorToken } from './colors';
export { layout } from './layout';
export { radii, type RadiusToken } from './radii';
export { spacing, type SpacingToken } from './spacing';
export { fontWeights, typography, type TypographyVariant } from './typography';

export const theme = {
  colors,
  typography,
  spacing,
  radii,
  layout,
} as const;

export type Theme = typeof theme;
