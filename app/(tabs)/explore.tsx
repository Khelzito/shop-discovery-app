import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  EmptyState,
  Icon,
  ImageFrame,
  Screen,
  SearchField,
  Section,
  ShopCardSkeleton,
  Skeleton,
  Text,
  VerifiedMark,
} from '@/components/ui';
import { colors, layout, radii, spacing, typography, type TypographyVariant } from '@/theme';

/**
 * TEMPORARY — design-system preview.
 *
 * Explore is used as a live catalogue of the Phase 01 primitives so the
 * visual system can be reviewed on a real device. This screen is replaced by
 * the real Explore experience (browse + search) in a later phase.
 */
export default function ExploreScreen() {
  const [query, setQuery] = useState('');

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="title">Design system</Text>
        <Text variant="meta" tone="secondary">
          Aperçu temporaire des composants de la Phase 01.
        </Text>
      </View>

      <View style={styles.sections}>
        <Section title="Recherche" subtitle="Composant signature, volontairement discret.">
          <SearchField value={query} onChangeText={setQuery} />
        </Section>

        <Section title="Typographie">
          <View style={styles.stack}>
            {TYPE_SAMPLES.map(({ variant, sample }) => (
              <View key={variant} style={styles.typeRow}>
                <Text variant={variant}>{sample}</Text>
                <Text variant="caption" tone="tertiary">
                  {variant} · {typography[variant].fontSize}/{typography[variant].lineHeight} ·{' '}
                  {typography[variant].fontWeight}
                </Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Couleurs" subtitle="Neutres d’abord. Aucune couleur d’accent en V1.">
          <View style={styles.swatches}>
            {SWATCHES.map(({ label, value, bordered }) => (
              <View key={label} style={styles.swatch}>
                <View
                  style={[
                    styles.swatchChip,
                    { backgroundColor: value },
                    bordered && styles.swatchChipBordered,
                  ]}
                />
                <Text variant="caption" tone="secondary">
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Boutons" subtitle="Une seule action dominante par section.">
          <View style={styles.stack}>
            <Button label="Visiter" iconRight="external" fullWidth />
            <Button label="Secondaire" variant="secondary" fullWidth />
            <View style={styles.inlineRow}>
              <Button label="Voir tout" variant="text" />
              <Button label="Chargement" loading />
              <Button label="Désactivé" disabled size="sm" />
            </View>
          </View>
        </Section>

        <Section title="Images" subtitle="Repli typographique quand aucun visuel n’existe.">
          <View style={styles.inlineRow}>
            <ImageFrame name="Maison Léon" ratio="portrait" width={120} />
            <ImageFrame name="Atelier Nord" ratio="square" width={96} />
            <ImageFrame name="Brume" ratio="square" width={64} />
          </View>
          <ImageFrame
            name="Studio Cassis"
            ratio="landscape"
            source="https://example.invalid/missing.jpg"
          />
          <Text variant="caption" tone="tertiary">
            Le visuel ci-dessus utilise une URL invalide : le repli s’affiche automatiquement.
          </Text>
        </Section>

        <Section title="Identité de boutique">
          <View style={styles.shopRow}>
            <ImageFrame name="Maison Léon" ratio="square" width={56} radius="md" />
            <View style={styles.shopMeta}>
              <View style={styles.shopNameRow}>
                <Text variant="shopName">Maison Léon</Text>
                <VerifiedMark />
              </View>
              <Text variant="meta" tone="secondary">
                Streetwear · France
              </Text>
            </View>
            <Icon name="favorite" size="lg" color={colors.iconMuted} />
          </View>
          <VerifiedMark variant="badge" />
        </Section>

        <Section title="Chargement">
          <View style={styles.inlineRow}>
            <ShopCardSkeleton width={140} />
            <ShopCardSkeleton width={140} />
          </View>
          <View style={styles.stack}>
            <Skeleton width="60%" height={20} />
            <Skeleton width="35%" height={12} />
          </View>
        </Section>

        <Section title="États vides">
          <View style={styles.card}>
            <EmptyState
              icon="search"
              title="Aucun résultat"
              description="Essaie un terme plus large, ou explore les boutiques populaires du moment."
              actionLabel="Voir les boutiques populaires"
              onActionPress={() => setQuery('')}
            />
          </View>
          <View style={styles.card}>
            <EmptyState
              tone="error"
              title="Chargement impossible"
              description="Vérifie ta connexion et réessaie."
              actionLabel="Réessayer"
              onActionPress={() => setQuery('')}
            />
          </View>
        </Section>
      </View>
    </Screen>
  );
}

const TYPE_SAMPLES: { variant: TypographyVariant; sample: string }[] = [
  { variant: 'title', sample: 'Titre d’écran' },
  { variant: 'sectionTitle', sample: 'Pépites cachées' },
  { variant: 'shopName', sample: 'Maison Léon' },
  { variant: 'body', sample: 'Texte courant, calme et lisible.' },
  { variant: 'bodyStrong', sample: 'Texte courant accentué.' },
  { variant: 'label', sample: 'Libellé de contrôle' },
  { variant: 'meta', sample: 'Streetwear · France' },
  { variant: 'caption', sample: 'Information secondaire' },
];

const SWATCHES: { label: string; value: string; bordered?: boolean }[] = [
  { label: 'background', value: colors.background, bordered: true },
  { label: 'surface', value: colors.surface, bordered: true },
  { label: 'surfaceSecondary', value: colors.surfaceSecondary, bordered: true },
  { label: 'border', value: colors.border },
  { label: 'textPrimary', value: colors.textPrimary },
  { label: 'textSecondary', value: colors.textSecondary },
  { label: 'textTertiary', value: colors.textTertiary },
  { label: 'danger', value: colors.danger },
];

const styles = StyleSheet.create({
  header: {
    gap: spacing.xxs,
    marginBottom: spacing.lg,
  },
  sections: {
    gap: layout.sectionGap,
  },
  stack: {
    gap: spacing.sm,
  },
  typeRow: {
    gap: spacing.xxs,
  },
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  swatch: {
    alignItems: 'center',
    gap: spacing.xxs,
    width: 72,
  },
  swatchChip: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
  },
  swatchChipBordered: {
    borderWidth: layout.borderWidth,
    borderColor: colors.border,
  },
  shopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  shopMeta: {
    flex: 1,
    gap: spacing.xxs,
  },
  shopNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: layout.hairline,
    borderColor: colors.border,
  },
});
