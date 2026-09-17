import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceRanking'>;

type StatsRow = {
  user_id: string;
  championships: number;
  completed_events_as_player: number;
  pairings_won: number;
  pairings_lost: number;
  draft_matches_won: number;
  draft_matches_lost: number;
  revenge_matches_won: number;
  revenge_matches_lost: number;
};

type PointsRow = {
  user_id: string;
  points: number;
};

type PlacementsRow = {
  user_id: string;
  second_places: number;
  third_places: number;
};

type UserRow = {
  id: string;
  display_name: string | null;
  username: string | null;
};

type RankingRow = {
  userId: string;
  name: string;
  points: number;
  completedEvents: number;
  championships: number;
  secondPlaces: number;
  thirdPlaces: number;
  ej: number;
  wre: number | null;
  pj: number;
  wrp: number | null;
  vj: number;
  wrv: number | null;
};

function winrate(won: number, lost: number): number | null {
  const total = won + lost;
  return total > 0 ? Math.round((won / total) * 100) : null;
}

function sortKey(v: number | null): number {
  return v ?? -1;
}

const LEGEND_TEXT =
  'Pts: Puntos por posición final (1°/2°/3°), según cantidad de jugadores del evento — 4 a 6 jug.: 5/3/2 · 7 a 9 jug.: 7/4/3 · 10 a 12 jug.: 9/6/4 · 13+ jug.: 12/8/5 · #PE: Participaciones en Eventos · 🥇: Copas (veces 1°) · 🥈: veces 2° · 🥉: veces 3° · EJ: Enfrentamientos Jugados · WRE: Winrate de Enfrentamientos · PJ: Partidas Jugadas · WRP: Winrate de Partidas · VJ: Venganzas Jugadas · WRV: Winrate de Venganzas';

