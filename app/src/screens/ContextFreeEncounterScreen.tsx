import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeEncounter'>;

type UserInfo = {
  id: string;
  username: string;
  display_name: string;
  presenceAvatar: { storage_path: string; storage_path_shiny: string | null; name: string } | null;
  isShiny: boolean;
};

type H2HStats = {
  oficiales: { winsA: number; winsB: number };
  venganzas: { winsA: number; winsB: number };
  sinContexto: { winsA: number; winsB: number };
};

function displayName(u: UserInfo): string {
  return u.display_name || u.username || 'Jugador';
}

export default function ContextFreeEncounterScreen({ navigation, route }: Props) {
  const { workspaceId, userAId, userBId } = route.params;
  const { user } = useAuth();
  const [userA, setUserA] = useState<UserInfo | null>(null);
  const [userB, setUserB] = useState<UserInfo | null>(null);
  const [stats, setStats] = useState<H2HStats>({
    oficiales: { winsA: 0, winsB: 0 },
    venganzas: { winsA: 0, winsB: 0 },
    sinContexto: { winsA: 0, winsB: 0 },
  });
  const [activeEncounterId, setActiveEncounterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [aborting, setAborting] = useState(false);
  const initialFocusRef = useRef(true);

  const load = useCallback(async () => {
    const [usersRes, presenceRes, officialH2HRes, cfEncRes, activeEncRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, username, display_name')
        .in('id', [userAId, userBId]),
      supabase
        .from('playground_presence')
        .select(
          'user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny, name )'
        )
        .eq('workspace_id', workspaceId)
        .in('user_id', [userAId, userBId]),
      supabase
        .from('v_head_to_head_stats')
        .select('draft_matches_won, draft_matches_lost, revenge_matches_won, revenge_matches_lost')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userAId)
        .eq('opponent_user_id', userBId)
        .maybeSingle(),
      supabase
        .from('context_free_encounters')
        .select('winner_user_id')
        .eq('workspace_id', workspaceId)
        .or(
          `and(user_a_id.eq.${userAId},user_b_id.eq.${userBId}),and(user_a_id.eq.${userBId},user_b_id.eq.${userAId})`
        )
        .not('ended_at', 'is', null),
      supabase
        .from('context_free_encounters')
        .select('id')
        .eq('workspace_id', workspaceId)
        .or(
          `and(user_a_id.eq.${userAId},user_b_id.eq.${userBId}),and(user_a_id.eq.${userBId},user_b_id.eq.${userAId})`
        )
        .is('ended_at', null)
        .limit(1)
        .maybeSingle(),
    ]);

    if (usersRes.error || presenceRes.error) {
      if (__DEV__) {
        console.error('ContextFreeEncounter load error:', usersRes.error ?? presenceRes.error);
      }
      return;
    }

    const usersData = usersRes.data ?? [];
    const presenceData = (presenceRes.data ?? []) as unknown as Array<{
      user_id: string;
      is_shiny: boolean;
      default_avatars: { storage_path: string; storage_path_shiny: string | null; name: string } | null;
    }>;

    const makeUser = (id: string): UserInfo => {
      const u = usersData.find((x) => x.id === id);
      const p = presenceData.find((x) => x.user_id === id);
      return {
        id,
        username: u?.username ?? '',
        display_name: u?.display_name ?? '',
        presenceAvatar: p?.default_avatars ?? null,
        isShiny: p?.is_shiny ?? false,
      };
    };

    setUserA(makeUser(userAId));
    setUserB(makeUser(userBId));

    const h2h = officialH2HRes.data as {
      draft_matches_won: number;
      draft_matches_lost: number;
      revenge_matches_won: number;
      revenge_matches_lost: number;
    } | null;

    const cfEncs = cfEncRes.data ?? [];
    const cfWinsA = cfEncs.filter((e) => e.winner_user_id === userAId).length;
    const cfWinsB = cfEncs.filter((e) => e.winner_user_id === userBId).length;

    setStats({
      oficiales: {
        winsA: h2h?.draft_matches_won ?? 0,
        winsB: h2h?.draft_matches_lost ?? 0,
      },
      venganzas: {
        winsA: h2h?.revenge_matches_won ?? 0,
        winsB: h2h?.revenge_matches_lost ?? 0,
      },
      sinContexto: { winsA: cfWinsA, winsB: cfWinsB },
    });

    const activeEnc = activeEncRes.data as { id: string } | null;
    setActiveEncounterId(activeEnc?.id ?? null);
  }, [workspaceId, userAId, userBId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const first = initialFocusRef.current;
        if (first) {
          setLoading(true);
          initialFocusRef.current = false;
        }
        await load();
        if (!cancelled && first) setLoading(false);
      })();
      return () => { cancelled = true; };
    }, [load])
  );

  useLayoutEffect(() => {
    if (userA && userB) {
      navigation.setOptions({
        title: `${displayName(userA)} vs ${displayName(userB)}`,
      });
    }
  }, [navigation, userA, userB]);

  const handleStart = (encounterType: 'bo1' | 'bo3') => {
    navigation.navigate('ContextFreeColorPick', {
      workspaceId,
      userAId,
      userBId,
      encounterType,
    });
  };

  const handleAbort = () => {
    if (!activeEncounterId) return;
    Alert.alert(
      'Abandonar enfrentamiento',
      '¿Querés abandonar el enfrentamiento en curso? No se registrará un ganador.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Abandonar',
          style: 'destructive',
          onPress: async () => {
            setAborting(true);
            const now = new Date().toISOString();
            await Promise.all([
              supabase
                .from('context_free_encounters')
                .update({ ended_at: now })
                .eq('id', activeEncounterId),
              supabase
                .from('context_free_matches')
                .update({ ended_at: now })
                .eq('encounter_id', activeEncounterId)
                .is('ended_at', null),
            ]);
            setAborting(false);
            await load();
          },
        },
      ]
    );
  };

  const renderAvatar = (u: UserInfo, size: number) => {
    const da = u.presenceAvatar;
    if (!da) return null;
    const path = u.isShiny && da.storage_path_shiny ? da.storage_path_shiny : da.storage_path;
    const url = defaultAvatarPublicUrl(path);
    if (!url) return null;
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="contain"
      />
    );
  };

  if (loading || !userA || !userB) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const isParticipant =
    user?.id != null && (user.id === userAId || user.id === userBId);

  const hasAnyHistory =
    stats.oficiales.winsA + stats.oficiales.winsB +
    stats.venganzas.winsA + stats.venganzas.winsB +
    stats.sinContexto.winsA + stats.sinContexto.winsB > 0;

  const renderH2HSection = (
    title: string,
    winsA: number,
    winsB: number
  ) => (
    <View style={styles.h2hSection}>
      <Text style={styles.h2hSectionTitle}>{title}</Text>
      <View style={styles.statsRow}>
        <View style={styles.statCell}>
          <Text style={styles.statNum}>{winsA}</Text>
          <Text style={styles.statLabel}>{displayName(userA)}</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statNum}>{winsA + winsB}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
        <View style={styles.statCell}>
          <Text style={styles.statNum}>{winsB}</Text>
          <Text style={styles.statLabel}>{displayName(userB)}</Text>
        </View>
      </View>
    </View>
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={styles.playersRow}>
        <View style={styles.playerCard}>
          {renderAvatar(userA, 64)}
          <Text style={styles.playerName}>{displayName(userA)}</Text>
          {userA.presenceAvatar ? (
            <Text style={styles.pokemonName}>
              {userA.presenceAvatar.name}{userA.isShiny ? ' ✨' : ''}
            </Text>
          ) : null}
        </View>
        <Text style={styles.vs}>vs</Text>
        <View style={styles.playerCard}>
          {renderAvatar(userB, 64)}
          <Text style={styles.playerName}>{displayName(userB)}</Text>
          {userB.presenceAvatar ? (
            <Text style={styles.pokemonName}>
              {userB.presenceAvatar.name}{userB.isShiny ? ' ✨' : ''}
            </Text>
          ) : null}
        </View>
      </View>

      {isParticipant ? (
        <View style={styles.actions}>
          <TouchableOpacity style={styles.startBtn} onPress={() => handleStart('bo1')}>
            <Text style={styles.startBtnText}>Iniciar Partida (BO1)</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.startBtn, styles.startBtnSecondary]}
            onPress={() => handleStart('bo3')}
          >
            <Text style={[styles.startBtnText, styles.startBtnTextSecondary]}>
              Iniciar Enfrentamiento (BO3)
            </Text>
          </TouchableOpacity>
          {activeEncounterId ? (
            <TouchableOpacity
              style={[styles.abortBtn, aborting && styles.disabledBtn]}
              onPress={handleAbort}
              disabled={aborting}
            >
              {aborting ? (
                <ActivityIndicator color="#DC2626" />
              ) : (
                <Text style={styles.abortBtnText}>🗑 Abandonar enfrentamiento en curso</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <Text style={styles.spectatorNote}>
          Solo los participantes pueden iniciar el encuentro.
        </Text>
      )}

      {hasAnyHistory ? (
        <View style={styles.historyCard}>
          <Text style={styles.historyCardTitle}>Historial</Text>
          {renderH2HSection('Oficiales', stats.oficiales.winsA, stats.oficiales.winsB)}
          {renderH2HSection('Venganzas', stats.venganzas.winsA, stats.venganzas.winsB)}
          {renderH2HSection('Sin contexto', stats.sinContexto.winsA, stats.sinContexto.winsB)}
        </View>
      ) : (
        <Text style={styles.noHistory}>Sin historial previo entre estos jugadores.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  playersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  playerCard: { alignItems: 'center', flex: 1 },
  playerName: { fontSize: 15, fontWeight: '700', color: '#111', marginTop: 8, textAlign: 'center' },
  pokemonName: { fontSize: 12, color: '#6B7280', marginTop: 2, textAlign: 'center' },
  vs: { fontSize: 20, fontWeight: '700', color: '#9CA3AF', marginHorizontal: 8 },
  actions: { paddingHorizontal: 16, paddingTop: 24, gap: 10 },
  startBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  startBtnSecondary: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#3B82F6',
  },
  startBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  startBtnTextSecondary: { color: '#3B82F6' },
  abortBtn: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  abortBtnText: { color: '#DC2626', fontSize: 14, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },
  spectatorNote: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingHorizontal: 32,
    paddingTop: 32,
  },
  historyCard: {
    margin: 16,
    marginTop: 24,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  historyCardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  h2hSection: { marginBottom: 12 },
  h2hSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 8,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  statCell: { alignItems: 'center' },
  statNum: { fontSize: 24, fontWeight: '800', color: '#111' },
  statLabel: { fontSize: 11, color: '#6B7280', marginTop: 2, textAlign: 'center' },
  noHistory: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingHorizontal: 32,
    paddingTop: 28,
    paddingBottom: 8,
  },
});
