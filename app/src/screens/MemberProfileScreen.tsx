import React, { useCallback, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { MtgColor, ParticipantEventPlacement, PlayerColorStat, PlayerWorkspaceStat } from '../lib/database.types';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';
import { MTG_COLOR_HEX } from '../components/ColorFlag';

type Props = NativeStackScreenProps<MainStackParamList, 'MemberProfile'>;

export default function MemberProfileScreen({ navigation, route }: Props) {
  const { userId, workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [stats, setStats] = useState<PlayerWorkspaceStat | null>(null);
  const [colorStats, setColorStats] = useState<PlayerColorStat[]>([]);
  const [eventHistory, setEventHistory] = useState<Pick<ParticipantEventPlacement, 'event_id' | 'event_name' | 'placement' | 'total_players'>[]>([]);

  const load = useCallback(async () => {
    const [userRes, roleRes, statsRes, colorsRes, historyRes] = await Promise.all([
      supabase.from('users').select('display_name, username').eq('id', userId).maybeSingle(),
      supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('v_player_workspace_stats')
        .select('pairings_won, pairings_lost, pairings_pending, draft_matches_won, draft_matches_lost, revenge_matches_won, revenge_matches_lost, super_cups_won, championships, events_as_player, events_as_ghost, avg_match_duration_minutes')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase
        .from('v_player_color_stats')
        .select('color, times_played, total_color_picks, percentage')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .order('times_played', { ascending: false }),
      supabase
        .from('v_participant_event_placement')
        .select('event_id, event_name, placement, total_players')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .eq('event_status', 'completed')
        .order('scheduled_for', { ascending: false })
        .limit(10),
    ]);

    if (userRes.error) {
      Alert.alert('Error', userRes.error.message ?? 'No se pudo cargar el perfil.');
      setDisplayName('');
      setLoading(false);
      return;
    }
    const row = userRes.data as { display_name?: string; username?: string } | null;
    const name = row?.display_name || row?.username || 'Sin nombre';
    setDisplayName(name);
    setIsOrganizer(roleRes.data?.role === 'organizer');
    if (roleRes.error && __DEV__) {
      console.error('MemberProfile role', roleRes.error);
    }
    setStats((statsRes.data as PlayerWorkspaceStat | null) ?? null);
    setColorStats((colorsRes.data as PlayerColorStat[] | null) ?? []);
    setEventHistory(
      ((historyRes.data as Pick<ParticipantEventPlacement, 'event_id' | 'event_name' | 'placement' | 'total_players'>[] | null) ?? [])
    );
    setLoading(false);
  }, [userId, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceDetail', { workspaceId }),
    });
  }, [navigation, workspaceId]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const totalPairings = (stats?.pairings_won ?? 0) + (stats?.pairings_lost ?? 0);
  const pairingWinPct = totalPairings > 0 ? Math.round((stats!.pairings_won / totalPairings) * 100) : null;
  const totalMatches = (stats?.draft_matches_won ?? 0) + (stats?.draft_matches_lost ?? 0);
  const matchWinPct = totalMatches > 0 ? Math.round((stats!.draft_matches_won / totalMatches) * 100) : null;
  const hasStats = totalPairings > 0 || totalMatches > 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.avatarBlock}>
        <PlayerAvatar userId={userId} size="large" withColorBorder={false} outsideEvent />
      </View>
      <Text style={styles.name}>{displayName}</Text>
      {isOrganizer ? (
        <View style={styles.badge}>
          <Text style={styles.badgeTxt}>Organizador</Text>
        </View>
      ) : null}

      <View style={styles.divider} />

      {/* Estadísticas globales */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Estadísticas</Text>
        {hasStats ? (
          <>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Enfrentamientos</Text>
              <Text style={styles.statValue}>
                {stats!.pairings_won}G – {stats!.pairings_lost}P
                {pairingWinPct !== null ? `  (${pairingWinPct}%)` : ''}
              </Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Partidas draft</Text>
              <Text style={styles.statValue}>
                {stats!.draft_matches_won}G – {stats!.draft_matches_lost}P
                {matchWinPct !== null ? `  (${matchWinPct}%)` : ''}
              </Text>
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>Sin partidas registradas</Text>
        )}
      </View>

      {/* Colores jugados */}
      {colorStats.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Colores jugados</Text>
          <View style={styles.colorsRow}>
            {colorStats.map((c) => (
              <View key={c.color} style={styles.colorItem}>
                <View
                  style={[
                    styles.colorDot,
                    { backgroundColor: MTG_COLOR_HEX[c.color as MtgColor] },
                  ]}
                />
                <Text style={styles.colorLabel}>{c.color}</Text>
                <Text style={styles.colorPct}>{c.percentage}%</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Historial de drafts */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Historial de drafts</Text>
        {eventHistory.length > 0 ? (
          eventHistory.map((e) => (
            <View key={e.event_id} style={styles.historyRow}>
              <Text style={styles.historyName} numberOfLines={1}>{e.event_name}</Text>
              <Text style={styles.historyPlacement}>{e.placement}° de {e.total_players}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>Sin drafts completados</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40, backgroundColor: '#fff', flexGrow: 1 },
  avatarBlock: { alignItems: 'center', marginBottom: 20 },
  name: { fontSize: 22, fontWeight: '700', color: '#111', textAlign: 'center', marginBottom: 14 },
  badge: {
    alignSelf: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  badgeTxt: { color: '#1D4ED8', fontSize: 14, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E5E7EB', marginTop: 24 },
  section: { marginTop: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  statLabel: { fontSize: 15, color: '#374151' },
  statValue: { fontSize: 15, fontWeight: '600', color: '#111' },
  emptyText: { fontSize: 14, color: '#9CA3AF', fontStyle: 'italic' },
  colorsRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  colorItem: { alignItems: 'center', gap: 4 },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  colorLabel: { fontSize: 12, fontWeight: '700', color: '#374151' },
  colorPct: { fontSize: 11, color: '#6B7280' },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  historyName: { fontSize: 15, color: '#374151', flex: 1, marginRight: 8 },
  historyPlacement: { fontSize: 15, fontWeight: '700', color: '#111' },
});
