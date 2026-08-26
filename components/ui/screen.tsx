import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewProps, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { colors, layout } from '@/theme';

export type ScreenProps = {
  children: ReactNode;
  /**
   * When true the content scrolls. Screens are content-first and usually
   * scroll rather than compress (see docs/DESIGN_SYSTEM.md).
   */
  scroll?: boolean;
  /** Apply the standard horizontal gutter. Disable for edge-to-edge media. */
  padded?: boolean;
  /** Center content on both axes. Used for empty and error screens. */
  center?: boolean;
  /** Safe-area edges. The bottom edge is owned by the tab bar by default. */
  edges?: readonly Edge[];
  background?: string;
  contentContainerStyle?: ViewStyle;
  scrollViewProps?: Omit<ScrollViewProps, 'contentContainerStyle' | 'style'>;
};

const DEFAULT_EDGES = ['top', 'left', 'right'] as const;

/**
 * Page container: safe area, background and the standard page gutter.
 * Every route renders inside one of these.
 */
export function Screen({
  children,
  scroll = false,
  padded = true,
  center = false,
  edges = DEFAULT_EDGES,
  background = colors.background,
  contentContainerStyle,
  scrollViewProps,
}: ScreenProps) {
  const content: ViewStyle[] = [
    padded ? styles.padded : styles.flush,
    center ? styles.center : styles.stack,
    ...(contentContainerStyle ? [contentContainerStyle] : []),
  ];

  return (
    <SafeAreaView edges={edges} style={[styles.safeArea, { backgroundColor: background }]}>
      {scroll ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[styles.scrollContent, ...content]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          {...scrollViewProps}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, ...content]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: layout.scrollBottomInset,
  },
  padded: {
    paddingHorizontal: layout.screenPadding,
  },
  flush: {
    paddingHorizontal: 0,
  },
  stack: {
    paddingTop: layout.screenPaddingTop,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 0,
  },
});
