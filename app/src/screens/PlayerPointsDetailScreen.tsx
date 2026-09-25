import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import {
  fetchDefaultPointConfigId,
  fetchPointTiers,
  tierIndexForPlayerCount,
  tierRangeLabel,
  type PointTier,
} from '../lib/pointConfig';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'PlayerPointsDetail'>;

const BREAKDOWN_COLUMNS =
  'user_id, event_id, event_name, scheduled_for, competition_format, top_size, player_count, position, points, venue_name, cube_name';

type BreakdownRow = {
  user_id: string;
  event_id: string;
  event_name: string;
  scheduled_for: string | null;
  competition_format: string | null;
  top_size: number | null;
  player_count: number;
  position: number;
  points: number;
  venue_name: string | null;
  cube_name: string | null;
};

type UserRow = {
  id: string;
  display_name: string | null;
  username: string | null;
};

type PodiumEntry = {
  userId: string;
  name: string;
  position: number;
  points: number;
};

type EventPoints = {
  eventId: string;
  eventName: string;
  scheduledFor: string | null;
  mode: string;
  venueName: string | null;
  cubeName: string | null;
  playerCount: number;
  position: number;
  points: number;
  podium: PodiumEntry[];
};

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

function formatMode(competitionFormat: string | null, topSize: number | null): string {
  if (competitionFormat === 'swiss') return 'Rondas suizas + Top 4';
  if (competitionFormat === 'round_robin') {
    return topSize === 4 ? 'Todos contra todos + Top 4' : 'Todos contra todos';
  }
  return competitionFormat ?? '—';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-AR');
}

