import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useKeepAwake } from 'expo-keep-awake';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import type { MtgColor } from '../lib/database.types';
import { defaultAvatarPublicUrl } from '../lib/avatarUrl';
import { useLifeTracker } from '../hooks/useLifeTracker';

type Props = NativeStackScreenProps<MainStackParamList, 'ContextFreeLifeTracker'>;

type MatchRow = {
  id: string;
  encounter_id: string;
  match_number: number;
  starting_life_a: number;
  starting_life_b: number;
  winner_user_id: string | null;
  started_by_user_id: string | null;
};

type EncounterRow = {
  id: string;
  encounter_type: 'bo1' | 'bo3';
  user_a_id: string;
  user_b_id: string;
  colors_a: string[];
  colors_b: string[];
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
};

type LifeSnapshot = { a: number; b: number };

function clampLife(value: number): number {
  return Math.max(0, value);
}

const COLOR_BG: Record<MtgColor, string> = {
  W: '#F8FAFC',
  U: '#DBEAFE',
  B: '#374151',
  R: '#FEE2E2',
  G: '#DCFCE7',
  C: '#E5E7EB',
};

function hashSeedString(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRandom(seed: string): () => number {
  let state = hashSeedString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCoordinatedBgColors(
  colorsA: MtgColor[],
  colorsB: MtgColor[],
  seed: string
): { bgA: MtgColor; bgB: MtgColor } {
  const poolA: MtgColor[] = colorsA.length > 0 ? colorsA : ['C'];
  const poolB: MtgColor[] = colorsB.length > 0 ? colorsB : ['C'];
  const rng = createSeededRandom(seed);

  let firstSide: 'a' | 'b';
  if (poolA.length < poolB.length) firstSide = 'a';
  else if (poolB.length < poolA.length) firstSide = 'b';
  else firstSide = rng() < 0.5 ? 'a' : 'b';

  const [firstPool, secondPool] = firstSide === 'a' ? [poolA, poolB] : [poolB, poolA];
  const firstPick = firstPool[Math.floor(rng() * firstPool.length)]!;
  const secondCandidates = secondPool.filter((c) => c !== firstPick);
  const secondPick =
    secondCandidates.length > 0
      ? secondCandidates[Math.floor(rng() * secondCandidates.length)]!
      : firstPick;

  if (firstSide === 'a') return { bgA: firstPick, bgB: secondPick };
  return { bgA: secondPick, bgB: firstPick };
}

export default function ContextFreeLifeTrackerScreen({ route, navigation }: Props) {
  useKeepAwake();
  const { matchId, encounterId, workspaceId, starterUserId } = route.params;
  const [loading, setLoading] = useState(true);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [encounter, setEncounter] = useState<EncounterRow | null>(null);
  const [ua, setUa] = useState<UserRow | null>(null);
  const [ub, setUb] = useState<UserRow | null>(null);
  const [showStarterModal, setShowStarterModal] = useState(false);
  const [colorsA, setColorsA] = useState<MtgColor[]>([]);
  const [colorsB, setColorsB] = useState<MtgColor[]>([]);
  const [winsA, setWinsA] = useState(0);
  const [winsB, setWinsB] = useState(0);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [avatarUriA, setAvatarUriA] = useState<string | null>(null);
  const [avatarUriB, setAvatarUriB] = useState<string | null>(null);

  const historyRef = useRef<LifeSnapshot[]>([]);
  const persistLifeRef = useRef<(side: 'a' | 'b') => Promise<void>>(async () => {});
  const encounterRef = useRef<EncounterRow | null>(null);
  const lifeRealtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const concluding = useRef(false);

  const {
    lifeA: aLife,
    lifeB: bLife,
    stableA,
    setStableA,
    stableB,
    setStableB,
    pendingA,
    setPendingA,
    pendingB,
    setPendingB,
    stableARef,
    stableBRef,
    pendingARef,
    pendingBRef,
    deltaA,
    deltaB,
    diffOpacityA,
    diffOpacityB,
    increment,
    clearTimers,
    clearPendingAdjustments,
    flushAndPersist,
  } = useLifeTracker({
    initialLifeA: 20,
    initialLifeB: 20,
    onFlush: (side) => persistLifeRef.current(side),
    delayMs: 3500,
  });

  const canUndo = historyRef.current.length > 1;

  const concludeMatch = useCallback(
    async (winnerUserId: string) => {
      if (!match || !encounter || concluding.current) return;
      concluding.current = true;
      clearTimers();
      await Promise.all([flushAndPersist('a'), flushAndPersist('b')]);
      const now = new Date().toISOString();

      await supabase
        .from('context_free_matches')
        .update({ winner_user_id: winnerUserId, ended_at: now })
        .eq('id', matchId);

      if (encounter.encounter_type === 'bo1') {
        await Promise.all([
          supabase
            .from('context_free_encounters')
            .update({ winner_user_id: winnerUserId, ended_at: now })
            .eq('id', encounterId),
          supabase
            .from('playground_presence')
            .update({ last_match_ended_at: now })
            .in('user_id', [encounter.user_a_id, encounter.user_b_id])
            .eq('workspace_id', workspaceId),
        ]);
        navigation.replace('ContextFreeMatchResult', {
          winnerId: winnerUserId,
          encounterType: 'bo1',
          winsA: 1,
          winsB: 0,
          userAId: encounter.user_a_id,
          userBId: encounter.user_b_id,
          workspaceId,
          encounterId,
        });
        return;
      }

      const { data: matchesData } = await supabase
        .from('context_free_matches')
        .select('winner_user_id')
        .eq('encounter_id', encounterId)
        .not('ended_at', 'is', null);

      const allMatches = (matchesData ?? []) as { winner_user_id: string | null }[];
      const newWinsA = allMatches.filter((m) => m.winner_user_id === encounter.user_a_id).length;
      const newWinsB = allMatches.filter((m) => m.winner_user_id === encounter.user_b_id).length;

      if (newWinsA >= 2 || newWinsB >= 2) {
        const encounterWinner = newWinsA >= 2 ? encounter.user_a_id : encounter.user_b_id;
        await Promise.all([
          supabase
            .from('context_free_encounters')
            .update({ winner_user_id: encounterWinner, ended_at: now })
            .eq('id', encounterId),
          supabase
            .from('playground_presence')
            .update({ last_match_ended_at: now })
            .in('user_id', [encounter.user_a_id, encounter.user_b_id])
            .eq('workspace_id', workspaceId),
        ]);
        navigation.replace('ContextFreeMatchResult', {
          winnerId: encounterWinner,
          encounterType: 'bo3',
          winsA: newWinsA,
          winsB: newWinsB,
          userAId: encounter.user_a_id,
          userBId: encounter.user_b_id,
          workspaceId,
          encounterId,
        });
        return;
      }

      navigation.replace('ContextFreeMatchResult', {
        winnerId: winnerUserId,
        encounterType: 'bo3',
        winsA: newWinsA,
        winsB: newWinsB,
        userAId: encounter.user_a_id,
        userBId: encounter.user_b_id,
        workspaceId,
        encounterId,
      });
    },
    [match, encounter, matchId, encounterId, workspaceId, clearTimers, flushAndPersist, navigation]
  );

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    setSessionUserId(uid);

    const [matchRes, encounterRes] = await Promise.all([
      supabase
        .from('context_free_matches')
        .select('id, encounter_id, match_number, starting_life_a, starting_life_b, winner_user_id, started_by_user_id')
        .eq('id', matchId)
        .maybeSingle(),
      supabase
        .from('context_free_encounters')
        .select('id, encounter_type, user_a_id, user_b_id, colors_a, colors_b')
        .eq('id', encounterId)
        .maybeSingle(),
    ]);

    if (matchRes.error || !matchRes.data || encounterRes.error || !encounterRes.data) {
      Alert.alert('Error', 'No se pudo cargar la partida.');
      setLoading(false);
      return;
    }

    const matchRow = matchRes.data as unknown as MatchRow;
    const encounterRow = encounterRes.data as unknown as EncounterRow;
    setMatch(matchRow);
    setEncounter(encounterRow);
    encounterRef.current = encounterRow;

    const cA = (encounterRow.colors_a ?? []) as MtgColor[];
    const cB = (encounterRow.colors_b ?? []) as MtgColor[];
    setColorsA(cA);
    setColorsB(cB);

    const [usersRes, lifeRes, winsRes, presenceRes] = await Promise.all([
      supabase
        .from('users')
        .select('id, username, display_name')
        .in('id', [encounterRow.user_a_id, encounterRow.user_b_id]),
      supabase
        .from('context_free_life_events')
        .select('user_id, delta')
        .eq('match_id', matchId),
      encounterRow.encounter_type === 'bo3'
        ? supabase
            .from('context_free_matches')
            .select('winner_user_id')
            .eq('encounter_id', encounterId)
            .not('ended_at', 'is', null)
        : Promise.resolve({ data: [] as { winner_user_id: string | null }[], error: null }),
      supabase
        .from('playground_presence')
        .select('user_id, is_shiny, default_avatars ( storage_path, storage_path_shiny )')
        .eq('workspace_id', workspaceId)
        .in('user_id', [encounterRow.user_a_id, encounterRow.user_b_id]),
    ]);

    if (usersRes.error || lifeRes.error) {
      Alert.alert('Error', 'No se pudo cargar el estado del life tracker.');
      setLoading(false);
      return;
    }

    const usersData = usersRes.data ?? [];
    setUa((usersData.find((u) => u.id === encounterRow.user_a_id) ?? null) as UserRow | null);
    setUb((usersData.find((u) => u.id === encounterRow.user_b_id) ?? null) as UserRow | null);

    const events = (lifeRes.data ?? []) as { user_id: string; delta: number }[];
    let sumA = 0;
    let sumB = 0;
    for (const ev of events) {
      if (ev.user_id === encounterRow.user_a_id) sumA += Number(ev.delta);
      else if (ev.user_id === encounterRow.user_b_id) sumB += Number(ev.delta);
    }
    const initialA = clampLife(matchRow.starting_life_a + sumA);
    const initialB = clampLife(matchRow.starting_life_b + sumB);
    setStableA(initialA);
    setStableB(initialB);
    stableARef.current = initialA;
    stableBRef.current = initialB;
    setPendingA(null);
    setPendingB(null);
    pendingARef.current = null;
    pendingBRef.current = null;
    historyRef.current = [{ a: initialA, b: initialB }];

    const winsData = (winsRes.data ?? []) as { winner_user_id: string | null }[];
    setWinsA(winsData.filter((w) => w.winner_user_id === encounterRow.user_a_id).length);
    setWinsB(winsData.filter((w) => w.winner_user_id === encounterRow.user_b_id).length);

    const presenceData = (presenceRes.data ?? []) as {
      user_id: string;
      is_shiny: boolean;
      default_avatars: { storage_path: string; storage_path_shiny: string | null } | { storage_path: string; storage_path_shiny: string | null }[] | null;
    }[];
    const resolveAvatarUri = (userId: string): string | null => {
      const p = presenceData.find((r) => r.user_id === userId);
      if (!p) return null;
      const da = Array.isArray(p.default_avatars) ? (p.default_avatars[0] ?? null) : p.default_avatars;
      if (!da) return null;
      const path = p.is_shiny && da.storage_path_shiny ? da.storage_path_shiny : da.storage_path;
      return defaultAvatarPublicUrl(path);
    };
    setAvatarUriA(resolveAvatarUri(encounterRow.user_a_id));
    setAvatarUriB(resolveAvatarUri(encounterRow.user_b_id));

    if (matchRow.started_by_user_id == null) {
      setShowStarterModal(true);
    }

    setLoading(false);
  }, [matchId, encounterId, workspaceId, setStableA, setStableB, stableARef, stableBRef, setPendingA, setPendingB, pendingARef, pendingBRef]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        clearTimers();
      };
    }, [load, clearTimers])
  );

  useEffect(() => {
    encounterRef.current = encounter;
  }, [encounter]);

  useEffect(() => {
    if (lifeRealtimeChannelRef.current) return;
    const channel = supabase
      .channel(`cf-match-life:${matchId}:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'context_free_life_events', filter: `match_id=eq.${matchId}` },
        (payload) => {
          const row = payload.new as { user_id?: string; delta?: number } | null;
          const enc = encounterRef.current;
          if (!row?.user_id || row.delta == null || !enc) return;
          if (row.user_id === enc.user_a_id) {
            const v = clampLife(stableARef.current + Number(row.delta));
            stableARef.current = v;
            pendingARef.current = null;
            setStableA(v);
            setPendingA(null);
          } else if (row.user_id === enc.user_b_id) {
            const v = clampLife(stableBRef.current + Number(row.delta));
            stableBRef.current = v;
            pendingBRef.current = null;
            setStableB(v);
            setPendingB(null);
          }
        }
      )
      .subscribe();
    lifeRealtimeChannelRef.current = channel;
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
      lifeRealtimeChannelRef.current = null;
    };
  }, [matchId]);

  useLayoutEffect(() => {
    if (!encounter) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'ContextFreeEncounter', {
        workspaceId,
        userAId: encounter.user_a_id,
        userBId: encounter.user_b_id,
      }),
    });
  }, [navigation, encounter?.id, workspaceId]);

  const persistLife = useCallback(
    async (target: 'a' | 'b', overrideValue?: number, checkWin = true) => {
      if (!encounter) return;
      const userId = target === 'a' ? encounter.user_a_id : encounter.user_b_id;
      const stable = clampLife(target === 'a' ? stableARef.current : stableBRef.current);
      const pending = overrideValue ?? (target === 'a' ? pendingARef.current : pendingBRef.current);
      if (pending == null) return;
      const normalizedPending = clampLife(pending);
      if (normalizedPending === stable) {
        if (target === 'a') { pendingARef.current = null; setPendingA(null); }
        else { pendingBRef.current = null; setPendingB(null); }
        return;
      }
      const delta = normalizedPending - stable;
      if (delta === 0) return;
      const { data, error } = await supabase
        .from('context_free_life_events')
        .insert({ match_id: matchId, user_id: userId, delta })
        .select('id')
        .maybeSingle();

      if (error) {
        if (target === 'a') { pendingARef.current = null; setPendingA(null); }
        else { pendingBRef.current = null; setPendingB(null); }
        Alert.alert('Error', error.message ?? 'No se pudo guardar el cambio de vida.');
        return;
      }
      const persistedLife = normalizedPending;
      const insertedLifeEventId = (data as { id?: string } | null)?.id ?? null;

      if (target === 'a') {
        stableARef.current = persistedLife;
        pendingARef.current = null;
        setStableA(persistedLife);
        setPendingA(null);
      } else {
        stableBRef.current = persistedLife;
        pendingBRef.current = null;
        setStableB(persistedLife);
        setPendingB(null);
      }
      historyRef.current = [
        ...historyRef.current.slice(-9),
        target === 'a'
          ? { a: persistedLife, b: stableBRef.current }
          : { a: stableARef.current, b: persistedLife },
      ];

      if (checkWin && persistedLife === 0) {
        const winnerUserId = target === 'a' ? encounter.user_b_id : encounter.user_a_id;
        const nmA = ua?.display_name || ua?.username || 'Jugador A';
        const nmB = ub?.display_name || ub?.username || 'Jugador B';
        const winnerName = target === 'a' ? nmB : nmA;
        const stableBeforeZero = stable;
        const userIdForZero = userId;
        Alert.alert('Fin de partida', '¿Confirmás el resultado?', [
          {
            text: 'Cancelar',
            style: 'cancel',
            onPress: () => {
              clearPendingAdjustments();
              void (async () => {
                let idToDelete = insertedLifeEventId;
                if (!idToDelete) {
                  const lastRes = await supabase
                    .from('context_free_life_events')
                    .select('id')
                    .eq('match_id', matchId)
                    .eq('user_id', userIdForZero)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();
                  if (lastRes.error || !lastRes.data?.id) {
                    Alert.alert(
                      'Error',
                      lastRes.error?.message ?? 'No se pudo deshacer el golpe de gracia.'
                    );
                    return;
                  }
                  idToDelete = lastRes.data.id as string;
                }
                const delRes = await supabase
                  .from('context_free_life_events')
                  .delete()
                  .eq('id', idToDelete);
                if (delRes.error) {
                  Alert.alert('Error', delRes.error.message ?? 'No se pudo deshacer el golpe de gracia.');
                  return;
                }
                const prevLife = clampLife(stableBeforeZero);
                if (target === 'a') {
                  stableARef.current = prevLife;
                  pendingARef.current = null;
                  setStableA(prevLife);
                  setPendingA(null);
                } else {
                  stableBRef.current = prevLife;
                  pendingBRef.current = null;
                  setStableB(prevLife);
                  setPendingB(null);
                }
                if (historyRef.current.length > 1) {
                  historyRef.current = historyRef.current.slice(0, -1);
                }
              })();
            },
          },
          {
            text: `Confirmar: gana ${winnerName}`,
            onPress: async () => {
              await concludeMatch(winnerUserId);
            },
          },
        ]);
      }
    },
    [
      clearPendingAdjustments,
      concludeMatch,
      encounter,
      matchId,
      ua,
      ub,
      stableARef,
      stableBRef,
      pendingARef,
      pendingBRef,
      setStableA,
      setStableB,
      setPendingA,
      setPendingB,
    ]
  );

  useEffect(() => {
    persistLifeRef.current = persistLife;
  }, [persistLife]);

  const adjustLife = useCallback(
    (target: 'a' | 'b', delta: number) => {
      increment(target, delta);
    },
    [increment]
  );

  const onUndo = async () => {
    clearPendingAdjustments();
    if (historyRef.current.length < 2 || !encounter) return;
    const nextHistory = [...historyRef.current];
    nextHistory.pop();
    const prev = nextHistory[nextHistory.length - 1];
    if (!prev) return;
    historyRef.current = nextHistory;
    if (prev.a !== stableARef.current) {
      await persistLife('a', prev.a);
    }
    if (prev.b !== stableBRef.current) {
      await persistLife('b', prev.b);
    }
  };

  const onSurrender = (target: 'a' | 'b') => {
    if (!encounter) return;
    const winner = target === 'a' ? encounter.user_b_id : encounter.user_a_id;
    Alert.alert('Rendición', '¿Rendirte?', [
      { text: 'Cancelar', style: 'cancel', onPress: () => clearPendingAdjustments() },
      {
        text: 'Sí, me rindo',
        style: 'destructive',
        onPress: async () => {
          await concludeMatch(winner);
        },
      },
    ]);
  };

  const onBack = useCallback(() => {
    if (!encounter) return;
    const doNavigate = () => {
      clearTimers();
      navigation.navigate('ContextFreeEncounter', {
        workspaceId,
        userAId: encounter.user_a_id,
        userBId: encounter.user_b_id,
      });
    };
    if (pendingA !== null || pendingB !== null) {
      Alert.alert('Cambios sin guardar', '¿Salir? Los cambios pendientes se descartarán.', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Salir', style: 'destructive', onPress: doNavigate },
      ]);
    } else {
      doNavigate();
    }
  }, [encounter, pendingA, pendingB, clearTimers, navigation, workspaceId]);

  const chooseStarter = useCallback(
    async (userId: string) => {
      await supabase
        .from('context_free_matches')
        .update({ started_by_user_id: userId })
        .eq('id', matchId);
      setShowStarterModal(false);
    },
    [matchId]
  );

  const nameA = useMemo(() => ua?.display_name || ua?.username || 'Jugador A', [ua]);
  const nameB = useMemo(() => ub?.display_name || ub?.username || 'Jugador B', [ub]);

  const layoutAB = useMemo(() => {
    if (!encounter) return { top: 'a' as const, bottom: 'b' as const };
    if (sessionUserId === encounter.user_a_id) return { top: 'b' as const, bottom: 'a' as const };
    if (sessionUserId === encounter.user_b_id) return { top: 'a' as const, bottom: 'b' as const };
    return { top: 'a' as const, bottom: 'b' as const };
  }, [sessionUserId, encounter]);

  const bgSeed = match?.id ?? matchId;
  const { bgA: bgColorA, bgB: bgColorB } = useMemo(
    () => pickCoordinatedBgColors(colorsA, colorsB, bgSeed),
    [colorsA, colorsB, bgSeed]
  );

  const canDecreaseA = aLife > 0;
  const canDecreaseB = bLife > 0;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!match || !encounter || !ua || !ub) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró la partida.</Text>
      </View>
    );
  }

  const renderPlayerHalf = (
    slot: 'a' | 'b',
    rotated: boolean,
    deltaDisplay: number,
    diffOpacity: Animated.Value
  ) => {
    const isA = slot === 'a';
    const name = isA ? nameA : nameB;
    const wins = isA ? winsA : winsB;
    const life = isA ? aLife : bLife;
    const canDec = isA ? canDecreaseA : canDecreaseB;
    const bgColor = isA ? bgColorA : bgColorB;
    const isDarkBg = bgColor === 'B';
    const t = isA ? ('a' as const) : ('b' as const);
    const userId = isA ? encounter.user_a_id : encounter.user_b_id;
    const avatarUri = isA ? avatarUriA : avatarUriB;
    const showBo3Pills = encounter.encounter_type === 'bo3';
    const diffColor =
      deltaDisplay > 0 ? '#16A34A' : deltaDisplay < 0 ? '#DC2626' : '#6B7280';
    const diffLabel =
      deltaDisplay > 0 ? `+${deltaDisplay}` : deltaDisplay < 0 ? String(deltaDisplay) : ' ';

    const body = (
      <>
        <View style={styles.topRow}>
          <View style={styles.bo3Wrap}>
            {showBo3Pills ? (
              <>
                <View style={[styles.bo3Box, wins >= 1 && styles.bo3Filled]} />
                <View style={[styles.bo3Box, wins >= 2 && styles.bo3Filled]} />
              </>
            ) : null}
          </View>
        </View>
        <View style={styles.lifeRow}>
          <View style={styles.playerBlock}>
            <View
              style={styles.avatarWrap}
            >
              <View style={styles.avatarInner}>
                {avatarUri ? (
                  <Image
                    source={{ uri: avatarUri }}
                    style={styles.avatarImage}
                    resizeMode="contain"
                  />
                ) : null}
              </View>
            </View>
            <Text style={[styles.playerName, isDarkBg && { color: '#fff' }]}>{name}</Text>
          </View>
          <View style={styles.lifeControlsVertical}>
            <TouchableOpacity
              style={[styles.lifeBtn, isDarkBg && { borderWidth: 1, borderColor: '#fff' }]}
              onPress={() => adjustLife(t, 1)}
            >
              <Text style={styles.lifeBtnTxt}>+1</Text>
            </TouchableOpacity>
            <View style={styles.lifeCenter}>
              <Animated.View style={[styles.lifeDiffWrap, { opacity: diffOpacity }]}>
                <Text style={[styles.lifeDiff, { color: diffColor }]}>{diffLabel}</Text>
              </Animated.View>
              <Text style={[styles.lifeNumber, isDarkBg && { color: '#fff' }]}>{clampLife(life)}</Text>
            </View>
            <TouchableOpacity
              style={[
                styles.lifeBtn,
                isDarkBg && { borderWidth: 1, borderColor: '#fff' },
                !canDec && styles.lifeBtnDisabled,
              ]}
              disabled={!canDec}
              onPress={() => adjustLife(t, -1)}
            >
              <Text style={styles.lifeBtnTxt}>-1</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.pendingReserveSlot} pointerEvents="none" />
      </>
    );
    return (
      <View
        style={[
          styles.half,
          { backgroundColor: COLOR_BG[bgColor] },
        ]}
      >
        {rotated ? <View style={styles.rotated}>{body}</View> : body}
        <TouchableOpacity
          style={[
            styles.flagBtn,
            rotated ? styles.flagBtnTowardEquatorTop : styles.flagBtnTowardEquatorBottom,
            rotated ? styles.flagBtnAvatarSideRotated : styles.flagBtnAvatarSideNormal,
          ]}
          onPress={() => onSurrender(t)}
        >
          <Text style={styles.flag}>🏳️</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <View style={styles.scrollInner} collapsable={false}>
          {renderPlayerHalf(
            layoutAB.top,
            true,
            layoutAB.top === 'a' ? deltaA : deltaB,
            layoutAB.top === 'a' ? diffOpacityA : diffOpacityB
          )}
          <View style={styles.undoWrap}>
            <View style={styles.undoBtnRow}>
              <TouchableOpacity style={styles.backBtn} onPress={onBack}>
                <Text style={styles.backTxt}>← Volver</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.undoBtn, !canUndo && styles.undoDisabled]}
                disabled={!canUndo}
                onPress={() => void onUndo()}
              >
                <Text style={styles.undoTxt}>Undo</Text>
              </TouchableOpacity>
            </View>
          </View>
          {renderPlayerHalf(
            layoutAB.bottom,
            false,
            layoutAB.bottom === 'a' ? deltaA : deltaB,
            layoutAB.bottom === 'a' ? diffOpacityA : diffOpacityB
          )}
        </View>
      </ScrollView>
      {showStarterModal && ua && ub ? (
        <View style={styles.starterModalBackdrop}>
          <View style={styles.starterModalCard}>
            <Text style={styles.starterModalTitle}>¿Quién empieza?</Text>
            <TouchableOpacity
              style={styles.starterOption}
              activeOpacity={0.8}
              onPress={() => void chooseStarter(encounter.user_a_id)}
            >
              {avatarUriA ? (
                <Image source={{ uri: avatarUriA }} style={styles.starterAvatar} resizeMode="contain" />
              ) : null}
              <Text style={styles.starterOptionName}>{nameA}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.starterOption}
              activeOpacity={0.8}
              onPress={() => void chooseStarter(encounter.user_b_id)}
            >
              {avatarUriB ? (
                <Image source={{ uri: avatarUriB }} style={styles.starterAvatar} resizeMode="contain" />
              ) : null}
              <Text style={styles.starterOptionName}>{nameB}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { flexGrow: 1 },
  scrollInner: { flexGrow: 1, position: 'relative' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' },
  muted: { color: '#666' },
  half: { flex: 1, minHeight: 272, padding: 16, justifyContent: 'center', position: 'relative' },
  rotated: { transform: [{ rotate: '180deg' }] },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  bo3Wrap: { flexDirection: 'row', transform: [{ translateY: 12 }] },
  bo3Box: { width: 24, height: 10, borderRadius: 3, borderWidth: 1, borderColor: '#9CA3AF', marginRight: 6 },
  bo3Filled: { backgroundColor: '#22C55E', borderColor: '#22C55E' },
  flag: { fontSize: 18 },
  lifeBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  lifeBtnDisabled: { opacity: 0.4 },
  lifeBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  lifeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  playerBlock: { width: '50%', alignItems: 'center', justifyContent: 'center' },
  avatarWrap: {
    width: '96%',
    maxWidth: 220,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarInner: { alignItems: 'center', justifyContent: 'center' },
  avatarImage: { width: '96%', maxWidth: 180, aspectRatio: 1, borderRadius: 90 },
  flagBtn: {
    position: 'absolute',
    backgroundColor: '#00000030',
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 4,
    zIndex: 2,
  },
  flagBtnTowardEquatorTop: { bottom: 12 },
  flagBtnTowardEquatorBottom: { top: 12 },
  flagBtnAvatarSideRotated: { right: 22 },
  flagBtnAvatarSideNormal: { left: 22 },
  playerName: { marginTop: 10, fontSize: 24, color: '#111', fontWeight: '700', textAlign: 'center' },
  lifeControlsVertical: { width: '50%', alignItems: 'center', justifyContent: 'space-between' },
  lifeCenter: { alignItems: 'center', flex: 1 },
  lifeDiffWrap: { minHeight: 48, justifyContent: 'flex-end', marginBottom: 2 },
  lifeDiff: { fontSize: 44, fontWeight: '800', lineHeight: 48 },
  lifeNumber: { fontSize: 72, color: '#111', fontWeight: '800', lineHeight: 80 },
  pendingReserveSlot: { marginTop: 6, height: 16 },
  undoWrap: { width: '100%', backgroundColor: '#fff' },
  undoBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  backBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 13,
  },
  backTxt: { color: '#6B7280', fontWeight: '600', fontSize: 14 },
  undoBtn: {
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 13,
  },
  undoDisabled: { opacity: 0.5 },
  undoTxt: { color: '#3B82F6', fontWeight: '700' },
  starterModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#00000099',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 100,
  },
  starterModalCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  starterModalTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    marginBottom: 18,
    textAlign: 'center',
  },
  starterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
    width: '100%',
    marginBottom: 10,
  },
  starterOptionDisabled: { opacity: 0.5 },
  starterAvatar: { width: 36, height: 36, borderRadius: 18 },
  starterOptionName: { fontSize: 18, fontWeight: '700', color: '#111', flex: 1 },
});
