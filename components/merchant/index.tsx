import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  Button,
  Chip,
  EmptyState,
  Icon,
  IconButton,
  Screen,
  Text,
  type IconName,
} from '@/components/ui';
import { MERCHANT_WELCOME_PATH } from '@/lib/merchant/routes';
import { useAuth } from '@/state/auth';
import { colors, layout, radii, spacing, typography } from '@/theme';

/**
 * Small building blocks of the merchant flow, composed only from the existing
 * UI primitives and tokens. Nothing here is a new design language: they exist
 * so five screens do not repeat the same layout code.
 */

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

/**
 * Signed out mid-flow (session expired, signed out elsewhere): a calm way back
 * in, never an automatic redirect that could loop.
 */
export function MerchantAuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <Screen center>
        <ActivityIndicator color={colors.textSecondary} />
      </Screen>
    );
  }

  if (status === 'signedOut') {
    return (
      <Screen center>
        <EmptyState
          icon="profile"
          title="Connectez-vous pour continuer"
          description="Votre boutique est rattachée à votre compte."
          actionLabel="Se connecter"
          onActionPress={() =>
            router.push({ pathname: '/sign-in', params: { redirect: MERCHANT_WELCOME_PATH } })
          }
        />
      </Screen>
    );
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Back
// ---------------------------------------------------------------------------

export function BackButton() {
  return (
    <IconButton
      icon="back"
      variant="bare"
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/profile'))}
      accessibilityLabel="Retour"
      style={styles.back}
    />
  );
}

// ---------------------------------------------------------------------------
// Numbered steps
// ---------------------------------------------------------------------------

export function NumberedSteps({ steps }: { steps: readonly string[] }) {
  return (
    <View style={styles.steps}>
      {steps.map((step, index) => (
        <View key={step} style={styles.step}>
          <View style={styles.stepNumber}>
            <Text variant="label">{index + 1}</Text>
          </View>
          <Text variant="body" style={styles.stepText}>
            {step}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export function Notice({
  children,
  icon = 'info',
  tone = 'neutral',
}: {
  children: string;
  icon?: IconName;
  tone?: 'neutral' | 'danger';
}) {
  const danger = tone === 'danger';
  return (
    <View
      accessibilityRole={danger ? 'alert' : 'text'}
      style={[styles.notice, danger ? styles.noticeDanger : styles.noticeNeutral]}>
      <Icon name={icon} size="sm" color={danger ? colors.danger : colors.iconMuted} />
      <Text variant="meta" tone={danger ? 'danger' : 'secondary'} style={styles.noticeText}>
        {children}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Analysis progress
// ---------------------------------------------------------------------------

const ANALYSIS_STEPS = ['Lecture du site', 'Compréhension de la marque', 'Préparation de la fiche'] as const;
const ANALYSIS_STEP_MS = 1800;

/**
 * What the analysis is doing, in words. No percentage: the server does not
 * report progress, and a fake bar would promise a timing nobody can keep.
 * The last step stays active until the answer arrives.
 */
export function AnalysisProgress() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActive((index) => Math.min(index + 1, ANALYSIS_STEPS.length - 1));
    }, ANALYSIS_STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.progress} accessibilityLiveRegion="polite">
      <Text variant="sectionTitle">Analyse de votre boutique…</Text>
      <Text variant="body" tone="secondary">
        Cela peut prendre quelques secondes.
      </Text>
      <View style={styles.progressSteps}>
        {ANALYSIS_STEPS.map((step, index) => (
          <View key={step} style={styles.progressStep}>
            <View style={styles.progressMarker}>
              {index < active ? (
                <Icon name="check" size="sm" color={colors.icon} />
              ) : index === active ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <View style={styles.progressDot} />
              )}
            </View>
            <Text variant="body" tone={index <= active ? 'primary' : 'tertiary'}>
              {step}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Form blocks
// ---------------------------------------------------------------------------

export function FieldBlock({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | null;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <View style={styles.fieldBlock}>
      <Text variant="meta" tone="secondary">
        {label}
      </Text>
      {children}
      {error ? (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export type ChoiceOption<T extends string> = { value: T; label: string };

/** Selection from a fixed vocabulary. Unselected options fade once the limit is reached. */
export function ChoiceChips<T extends string>({
  options,
  selected,
  onToggle,
  max,
}: {
  options: readonly ChoiceOption<T>[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  max?: number;
}) {
  const full = max !== undefined && selected.length >= max;
  return (
    <View style={styles.wrap}>
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        const blocked = full && !isSelected;
        return (
          <Chip
            key={option.value}
            label={option.label}
            selected={isSelected}
            onPress={() => {
              if (!blocked) {
                onToggle(option.value);
              }
            }}
            style={blocked ? styles.blocked : undefined}
          />
        );
      })}
    </View>
  );
}

/** Free-text items the merchant can remove, or add up to a limit. */
export function EditableList({
  label,
  items,
  onChange,
  placeholder,
  maxItems,
  maxLength,
  hint,
  error,
}: {
  label: string;
  items: readonly string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  maxItems: number;
  maxLength: number;
  hint?: string | null;
  error?: string | null;
}) {
  const [input, setInput] = useState('');

  const add = () => {
    const value = input.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    if (value.length === 0 || items.length >= maxItems) {
      return;
    }
    const exists = items.some(
      (item) => item.toLocaleLowerCase('fr-FR') === value.toLocaleLowerCase('fr-FR')
    );
    if (!exists) {
      onChange([...items, value]);
    }
    setInput('');
  };

  return (
    <FieldBlock label={label} hint={hint} error={error}>
      {items.length > 0 ? (
        <View style={styles.wrap}>
          {items.map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityLabel={`Retirer ${item}`}
              onPress={() => onChange(items.filter((existing) => existing !== item))}
              style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}>
              <Text variant="label" numberOfLines={1} style={styles.pillText}>
                {item}
              </Text>
              <Icon name="close" size={14} color={colors.iconMuted} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {items.length < maxItems ? (
        <View style={styles.addRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={placeholder}
            placeholderTextColor={colors.textTertiary}
            accessibilityLabel={placeholder}
            maxLength={maxLength}
            returnKeyType="done"
            submitBehavior="submit"
            onSubmitEditing={add}
            style={styles.addInput}
          />
          <Button variant="text" label="Ajouter" onPress={add} disabled={input.trim().length === 0} />
        </View>
      ) : null}
    </FieldBlock>
  );
}

const styles = StyleSheet.create({
  back: {
    marginBottom: spacing.lg,
  },
  steps: {
    gap: spacing.md,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
  },
  stepText: {
    flex: 1,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
  },
  noticeNeutral: {
    backgroundColor: colors.surfaceSecondary,
  },
  noticeDanger: {
    backgroundColor: colors.dangerSurface,
  },
  noticeText: {
    flex: 1,
  },
  progress: {
    gap: spacing.xs,
  },
  progressSteps: {
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  progressStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  progressMarker: {
    width: layout.iconSize.lg,
    alignItems: 'center',
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
  },
  fieldBlock: {
    gap: spacing.xs,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  blocked: {
    opacity: 0.4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: layout.borderWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    maxWidth: '100%',
  },
  pillPressed: {
    backgroundColor: colors.surfacePressed,
  },
  pillText: {
    flexShrink: 1,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  addInput: {
    flex: 1,
    height: layout.controlHeight.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSecondary,
    ...typography.body,
    color: colors.textPrimary,
  },
});
