import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import RankingTable from '../components/RankingTable';
import SeasonPodium from '../components/SeasonPodium';
import { fetchPointTiers, type PointTier } from '../lib/pointConfig';
import {
  PRODEC_POINTS_COLUMNS,
  RANKING_STATS_COLUMNS,
  buildRankingLegend,
  buildRankingRows,
  fetchUserNames,
  prodecByUserFromRows,
  type Medals,
  type PointsWithProDeCRow,
  type RankingRow,
  type RankingStatsRow,
} from '../lib/ranking';
import { computeSeasonPodium } from '../lib/seasonPodium';
import {
  SEASON_COLUMNS,
  closeSeasonIfReady,
  fetchIsWorkspaceOrganizer,
  fetchUnfinishedEvents,
  phaseSubtitle,
  type SeasonRow,
  type UnfinishedEvent,
} from '../lib/seasons';
import { getEventStatusLabel } from '../lib/labels';
import type { EventStatus } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceSeason'>;

type PositionRow = {
  user_id: string;
  position: number;
};

const CONFETTI_KEY = (userId: string, seasonId: string) => `season_podium_confetti_${userId}_${seasonId}`;

async function fetchSeason(seasonId: string): Promise<SeasonRow | null> {
  const res = await supabase.from('v_seasons').select(SEASON_COLUMNS).eq('season_id', seasonId).maybeSingle();
  return (res.data ?? null) as SeasonRow | null;
}

