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
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
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
  oficialesBO3: { winsA: number; winsB: number };
  venganzas: { winsA: number; winsB: number };
  sinContextoBO1: { winsA: number; winsB: number };
  sinContextoBO3: { winsA: number; winsB: number };
};

type ExtraStats = {
  eventsA: number;
  eventsB: number;
  personalMatchesA: { oficiales: number; venganzas: number; sinContexto: number };
  personalMatchesB: { oficiales: number; venganzas: number; sinContexto: number };
  topTypeA: Array<{ type: string; count: number; total: number }>;
  topTypeB: Array<{ type: string; count: number; total: number }>;
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
    oficialesBO3: { winsA: 0, winsB: 0 },
    venganzas: { winsA: 0, winsB: 0 },
    sinContextoBO1: { winsA: 0, winsB: 0 },
    sinContextoBO3: { winsA: 0, winsB: 0 },
  });
  const [extraStats, setExtraStats] = useState<ExtraStats | null>(null);
  const [activeEncounterId, setActiveEncounterId] = useState<string | null>(null);
  const [activeEncounterType, setActiveEncounterType] = useState<'bo1' | 'bo3' | null>(null);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [aborting, setAborting] = useState(false);
  const initialFocusRef = useRef(true);

  const load = useCallback(async () => {
    // Phase 1: parallel queries
    const [usersRes, presenceRes, h2hRes, cfEncRes, activeEncRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, username, display_name')
        .in('id', [userAId, userBId]),
      supabase
        .from('playground_presence')
        .select('user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny, name )')
        .eq('workspace_id', workspaceId)
        .in('user_id', [userAId, userBId]),
      supabase
        .from('v_head_to_head_stats')
        .select('revenge_matches_won, revenge_matches_lost')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userAId)
        .eq('opponent_user_id', userBId)
        .maybeSingle(),
      supabase
        .from('context_free_encounters')
        .select('id, winner_user_id, encounter_type')
        .eq('workspace_id', workspaceId)
        .or(
          `and(user_a_id.eq.${userAId},user_b_id.eq.${userBId}),and(user_a_id.eq.${userBId},user_b_id.eq.${userAId})`
        )
        .not('ended_at', 'is', null),
      supabase
        .from('context_free_encounters')
        .select('id, encounter_type')
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

    const h2h = h2hRes.data as { revenge_matches_won: number; revenge_matches_lost: number } | null;

    const cfEncs = (cfEncRes.data ?? []) as Array<{ id: string; winner_user_id: string | null; encounter_type: string }>;
    const cfBO1 = cfEncs.filter((e) => e.encounter_type === 'bo1');
    const cfBO3 = cfEncs.filter((e) => e.encounter_type === 'bo3');

    const activeEnc = activeEncRes.data as { id: string; encounter_type: 'bo1' | 'bo3' } | null;
    setActiveEncounterId(activeEnc?.id ?? null);
    setActiveEncounterType(activeEnc?.encounter_type ?? null);

    // Phase 2: active match for resume button
    let currentActiveMatchId: string | null = null;
    if (activeEnc?.id) {
      const { data: activeMatchData } = await supabase
        .from('context_free_matches')
        .select('id')
        .eq('encounter_id', activeEnc.id)
        .is('ended_at', null)
        .limit(1)
        .maybeSingle();
      currentActiveMatchId = (activeMatchData as { id: string } | null)?.id ?? null;
    }
    setActiveMatchId(currentActiveMatchId);

    // Phase 3: oficiales — individual match wins + BO3 encounter wins
    let bo3WinsA = 0, bo3WinsB = 0;
    let individualWinsA = 0, individualWinsB = 0;

    const epARes = await supabase
      .from('event_participants')
      .select('id, event_id, role, draft_events!inner(competition_format, event_type)')
      .eq('user_id', userAId)
      .eq('draft_events.workspace_id', workspaceId);

    const epAData = (epARes.data ?? []) as unknown as Array<{
      id: string;
      event_id: string;
      role: string;
      draft_events: { competition_format: string; event_type: string };
    }>;

    const eventsA = epAData.filter(
      (ep) => ep.role === 'player' && ep.draft_events.event_type !== 'two_headed_giant'
    ).length;

    const epAIds = epAData.map((ep) => ep.id);

    if (epAIds.length > 0) {
      const epAIdSet = new Set(epAIds);
      const formatByEventId = new Map(epAData.map((ep) => [ep.event_id, ep.draft_events.competition_format]));

      const epBRes = await supabase
        .from('event_participants')
        .select('id, event_id')
        .eq('user_id', userBId)
        .in('event_id', epAData.map((ep) => ep.event_id));

      const epBData = epBRes.data ?? [];
      const epBIds = epBData.map((ep) => ep.id);
      const epBIdSet = new Set(epBIds);

      if (epBIds.length > 0) {
        const allIds = [...epAIds, ...epBIds];
        const { data: pairingsData } = await supabase
          .from('pairings')
          .select('id, participant_a_id, participant_b_id, event_id, official_winner_participant_id')
          .in('participant_a_id', allIds)
          .in('participant_b_id', allIds);

        const rawPairings = (pairingsData ?? []) as Array<{
          id: string;
          participant_a_id: string;
          participant_b_id: string;
          event_id: string;
          official_winner_participant_id: string | null;
        }>;

        const h2hPairingIds: string[] = [];
        const pairingUserAPartMap = new Map<string, string>();

        for (const p of rawPairings) {
          const aIsEpA = epAIdSet.has(p.participant_a_id);
          const bIsEpB = epBIdSet.has(p.participant_b_id);
          const aIsEpB = epBIdSet.has(p.participant_a_id);
          const bIsEpA = epAIdSet.has(p.participant_b_id);
          if (!((aIsEpA && bIsEpB) || (aIsEpB && bIsEpA))) continue;

          const partAIsUserA = epAIdSet.has(p.participant_a_id);
          const userAPartId = partAIsUserA ? p.participant_a_id : p.participant_b_id;
          h2hPairingIds.push(p.id);
          pairingUserAPartMap.set(p.id, userAPartId);

          if (p.official_winner_participant_id && formatByEventId.get(p.event_id) === 'round_robin') {
            if (p.official_winner_participant_id === userAPartId) bo3WinsA++;
            else bo3WinsB++;
          }
        }

        if (h2hPairingIds.length > 0) {
          const { data: matchesData } = await supabase
            .from('matches')
            .select('pairing_id, winner_participant_id')
            .in('pairing_id', h2hPairingIds)
            .eq('status', 'completed')
            .not('winner_participant_id', 'is', null);

          for (const m of (matchesData ?? []) as Array<{ pairing_id: string; winner_participant_id: string | null }>) {
            if (!m.winner_participant_id) continue;
            const uAPartId = pairingUserAPartMap.get(m.pairing_id);
            if (!uAPartId) continue;
            if (m.winner_participant_id === uAPartId) individualWinsA++;
            else individualWinsB++;
          }
        }
      }
    }

    setStats({
      oficiales: { winsA: individualWinsA, winsB: individualWinsB },
      oficialesBO3: { winsA: bo3WinsA, winsB: bo3WinsB },
      venganzas: {
        winsA: h2h?.revenge_matches_won ?? 0,
        winsB: h2h?.revenge_matches_lost ?? 0,
      },
      sinContextoBO1: {
        winsA: cfBO1.filter((e) => e.winner_user_id === userAId).length,
        winsB: cfBO1.filter((e) => e.winner_user_id === userBId).length,
      },
      sinContextoBO3: {
        winsA: cfBO3.filter((e) => e.winner_user_id === userAId).length,
        winsB: cfBO3.filter((e) => e.winner_user_id === userBId).length,
      },
    });

    // Phase 4: extra stats — batch 1 (parallel)
    const [epBAllRes, typeARes, cfEncARes, cfEncBRes] = await Promise.all([
      supabase
        .from('event_participants')
        .select('id, event_id, role, draft_events!inner(event_type)')
        .eq('user_id', userBId)
        .eq('draft_events.workspace_id', workspaceId),
      (epAData.length > 0
        ? supabase
            .from('event_participant_avatar_history')
            .select('default_avatars!inner(pokemon_type)')
            .eq('user_id', userAId)
            .in('event_id', epAData.map((ep) => ep.event_id))
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      supabase
        .from('context_free_encounters')
        .select('id')
        .eq('workspace_id', workspaceId)
        .or(`user_a_id.eq.${userAId},user_b_id.eq.${userAId}`),
      supabase
        .from('context_free_encounters')
        .select('id')
        .eq('workspace_id', workspaceId)
        .or(`user_a_id.eq.${userBId},user_b_id.eq.${userBId}`),
    ]);

    const epBAllData = (epBAllRes.data ?? []) as unknown as Array<{
      id: string;
      event_id: string;
      role: string;
      draft_events: { event_type: string };
    }>;
    const eventsB = epBAllData.filter(
      (ep) => ep.role === 'player' && ep.draft_events.event_type !== 'two_headed_giant'
    ).length;
    const workspaceEventIdsB = epBAllData.map((ep) => ep.event_id);
    const epBParticipantIds = epBAllData.map((ep) => ep.id);
    const cfEncIdsA = ((cfEncARes.data ?? []) as Array<{ id: string }>).map((e) => e.id);
    const cfEncIdsB = ((cfEncBRes.data ?? []) as Array<{ id: string }>).map((e) => e.id);

    // Phase 4: batch 2 (parallel, needs epBAllData + cfEncIds)
    const [typeBRes, cfMatchesARes, cfMatchesBRes, aPairingMatchRes, bPairingMatchRes] = await Promise.all([
      (workspaceEventIdsB.length > 0
        ? supabase
            .from('event_participant_avatar_history')
            .select('default_avatars!inner(pokemon_type)')
            .eq('user_id', userBId)
            .in('event_id', workspaceEventIdsB)
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      (cfEncIdsA.length > 0
        ? supabase
            .from('context_free_matches')
            .select('id')
            .in('encounter_id', cfEncIdsA)
            .not('winner_user_id', 'is', null)
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      (cfEncIdsB.length > 0
        ? supabase
            .from('context_free_matches')
            .select('id')
            .in('encounter_id', cfEncIdsB)
            .not('winner_user_id', 'is', null)
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      (epAIds.length > 0
        ? supabase
            .from('pairings')
            .select('matches!inner(match_type)')
            .or(`participant_a_id.in.(${epAIds.join(',')}),participant_b_id.in.(${epAIds.join(',')})`)
            .eq('matches.status', 'completed')
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
      (epBParticipantIds.length > 0
        ? supabase
            .from('pairings')
            .select('matches!inner(match_type)')
            .or(`participant_a_id.in.(${epBParticipantIds.join(',')}),participant_b_id.in.(${epBParticipantIds.join(',')})`)
            .eq('matches.status', 'completed')
        : Promise.resolve({ data: null, error: null })
      ) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
    ]);

    const countMatchTypes = (data: unknown[] | null) => {
      let oficiales = 0;
      let venganzas = 0;
      for (const p of (data ?? []) as Array<{ matches: Array<{ match_type: string }> }>) {
        for (const m of (p.matches ?? [])) {
          if (['draft', 'tiebreak', 'final'].includes(m.match_type)) oficiales++;
          else if (m.match_type === 'revenge') venganzas++;
        }
      }
      return { oficiales, venganzas };
    };
    const { oficiales: aOficiales, venganzas: aVenganzas } = countMatchTypes(aPairingMatchRes.data);
    const { oficiales: bOficiales, venganzas: bVenganzas } = countMatchTypes(bPairingMatchRes.data);

    const computeTopType = (rows: unknown[]): Array<{ type: string; count: number; total: number }> => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const da = r.default_avatars;
        const resolved = Array.isArray(da)
          ? ((da[0] as Record<string, unknown> | undefined) ?? null)
          : (da as Record<string, unknown> | null);
        const type = resolved?.pokemon_type as string | null | undefined;
        if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      if (counts.size === 0) return [];
      const max = Math.max(...counts.values());
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      return [...counts.entries()]
        .filter(([, c]) => c === max)
        .map(([type, count]) => ({ type, count, total }));
    };

    setExtraStats({
      eventsA,
      eventsB,
      personalMatchesA: {
        oficiales: aOficiales,
        venganzas: aVenganzas,
        sinContexto: (cfMatchesARes.data ?? []).length,
      },
      personalMatchesB: {
        oficiales: bOficiales,
        venganzas: bVenganzas,
        sinContexto: (cfMatchesBRes.data ?? []).length,
      },
      topTypeA: computeTopType(typeARes.data ?? []),
      topTypeB: computeTopType(typeBRes.data ?? []),
    });
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
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'ContextFreeMatches', { workspaceId }),
    });
  }, [navigation, workspaceId]);

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

  const handleResume = async () => {
    if (!activeEncounterId) return;
    if (activeMatchId) {
      navigation.navigate('ContextFreeLifeTracker', {
        matchId: activeMatchId,
        encounterId: activeEncounterId,
        workspaceId,
      });
      return;
    }
    // No open match yet (intermediate BO3 between matches) — create next one
    const { data: existing } = await supabase
      .from('context_free_matches')
      .select('id')
      .eq('encounter_id', activeEncounterId);
    const nextNumber = (existing?.length ?? 0) + 1;
    const { data: newMatch } = await supabase
      .from('context_free_matches')
      .insert({ encounter_id: activeEncounterId, match_number: nextNumber, starting_life_a: 20, starting_life_b: 20 })
      .select('id')
      .single();
    if (!newMatch) {
      Alert.alert('Error', 'No se pudo crear la siguiente partida.');
      return;
    }
    navigation.navigate('ContextFreeLifeTracker', {
      matchId: (newMatch as { id: string }).id,
      encounterId: activeEncounterId,
      workspaceId,
    });
  };

  const handleAbort = () => {
    if (!activeEncounterId) return;
    const typeLabel = activeEncounterType === 'bo3' ? 'enfrentamiento' : 'partida';
    Alert.alert(
      `Abortar ${typeLabel}`,
      `¿Querés abortar el ${typeLabel} en curso? No se registrará un ganador.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Abortar',
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
    stats.oficialesBO3.winsA + stats.oficialesBO3.winsB +
    stats.venganzas.winsA + stats.venganzas.winsB +
    stats.sinContextoBO1.winsA + stats.sinContextoBO1.winsB +
    stats.sinContextoBO3.winsA + stats.sinContextoBO3.winsB > 0;

  const hasOficiales =
    stats.oficiales.winsA + stats.oficiales.winsB +
    stats.oficialesBO3.winsA + stats.oficialesBO3.winsB > 0;
  const hasSinContexto =
    stats.sinContextoBO1.winsA + stats.sinContextoBO1.winsB +
    stats.sinContextoBO3.winsA + stats.sinContextoBO3.winsB > 0;

  const renderH2HSection = (title: string | null, winsA: number, winsB: number) => {
    const total = winsA + winsB;
    const pctA = total > 0 ? Math.round((winsA / total) * 100) : null;
    const pctB = total > 0 ? Math.round((winsB / total) * 100) : null;
    return (
      <View style={styles.h2hSection}>
        {title !== null ? <Text style={styles.h2hSectionTitle}>{title}</Text> : null}
        <View style={styles.statsRow}>
          <View style={styles.statCell}>
            <Text style={styles.statNum}>{winsA}</Text>
            {pctA !== null ? <Text style={styles.statPct}>{pctA}%</Text> : null}
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statNum}>{total}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statNum}>{winsB}</Text>
            {pctB !== null ? <Text style={styles.statPct}>{pctB}%</Text> : null}
          </View>
        </View>
      </View>
    );
  };

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
        </View>
        <Text style={styles.vs}>vs</Text>
        <View style={styles.playerCard}>
          {renderAvatar(userB, 64)}
          <Text style={styles.playerName}>{displayName(userB)}</Text>
        </View>
      </View>

      {isParticipant ? (
        <View style={styles.actions}>
          {activeEncounterId ? (
            <TouchableOpacity
              style={styles.startBtn}
              onPress={() => void handleResume()}
            >
              <Text style={styles.startBtnText}>
                {activeEncounterType === 'bo3' ? 'Retomar enfrentamiento' : 'Retomar partida'}
              </Text>
            </TouchableOpacity>
          ) : (
            <>
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
            </>
          )}
          {activeEncounterId ? (
            <TouchableOpacity
              style={[styles.abortBtn, aborting && styles.disabledBtn]}
              onPress={handleAbort}
              disabled={aborting}
            >
              {aborting ? (
                <ActivityIndicator color="#DC2626" />
              ) : (
                <Text style={styles.abortBtnText}>
                  {activeEncounterType === 'bo1'
                    ? '🗑 Abortar partida en curso'
                    : '🗑 Abortar enfrentamiento en curso'}
                </Text>
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

          {hasOficiales ? (
            <View style={styles.h2hGroup}>
              <Text style={styles.h2hGroupTitle}>Oficiales</Text>
              {stats.oficiales.winsA + stats.oficiales.winsB > 0
                ? renderH2HSection('Partidas', stats.oficiales.winsA, stats.oficiales.winsB)
                : null}
              {stats.oficialesBO3.winsA + stats.oficialesBO3.winsB > 0
                ? renderH2HSection('BO3', stats.oficialesBO3.winsA, stats.oficialesBO3.winsB)
                : null}
            </View>
          ) : null}

          {stats.venganzas.winsA + stats.venganzas.winsB > 0 ? (
            <View style={styles.h2hGroup}>
              <Text style={styles.h2hGroupTitle}>Venganzas</Text>
              {renderH2HSection(null, stats.venganzas.winsA, stats.venganzas.winsB)}
            </View>
          ) : null}

          {hasSinContexto ? (
            <View style={styles.h2hGroup}>
              <Text style={styles.h2hGroupTitle}>Sin contexto</Text>
              {stats.sinContextoBO1.winsA + stats.sinContextoBO1.winsB > 0
                ? renderH2HSection('BO1', stats.sinContextoBO1.winsA, stats.sinContextoBO1.winsB)
                : null}
              {stats.sinContextoBO3.winsA + stats.sinContextoBO3.winsB > 0
                ? renderH2HSection('BO3', stats.sinContextoBO3.winsA, stats.sinContextoBO3.winsB)
                : null}
            </View>
          ) : null}
        </View>
      ) : (
        <Text style={styles.noHistory}>Sin historial previo entre estos jugadores.</Text>
      )}

      {extraStats ? (
        <View style={styles.extraCard}>
          <View style={styles.extraSection}>
            <Text style={styles.extraTitle}>Participaciones en drafts</Text>
            <View style={styles.extraRow}>
              <View style={styles.extraCell}>
                <Text style={styles.extraNum}>{extraStats.eventsA}</Text>
                <Text style={styles.extraLabel}>{displayName(userA)}</Text>
              </View>
              <View style={styles.extraCell}>
                <Text style={styles.extraNum}>{extraStats.eventsB}</Text>
                <Text style={styles.extraLabel}>{displayName(userB)}</Text>
              </View>
            </View>
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.extraTitle}>Partidas totales</Text>
            <View style={styles.extraRow}>
              <View style={[styles.extraCell, styles.extraCellLabel]} />
              <View style={styles.extraCell}>
                <Text style={styles.extraNameLabel}>{userA ? displayName(userA) : '—'}</Text>
              </View>
              <View style={styles.extraCell}>
                <Text style={styles.extraNameLabel}>{userB ? displayName(userB) : '—'}</Text>
              </View>
            </View>
            {[
              { label: 'Oficiales', a: extraStats.personalMatchesA.oficiales, b: extraStats.personalMatchesB.oficiales },
              { label: 'Venganzas', a: extraStats.personalMatchesA.venganzas, b: extraStats.personalMatchesB.venganzas },
              { label: 'Sin contexto', a: extraStats.personalMatchesA.sinContexto, b: extraStats.personalMatchesB.sinContexto },
            ].map(({ label, a, b }) => (
              <View key={label} style={styles.extraRow}>
                <View style={[styles.extraCell, styles.extraCellLabel]}>
                  <Text style={styles.extraLabel}>{label}</Text>
                </View>
                <View style={styles.extraCell}>
                  <Text style={styles.extraNum}>{a}</Text>
                </View>
                <View style={styles.extraCell}>
                  <Text style={styles.extraNum}>{b}</Text>
                </View>
              </View>
            ))}
          </View>

          {extraStats.topTypeA.length > 0 || extraStats.topTypeB.length > 0 ? (
            <View style={styles.extraSection}>
              <Text style={styles.extraTitle}>Tipo Pokémon más frecuente</Text>
              <View style={styles.extraRow}>
                <View style={styles.extraCell}>
                  {extraStats.topTypeA.length > 0 ? (
                    <>
                      <Text style={styles.extraNum}>
                        {extraStats.topTypeA.map((t) => t.type).join(' / ')}
                      </Text>
                      <Text style={styles.extraLabel}>
                        {extraStats.topTypeA[0]!.count}/{extraStats.topTypeA[0]!.total}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.extraLabel}>-</Text>
                  )}
                  <Text style={styles.extraNameLabel}>{displayName(userA)}</Text>
                </View>
                <View style={styles.extraCell}>
                  {extraStats.topTypeB.length > 0 ? (
                    <>
                      <Text style={styles.extraNum}>
                        {extraStats.topTypeB.map((t) => t.type).join(' / ')}
                      </Text>
                      <Text style={styles.extraLabel}>
                        {extraStats.topTypeB[0]!.count}/{extraStats.topTypeB[0]!.total}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.extraLabel}>-</Text>
                  )}
                  <Text style={styles.extraNameLabel}>{displayName(userB)}</Text>
                </View>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
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
  h2hGroup: {
    marginBottom: 8,
  },
  h2hGroupTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    textAlign: 'center',
    marginBottom: 4,
    marginTop: 4,
  },
  h2hSection: { marginBottom: 10 },
  h2hSectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textAlign: 'center',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  statCell: { alignItems: 'center', flex: 1 },
  statNum: { fontSize: 18, fontWeight: '800', color: '#111' },
  statPct: { fontSize: 12, fontWeight: '600', color: '#6B7280', marginTop: 1 },
  statLabel: { fontSize: 11, color: '#6B7280', marginTop: 2, textAlign: 'center' },
  noHistory: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingHorizontal: 32,
    paddingTop: 28,
    paddingBottom: 8,
  },
  extraCard: {
    margin: 16,
    marginTop: 12,
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 16,
  },
  extraSection: { gap: 8 },
  extraTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  extraRow: { flexDirection: 'row', justifyContent: 'space-around' },
  extraCell: { alignItems: 'center', flex: 1, gap: 2 },
  extraCellLabel: { alignItems: 'flex-start', flex: 1.2 },
  extraNum: { fontSize: 16, fontWeight: '800', color: '#111', textAlign: 'center' },
  extraLabel: { fontSize: 11, color: '#6B7280', textAlign: 'center' },
  extraNameLabel: { fontSize: 10, color: '#9CA3AF', marginTop: 2, textAlign: 'center' },
});
