import { Image, type ImageSource } from 'expo-image';
import { useState, type ReactNode } from 'react';
import {
  StyleSheet,
  Text as RNText,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, fontWeights, layout, radii } from '@/theme';

export type ImageFrameRatio = keyof typeof layout.imageRatio;

export type ImageFrameProps = {
  /** Remote URL or local asset. When absent or broken, the fallback renders. */
  source?: ImageSource | string | null;
  /** Shop or brand name. Drives the typographic fallback and the a11y label. */
  name: string;
  ratio?: ImageFrameRatio | number;
  radius?: keyof typeof radii;
  /** Fixed width. Omit to stretch to the parent. */
  width?: number;
  style?: StyleProp<ViewStyle>;
  /** Rendered above the image, e.g. a favorite control. */
  children?: ReactNode;
};

/**
 * Shop imagery container with three states (docs/MASTER_SPEC.md §12):
 * merchant visual, loading fade-in, and — when no usable visual exists —
 * an elegant typographic placeholder built from the shop's own name.
 *
 * We never fabricate merchant imagery.
 */
export function ImageFrame({
  source,
  name,
  ratio = 'portrait',
  radius = 'image',
  width,
  style,
  children,
}: ImageFrameProps) {
  const [failed, setFailed] = useState(false);
  const [frameWidth, setFrameWidth] = useState(0);

  const aspectRatio = typeof ratio === 'number' ? ratio : layout.imageRatio[ratio];
  const hasSource = source != null && source !== '' && !failed;

  const onLayout = (event: LayoutChangeEvent) => {
    setFrameWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.frame,
        { aspectRatio, borderRadius: radii[radius] },
        width != null ? { width } : styles.stretch,
        style,
      ]}>
      {hasSource ? (
        <Image
          source={typeof source === 'string' ? { uri: source } : source}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={220}
          accessible
          accessibilityLabel={name}
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
        />
      ) : (
        <InitialsFallback name={name} frameWidth={frameWidth} />
      )}
      {children}
    </View>
  );
}

function InitialsFallback({ name, frameWidth }: { name: string; frameWidth: number }) {
  const initials = getInitials(name);
  // Scales with the frame so a 96px tile and a full-width cover both read well.
  const fontSize = clamp(frameWidth * 0.24, 18, 64);

  return (
    <View accessible accessibilityLabel={name} style={styles.fallback}>
      <RNText
        style={[
          styles.initials,
          {
            fontSize,
            lineHeight: fontSize * 1.1,
            letterSpacing: fontSize * 0.06,
            // Letter-spacing is also applied after the last glyph; pull it
            // back so the initials stay optically centred.
            marginRight: -fontSize * 0.06,
          },
        ]}
        numberOfLines={1}
        allowFontScaling={false}>
        {initials}
      </RNText>
    </View>
  );
}

/** First letters of up to two words, e.g. "Maison Léon" -> "ML". */
export function getInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_·]+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '—';
  }

  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase('fr-FR');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    backgroundColor: colors.surfaceSecondary,
  },
  stretch: {
    alignSelf: 'stretch',
  },
  fallback: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
    borderWidth: layout.hairline,
    borderColor: colors.border,
  },
  initials: {
    color: colors.textSecondary,
    fontWeight: fontWeights.medium,
    textAlign: 'center',
  },
});
