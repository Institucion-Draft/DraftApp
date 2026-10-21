import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import PlayerAvatar from './PlayerAvatar';
import { useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';
import type { PlaceStatsSection } from '../lib/placeStatsSections';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

type Props = {
  sections: PlaceStatsSection[];
};

/**
 * Bloque compacto de estadísticas de un cubo o sede. Sin secciones con datos no renderiza nada (ni título ni vacío).
 * Con participantId en la fila se ve el Pokémon de ese evento; sin él, el Pokémon personal de la cuenta
 * (users.default_avatar_id), y la foto custom le gana en ambos casos.
 */
export default function PlaceStatsCard({ sections }: Props) {
  const styles = useThemedStyles(createStyles);
  const visible = sections.filter((s) => s.rows.length > 0);
  if (visible.length === 0) return null;

  return (
    <View style={styles.card}>
      {visible.map((s, i) => (
        <View key={s.title} style={i > 0 ? styles.sectionGap : undefined}>
          <Text style={styles.sectionTitle}>{s.title}</Text>
          {s.subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{s.subtitle}</Text> : null}
          {s.rows.map((r) => (
            <View key={`${r.userId}-${r.position ?? 'x'}`} style={styles.row}>
              <Text style={styles.medal}>{r.position ? MEDAL[r.position] ?? '' : '🏆'}</Text>
              {r.participantId ? (
                <PlayerAvatar userId={r.userId} participantId={r.participantId} size="small" />
              ) : (
                <PlayerAvatar userId={r.userId} size="small" />
              )}
              <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
              {r.trailing ? <Text style={styles.trailing}>{r.trailing}</Text> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      marginTop: 20,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: 10,
      padding: 12,
    },
    sectionGap: { marginTop: 14 },
    sectionTitle: { fontSize: 15, fontWeight: '700', color: c.text, marginBottom: 2 },
    subtitle: { fontSize: 12, color: c.textMuted, marginBottom: 6 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
    medal: { width: 24, fontSize: 18, textAlign: 'center' },
    name: { flex: 1, fontSize: 15, color: c.text },
    trailing: { fontSize: 14, fontWeight: '600', color: c.textBody },
  });
