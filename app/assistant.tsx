import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import type { AssistantHistoryTurn } from '@/ai/contracts/assistant';
import { ShopRow } from '@/components/shop/shop-row';
import { Button, EmptyState, IconButton, Screen, Text, TextField } from '@/components/ui';
import { searchShopsByIntent } from '@/data/search';
import { askAssistant } from '@/lib/api/assistant';
import { recordSearchInteraction } from '@/lib/api/discovery';
import { searchWithIntent } from '@/lib/api/search';
import { useAuth } from '@/state/auth';
import { useFavorites } from '@/state/favorites';
import { usePreferences } from '@/state/preferences';
import { colors, layout, radii, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  shops?: Shop[];
  searchId?: string | null;
};

const EXAMPLES = [
  'Je cherche des sneakers originales et plutôt confidentielles',
  'Une boutique élégante pour un cadeau autour de 50 €',
  'Comment fonctionne la vérification des boutiques ?',
] as const;

export default function AssistantScreen() {
  const { status, session } = useAuth();
  const { deliveryCountry, hydrated } = usePreferences();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useMemo<AssistantHistoryTurn[]>(
    () => messages.slice(-6).map((message) => ({ role: message.role, text: message.text })),
    [messages]
  );

  const send = async (suggestion?: string) => {
    const message = (suggestion ?? draft).trim();
    if (!message || sending || status !== 'signedIn') return;

    const userMessage: UiMessage = { id: `u-${messages.length}`, role: 'user', text: message };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setSending(true);
    setError(null);

    let candidates: Shop[] = [];
    let searchId: string | null = null;

    try {
      // Carry the latest user turn into short follow-ups such as "plus minimaliste".
      const previousUser = [...messages].reverse().find((item) => item.role === 'user')?.text;
      const retrievalQuery = previousUser ? `${previousUser}. ${message}` : message;
      const search = await searchWithIntent(
        retrievalQuery,
        session && hydrated ? { shippingCountryCode: deliveryCountry } : {}
      );
      if (search.ok) {
        searchId = search.searchId;
        const found = await searchShopsByIntent(search.intent, {
          semanticMatches: search.semanticMatches,
          limit: 40,
        });
        candidates = found.results.slice(0, 8).map((result) => result.shop);
      }
    } catch {
      // Help questions can still be answered with zero shop candidates.
      candidates = [];
    }

    const answer = await askAssistant({
      message,
      candidateShopIds: candidates.map((shop) => shop.id),
      history,
      locale: 'fr',
      ...(session && hydrated ? { shippingCountryCode: deliveryCountry } : {}),
    });

    if (!answer.ok) {
      setError(answer.error.message);
      setSending(false);
      return;
    }

    const allowed = new Map(candidates.map((shop) => [shop.id, shop]));
    const shops = answer.data.recommendedShopIds
      .map((id) => allowed.get(id))
      .filter((shop): shop is Shop => shop !== undefined);

    setMessages((current) => [
      ...current,
      {
        id: `a-${messages.length + 1}`,
        role: 'assistant',
        text: answer.data.reply,
        shops,
        searchId,
      },
    ]);
    setSending(false);
  };

  if (status === 'signedOut') {
    return (
      <Screen scroll>
        <IconButton icon="back" variant="bare" onPress={() => router.back()} accessibilityLabel="Retour" style={styles.back} />
        <Text variant="title">Assistant</Text>
        <View style={styles.signedOut}>
          <EmptyState
            icon="sparkle"
            title="Connecte-toi pour utiliser l’assistant"
            description="Tes préférences et tes recherches peuvent ainsi être prises en compte sans exposer de données privées au catalogue."
            actionLabel="Se connecter"
            onActionPress={() => router.push('/sign-in')}
          />
        </View>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen scroll>
        <IconButton icon="back" variant="bare" onPress={() => router.back()} accessibilityLabel="Retour" style={styles.back} />
        <Text variant="title">Assistant</Text>
        <Text variant="body" tone="secondary" style={styles.intro}>
          Décris ce que tu cherches ou pose une question sur Shop Discovery. Les boutiques proposées viennent uniquement du catalogue.
        </Text>

        {messages.length === 0 ? (
          <View style={styles.examples}>
            {EXAMPLES.map((example) => (
              <Button key={example} label={example} variant="secondary" fullWidth onPress={() => void send(example)} />
            ))}
          </View>
        ) : (
          <View style={styles.messages}>
            {messages.map((message) => (
              <View key={message.id} style={styles.messageBlock}>
                <View style={[styles.bubble, message.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
                  <Text variant="body">{message.text}</Text>
                </View>
                {message.role === 'assistant' && message.shops && message.shops.length > 0 ? (
                  <View style={styles.shopList}>
                    {message.shops.map((shop, index) => (
                      <ShopRow
                        key={shop.id}
                        shop={shop}
                        favorite={isFavorite(shop.id)}
                        onToggleFavorite={(shopId) => {
                          const wasFavorite = isFavorite(shopId);
                          toggleFavorite(shopId);
                          if (!wasFavorite) void recordSearchInteraction(message.searchId ?? null, shopId, 'favorite', index);
                        }}
                        onPress={() => {
                          void recordSearchInteraction(message.searchId ?? null, shop.id, 'shop_open', index);
                          router.push({
                            pathname: '/shop/[id]',
                            params: {
                              id: shop.id,
                              source: 'search',
                              ...(message.searchId ? { searchId: message.searchId } : {}),
                              position: String(index),
                            },
                          });
                        }}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {sending ? <Text variant="meta" tone="secondary" style={styles.status}>Je cherche dans le catalogue…</Text> : null}
        {error ? <Text variant="meta" tone="danger" style={styles.status}>{error}</Text> : null}

        <View style={styles.composer}>
          <TextField
            label="Ta demande"
            value={draft}
            onChangeText={setDraft}
            placeholder="Ex. une marque française minimaliste…"
            multiline
            maxLength={1000}
            editable={!sending}
          />
          <Button label="Envoyer" iconLeft="sparkle" loading={sending} disabled={draft.trim().length === 0} fullWidth onPress={() => void send()} />
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  back: { marginBottom: spacing.lg },
  intro: { marginTop: spacing.sm },
  signedOut: { marginTop: layout.sectionGap },
  examples: { marginTop: layout.sectionGap, gap: spacing.sm },
  messages: { marginTop: layout.sectionGap, gap: spacing.lg },
  messageBlock: { gap: spacing.md },
  bubble: { maxWidth: '92%', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.md },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.surfaceSecondary },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  shopList: { gap: spacing.md },
  status: { marginTop: spacing.md },
  composer: { marginTop: layout.sectionGap, gap: spacing.md, paddingBottom: spacing.xl },
});
