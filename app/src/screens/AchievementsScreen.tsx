import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import AchievementMedal from '../components/AchievementMedal';
import {
  achievementDisplayDescription,
  achievementDisplayName,
  computeAchievementStats,
  fetchAchievementDefinitions,
  fetchSeasonUnlocks,
  fetchWorkspaceMemberIds,
  formatAchievementPercent,
  isAchievementRevealed,
  markAchievementsSeen,
  type AchievementDefinition,
  type AchievementStat,
  type AchievementUnlock,
} from '../lib/achievements';
import { formatBaDate } from '../lib/seasons';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'Achievements'>;

type Tab = 'medallero' | 'lista';

const MEDALS_PER_ROW = 3;

export default function AchievementsScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { workspaceId, seasonId } = route.params;
  const { user } = useAuth();
  const myUserId = user?.id ?? null;

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('medallero');
  const [seasonName, setSeasonName] = useState('');
  const [definitions, setDefinitions] = useState<AchievementDefinition[]>([]);
  const [unlocks, setUnlocks] = useState<AchievementUnlock[]>([]);
  const [stats, setStats] = useState<Map<string, AchievementStat>>(new Map());

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'WorkspaceSeason', { workspaceId, seasonId }, true),
    });
  }, [navigation, workspaceId, seasonId]);

  const load = useCallback(async () => {
    const [defs, seasonUnlocks, memberIds, seasonRes] = await Promise.all([
      fetchAchievementDefinitions(),
      fetchSeasonUnlocks(seasonId),
      fetchWorkspaceMemberIds(workspaceId),
      supabase.from('v_seasons').select('name').eq('season_id', seasonId).maybeSingle(),
    ]);
    setDefinitions(defs);
    setUnlocks(seasonUnlocks);
    setStats(computeAchievementStats(defs, seasonUnlocks, memberIds));
    setSeasonName((seasonRes.data as { name?: string } | null)?.name ?? '');
    setLoading(false);

    // Entrar a la pantalla apaga el indicador de "no visto" de esta temporada.
    if (myUserId && seasonUnlocks.some((u) => u.user_id === myUserId && u.seen_at == null)) {
      void markAchievementsSeen(seasonId);
    }
  }, [seasonId, workspaceId, myUserId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const mine = useMemo(() => {
    const m = new Map<string, AchievementUnlock>();
    for (const u of unlocks) {
      if (u.user_id === myUserId) m.set(u.achievement_id, u);
    }
    return m;
  }, [unlocks, myUserId]);

  const openDetail = (achievementId: string) => {
    if (!myUserId) return;
    navigation.navigate('AchievementDetail', {
      achievementId,
      seasonId,
      userId: myUserId,
      workspaceId,
      from: 'Achievements',
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const rows: AchievementDefinition[][] = [];
  for (let i = 0; i < definitions.length; i += MEDALS_PER_ROW) {
    rows.push(definitions.slice(i, i + MEDALS_PER_ROW));
  }

  const renderMedallero = () => (
    <ScrollView contentContainerStyle={styles.medalleroContent}>
      {/* Placeholder de la ilustración final (alguien abriendo una campera y mostrando las medallas
          colgadas en el forro): un abrigo y un forro con las medallas numeradas. */}
      <Text style={styles.coatEmoji}>🧥</Text>
      <Text style={styles.coatCaption}>
        {mine.size} de {definitions.length} medallas
      </Text>
      <View style={styles.lining}>
        {rows.map((row, ri) => (
          <View key={ri} style={styles.liningRow}>
            {row.map((d) => {
              const unlocked = mine.has(d.id);
              const shownName = achievementDisplayName(d, unlocked);
              return (
                <TouchableOpacity
                  key={d.id}
                  style={styles.medalCell}
                  onPress={() => openDetail(d.id)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    unlocked
                      ? shownName
                      : isAchievementRevealed(d, unlocked)
                        ? `${shownName} (sin conseguir)`
                        : 'Logro secreto (sin conseguir)'
                  }
                >
                  <View style={styles.hook} />
                  <AchievementMedal slot={d.icon_slot} unlocked={unlocked} size={56} />
                  <Text style={[styles.medalName, !unlocked && styles.medalNameOff]} numberOfLines={2}>
                    {shownName}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );

  const renderLista = () => (
    <ScrollView contentContainerStyle={styles.listContent}>
      {definitions.map((d) => {
        const unlock = mine.get(d.id);
        const unlocked = unlock != null;
        const stat = stats.get(d.id);
        const shownName = achievementDisplayName(d, unlocked);
        const shownDescription = achievementDisplayDescription(d, unlocked);
        return (
          <TouchableOpacity
            key={d.id}
            style={styles.listRow}
            onPress={() => openDetail(d.id)}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <AchievementMedal slot={d.icon_slot} unlocked={unlocked} size={48} />
            <View style={styles.listBody}>
              <Text style={[styles.listName, !unlocked && styles.listNameOff]} numberOfLines={2}>
                {shownName}
              </Text>
              {shownDescription ? <Text style={styles.listDesc}>{shownDescription}</Text> : null}
              <Text style={styles.listPercent}>
                {formatAchievementPercent(stat?.percent ?? 0)} de los miembros
              </Text>
            </View>
            {unlock ? <Text style={styles.listDate}>{formatBaDate(unlock.unlocked_at)}</Text> : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  return (
    <View style={styles.screen}>
      {seasonName ? <Text style={styles.seasonName}>{seasonName}</Text> : null}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, tab === 'medallero' && styles.tabActive]}
          onPress={() => setTab('medallero')}
          accessibilityRole="button"
        >
          <Text style={[styles.tabTxt, tab === 'medallero' && styles.tabTxtActive]}>🎯 Medallero</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'lista' && styles.tabActive]}
          onPress={() => setTab('lista')}
          accessibilityRole="button"
        >
          <Text style={[styles.tabTxt, tab === 'lista' && styles.tabTxtActive]}>📋 Lista</Text>
        </TouchableOpacity>
      </View>
      {definitions.length === 0 ? (
        <Text style={styles.empty}>Todavía no hay logros cargados.</Text>
      ) : tab === 'medallero' ? (
        renderMedallero()
      ) : (
        renderLista()
      )}
    </View>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background },
    seasonName: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textSecondary,
      textTransform: 'uppercase',
      textAlign: 'center',
      paddingTop: 12,
    },
    tabBar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
    tab: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: c.backgroundAlt,
    },
    tabActive: { backgroundColor: c.achievement.subtle, borderWidth: 1, borderColor: c.achievement.border },
    tabTxt: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
    tabTxtActive: { color: c.achievement.text },
    empty: { color: c.textSecondary, fontSize: 14, marginTop: 24, textAlign: 'center' },

    // Medallero
    medalleroContent: { paddingHorizontal: 16, paddingBottom: 32, alignItems: 'center' },
    coatEmoji: { fontSize: 64, marginTop: 4 },
    coatCaption: { fontSize: 13, fontWeight: '600', color: c.textSecondary, marginBottom: 12 },
    lining: {
      alignSelf: 'stretch',
      backgroundColor: c.achievement.subtle,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: c.achievement.border,
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 6,
    },
    liningRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 6 },
    medalCell: { flex: 1, alignItems: 'center', paddingVertical: 6, paddingHorizontal: 4 },
    hook: { width: 2, height: 10, backgroundColor: c.achievement.border, marginBottom: 2 },
    medalName: { fontSize: 11, fontWeight: '700', color: c.achievement.text, textAlign: 'center', marginTop: 4 },
    medalNameOff: { color: c.textMuted, fontWeight: '600' },

    // Lista
    listContent: { paddingHorizontal: 16, paddingBottom: 32 },
    listRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.divider,
    },
    listBody: { flex: 1, minWidth: 0 },
    listName: { fontSize: 16, fontWeight: '700', color: c.text },
    listNameOff: { color: c.textMuted, fontWeight: '600' },
    listDesc: { fontSize: 13, color: c.textSecondary, marginTop: 2, lineHeight: 18 },
    listPercent: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    listDate: { fontSize: 12, fontWeight: '600', color: c.achievement.text },
  });
