import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps, NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useKeepAwake } from 'expo-keep-awake';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import {
  findConcurrentInProgressDetailsForPairParticipants,
  formatConcurrentMatchBlockMessage,
} from '../lib/participantConcurrentMatch';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';
import {
  buildSequentialEmojis,
  categorizeMove,
  getEffectiveAttackPattern,
  getSpecialBehavior,
  pickMove,
  pickRandomMoveFromAll,
  type MoveTarget,
} from '../lib/pokemonMovepool';

type Props = NativeStackScreenProps<MainStackParamList, 'LifeTracker'>;

type MatchRow = {
  id: string;
  pairing_id: string;
  winner_participant_id: string | null;
  match_type: string | null;
  starting_life_a: number;
  starting_life_b: number;
  life_tracker_user_id: string | null;
  status: 'in_progress' | 'completed' | 'aborted';
  who_started_participant_id: string | null;
};

type PairingRow = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
};

type ParticipantRow = {
  id: string;
  user_id: string;
  rotated_avatar_id: string | null;
  rotated_avatar: { storage_path: string } | { storage_path: string }[] | null;
  users:
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }
    | {
        username: string;
        display_name: string;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }[]
    | null;
};

type LifeSnapshot = { a: number; b: number };

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function getPokemonNameFromAvatar(participant: ParticipantRow | null): string {
  if (!participant) return 'normal';
  const rotatedDa = relationOne(participant.rotated_avatar);
  if (rotatedDa?.storage_path) {
    const filename = rotatedDa.storage_path.split('/').pop() ?? '';
    const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
    if (base) return base;
  }
  const user = relationOne(participant.users);
  if (!user) return 'normal';
  const customPath = user.custom_avatar_path;
  if (customPath) {
    const filename = customPath.split('/').pop() ?? '';
    return filename.replace(/\.[^.]+$/, '').toLowerCase();
  }
  const defaultAvatar = relationOne(user.default_avatars);
  if (!defaultAvatar) return 'normal';
  const filename = defaultAvatar.storage_path.split('/').pop() ?? '';
  return filename.replace(/\.[^.]+$/, '').toLowerCase();
}

function clampLife(value: number): number {
  return Math.max(0, value);
}

function flushLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

const computeSurroundPositions = (count: number, radius = 50) => {
  if (count === 3) {
    return [
      { x: -radius, y: 0 },
      { x: 0, y: -radius },
      { x: radius, y: 0 },
    ];
  }
  if (count === 4) {
    return [
      { x: 0, y: -radius },
      { x: 0, y: radius },
      { x: -radius, y: 0 },
      { x: radius, y: 0 },
    ];
  }
  return [];
};

function measureAvatarCenterInScroll(
  wrap: View | null,
  content: View | null
): Promise<{ cx: number; cy: number }> {
  return new Promise((resolve) => {
    if (!wrap || !content) {
      resolve({ cx: 180, cy: 220 });
      return;
    }
    wrap.measureInWindow((wx, wy, ww, wh) => {
      content.measureInWindow((cwx, cwy, _cww, _cwh) => {
        resolve({
          cx: wx - cwx + ww / 2,
          cy: wy - cwy + wh / 2,
        });
      });
    });
  });
}

async function navigateAfterMatchMaybeComplete(
  navigation: NativeStackNavigationProp<MainStackParamList, 'LifeTracker'>,
  eventId: string,
  matchId: string,
  previousEventStatus: string | null | undefined
): Promise<void> {
  if (previousEventStatus === 'completed') {
    navigation.replace('MatchResult', { matchId });
    return;
  }
  const delays = [1500, 700, 700];
  for (const ms of delays) {
    await new Promise((r) => setTimeout(r, ms));
    const { data, error } = await supabase.from('draft_events').select('status').eq('id', eventId).maybeSingle();
    if (!error && data?.status === 'completed') {
      navigation.replace('Standings', { eventId, showPodiumIntro: true });
      return;
    }
  }
  navigation.replace('MatchResult', { matchId });
}

const COLOR_BG: Record<MtgColor, string> = {
  W: '#F8FAFC',
  U: '#DBEAFE',
  B: '#374151',
  R: '#FEE2E2',
  G: '#DCFCE7',
  C: '#E5E7EB',
};

