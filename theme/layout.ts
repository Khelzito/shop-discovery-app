import { StyleSheet } from 'react-native';

import { spacing } from './spacing';

/**
 * Layout tokens: page rhythm, control sizing, image ratios.
 */
export const layout = {
  /** Horizontal gutter for every screen. */
  screenPadding: spacing.lg,
  /** Vertical breathing room at the top of a screen body. */
  screenPaddingTop: spacing.md,
  /** Space between two top-level sections. */
  sectionGap: spacing.xxl,
  /** Space between a section header and its content. */
  sectionHeaderGap: spacing.md,
  /** Extra space under the last section so content clears the tab bar. */
  scrollBottomInset: spacing.huge,

  /** Separator thickness. */
  hairline: StyleSheet.hairlineWidth,
  borderWidth: 1,

  /** Minimum comfortable touch target (accessibility). */
  minTouchTarget: 44,

  /** Control heights. */
  controlHeight: {
    sm: 40,
    md: 48,
    lg: 56,
  },

  /** The search field is a signature component and stays generous. */
  searchFieldHeight: 54,

  /** Icon sizes. */
  iconSize: {
    sm: 16,
    md: 20,
    lg: 24,
    xl: 28,
  },

  /** Image aspect ratios (width / height). */
  imageRatio: {
    /** Primary shop / editorial visual. */
    portrait: 4 / 5,
    /** Horizontal editorial visual. */
    landscape: 3 / 2,
    /** Small selection tile. */
    square: 1,
  },

  /** Default hit slop for small icon-only controls. */
  hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
} as const;
