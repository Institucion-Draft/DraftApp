import React, { useCallback, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
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
  fetchUserDisplayName,
  fetchWorkspaceMemberIds,
  formatAchievementPercent,
  type AchievementDefinition,
  type AchievementUnlock,
} from '../lib/achievements';
import { formatBaDate } from '../lib/seasons';
import { useTheme, useThemedStyles } from '../theme';
import type { ThemeColors } from '../theme';

type Props = NativeStackScreenProps<MainStackParamList, 'AchievementDetail'>;

/**
 * Detalle de un logro para un usuario y una temporada. Se llega desde el Medallero, la Lista, o un
 * mensaje de logro de una bitácora (por eso `userId` puede no ser el usuario actual).
 */
export default function AchievementDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { achievementId, seasonId, userId, workspaceId, from, eventId } = route.params;
  const { user } = useAuth();
  const isMine = user?.id === userId;

  const [loading, setLoading] = useState(true);
  const [definition, setDefinition] = useState<AchievementDefinition | null>(null);
  const [unlock, setUnlock] = useState<AchievementUnlock | null>(null);
  const [percent, setPercent] = useState(0);
  const [ownerName, setOwnerName] = useState('');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft:
        from === 'EventDiary' && eventId
          ? hierarchicalHeaderBack(navigation, 'EventDiary', { eventId }, true)
          : hierarchicalHeaderBack(navigation, 'Achievements', { workspaceId, seasonId }, true),
    });
  }, [navigation, from, eventId, workspaceId, seasonId]);

  const load = useCallback(async () => {
    const [defs, unlocks, memberIds, name] = await Promise.all([
      fetchAchievementDefinitions(),
      fetchSeasonUnlocks(seasonId),
      fetchWorkspaceMemberIds(workspaceId),
      isMine ? Promise.resolve('') : fetchUserDisplayName(userId),
    ]);
    const def = defs.find((d) => d.id === achievementId) ?? null;
    setDefinition(def);
    setUnlock(unlocks.find((u) => u.achievement_id === achievementId && u.user_id === userId) ?? null);
    setPercent(def ? (computeAchievementStats([def], unlocks, memberIds).get(def.id)?.percent ?? 0) : 0);
    setOwnerName(name);
    setLoading(false);
  }, [achievementId, seasonId, workspaceId, userId, isMine]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!definition) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el logro.</Text>
      </View>
    );
  }

  const unlocked = unlock != null;
  // Un secreto bloqueado (para el usuario cuyo logro se mira) no revela nombre ni descripción.
  const shownName = achievementDisplayName(definition, unlocked);
  const shownDescription = achievementDisplayDescription(definition, unlocked);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <AchievementMedal slot={definition.icon_slot} unlocked={unlocked} size={104} />
      <Text style={[styles.name, !unlocked && styles.nameOff]}>{shownName}</Text>
      {shownDescription ? <Text style={styles.description}>{shownDescription}</Text> : null}
      {unlocked && unlock ? (
        <>
          {!isMine && ownerName ? <Text style={styles.owner}>Logro de {ownerName}</Text> : null}
          <Text style={styles.date}>Obtenido el {formatBaDate(unlock.unlocked_at)}</Text>
        </>
      ) : null}
      <Text style={styles.percent}>{formatAchievementPercent(percent)} de los miembros lo tiene</Text>
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background },
    muted: { fontSize: 15, color: c.textSecondary, textAlign: 'center' },
    content: { alignItems: 'center', paddingHorizontal: 28, paddingTop: 36, paddingBottom: 40 },
    name: { fontSize: 28, fontWeight: '800', color: c.text, textAlign: 'center', marginTop: 20 },
    nameOff: { color: c.textMuted },
    description: { fontSize: 16, color: c.textBody, textAlign: 'center', lineHeight: 23, marginTop: 14 },
    owner: { fontSize: 15, fontWeight: '600', color: c.textSecondary, marginTop: 22 },
    date: { fontSize: 20, fontWeight: '800', color: c.achievement.text, marginTop: 6, textAlign: 'center' },
    percent: { fontSize: 12, color: c.textMuted, marginTop: 28, textAlign: 'center' },
  });