export default function LifeTrackerScreen({ route, navigation }: Props) {
  useKeepAwake();
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  /** Otro match in_progress del mismo jugador en otro pairing. */
  const [concurrentBlockMessage, setConcurrentBlockMessage] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [whoStartedParticipantId, setWhoStartedParticipantId] = useState<string | null>(null);
  const [savingStarter, setSavingStarter] = useState(false);
  const [currentTurnParticipantId, setCurrentTurnParticipantId] = useState<string | null>(null);
  const [turnStartLifeA, setTurnStartLifeA] = useState(20);
  const [turnStartLifeB, setTurnStartLifeB] = useState(20);
  const [turnStartedAt, setTurnStartedAt] = useState<string | null>(null);
  const [lastTurnNumber, setLastTurnNumber] = useState(0);
  const [passingTurn, setPassingTurn] = useState(false);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [pairing, setPairing] = useState<PairingRow | null>(null);
  const [pa, setPa] = useState<ParticipantRow | null>(null);
  const [pb, setPb] = useState<ParticipantRow | null>(null);
  const [colorsA, setColorsA] = useState<MtgColor[]>([]);
  const [colorsB, setColorsB] = useState<MtgColor[]>([]);
  const [winsA, setWinsA] = useState(0);
  const [winsB, setWinsB] = useState(0);
  const [stableA, setStableA] = useState(20);
  const [stableB, setStableB] = useState(20);
  const [pendingA, setPendingA] = useState<number | null>(null);
  const [pendingB, setPendingB] = useState<number | null>(null);
  const stableARef = useRef(20);
  const stableBRef = useRef(20);
  const pendingARef = useRef<number | null>(null);
  const pendingBRef = useRef<number | null>(null);
  const [persistingA, setPersistingA] = useState(false);
  const [persistingB, setPersistingB] = useState(false);
  const historyRef = useRef<LifeSnapshot[]>([]);
  const timerARef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerBRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myUserIdRef = useRef<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const pairingRef = useRef<PairingRow | null>(null);
  const lifeRealtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const diffOpacityA = useRef(new Animated.Value(0)).current;
  const diffOpacityB = useRef(new Animated.Value(0)).current;
  const attackTravel = useRef(new Animated.Value(0)).current;
  const defenderShake = useRef(new Animated.Value(0)).current;
  const attackerShake = useRef(new Animated.Value(0)).current;
  const attackSelfOpacity = useRef(new Animated.Value(1)).current;
  const specialPreAnim = useRef(new Animated.Value(0)).current;
  const surroundFade = useRef(new Animated.Value(0)).current;
  const circularProgress = useRef(new Animated.Value(0)).current;
  const circularTx = useMemo(
    () =>
      circularProgress.interpolate({
        inputRange: [0, 0.25, 0.5, 0.75, 1],
        outputRange: [0, 60, 0, -60, 0],
      }),
    [circularProgress]
  );
  const circularTy = useMemo(
    () =>
      circularProgress.interpolate({
        inputRange: [0, 0.25, 0.5, 0.75, 1],
        outputRange: [-60, 0, 60, 0, -60],
      }),
    [circularProgress]
  );
  const [attackingFrom, setAttackingFrom] = useState<'a' | 'b' | null>(null);
  const [attackEmoji, setAttackEmoji] = useState<string | null>(null);
  const [attackMoveTarget, setAttackMoveTarget] = useState<MoveTarget | null>(null);
  type SurroundPayload = { cx: number; cy: number; items: { x: number; y: number; emoji: string }[] };
  type CircularPayload = { cx: number; cy: number; emoji: string };
  const [surroundPayload, setSurroundPayload] = useState<SurroundPayload | null>(null);
  const [circularPayload, setCircularPayload] = useState<CircularPayload | null>(null);
  const [specialEmoji, setSpecialEmoji] = useState<string | null>(null);
  const [specialType, setSpecialType] = useState<'ditto' | 'metronome' | null>(null);
  const [lifeDisplayedA, setLifeDisplayedA] = useState(20);
  const [lifeDisplayedB, setLifeDisplayedB] = useState(20);
  const scrollContentLayoutRef = useRef<View>(null);
  const avatarWrapMeasureRefA = useRef<View>(null);
  const avatarWrapMeasureRefB = useRef<View>(null);
  const avatarPositionA = useRef(0);
  const avatarPositionB = useRef(0);

  const aLife = pendingA ?? stableA;
  const bLife = pendingB ?? stableB;
  const deltaA = clampLife((pendingA ?? stableA)) - stableA;
  const deltaB = clampLife((pendingB ?? stableB)) - stableB;
  const canUndo = historyRef.current.length > 1;

  const clearPendingAdjustments = useCallback(() => {
    if (timerARef.current) clearTimeout(timerARef.current);
    if (timerBRef.current) clearTimeout(timerBRef.current);
    timerARef.current = null;
    timerBRef.current = null;
    pendingARef.current = null;
    pendingBRef.current = null;
    setPendingA(null);
    setPendingB(null);
  }, []);

  useEffect(() => {
    Animated.timing(diffOpacityA, {
      toValue: deltaA !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaA, diffOpacityA]);

  useEffect(() => {
    Animated.timing(diffOpacityB, {
      toValue: deltaB !== 0 ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [deltaB, diffOpacityB]);

  const updateAvatarYInScrollContent = useCallback((slot: 'a' | 'b') => {
    const wrap = slot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
    const content = scrollContentLayoutRef.current;
    if (!wrap || !content) return;
    wrap.measureInWindow((_wx, wy, _ww, _wh) => {
      content.measureInWindow((_cx, cy, _cw, _ch) => {
        const relativeY = wy - cy;
        if (slot === 'a') avatarPositionA.current = relativeY;
        else avatarPositionB.current = relativeY;
      });
    });
  }, []);

  const load = useCallback(async () => {
    setConcurrentBlockMessage(null);
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    myUserIdRef.current = uid;
    setSessionUserId(uid);

    const { data: mData, error: mErr } = await supabase
      .from('matches')
      .select(
        'id, pairing_id, winner_participant_id, match_type, starting_life_a, starting_life_b, life_tracker_user_id, status, who_started_participant_id'
      )
      .eq('id', matchId)
      .maybeSingle();
    if (mErr || !mData) {
      Alert.alert('Error', 'No se pudo cargar la partida.');
      setLoading(false);
      return;
    }
    const matchRow = mData as MatchRow;
    setMatch(matchRow);
    setWhoStartedParticipantId(matchRow.who_started_participant_id ?? null);

    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id')
      .eq('id', matchRow.pairing_id)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setLoading(false);
      return;
    }
    const pairingRow = pData as PairingRow;
    setPairing(pairingRow);

    const [eventRes, participantsRes, colorsRes, lifeRes, winsRes] = await Promise.all([
      supabase
        .from('draft_events')
        .select('workspace_id, turn_tracking_enabled')
        .eq('id', pairingRow.event_id)
        .maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          rotated_avatar_id,
          rotated_avatar:default_avatars!rotated_avatar_id(storage_path),
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .in('id', [pairingRow.participant_a_id, pairingRow.participant_b_id]),
      supabase
        .from('participant_colors')
        .select('participant_id, color')
        .in('participant_id', [pairingRow.participant_a_id, pairingRow.participant_b_id]),
      supabase.from('life_events').select('participant_id, resulting_life, occurred_at').eq('match_id', matchId),
      supabase
        .from('matches')
        .select('winner_participant_id, match_type, status')
        .eq('pairing_id', pairingRow.id)
        .eq('status', 'completed')
        .not('winner_participant_id', 'is', null),
    ]);

    if (participantsRes.error || colorsRes.error || lifeRes.error || winsRes.error) {
      Alert.alert('Error', 'No se pudo cargar el estado del life tracker.');
      setLoading(false);
      return;
    }

    const pRowsPre = (participantsRes.data ?? []) as ParticipantRow[];
    const pMapPre = new Map(pRowsPre.map((x) => [x.id, x]));
    const rowA = pMapPre.get(pairingRow.participant_a_id);
    const rowB = pMapPre.get(pairingRow.participant_b_id);
    const uA = relationOne(rowA?.users);
    const uB = relationOne(rowB?.users);
    const preNameA = uA?.display_name || uA?.username || 'Jugador A';
    const preNameB = uB?.display_name || uB?.username || 'Jugador B';

    const wsId = eventRes.data?.workspace_id as string | undefined;
    setTurnTrackingEnabled(!!(eventRes.data as { turn_tracking_enabled?: boolean | null } | null)?.turn_tracking_enabled);
    const [roleRes, concurrentDetails] = await Promise.all([
      wsId && uid
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', wsId)
            .eq('user_id', uid)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      findConcurrentInProgressDetailsForPairParticipants({
        eventId: pairingRow.event_id,
        excludePairingId: pairingRow.id,
        participantAId: pairingRow.participant_a_id,
        participantBId: pairingRow.participant_b_id,
      }),
    ]);
    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
    const organizer = !roleRes.error && roleRes.data?.role === 'organizer';
    setIsOrganizer(organizer);

    const blockMsg = formatConcurrentMatchBlockMessage({
      nameA: preNameA,
      nameB: preNameB,
      participantAId: pairingRow.participant_a_id,
      participantBId: pairingRow.participant_b_id,
      userIdA: rowA?.user_id ?? '',
      userIdB: rowB?.user_id ?? '',
      myUserId: uid,
      isWorkspaceOrganizer: organizer,
      aInOtherMatchId: concurrentDetails.participantAInOtherMatchId,
      bInOtherMatchId: concurrentDetails.participantBInOtherMatchId,
    });
    if (blockMsg) {
      setConcurrentBlockMessage(blockMsg);
      setLoading(false);
      return;
    }

    const pRows = pRowsPre;
    const pMap = pMapPre;
    setPa(pMap.get(pairingRow.participant_a_id) ?? null);
    setPb(pMap.get(pairingRow.participant_b_id) ?? null);

    const colorMap: Record<string, MtgColor[]> = {};
    for (const c of colorsRes.data ?? []) {
      const pid = c.participant_id as string;
      if (!colorMap[pid]) colorMap[pid] = [];
      colorMap[pid].push(c.color as MtgColor);
    }
    setColorsA(colorMap[pairingRow.participant_a_id] ?? []);
    setColorsB(colorMap[pairingRow.participant_b_id] ?? []);

    const latestByParticipant: Record<string, { life: number; at: string }> = {};
    for (const e of lifeRes.data ?? []) {
      const pid = e.participant_id as string;
      const at = String(e.occurred_at);
      if (!latestByParticipant[pid] || latestByParticipant[pid].at < at) {
        latestByParticipant[pid] = { life: Number(e.resulting_life), at };
      }
    }
    const initialA = clampLife(latestByParticipant[pairingRow.participant_a_id]?.life ?? matchRow.starting_life_a);
    const initialB = clampLife(latestByParticipant[pairingRow.participant_b_id]?.life ?? matchRow.starting_life_b);
    setStableA(initialA);
    setStableB(initialB);
    stableARef.current = initialA;
    stableBRef.current = initialB;
    setPendingA(null);
    setPendingB(null);
    pendingARef.current = null;
    pendingBRef.current = null;
    historyRef.current = [{ a: initialA, b: initialB }];

    const wins = (winsRes.data ?? []) as { winner_participant_id: string; match_type: string }[];
    const officialWins = wins.filter((w) => w.match_type === 'draft' || w.match_type === 'final');
    setWinsA(officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_a_id).length);
    setWinsB(officialWins.filter((w) => w.winner_participant_id === pairingRow.participant_b_id).length);

    let lifeDispA = clampLife(matchRow.starting_life_a);
    let lifeDispB = clampLife(matchRow.starting_life_b);

    const turnTrackOn = !!(eventRes.data as { turn_tracking_enabled?: boolean | null } | null)?.turn_tracking_enabled;
    if (turnTrackOn) {
      const turnsRes = await supabase
        .from('match_turns')
        .select('turn_number, attacker_participant_id, life_a_after, life_b_after, ended_at')
        .eq('match_id', matchId)
        .order('turn_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (turnsRes.error) {
        if (__DEV__) console.error('match_turns load:', turnsRes.error);
        setLastTurnNumber(0);
        setCurrentTurnParticipantId(matchRow.who_started_participant_id ?? null);
        setTurnStartLifeA(initialA);
        setTurnStartLifeB(initialB);
        setTurnStartedAt(new Date().toISOString());
      } else {
        const last = turnsRes.data as {
          turn_number: number;
          attacker_participant_id: string;
          life_a_after: number;
          life_b_after: number;
          ended_at: string | null;
        } | null;
        if (last) {
          setLastTurnNumber(last.turn_number);
          const nextPid =
            last.attacker_participant_id === pairingRow.participant_a_id
              ? pairingRow.participant_b_id
              : pairingRow.participant_a_id;
          setCurrentTurnParticipantId(nextPid);
          setTurnStartLifeA(clampLife(Number(last.life_a_after)));
          setTurnStartLifeB(clampLife(Number(last.life_b_after)));
          setTurnStartedAt(last.ended_at ?? new Date().toISOString());
          lifeDispA = clampLife(Number(last.life_a_after));
          lifeDispB = clampLife(Number(last.life_b_after));
        } else {
          setLastTurnNumber(0);
          setCurrentTurnParticipantId(matchRow.who_started_participant_id ?? null);
          setTurnStartLifeA(initialA);
          setTurnStartLifeB(initialB);
          setTurnStartedAt(new Date().toISOString());
        }
      }
    } else {
      setLastTurnNumber(0);
      setCurrentTurnParticipantId(null);
      setTurnStartLifeA(initialA);
      setTurnStartLifeB(initialB);
      setTurnStartedAt(null);
    }

    setLifeDisplayedA(lifeDispA);
    setLifeDisplayedB(lifeDispB);

    const trackerUserId = matchRow.life_tracker_user_id;
    if (!uid) {
      setBlocked(true);
      setLoading(false);
      return;
    }
    if (!trackerUserId) {
      const lockRes = await supabase
        .from('matches')
        .update({ life_tracker_user_id: uid })
        .eq('id', matchId);
      if (lockRes.error) {
        Alert.alert('Error', lockRes.error.message ?? 'No se pudo tomar control de la partida.');
      }
      setBlocked(false);
    } else if (trackerUserId === uid) {
      setBlocked(false);
    } else if (!organizer) {
      setBlocked(true);
    } else {
      setBlocked(true);
    }

    setLoading(false);
  }, [matchId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        if (timerARef.current) clearTimeout(timerARef.current);
        if (timerBRef.current) clearTimeout(timerBRef.current);
      };
    }, [load])
  );

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    if (lifeRealtimeChannelRef.current) return;
    const channel = supabase
      .channel(`match-life:${matchId}:${Date.now()}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'life_events', filter: `match_id=eq.${matchId}` },
        (payload) => {
          const row = payload.new as { participant_id?: string; resulting_life?: number } | null;
          const pr = pairingRef.current;
          if (!row?.participant_id || row.resulting_life == null || !pr) return;
          if (row.participant_id === pr.participant_a_id) {
            const v = clampLife(Number(row.resulting_life));
            stableARef.current = v;
            pendingARef.current = null;
            setStableA(v);
            setPendingA(null);
          } else if (row.participant_id === pr.participant_b_id) {
            const v = clampLife(Number(row.resulting_life));
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

  const pairingsFromTab = route.params.fromTab ?? 'official';

  useLayoutEffect(() => {
    if (!pairing) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingDetail', {
        pairingId: pairing.id,
        fromTab: pairingsFromTab,
      }),
    });
  }, [navigation, pairing?.id, pairingsFromTab]);

  const persistLife = useCallback(
    async (target: 'a' | 'b', overrideValue?: number, checkWin = true) => {
      if (!pairing) return;
      const participantId =
        target === 'a' ? pairing.participant_a_id : pairing.participant_b_id;
      const stable = clampLife(target === 'a' ? stableARef.current : stableBRef.current);
      const pending =
        overrideValue ?? (target === 'a' ? pendingARef.current : pendingBRef.current);
      if (pending == null) return;
      const normalizedPending = clampLife(pending);
      if (normalizedPending === stable) return;
      const delta = normalizedPending - stable;
      if (delta === 0) return;
      if (target === 'a') setPersistingA(true);
      else setPersistingB(true);

      const { data, error } = await supabase
        .from('life_events')
        .insert({
          match_id: matchId,
          participant_id: participantId,
          delta,
          resulting_life: normalizedPending,
        })
        .select('id, resulting_life')
        .maybeSingle();
      if (target === 'a') setPersistingA(false);
      else setPersistingB(false);

      if (error) {
        if (target === 'a') {
          pendingARef.current = null;
          setPendingA(null);
        } else {
          pendingBRef.current = null;
          setPendingB(null);
        }
        Alert.alert('Error', error.message ?? 'No se pudo guardar el cambio de vida.');
        return;
      }
      const persistedLife = clampLife(Number(data?.resulting_life ?? normalizedPending));
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
        const winnerParticipantId =
          target === 'a' ? pairing.participant_b_id : pairing.participant_a_id;
        const uA = relationOne(pa?.users);
        const uB = relationOne(pb?.users);
        const nmA = uA?.display_name || uA?.username || 'Jugador A';
        const nmB = uB?.display_name || uB?.username || 'Jugador B';
        const winnerName = target === 'a' ? nmB : nmA;
        const stableBeforeZero = stable;
        const participantIdForZero = participantId;
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
                    .from('life_events')
                    .select('id')
                    .eq('match_id', matchId)
                    .eq('participant_id', participantIdForZero)
                    .eq('resulting_life', 0)
                    .order('occurred_at', { ascending: false })
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
                const delRes = await supabase.from('life_events').delete().eq('id', idToDelete);
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
              if (!pairing) return;
              const eventBeforeRes = await supabase
                .from('draft_events')
                .select('status')
                .eq('id', pairing.event_id)
                .maybeSingle();
              const previousEventStatus = eventBeforeRes.data?.status;
              const endRes = await supabase
                .from('matches')
                .update({
                  winner_participant_id: winnerParticipantId,
                  ended_at: new Date().toISOString(),
                  status: 'completed',
                })
                .eq('id', matchId);
              if (endRes.error) {
                Alert.alert('Error', endRes.error.message ?? 'No se pudo cerrar la partida.');
                return;
              }
              if (pairing) {
                void navigateAfterMatchMaybeComplete(
                  navigation,
                  pairing.event_id,
                  matchId,
                  previousEventStatus
                );
              } else {
                navigation.replace('MatchResult', { matchId });
              }
            },
          },
        ]);
      }
    },
    [clearPendingAdjustments, matchId, navigation, pairing, pa, pb]
  );

  const queuePersist = useCallback(
    (target: 'a' | 'b') => {
      const ref = target === 'a' ? timerARef : timerBRef;
      if (ref.current) clearTimeout(ref.current);
      const delayMs = turnTrackingEnabled ? 1000 : 3500;
      ref.current = setTimeout(() => {
        void persistLife(target);
      }, delayMs);
    },
    [persistLife, turnTrackingEnabled]
  );

  const adjustLife = useCallback(
    (target: 'a' | 'b', delta: number) => {
      if (blocked) return;
      if (target === 'a') {
        const current = clampLife(pendingARef.current ?? stableARef.current);
        if (delta < 0 && current <= 0) return;
        const next = clampLife(current + delta);
        pendingARef.current = next;
        setPendingA(next);
      } else {
        const current = clampLife(pendingBRef.current ?? stableBRef.current);
        if (delta < 0 && current <= 0) return;
        const next = clampLife(current + delta);
        pendingBRef.current = next;
        setPendingB(next);
      }
      queuePersist(target);
    },
    [blocked, queuePersist]
  );

  const onUndo = async () => {
    clearPendingAdjustments();
    if (historyRef.current.length < 2 || !pairing) return;
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
    if (!pairing) return;
    const winner =
      target === 'a' ? pairing.participant_b_id : pairing.participant_a_id;
    Alert.alert('Rendición', '¿Rendirte?', [
      { text: 'Cancelar', style: 'cancel', onPress: () => clearPendingAdjustments() },
      {
        text: 'Sí, me rindo',
        style: 'destructive',
        onPress: async () => {
          const eventBeforeRes = await supabase
            .from('draft_events')
            .select('status')
            .eq('id', pairing.event_id)
            .maybeSingle();
          const previousEventStatus = eventBeforeRes.data?.status;
          const { error } = await supabase
            .from('matches')
            .update({
              winner_participant_id: winner,
              ended_at: new Date().toISOString(),
              ended_by_surrender: true,
              status: 'completed',
            })
            .eq('id', matchId);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo cerrar la partida.');
            return;
          }
          if (pairing) {
            void navigateAfterMatchMaybeComplete(
              navigation,
              pairing.event_id,
              matchId,
              previousEventStatus
            );
          } else {
            navigation.replace('MatchResult', { matchId });
          }
        },
      },
    ]);
  };

  const takeControl = async () => {
    const uid = myUserIdRef.current;
    if (!uid) return;
    const { error } = await supabase
      .from('matches')
      .update({ life_tracker_user_id: uid })
      .eq('id', matchId);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo tomar control.');
      return;
    }
    setBlocked(false);
  };

  const chooseStarter = useCallback(
    async (participantId: string) => {
      if (savingStarter) return;
      if (!match) return;
      setSavingStarter(true);
      const { error } = await supabase
        .from('matches')
        .update({ who_started_participant_id: participantId })
        .eq('id', match.id);
      setSavingStarter(false);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudo guardar quién empieza.');
        return;
      }
      setWhoStartedParticipantId(participantId);
      setMatch((prev) => (prev ? { ...prev, who_started_participant_id: participantId } : prev));
      if (turnTrackingEnabled) {
        const a = clampLife(pendingARef.current ?? stableARef.current);
        const b = clampLife(pendingBRef.current ?? stableBRef.current);
        setCurrentTurnParticipantId(participantId);
        setTurnStartLifeA(a);
        setTurnStartLifeB(b);
        setTurnStartedAt(new Date().toISOString());
      }
    },
    [match, savingStarter, turnTrackingEnabled]
  );

  const passTurn = useCallback(async () => {
    if (!pairing || !match || !pa || !pb || passingTurn) return;
    if (!currentTurnParticipantId || !turnStartedAt) return;
    const uid = myUserIdRef.current;
    if (!uid) return;

    const attackerPid = currentTurnParticipantId;
    const isAttackerA = attackerPid === pairing.participant_a_id;
    const attackerUserId = isAttackerA ? pa.user_id : pb.user_id;
    const attackerSide: 'a' | 'b' = isAttackerA ? 'a' : 'b';
    const attackerParticipant = isAttackerA ? pa : pb;

    const lifeA = clampLife(aLife);
    const lifeB = clampLife(bLife);
    const atkLife = isAttackerA ? lifeA : lifeB;
    const defLife = isAttackerA ? lifeB : lifeA;
    const turnStartAtk = isAttackerA ? turnStartLifeA : turnStartLifeB;
    const turnStartDef = isAttackerA ? turnStartLifeB : turnStartLifeA;
    const myDelta = atkLife - turnStartAtk;
    const otherDelta = defLife - turnStartDef;
    const move_category = categorizeMove(myDelta, otherDelta);
    const pokemonName = getPokemonNameFromAvatar(attackerParticipant);
    const defenderParticipant = isAttackerA ? pb : pa;
    const defenderPokemonName = getPokemonNameFromAvatar(defenderParticipant);
    const attackerSpecial = getSpecialBehavior(pokemonName);

    let move;
    if (attackerSpecial === 'ditto') {
      move = pickMove(defenderPokemonName, move_category, otherDelta);
    } else if (attackerSpecial === 'metronome') {
      move = pickRandomMoveFromAll();
    } else {
      move = pickMove(pokemonName, move_category, otherDelta);
    }

    const nextNum = lastTurnNumber + 1;
    setPassingTurn(true);

    if (attackerSpecial === 'ditto') {
      const { count, error: dittoCountErr } = await supabase
        .from('match_turns')
        .select('id', { count: 'exact', head: true })
        .eq('match_id', match.id)
        .eq('attacker_user_id', attackerUserId);
      if (dittoCountErr && __DEV__) {
        console.error('match_turns ditto count:', dittoCountErr);
      }
      const isFirstDittoTurn = (count ?? 0) === 0;
      if (isFirstDittoTurn) {
        setAttackingFrom(attackerSide);
        setSpecialType('ditto');
        setSpecialEmoji('🌀');
        specialPreAnim.setValue(0);
        await new Promise<void>((resolve) => {
          Animated.timing(specialPreAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }).start(() => resolve());
        });
        setSpecialEmoji(null);
        setSpecialType(null);
        specialPreAnim.setValue(0);
      }
    } else if (attackerSpecial === 'metronome') {
      setAttackingFrom(attackerSide);
      setSpecialType('metronome');
      setSpecialEmoji('☝️');
      specialPreAnim.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.timing(specialPreAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }).start(() => resolve());
      });
      setSpecialEmoji(null);
      setSpecialType(null);
      specialPreAnim.setValue(0);
    }

    attackTravel.setValue(0);
    defenderShake.setValue(0);
    attackerShake.setValue(0);
    attackSelfOpacity.setValue(1);
    surroundFade.setValue(0);
    circularProgress.setValue(0);
    setSurroundPayload(null);
    setCircularPayload(null);
    setAttackingFrom(attackerSide);
    setAttackMoveTarget(move.target);
    setAttackEmoji(move.emoji);

    const effectivePattern = getEffectiveAttackPattern(move);
    const strikeCount = move.count ?? 1;

    const defenderShakeSteps = [
      Animated.timing(defenderShake, { toValue: 10, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: -10, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: 8, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: -8, duration: 80, useNativeDriver: true }),
      Animated.timing(defenderShake, { toValue: 0, duration: 80, useNativeDriver: true }),
    ];

    const runDefenderShakeOnly = () =>
      new Promise<void>((resolve) => {
        Animated.sequence(defenderShakeSteps).start(() => resolve());
      });

    const runAttackerSoftShakeOnly = () =>
      new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.timing(attackerShake, { toValue: -5, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 5, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: -3, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 3, duration: 80, useNativeDriver: true }),
          Animated.timing(attackerShake, { toValue: 0, duration: 80, useNativeDriver: true }),
        ]).start(() => resolve());
      });

    const runTravelEnemy = () =>
      new Promise<void>((resolve) => {
        Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }).start(() =>
          resolve()
        );
      });

    const runTravelAbsorb = () =>
      new Promise<void>((resolve) => {
        Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }).start(() =>
          resolve()
        );
      });

    if (effectivePattern === 'sequential' && strikeCount > 1 && move.target === 'enemy') {
      const seq = buildSequentialEmojis(move);
      for (let i = 0; i < seq.length; i += 1) {
        attackTravel.setValue(0);
        setAttackEmoji(seq[i]!);
        await flushLayout();
        await runTravelEnemy();
        if (i < seq.length - 1) {
          await new Promise<void>((r) => setTimeout(r, 120));
        }
      }
      await runDefenderShakeOnly();
    } else if (
      effectivePattern === 'surround' &&
      (move.target === 'enemy' || move.target === 'absorb')
    ) {
      const defenderSlot: 'a' | 'b' = isAttackerA ? 'b' : 'a';
      updateAvatarYInScrollContent('a');
      updateAvatarYInScrollContent('b');
      await flushLayout();
      const defWrap = defenderSlot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
      const center = await measureAvatarCenterInScroll(defWrap, scrollContentLayoutRef.current);
      setAttackEmoji(null);
      await runDefenderShakeOnly();
      const offsets = computeSurroundPositions(strikeCount, 50);
      if (offsets.length > 0) {
        surroundFade.setValue(0);
        setSurroundPayload({
          cx: center.cx,
          cy: center.cy,
          items: offsets.map((o) => ({ x: o.x, y: o.y, emoji: move.emoji })),
        });
        await new Promise<void>((resolve) => {
          Animated.sequence([
            Animated.timing(surroundFade, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.delay(600),
            Animated.timing(surroundFade, { toValue: 0, duration: 200, useNativeDriver: true }),
          ]).start(() => resolve());
        });
        setSurroundPayload(null);
        surroundFade.setValue(0);
      }
      if (move.target === 'absorb') {
        attackTravel.setValue(0);
        setAttackEmoji(move.emoji);
        await flushLayout();
        await runTravelAbsorb();
      }
    } else if (effectivePattern === 'circular') {
      const anchorSlot: 'a' | 'b' = move.target === 'self' ? attackerSide : isAttackerA ? 'b' : 'a';
      updateAvatarYInScrollContent('a');
      updateAvatarYInScrollContent('b');
      await flushLayout();
      const anchorWrap = anchorSlot === 'a' ? avatarWrapMeasureRefA.current : avatarWrapMeasureRefB.current;
      const center = await measureAvatarCenterInScroll(anchorWrap, scrollContentLayoutRef.current);
      setAttackEmoji(null);
      setCircularPayload({ cx: center.cx, cy: center.cy, emoji: move.emoji });
      circularProgress.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.timing(circularProgress, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }).start(() => resolve());
      });
      setCircularPayload(null);
      circularProgress.setValue(0);
      if (move.target === 'enemy') {
        await runDefenderShakeOnly();
      } else {
        await runAttackerSoftShakeOnly();
      }
    } else if (move.target === 'enemy') {
      await new Promise<void>((resolve) => {
        Animated.timing(attackTravel, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }).start(() => {
          Animated.sequence(defenderShakeSteps).start(() => resolve());
        });
      });
    } else if (move.target === 'self') {
      attackSelfOpacity.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.timing(attackSelfOpacity, { toValue: 1, duration: 100, useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(attackerShake, { toValue: -5, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 5, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: -3, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 3, duration: 80, useNativeDriver: true }),
            Animated.timing(attackerShake, { toValue: 0, duration: 80, useNativeDriver: true }),
          ]),
          Animated.timing(attackSelfOpacity, { toValue: 0, duration: 100, useNativeDriver: true }),
        ]).start(() => resolve());
      });
    } else {
      await new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.sequence(defenderShakeSteps),
          Animated.timing(attackTravel, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]).start(() => resolve());
      });
    }

    const { error } = await supabase.from('match_turns').insert({
      match_id: match.id,
      turn_number: nextNum,
      attacker_user_id: attackerUserId,
      attacker_participant_id: attackerPid,
      life_a_before: turnStartLifeA,
      life_b_before: turnStartLifeB,
      life_a_after: lifeA,
      life_b_after: lifeB,
      move_category,
      started_at: turnStartedAt,
      ended_at: new Date().toISOString(),
    });

    setAttackingFrom(null);
    setAttackEmoji(null);
    setAttackMoveTarget(null);
    setSurroundPayload(null);
    setCircularPayload(null);
    setSpecialEmoji(null);
    setSpecialType(null);
    attackTravel.setValue(0);
    defenderShake.setValue(0);
    attackerShake.setValue(0);
    attackSelfOpacity.setValue(1);
    specialPreAnim.setValue(0);
    surroundFade.setValue(0);
    circularProgress.setValue(0);
    setPassingTurn(false);

    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo pasar el turno.');
      return;
    }

    setLifeDisplayedA(clampLife(lifeA));
    setLifeDisplayedB(clampLife(lifeB));

    const otherPid =
      attackerPid === pairing.participant_a_id ? pairing.participant_b_id : pairing.participant_a_id;
    setLastTurnNumber(nextNum);
    setCurrentTurnParticipantId(otherPid);
    setTurnStartLifeA(lifeA);
    setTurnStartLifeB(lifeB);
    setTurnStartedAt(new Date().toISOString());
  }, [
    aLife,
    bLife,
    currentTurnParticipantId,
    lastTurnNumber,
    match,
    pairing,
    pa,
    pb,
    passingTurn,
    turnStartLifeA,
    turnStartLifeB,
    turnStartedAt,
    updateAvatarYInScrollContent,
  ]);

  const nameA = useMemo(() => {
    const u = relationOne(pa?.users);
    return u?.display_name || u?.username || 'Jugador A';
  }, [pa]);
  const nameB = useMemo(() => {
    const u = relationOne(pb?.users);
    return u?.display_name || u?.username || 'Jugador B';
  }, [pb]);
  const layoutAB = useMemo(() => {
    if (!pa || !pb) return { top: 'a' as const, bottom: 'b' as const };
    if (sessionUserId === pa.user_id) return { top: 'b' as const, bottom: 'a' as const };
    if (sessionUserId === pb.user_id) return { top: 'a' as const, bottom: 'b' as const };
    return { top: 'a' as const, bottom: 'b' as const };
  }, [sessionUserId, pa, pb]);
  const canDecreaseA = aLife > 0;
  const canDecreaseB = bLife > 0;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (concurrentBlockMessage) {
    return (
      <View style={styles.centered}>
        <Text style={styles.blockedText}>{concurrentBlockMessage}</Text>
        <TouchableOpacity
          style={[styles.linkBtn, styles.concurrentBackBtn]}
          onPress={() =>
            pairing
              ? navigation.navigate('PairingDetail', { pairingId: pairing.id, fromTab: pairingsFromTab })
              : navigation.goBack()
          }
        >
          <Text style={styles.linkTxt}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!match || !pairing || !pa || !pb) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró la partida.</Text>
      </View>
    );
  }

  if (blocked) {
    return (
      <View style={styles.centered}>
        <Text style={styles.blockedText}>Esta partida está siendo controlada desde otro celular.</Text>
        {isOrganizer ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() =>
              Alert.alert('Tomar control', '¿Tomar control de la partida?', [
                { text: 'Cancelar', style: 'cancel', onPress: () => clearPendingAdjustments() },
                { text: 'Tomar control', onPress: () => void takeControl() },
              ])
            }
          >
            <Text style={styles.primaryTxt}>Tomar control de la partida</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => navigation.navigate('PairingDetail', { pairingId: pairing.id, fromTab: pairingsFromTab })}
          >
            <Text style={styles.linkTxt}>Volver</Text>
          </TouchableOpacity>
        )}
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
    const p = isA ? pa! : pb!;
    const name = isA ? nameA : nameB;
    const wins = isA ? winsA : winsB;
    const life = isA ? aLife : bLife;
    const lifeForHpBar = isA ? lifeDisplayedA : lifeDisplayedB;
    const canDec = isA ? canDecreaseA : canDecreaseB;
    const pending = isA ? pendingA : pendingB;
    const persisting = isA ? persistingA : persistingB;
    const colors = isA ? colorsA : colorsB;
    const isDarkBg = colors[0] === 'B';
    const t = isA ? ('a' as const) : ('b' as const);
    const startingLife = isA ? match?.starting_life_a ?? 20 : match?.starting_life_b ?? 20;
    const hpRatio =
      startingLife > 0 ? Math.max(0, Math.min(1, clampLife(lifeForHpBar) / startingLife)) : 0;
    const hpColor = hpRatio >= 0.5 ? '#16A34A' : hpRatio >= 0.25 ? '#EAB308' : '#DC2626';
    const passTurnBorder = colors.length > 1 ? COLOR_BG[colors[1]!] : '#6B7280';
    const isMyTurn =
      turnTrackingEnabled &&
      whoStartedParticipantId != null &&
      currentTurnParticipantId === p.id;
    const hasUnsettledLife =
      pendingA != null || pendingB != null || persistingA || persistingB;
    const passTurnDisabled = !isMyTurn || passingTurn || hasUnsettledLife;
    const isDefenderShake =
      turnTrackingEnabled &&
      attackingFrom != null &&
      attackMoveTarget != null &&
      attackMoveTarget !== 'self' &&
      ((attackingFrom === 'a' && slot === 'b') || (attackingFrom === 'b' && slot === 'a'));
    const isAttackerSoftShake =
      turnTrackingEnabled &&
      attackingFrom != null &&
      attackMoveTarget === 'self' &&
      ((attackingFrom === 'a' && slot === 'a') || (attackingFrom === 'b' && slot === 'b'));
    const diffColor =
      deltaDisplay > 0 ? '#16A34A' : deltaDisplay < 0 ? '#DC2626' : '#6B7280';
    const diffLabel =
      deltaDisplay > 0 ? `+${deltaDisplay}` : deltaDisplay < 0 ? String(deltaDisplay) : '\u00a0';
    const body = (
      <>
        <View style={[styles.topRow, turnTrackingEnabled && styles.topRowTurn]}>
          <View style={styles.bo3Wrap}>
            <View style={[styles.bo3Box, wins >= 1 && styles.bo3Filled]} />
            <View style={[styles.bo3Box, wins >= 2 && styles.bo3Filled]} />
          </View>
        </View>
        <View style={styles.lifeRow}>
          <View style={[styles.playerBlock, turnTrackingEnabled && styles.playerBlockTurn]}>
            {turnTrackingEnabled ? (
              <View style={styles.nameRowTurn}>
                {currentTurnParticipantId === p.id ? (
                  <Text style={[styles.turnArrow, isDarkBg && styles.turnArrowDark]}>▶</Text>
                ) : null}
                <Text style={[styles.playerNameAbove, isDarkBg && { color: '#fff' }]}>{name}</Text>
              </View>
            ) : null}
            <View
              ref={isA ? avatarWrapMeasureRefA : avatarWrapMeasureRefB}
              onLayout={() => updateAvatarYInScrollContent(t)}
              style={[styles.avatarWrap, turnTrackingEnabled && styles.avatarWrapTurn]}
            >
              {isDefenderShake ? (
                <Animated.View style={{ transform: [{ translateX: defenderShake }] }}>
                  <View style={styles.avatarInner}>
                    <PlayerAvatar
                      userId={p.user_id}
                      participantId={p.id}
                      size="xlarge"
                      withColorBorder
                      borderWidth={5}
                    />
                  </View>
                </Animated.View>
              ) : isAttackerSoftShake ? (
                <Animated.View style={{ transform: [{ translateX: attackerShake }] }}>
                  <View style={styles.avatarInner}>
                    <PlayerAvatar
                      userId={p.user_id}
                      participantId={p.id}
                      size="xlarge"
                      withColorBorder
                      borderWidth={5}
                    />
                  </View>
                </Animated.View>
              ) : (
                <View style={styles.avatarInner}>
                  <PlayerAvatar
                    userId={p.user_id}
                    participantId={p.id}
                    size="xlarge"
                    withColorBorder
                    borderWidth={5}
                  />
                </View>
              )}
              {specialEmoji != null && specialType != null && attackingFrom === t ? (
                <Animated.View
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFillObject, styles.specialPreLayer]}
                >
                  <Animated.View
                    style={[
                      styles.specialPreInner,
                      {
                        transform:
                          specialType === 'ditto'
                            ? [
                                {
                                  rotate: specialPreAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: ['0deg', '360deg'],
                                  }),
                                },
                                {
                                  scale: specialPreAnim.interpolate({
                                    inputRange: [0, 0.5, 1],
                                    outputRange: [0.5, 1.5, 0],
                                  }),
                                },
                              ]
                            : [
                                {
                                  translateX: specialPreAnim.interpolate({
                                    inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1],
                                    outputRange: [-10, 10, -10, 10, -10, 0],
                                  }),
                                },
                              ],
                      },
                    ]}
                  >
                    <Text
                      style={
                        specialType === 'ditto' ? styles.specialDittoEmoji : styles.specialMetronomeEmoji
                      }
                    >
                      {specialEmoji}
                    </Text>
                  </Animated.View>
                </Animated.View>
              ) : null}
            </View>
            {turnTrackingEnabled ? (
              <>
                <View style={styles.hpBarRow}>
                  <Text style={[styles.hpBarLabel, isDarkBg && styles.hpBarLabelDark]}>HP</Text>
                  <View style={styles.hpBarTrack}>
                    <View
                      style={[
                        styles.hpBarFill,
                        { width: `${hpRatio * 100}%`, backgroundColor: hpColor },
                      ]}
                    />
                  </View>
                </View>
                <TouchableOpacity
                  style={[
                    styles.passTurnBtn,
                    { borderColor: passTurnBorder },
                    passTurnDisabled && styles.passTurnBtnDisabled,
                  ]}
                  activeOpacity={0.85}
                  disabled={passTurnDisabled}
                  onPress={() => void passTurn()}
                >
                  <Text style={styles.passTurnBtnTxt}>Pasar turno</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={[styles.playerName, isDarkBg && { color: '#fff' }]}>{name}</Text>
            )}
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
        {pending != null || persisting ? <Text style={styles.pending}>Pendiente...</Text> : null}
      </>
    );
    return (
      <View
        style={[
          styles.half,
          turnTrackingEnabled && styles.halfTurnTrack,
          { backgroundColor: COLOR_BG[colors[0] ?? 'C'] },
        ]}
      >
        {rotated ? <View style={styles.rotated}>{body}</View> : body}
        <TouchableOpacity
          style={[
            styles.flagBtn,
            rotated ? styles.flagBtnTowardEquatorTop : styles.flagBtnTowardEquatorBottom,
            turnTrackingEnabled
              ? rotated
                ? styles.flagBtnTowardEquatorTopTurn
                : styles.flagBtnTowardEquatorBottomTurn
              : null,
            rotated ? styles.flagBtnAvatarSideRotated : styles.flagBtnAvatarSideNormal,
          ]}
          onPress={() => onSurrender(t)}
        >
          <Text style={styles.flag}>🏳️</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const showStarterModal =
    turnTrackingEnabled &&
    whoStartedParticipantId == null &&
    !!pa &&
    !!pb &&
    match?.status === 'in_progress';

  const ayFly = avatarPositionA.current;
  const byFly = avatarPositionB.current;
  const attackFlyMeasured = ayFly > 2 || byFly > 2;
  let attackFlyOutputRange: [number, number] | null = null;
  if (attackEmoji && attackingFrom && attackMoveTarget) {
    if (attackMoveTarget === 'self') {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [ayFly, ayFly]
          : [byFly, byFly]
        : [80, 80];
    } else if (attackMoveTarget === 'absorb') {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [byFly, ayFly]
          : [ayFly, byFly]
        : attackingFrom === 'a'
          ? [400, 80]
          : [80, 400];
    } else {
      attackFlyOutputRange = attackFlyMeasured
        ? attackingFrom === 'a'
          ? [ayFly, byFly]
          : [byFly, ayFly]
        : attackingFrom === 'a'
          ? [80, 400]
          : [400, 80];
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
        <View ref={scrollContentLayoutRef} style={styles.scrollInner} collapsable={false}>
          {renderPlayerHalf(
            layoutAB.top,
            true,
            layoutAB.top === 'a' ? deltaA : deltaB,
            layoutAB.top === 'a' ? diffOpacityA : diffOpacityB
          )}

          <View style={styles.undoWrap}>
            <TouchableOpacity
              style={[styles.undoBtn, !canUndo && styles.undoDisabled]}
              disabled={!canUndo}
              onPress={() => void onUndo()}
            >
              <Text style={styles.undoTxt}>Undo</Text>
            </TouchableOpacity>
          </View>

          {renderPlayerHalf(
            layoutAB.bottom,
            false,
            layoutAB.bottom === 'a' ? deltaA : deltaB,
            layoutAB.bottom === 'a' ? diffOpacityA : diffOpacityB
          )}
          {attackFlyOutputRange && attackEmoji ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.attackFlyWrap,
                {
                  opacity: attackSelfOpacity,
                  transform: [
                    {
                      translateY: attackTravel.interpolate({
                        inputRange: [0, 1],
                        outputRange: attackFlyOutputRange,
                      }),
                    },
                  ],
                },
              ]}
            >
              <Text style={styles.attackFlyEmoji}>{attackEmoji}</Text>
            </Animated.View>
          ) : null}
          {surroundPayload ? (
            <View
              pointerEvents="none"
              style={[
                styles.surroundAnchor,
                { left: surroundPayload.cx, top: surroundPayload.cy },
              ]}
            >
              <Animated.View style={{ opacity: surroundFade }}>
                {surroundPayload.items.map((it, idx) => (
                  <Text
                    key={`${it.emoji}-${idx}`}
                    style={[
                      styles.surroundEmoji,
                      { left: it.x - 28, top: it.y - 28 },
                    ]}
                  >
                    {it.emoji}
                  </Text>
                ))}
              </Animated.View>
            </View>
          ) : null}
          {circularPayload ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.circularWrap,
                {
                  left: circularPayload.cx - 28,
                  top: circularPayload.cy - 28,
                  transform: [{ translateX: circularTx }, { translateY: circularTy }],
                },
              ]}
            >
              <Text style={styles.attackFlyEmoji}>{circularPayload.emoji}</Text>
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>
      {showStarterModal && pa && pb ? (
        <View style={styles.starterModalBackdrop}>
          <View style={styles.starterModalCard}>
            <Text style={styles.starterModalTitle}>¿Quién empieza?</Text>
            <TouchableOpacity
              style={[styles.starterOption, savingStarter && styles.starterOptionDisabled]}
              activeOpacity={0.8}
              disabled={savingStarter}
              onPress={() => void chooseStarter(pa.id)}
            >
              <PlayerAvatar
                userId={pa.user_id}
                participantId={pa.id}
                size="small"
                withColorBorder
                borderWidth={3}
              />
              <Text style={styles.starterOptionName}>{nameA}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.starterOption, savingStarter && styles.starterOptionDisabled]}
              activeOpacity={0.8}
              disabled={savingStarter}
              onPress={() => void chooseStarter(pb.id)}
            >
              <PlayerAvatar
                userId={pb.user_id}
                participantId={pb.id}
                size="small"
                withColorBorder
                borderWidth={3}
              />
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
  attackFlyWrap: {
    position: 'absolute',
    left: '50%',
    marginLeft: -28,
    top: 0,
    zIndex: 40,
  },
  surroundAnchor: {
    position: 'absolute',
    zIndex: 40,
    width: 0,
    height: 0,
  },
  surroundEmoji: {
    position: 'absolute',
    fontSize: 56,
  },
  circularWrap: {
    position: 'absolute',
    zIndex: 40,
  },
  attackFlyEmoji: { fontSize: 56 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' },
  muted: { color: '#666' },
  blockedText: { color: '#111', fontSize: 16, textAlign: 'center', marginBottom: 14 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  primaryTxt: { color: '#fff', fontWeight: '700' },
  linkBtn: { marginTop: 6 },
  concurrentBackBtn: { marginTop: 18 },
  linkTxt: { color: '#3B82F6', fontWeight: '700' },
  half: { flex: 1, minHeight: 300, padding: 16, justifyContent: 'center', position: 'relative' },
  halfTurnTrack: { paddingVertical: 10, paddingHorizontal: 12 },
  rotated: { transform: [{ rotate: '180deg' }] },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  topRowTurn: { marginBottom: 12 },
  bo3Wrap: { flexDirection: 'row' },
  bo3Box: { width: 24, height: 10, borderRadius: 3, borderWidth: 1, borderColor: '#9CA3AF', marginRight: 6 },
  bo3Filled: { backgroundColor: '#22C55E', borderColor: '#22C55E' },
  flag: { fontSize: 18 },
  lifeBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  lifeBtnDisabled: { opacity: 0.4 },
  lifeBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  lifeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  playerBlock: { width: '50%', alignItems: 'center', justifyContent: 'center' },
  playerBlockTurn: { justifyContent: 'flex-start', paddingVertical: 0 },
  avatarWrap: {
    width: '96%',
    maxWidth: 220,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarWrapTurn: {
    marginTop: 0,
    marginBottom: 0,
    width: 'auto',
    aspectRatio: undefined,
    maxWidth: undefined,
    alignSelf: 'center',
  },
  flagBtnTowardEquatorTopTurn: { bottom: 4 },
  flagBtnTowardEquatorBottomTurn: { top: 4 },
  avatarInner: { alignItems: 'center', justifyContent: 'center' },
  specialPreLayer: { zIndex: 15, justifyContent: 'center', alignItems: 'center' },
  specialPreInner: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  specialDittoEmoji: { fontSize: 56 },
  specialMetronomeEmoji: { fontSize: 48 },
  flagBtn: {
    position: 'absolute',
    backgroundColor: '#00000030',
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 4,
    zIndex: 2,
  },
  /** Mitad superior (rotada): borde inferior hacia el ecuador / barra Undo. */
  flagBtnTowardEquatorTop: { bottom: 12 },
  /** Mitad inferior: borde superior hacia el ecuador. */
  flagBtnTowardEquatorBottom: { top: 12 },
  /** Contenido rotado 180°: el bloque del avatar queda a la derecha; misma orientación que antes. */
  flagBtnAvatarSideRotated: { right: 22 },
  flagBtnAvatarSideNormal: { left: 22 },
  playerName: { marginTop: 10, fontSize: 24, color: '#111', fontWeight: '700', textAlign: 'center' },
  nameRowTurn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 0,
    marginBottom: 0,
    flexWrap: 'wrap',
  },
  turnArrow: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
    marginRight: 4,
  },
  turnArrowDark: { color: '#fff' },
  playerNameAbove: {
    marginBottom: 0,
    fontSize: 24,
    color: '#111',
    fontWeight: '700',
    textAlign: 'center',
  },
  hpBarRow: {
    marginTop: 0,
    flexDirection: 'row',
    alignItems: 'center',
    width: 130,
    alignSelf: 'center',
    position: 'relative',
  },
  hpBarLabel: {
    position: 'absolute',
    right: '100%',
    marginRight: 6,
    fontSize: 10,
    fontWeight: '700',
    color: '#111',
  },
  hpBarLabelDark: { color: '#fff' },
  hpBarTrack: {
    width: 130,
    backgroundColor: '#1F2937',
    padding: 2,
    borderRadius: 4,
  },
  hpBarFill: {
    height: 8,
    borderRadius: 2,
  },
  passTurnBtn: {
    marginTop: 10,
    paddingVertical: 18,
    paddingHorizontal: 36,
    borderRadius: 10,
    borderWidth: 2,
    backgroundColor: '#FFFFFF',
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  passTurnBtnDisabled: { opacity: 0.4 },
  passTurnBtnTxt: {
    color: '#111',
    fontWeight: '700',
    fontSize: 18,
    textAlign: 'center',
  },
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
  starterOptionName: { fontSize: 18, fontWeight: '700', color: '#111', flex: 1 },
  lifeControlsVertical: { width: '50%', alignItems: 'center', justifyContent: 'space-between' },
  lifeCenter: { alignItems: 'center', flex: 1 },
  lifeDiffWrap: { minHeight: 48, justifyContent: 'flex-end', marginBottom: 2 },
  lifeDiff: { fontSize: 44, fontWeight: '800', lineHeight: 48 },
  lifeNumber: { fontSize: 72, color: '#111', fontWeight: '800', lineHeight: 80 },
  pending: { marginTop: 6, fontSize: 12, color: '#666', textAlign: 'center' },
  undoWrap: { alignItems: 'center', paddingVertical: 8, backgroundColor: '#fff' },
  undoBtn: { borderWidth: 1, borderColor: '#BFDBFE', backgroundColor: '#EFF6FF', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 14 },
  undoDisabled: { opacity: 0.5 },
  undoTxt: { color: '#3B82F6', fontWeight: '700' },
});
