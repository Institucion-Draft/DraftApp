import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import PokemonSprite from '../components/PokemonSprite';
import { fetchReceivedPokemon } from '../lib/pokemonReceivedApi';
import { formatEventDate, pokemonDisplayName, type ReceivedRow } from '../lib/pokemonReceived';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'PokemonHistory'>;

/** Historial completo de Pokémon asignados por evento, del más reciente al más antiguo. */
export default function PokemonHistoryScreen({ route }: Props) {
  const { userId, workspaceId } = route.params;
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [rows, setRows] = useState<ReceivedRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReceivedPokemon(userId, workspaceId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, workspaceId]);

  if (!rows) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(r) => r.id}
      ListEmptyComponent={<Text style={styles.empty}>Todavía no hay Pokémon asignados.</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <PokemonSprite row={item} size={48} />
          <View style={styles.info}>
            <Text style={styles.pokemon} numberOfLines={1}>
              {pokemonDisplayName(item)}
              {item.isShiny ? '  ✨ shiny' : ''}
            </Text>
            <Text style={styles.event} numberOfLines={1}>
              {item.eventName}
            </Text>
          </View>
          <Text style={styles.date}>{formatEventDate(item.eventDate)}</Text>
        </View>
      )}
    />
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: c.background },
    content: { padding: 24, paddingBottom: 40 },
    empty: { fontSize: 14, color: c.textMuted, fontStyle: 'italic' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    info: { flex: 1 },
    pokemon: { fontSize: 15, fontWeight: '600', color: c.text },
    event: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    date: { fontSize: 12, color: c.textMuted },
  });
