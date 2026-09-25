import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { fetchWorkspaceSeasons, phaseSubtitle, syncWorkspaceSeasons, type SeasonRow } from '../lib/seasons';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceSeasonHistory'>;

export default function WorkspaceSeasonHistoryScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setLoading(true);
      (async () => {
        // Cierra las que ya se puedan cerrar antes de listar, así el estado mostrado es el vigente.
        await syncWorkspaceSeasons(workspaceId);
        const all = await fetchWorkspaceSeasons(workspaceId);
        if (cancelled) return;
        setSeasons(all.filter((s) => s.phase === 'finishing' || s.phase === 'closed').reverse());
        setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [workspaceId])
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {seasons.length === 0 ? (
        <Text style={styles.empty}>Todavía no hay temporadas terminadas.</Text>
      ) : (
        seasons.map((s) => (
          <TouchableOpacity
            key={s.season_id}
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('WorkspaceSeason', { workspaceId, seasonId: s.season_id })}
            accessibilityRole="button"
          >
            <View style={styles.rowMain}>
              <Text style={styles.name}>{s.name}</Text>
              <Text style={styles.sub}>{phaseSubtitle(s)}</Text>
            </View>
            <View style={[styles.badge, s.phase === 'finishing' ? styles.badgePending : styles.badgeClosed]}>
              <Text style={[styles.badgeTxt, s.phase === 'finishing' ? styles.badgeTxtPending : styles.badgeTxtClosed]}>
                {s.phase === 'finishing' ? 'Pendiente' : 'Cerrada'}
              </Text>
            </View>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scroll: { padding: 16, paddingBottom: 40 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background },
    empty: { fontSize: 14, color: c.textMuted, fontStyle: 'italic', paddingVertical: 24, textAlign: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
      gap: 10,
    },
    rowMain: { flex: 1 },
    name: { fontSize: 16, fontWeight: '700', color: c.text },
    sub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
    badgePending: { backgroundColor: c.status.warning.subtle },
    badgeClosed: { backgroundColor: c.backgroundAlt },
    badgeTxt: { fontSize: 11, fontWeight: '700' },
    badgeTxtPending: { color: c.status.warning.text },
    badgeTxtClosed: { color: c.textBody },
  });