export default function WorkspaceSeasonScreen({ navigation, route }: Props) {
  const { workspaceId, seasonId } = route.params;
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<SeasonRow | null>(null);
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [tiers, setTiers] = useState<PointTier[]>([]);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [unfinished, setUnfinished] = useState<UnfinishedEvent[]>([]);
  const [showConfetti, setShowConfetti] = useState(false);

  const load = useCallback(async () => {
    let seasonRow = await fetchSeason(seasonId);
    if (!seasonRow) {
      setSeason(null);
      setLoading(false);
      return;
    }

    // Una temporada terminada pero sin cerrar puede haberse destrabado desde la última vez: se
    // intenta cerrar (idempotente) para mostrar el cartel de bloqueo solo si de verdad sigue trabada.
    if (seasonRow.phase === 'finishing') {
      const closed = await closeSeasonIfReady(seasonId);
      if (closed === 'closed') seasonRow = (await fetchSeason(seasonId)) ?? seasonRow;
    }

    const [statsRes, pointsRes, positionsRes, seasonTiers, organizer, blockers] = await Promise.all([
      supabase.from('v_season_player_stats').select(RANKING_STATS_COLUMNS).eq('season_id', seasonId),
      supabase.from('v_season_points').select(`user_id, points, ${PRODEC_POINTS_COLUMNS}`).eq('season_id', seasonId),
      supabase.from('v_season_positions').select('user_id, position').eq('season_id', seasonId).lte('position', 3),
      fetchPointTiers(seasonRow.point_config_id),
      user?.id ? fetchIsWorkspaceOrganizer(workspaceId, user.id) : Promise.resolve(false),
      seasonRow.phase === 'finishing' ? fetchUnfinishedEvents(seasonId) : Promise.resolve([] as UnfinishedEvent[] | null),
    ]);

    const stats = (statsRes.data ?? []) as RankingStatsRow[];
    const pointsByUser = new Map<string, number>();
    const pointsRows = (pointsRes.data ?? []) as PointsWithProDeCRow[];
    for (const p of pointsRows) {
      pointsByUser.set(p.user_id, p.points);
    }
    const medalsByUser = new Map<string, Medals>();
    for (const pos of (positionsRes.data ?? []) as PositionRow[]) {
      const m = medalsByUser.get(pos.user_id) ?? { first: 0, second: 0, third: 0 };
      if (pos.position === 1) m.first += 1;
      else if (pos.position === 2) m.second += 1;
      else if (pos.position === 3) m.third += 1;
      medalsByUser.set(pos.user_id, m);
    }

    const namesByUser = await fetchUserNames(stats.map((s) => s.user_id));

    navigation.setOptions({ title: seasonRow.name });
    setSeason(seasonRow);
    setTiers(seasonTiers);
    setIsOrganizer(organizer);
    setUnfinished(blockers ?? []);
    setRows(buildRankingRows(stats, pointsByUser, medalsByUser, namesByUser, prodecByUserFromRows(pointsRows)));
    setLoading(false);
  }, [seasonId, workspaceId, user?.id, navigation]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  const podiumSteps = season?.phase === 'closed' ? computeSeasonPodium(rows) : [];
  const podiumVisible = podiumSteps.length > 0;

  // Confeti una sola vez por usuario y temporada, la primera vez que se ve el podio de cierre.
  useEffect(() => {
    if (loading || !podiumVisible || !user?.id) return;
    let cancelled = false;
    void (async () => {
      const key = CONFETTI_KEY(user.id, seasonId);
      const seen = await AsyncStorage.getItem(key);
      if (seen || cancelled) return;
      setShowConfetti(true);
      await AsyncStorage.setItem(key, '1');
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, podiumVisible, user?.id, seasonId]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#3B82F6" />
      </View>
    );
  }

  if (!season) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró la temporada.</Text>
      </View>
    );
  }

  const header = (
    <View>
      <View style={styles.header}>
        <Text style={styles.title}>{season.name}</Text>
        <Text style={styles.subtitle}>{phaseSubtitle(season)}</Text>
        {season.phase === 'closed' && season.closed_forced ? (
          <Text style={styles.forcedNote}>
            Cierre forzado: incluye los podios asegurados de eventos que quedaron inconclusos.
          </Text>
        ) : null}
      </View>

      {season.phase === 'closed' && podiumVisible ? (
        <View>
          <Text style={styles.sectionLabel}>Podio de la temporada</Text>
          <SeasonPodium
            steps={podiumSteps}
            onPressPlayer={(p) =>
              navigation.navigate('PlayerPointsDetail', { userId: p.userId, workspaceId, playerName: p.name, seasonId })
            }
          />
        </View>
      ) : null}

      {season.phase === 'finishing' ? (
        <View style={styles.blockedCard}>
          <Text style={styles.blockedTitle}>Temporada pendiente de cierre</Text>
          <Text style={styles.blockedBody}>
            {unfinished.length === 1
              ? 'Queda 1 evento inconcluso, así que la temporada no puede cerrarse sola:'
              : `Quedan ${unfinished.length} eventos inconclusos, así que la temporada no puede cerrarse sola:`}
          </Text>
          {unfinished.map((e) => (
            <Text key={e.event_id} style={styles.blockedEvent} numberOfLines={1}>
              • {e.event_name} ({getEventStatusLabel(e.status as EventStatus)})
            </Text>
          ))}
          <Text style={styles.blockedHint}>
            Se cierra sola apenas se resuelvan. Un organizador también puede cerrarla de todos modos.
          </Text>
          {isOrganizer ? (
            <TouchableOpacity
              style={styles.blockedBtn}
              onPress={() => navigation.navigate('SeasonForceClose', { workspaceId, seasonId })}
              accessibilityRole="button"
            >
              <Text style={styles.blockedBtnText}>Cerrar temporada de todos modos</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {season.phase === 'closed' && podiumVisible ? <Text style={styles.sectionLabel}>Tabla completa</Text> : null}
    </View>
  );

  return (
    <View style={styles.root}>
      {showConfetti ? (
        <View pointerEvents="none" style={styles.confettiOverlay}>
          <ConfettiCannon
            count={150}
            origin={{ x: Math.max(80, Dimensions.get('window').width / 2), y: -6 }}
            fadeOut
          />
        </View>
      ) : null}
      <RankingTable
        rows={rows}
        emptyText={
          season.phase === 'upcoming' ? 'La temporada todavía no arrancó.' : 'Todavía nadie jugó en esta temporada.'
        }
        legendText={buildRankingLegend(tiers)}
        onPressRow={(r) =>
          navigation.navigate('PlayerPointsDetail', { userId: r.userId, workspaceId, playerName: r.name, seasonId })
        }
        header={header}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  muted: { fontSize: 15, color: '#666', textAlign: 'center' },
  confettiOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 },
  header: { marginBottom: 14 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  subtitle: { fontSize: 13, color: '#6B7280', marginTop: 2 },
  forcedNote: { fontSize: 12, color: '#92400E', marginTop: 6, lineHeight: 17 },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: '#6B7280', textTransform: 'uppercase', marginBottom: 10 },
  blockedCard: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  blockedTitle: { fontSize: 15, fontWeight: '700', color: '#92400E', marginBottom: 6 },
  blockedBody: { fontSize: 13, color: '#78350F', marginBottom: 6, lineHeight: 18 },
  blockedEvent: { fontSize: 13, color: '#78350F', paddingVertical: 2 },
  blockedHint: { fontSize: 12, color: '#92400E', marginTop: 8, lineHeight: 17 },
  blockedBtn: {
    marginTop: 12,
    backgroundColor: '#DC2626',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  blockedBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