export default function WorkspaceRankingScreen({ navigation, route }: Props) {
  const { workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RankingRow[]>([]);

  const load = useCallback(async () => {
    const [statsRes, pointsRes, placementsRes] = await Promise.all([
      supabase
        .from('v_player_workspace_stats')
        .select(
          'user_id, championships, completed_events_as_player, pairings_won, pairings_lost, draft_matches_won, draft_matches_lost, revenge_matches_won, revenge_matches_lost'
        )
        .eq('workspace_id', workspaceId),
      supabase.from('v_workspace_points').select('user_id, points').eq('workspace_id', workspaceId),
      supabase
        .from('v_workspace_placements')
        .select('user_id, second_places, third_places')
        .eq('workspace_id', workspaceId),
    ]);

    const stats = (statsRes.data ?? []) as StatsRow[];
    const pointsByUser = new Map<string, number>();
    for (const p of (pointsRes.data ?? []) as PointsRow[]) {
      pointsByUser.set(p.user_id, p.points);
    }
    const placementsByUser = new Map<string, { second: number; third: number }>();
    for (const pl of (placementsRes.data ?? []) as PlacementsRow[]) {
      placementsByUser.set(pl.user_id, { second: pl.second_places, third: pl.third_places });
    }

    const userIds = stats.map((s) => s.user_id);
    let namesByUser: Record<string, string> = {};
    if (userIds.length > 0) {
      const usersRes = await supabase.from('users').select('id, display_name, username').in('id', userIds);
      for (const u of (usersRes.data ?? []) as UserRow[]) {
        namesByUser[u.id] = u.display_name || u.username || 'Jugador';
      }
    }

    const built: RankingRow[] = stats.map((s) => ({
      userId: s.user_id,
      name: namesByUser[s.user_id] ?? 'Jugador',
      points: pointsByUser.get(s.user_id) ?? 0,
      completedEvents: s.completed_events_as_player,
      championships: s.championships,
      secondPlaces: placementsByUser.get(s.user_id)?.second ?? 0,
      thirdPlaces: placementsByUser.get(s.user_id)?.third ?? 0,
      ej: s.pairings_won + s.pairings_lost,
      wre: winrate(s.pairings_won, s.pairings_lost),
      pj: s.draft_matches_won + s.draft_matches_lost,
      wrp: winrate(s.draft_matches_won, s.draft_matches_lost),
      vj: s.revenge_matches_won + s.revenge_matches_lost,
      wrv: winrate(s.revenge_matches_won, s.revenge_matches_lost),
    }));

    built.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.championships !== a.championships) return b.championships - a.championships;
      const wreA = sortKey(a.wre);
      const wreB = sortKey(b.wre);
      if (wreB !== wreA) return wreB - wreA;
      const wrpA = sortKey(a.wrp);
      const wrpB = sortKey(b.wrp);
      if (wrpB !== wrpA) return wrpB - wrpA;
      const wrvA = sortKey(a.wrv);
      const wrvB = sortKey(b.wrv);
      if (wrvB !== wrvA) return wrvB - wrvA;
      return a.name.localeCompare(b.name);
    });

    setRows(built);
    setLoading(false);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} horizontal={false}>
      <ScrollView horizontal contentContainerStyle={styles.tableWrap}>
        <View>
          <View style={styles.headerRow}>
            <Text style={[styles.cell, styles.posCol, styles.headerTxt]}>#</Text>
            <Text style={[styles.cell, styles.nameCol, styles.headerTxt, styles.leftAlign]}>Jugador</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>Pts</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>#PE</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥇</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥈</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>🥉</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>EJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRE</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>PJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRP</Text>
            <Text style={[styles.cell, styles.statCol, styles.headerTxt]}>VJ</Text>
            <Text style={[styles.cell, styles.pctCol, styles.headerTxt]}>WRV</Text>
          </View>
          {rows.length === 0 ? (
            <Text style={styles.emptyText}>Todavía nadie jugó en este workspace.</Text>
          ) : (
            rows.map((r, idx) => (
              <TouchableOpacity
                key={r.userId}
                style={styles.row}
                activeOpacity={0.7}
                onPress={() =>
                  navigation.navigate('PlayerPointsDetail', { userId: r.userId, workspaceId, playerName: r.name })
                }
              >
                <Text style={[styles.cell, styles.posCol]}>{idx + 1}</Text>
                <View style={[styles.nameCol, styles.nameCell]}>
                  <PlayerAvatar userId={r.userId} size="tiny" withColorBorder={false} outsideEvent style={styles.avatar} />
                  <Text style={styles.nameTxt} numberOfLines={1}>
                    {r.name}
                  </Text>
                </View>
                <Text style={[styles.cell, styles.statCol, styles.pointsTxt]}>{r.points}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.completedEvents}</Text>
                <Text style={[styles.cell, styles.statCol, styles.goldTxt]}>{r.championships}</Text>
                <Text style={[styles.cell, styles.statCol, styles.silverTxt]}>{r.secondPlaces}</Text>
                <Text style={[styles.cell, styles.statCol, styles.bronzeTxt]}>{r.thirdPlaces}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.ej}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wre != null ? `${r.wre}%` : '-'}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.pj}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wrp != null ? `${r.wrp}%` : '-'}</Text>
                <Text style={[styles.cell, styles.statCol]}>{r.vj}</Text>
                <Text style={[styles.cell, styles.pctCol]}>{r.wrv != null ? `${r.wrv}%` : '-'}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
      <Text style={styles.legendTxt}>{LEGEND_TEXT}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, paddingBottom: 40 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tableWrap: { paddingBottom: 8 },
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingBottom: 8,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  cell: { textAlign: 'center', color: '#111', fontWeight: '600', fontSize: 12 },
  headerTxt: { fontWeight: '700', color: '#6B7280', fontSize: 11, textTransform: 'uppercase' },
  leftAlign: { textAlign: 'left' },
  posCol: { width: 26, minWidth: 26 },
  nameCol: { width: 140, minWidth: 140 },
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatar: { marginRight: 2 },
  nameTxt: { fontSize: 13, fontWeight: '600', color: '#111', flexShrink: 1 },
  statCol: { width: 44, minWidth: 44 },
  pctCol: { width: 50, minWidth: 50, fontSize: 11 },
  pointsTxt: { color: '#3B82F6', fontWeight: '700' },
  goldTxt: { color: '#CA8A04' },
  silverTxt: { color: '#9CA3AF' },
  bronzeTxt: { color: '#B45309' },
  emptyText: { fontSize: 14, color: '#9CA3AF', fontStyle: 'italic', paddingVertical: 24 },
  legendTxt: { marginTop: 14, color: '#666', fontSize: 12, lineHeight: 17 },
});
