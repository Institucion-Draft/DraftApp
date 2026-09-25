import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import RankingTable from '../components/RankingTable';
import { fetchDefaultPointConfigId, fetchPointTiers, type PointTier } from '../lib/pointConfig';
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
import { useTheme } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'WorkspaceRanking'>;

type StatsRow = RankingStatsRow & { championships: number };

type PlacementsRow = {
  user_id: string;
  second_places: number;
  third_places: number;
};

export default function WorkspaceRankingScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { workspaceId } = route.params;
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [tiers, setTiers] = useState<PointTier[]>([]);

  const load = useCallback(async () => {
    const [statsRes, pointsRes, placementsRes, defaultTiers] = await Promise.all([
      supabase
        .from('v_player_workspace_stats')
        .select(`${RANKING_STATS_COLUMNS}, championships`)
        .eq('workspace_id', workspaceId),
      supabase
        .from('v_workspace_points')
        .select(`user_id, points, ${PRODEC_POINTS_COLUMNS}`)
        .eq('workspace_id', workspaceId),
      supabase
        .from('v_workspace_placements')
        .select('user_id, second_places, third_places')
        .eq('workspace_id', workspaceId),
      fetchDefaultPointConfigId().then(fetchPointTiers),
    ]);

    const stats = (statsRes.data ?? []) as StatsRow[];
    const pointsByUser = new Map<string, number>();
    const pointsRows = (pointsRes.data ?? []) as PointsWithProDeCRow[];
    for (const p of pointsRows) {
      pointsByUser.set(p.user_id, p.points);
    }
    const placementsByUser = new Map<string, PlacementsRow>();
    for (const pl of (placementsRes.data ?? []) as PlacementsRow[]) {
      placementsByUser.set(pl.user_id, pl);
    }
    const medalsByUser = new Map<string, Medals>();
    for (const s of stats) {
      const pl = placementsByUser.get(s.user_id);
      medalsByUser.set(s.user_id, {
        first: s.championships,
        second: pl?.second_places ?? 0,
        third: pl?.third_places ?? 0,
      });
    }

    const namesByUser = await fetchUserNames(stats.map((s) => s.user_id));

    setTiers(defaultTiers);
    setRows(buildRankingRows(stats, pointsByUser, medalsByUser, namesByUser, prodecByUserFromRows(pointsRows)));
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
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <RankingTable
      rows={rows}
      emptyText="Todavía nadie jugó en este workspace."
      legendText={buildRankingLegend(tiers)}
      onPressRow={(r) =>
        navigation.navigate('PlayerPointsDetail', { userId: r.userId, workspaceId, playerName: r.name })
      }
    />
  );
}

const styles = StyleSheet.create({
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