export default function PlayerPointsDetailScreen({ route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { userId, workspaceId, seasonId } = route.params;
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<EventPoints[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [tiers, setTiers] = useState<PointTier[]>([]);

  const load = useCallback(async () => {
    // Con seasonId el detalle sale de la temporada (config de puntos propia, incluye los eventos
    // congelados por un cierre forzado); sin seasonId, del Ranking Global como siempre.
    const breakdownView = seasonId ? 'v_season_points_breakdown' : 'v_workspace_points_breakdown';

    const configIdPromise: Promise<string | null> = seasonId
      ? Promise.resolve(
          supabase.from('v_seasons').select('point_config_id').eq('season_id', seasonId).maybeSingle()
        ).then((r) => (r.data as { point_config_id: string } | null)?.point_config_id ?? null)
      : fetchDefaultPointConfigId();
    const tiersPromise = configIdPromise.then(fetchPointTiers);

    const mineBase = supabase.from(breakdownView).select(BREAKDOWN_COLUMNS).eq('user_id', userId);
    const mineRes = await (seasonId ? mineBase.eq('season_id', seasonId) : mineBase.eq('workspace_id', workspaceId));

    const mine = (mineRes.data ?? []) as BreakdownRow[];
    const eventIds = mine.map((r) => r.event_id);

    let allByEvent = new Map<string, BreakdownRow[]>();
    let namesByUser: Record<string, string> = {};
    if (eventIds.length > 0) {
      const allBase = supabase.from(breakdownView).select(BREAKDOWN_COLUMNS).in('event_id', eventIds);
      const allRes = await (seasonId ? allBase.eq('season_id', seasonId) : allBase);
      const all = (allRes.data ?? []) as BreakdownRow[];
      for (const r of all) {
        if (!allByEvent.has(r.event_id)) allByEvent.set(r.event_id, []);
        allByEvent.get(r.event_id)!.push(r);
      }

      const involvedUserIds = Array.from(new Set(all.map((r) => r.user_id)));
      if (involvedUserIds.length > 0) {
        const usersRes = await supabase.from('users').select('id, display_name, username').in('id', involvedUserIds);
        for (const u of (usersRes.data ?? []) as UserRow[]) {
          namesByUser[u.id] = u.display_name || u.username || 'Jugador';
        }
      }
    }

    const built: EventPoints[] = mine.map((r) => {
      const eventRows = allByEvent.get(r.event_id) ?? [];
      const podium: PodiumEntry[] = eventRows
        .map((er) => ({
          userId: er.user_id,
          name: namesByUser[er.user_id] ?? 'Jugador',
          position: er.position,
          points: er.points,
        }))
        .sort((a, b) => a.position - b.position);

      return {
        eventId: r.event_id,
        eventName: r.event_name,
        scheduledFor: r.scheduled_for,
        mode: formatMode(r.competition_format, r.top_size),
        venueName: r.venue_name,
        cubeName: r.cube_name,
        playerCount: r.player_count,
        position: r.position,
        points: r.points,
        podium,
      };
    });

    built.sort((a, b) => b.points - a.points);

    setTiers(await tiersPromise);
    setRows(built);
    setLoading(false);
  }, [userId, workspaceId, seasonId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setExpandedEventIds(new Set());
      void load();
    }, [load])
  );

  const toggleExpanded = (eventId: string) => {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const total = rows.reduce((sum, r) => sum + r.points, 0);

  const highlightedCells = new Set<string>();
  for (const r of rows) {
    if (!expandedEventIds.has(r.eventId)) continue;
    const tierIdx = tierIndexForPlayerCount(tiers, r.playerCount);
    if (tierIdx != null) highlightedCells.add(`${tierIdx}-${r.position}`);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <View style={styles.totalBox}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{total} pts</Text>
      </View>

      {rows.length === 0 ? (
        <Text style={styles.emptyText}>Todavía no sumó puntos en ningún evento.</Text>
      ) : (
        rows.map((r) => {
          const expanded = expandedEventIds.has(r.eventId);
          const otherPodium = r.podium.filter((p) => p.userId !== userId);
          return (
            <View key={r.eventId}>
              <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => toggleExpanded(r.eventId)}>
                <Text style={styles.medal}>{MEDAL[r.position] ?? `${r.position}°`}</Text>
                <View style={styles.rowMain}>
                  <Text style={styles.eventName} numberOfLines={1}>
                    {r.eventName}
                  </Text>
                  <Text style={styles.rowSub}>
                    {r.position}° de {r.playerCount} jugadores
                  </Text>
                </View>
                <Text style={styles.rowPoints}>+{r.points}</Text>
                <Text style={styles.expandChevron}>{expanded ? '▾' : '▸'}</Text>
              </TouchableOpacity>

              {expanded ? (
                <View style={styles.expandedBox}>
                  <View style={styles.expandedLeft}>
                    {otherPodium.length > 0 ? (
                      otherPodium.map((p) => (
                        <View key={p.userId} style={styles.podiumRow}>
                          <Text style={styles.podiumMedal}>{MEDAL[p.position] ?? `${p.position}°`}</Text>
                          <Text style={styles.podiumName} numberOfLines={1}>
                            {p.name}
                          </Text>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.podiumEmpty}>Nadie más sumó posición acá.</Text>
                    )}
                  </View>
                  <View style={styles.expandedRight}>
                    <Text style={styles.eventMetaLine}>Fecha: {formatDate(r.scheduledFor)}</Text>
                    <Text style={styles.eventMetaLine}>Formato: {r.mode}</Text>
                    {r.venueName ? <Text style={styles.eventMetaLine}>Sede: {r.venueName}</Text> : null}
                    {r.cubeName ? <Text style={styles.eventMetaLine}>Cubo: {r.cubeName}</Text> : null}
                  </View>
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <View style={styles.legendSection}>
        <Text style={styles.legendTitle}>Puntos por posición final según cantidad de jugadores</Text>
        <View style={styles.legendTable}>
          <View style={styles.legendHeaderRow}>
            <Text style={[styles.legendCell, styles.legendRangeCol, styles.legendHeaderTxt]}>Jug.</Text>
            <Text style={[styles.legendCell, styles.legendHeaderTxt]}>🥇</Text>
            <Text style={[styles.legendCell, styles.legendHeaderTxt]}>🥈</Text>
            <Text style={[styles.legendCell, styles.legendHeaderTxt]}>🥉</Text>
          </View>
          {tiers.map((t, idx) => (
            <View key={t.minPlayers} style={styles.legendRow}>
              <Text style={[styles.legendCell, styles.legendRangeCol]}>{tierRangeLabel(tiers, idx)}</Text>
              {[1, 2, 3].map((position) => (
                <Text
                  key={position}
                  style={[styles.legendCell, highlightedCells.has(`${idx}-${position}`) && styles.legendCellHighlight]}
                >
                  {t.points[position - 1] ?? 0}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scroll: { padding: 16, paddingBottom: 40 },
    loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    totalBox: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: c.status.info.subtle,
      borderRadius: 12,
      paddingVertical: 14,
      paddingHorizontal: 16,
      marginBottom: 16,
    },
    totalLabel: { fontSize: 14, fontWeight: '600', color: c.textBody },
    totalValue: { fontSize: 20, fontWeight: '800', color: c.accent },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
      gap: 10,
    },
    medal: { fontSize: 22, width: 30, textAlign: 'center' },
    rowMain: { flex: 1 },
    eventName: { fontSize: 15, fontWeight: '600', color: c.text },
    rowSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    rowPoints: { fontSize: 16, fontWeight: '700', color: c.accent },
    expandChevron: { fontSize: 13, color: c.textMuted, width: 16, textAlign: 'center' },
    expandedBox: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      backgroundColor: c.card,
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
      marginTop: -4,
    },
    expandedLeft: { flex: 1, paddingRight: 8 },
    expandedRight: { alignItems: 'flex-end', maxWidth: '48%' },
    podiumRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
    podiumMedal: { fontSize: 15, width: 22, textAlign: 'center' },
    podiumName: { fontSize: 13, color: c.textBody, flexShrink: 1 },
    podiumEmpty: { fontSize: 12, color: c.textMuted, fontStyle: 'italic', paddingVertical: 4 },
    eventMetaLine: { fontSize: 11, color: c.textMuted, textAlign: 'right', marginBottom: 3 },
    emptyText: { fontSize: 14, color: c.textMuted, fontStyle: 'italic', paddingVertical: 24 },
    legendSection: { marginTop: 16, alignItems: 'flex-start' },
    legendTitle: { fontSize: 12, color: c.textSecondary, marginBottom: 8 },
    legendTable: { alignSelf: 'flex-start' },
    legendHeaderRow: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: 6,
      marginBottom: 2,
    },
    legendRow: { flexDirection: 'row', paddingVertical: 4 },
    legendCell: { width: 34, fontSize: 12, color: c.textSecondary, textAlign: 'center' },
    legendRangeCol: { width: 46, textAlign: 'left' },
    legendHeaderTxt: { fontWeight: '700', color: c.textSecondary },
    legendCellHighlight: {
      fontWeight: '800',
      color: c.text,
      backgroundColor: c.status.warning.subtle,
      borderRadius: 4,
      overflow: 'hidden',
    },
  });
