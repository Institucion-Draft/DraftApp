import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';
import type { MtgColor } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'LifeTracker'>;

type MatchRow = {
  id: string;
  pairing_id: string;
  winner_participant_id: string | null;
  starting_life_a: number;
  starting_life_b: number;
  life_tracker_user_id: string | null;
  status: 'in_progress' | 'completed' | 'aborted';
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

function clampLife(value: number): number {
  return Math.max(0, value);
}

const COLOR_BG: Record<MtgColor, string> = {
  W: '#F8FAFC',
  U: '#DBEAFE',
  B: '#1F2937',
  R: '#FEE2E2',
  G: '#DCFCE7',
  C: '#E5E7EB',
};

export default function LifeTrackerScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
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
  const pairingRef = useRef<PairingRow | null>(null);
  const lifeRealtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const aLife = pendingA ?? stableA;
  const bLife = pendingB ?? stableB;
  const canUndo = historyRef.current.length > 1;

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const uid = meRes.data.user?.id ?? null;
    myUserIdRef.current = uid;

    const { data: mData, error: mErr } = await supabase
      .from('matches')
      .select(
        'id, pairing_id, winner_participant_id, starting_life_a, starting_life_b, life_tracker_user_id, status'
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
      supabase.from('draft_events').select('workspace_id').eq('id', pairingRow.event_id).maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
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

    const roleRes = eventRes.data?.workspace_id
      ? await supabase
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', eventRes.data.workspace_id as string)
          .maybeSingle()
      : { data: null };
    const organizer = roleRes.data?.role === 'organizer';
    setIsOrganizer(organizer);

    const pRows = (participantsRes.data ?? []) as ParticipantRow[];
    const pMap = new Map(pRows.map((x) => [x.id, x]));
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

  useLayoutEffect(() => {
    if (!pairing) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingDetail', {
        pairingId: pairing.id,
      }),
    });
  }, [navigation, pairing?.id]);

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
        Alert.alert('Fin de partida', '¿Confirmás el resultado?', [
          {
            text: 'Cancelar',
            style: 'cancel',
            onPress: () => {
              void persistLife(target, stableBeforeZero, false);
            },
          },
          {
            text: `Confirmar: gana ${winnerName}`,
            onPress: async () => {
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
              navigation.replace('MatchResult', { matchId });
            },
          },
        ]);
      }
    },
    [matchId, navigation, pairing, pa, pb]
  );

  const queuePersist = useCallback(
    (target: 'a' | 'b') => {
      const ref = target === 'a' ? timerARef : timerBRef;
      if (ref.current) clearTimeout(ref.current);
      ref.current = setTimeout(() => {
        void persistLife(target);
      }, 10000);
    },
    [persistLife]
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
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sí, me rindo',
        style: 'destructive',
        onPress: async () => {
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
          navigation.replace('MatchResult', { matchId });
        },
      },
    ]);
  };

  const onAbort = () => {
    Alert.alert('Abortar partida', '¿Abortar la partida? No se contará en estadísticas.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Abortar',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase
            .from('matches')
            .update({ status: 'aborted', ended_at: new Date().toISOString() })
            .eq('id', matchId);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo abortar la partida.');
            return;
          }
          if (pairing) {
            navigation.navigate('PairingDetail', { pairingId: pairing.id });
          } else {
            navigation.goBack();
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

  const nameA = useMemo(() => {
    const u = relationOne(pa?.users);
    return u?.display_name || u?.username || 'Jugador A';
  }, [pa]);
  const nameB = useMemo(() => {
    const u = relationOne(pb?.users);
    return u?.display_name || u?.username || 'Jugador B';
  }, [pb]);
  const avatarA = useMemo(() => {
    const u = relationOne(pa?.users);
    const da = relationOne(u?.default_avatars);
    return u ? avatarPublicUrl(u.custom_avatar_path) ?? avatarPublicUrl(da?.storage_path ?? null) : null;
  }, [pa]);
  const avatarB = useMemo(() => {
    const u = relationOne(pb?.users);
    const da = relationOne(u?.default_avatars);
    return u ? avatarPublicUrl(u.custom_avatar_path) ?? avatarPublicUrl(da?.storage_path ?? null) : null;
  }, [pb]);
  const canDecreaseA = aLife > 0;
  const canDecreaseB = bLife > 0;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
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
                { text: 'Cancelar', style: 'cancel' },
                { text: 'Tomar control', onPress: () => void takeControl() },
              ])
            }
          >
            <Text style={styles.primaryTxt}>Tomar control de la partida</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => navigation.navigate('PairingDetail', { pairingId: pairing.id })}
          >
            <Text style={styles.linkTxt}>Volver</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <TouchableOpacity style={styles.menuBtn} onPress={onAbort}>
        <Text style={styles.menuTxt}>...</Text>
      </TouchableOpacity>

      <View style={[styles.half, { backgroundColor: COLOR_BG[colorsA[0] ?? 'C'] }]}>
        <View style={styles.rotated}>
          <View style={styles.topRow}>
            <View style={styles.bo3Wrap}>
              <View style={[styles.bo3Box, winsA >= 1 && styles.bo3Filled]} />
              <View style={[styles.bo3Box, winsA >= 2 && styles.bo3Filled]} />
            </View>
          </View>
          <View style={styles.lifeRow}>
            <View style={styles.playerBlock}>
              <View style={styles.avatarWrap}>
                {avatarA ? (
                  <Image source={{ uri: avatarA }} style={styles.playerAvatar} />
                ) : (
                  <View style={[styles.playerAvatar, styles.playerAvatarPlaceholder]} />
                )}
                <TouchableOpacity style={styles.flagBtn} onPress={() => onSurrender('a')}>
                  <Text style={styles.flag}>🏳️</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.playerName}>{nameA}</Text>
            </View>
            <View style={styles.lifeControlsVertical}>
              <TouchableOpacity style={styles.lifeBtn} onPress={() => adjustLife('a', 1)}><Text style={styles.lifeBtnTxt}>+1</Text></TouchableOpacity>
              <View style={styles.lifeCenter}>
                <Text style={styles.lifeNumber}>{clampLife(aLife)}</Text>
              </View>
              <TouchableOpacity
                style={[styles.lifeBtn, !canDecreaseA && styles.lifeBtnDisabled]}
                disabled={!canDecreaseA}
                onPress={() => adjustLife('a', -1)}
              >
                <Text style={styles.lifeBtnTxt}>-1</Text>
              </TouchableOpacity>
            </View>
          </View>
          {(pendingA != null || persistingA) ? <Text style={styles.pending}>Pendiente...</Text> : null}
        </View>
      </View>

      <View style={styles.undoWrap}>
        <TouchableOpacity
          style={[styles.undoBtn, !canUndo && styles.undoDisabled]}
          disabled={!canUndo}
          onPress={() => void onUndo()}
        >
          <Text style={styles.undoTxt}>Undo</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.half, { backgroundColor: COLOR_BG[colorsB[0] ?? 'C'] }]}>
        <View style={styles.topRow}>
          <View style={styles.bo3Wrap}>
            <View style={[styles.bo3Box, winsB >= 1 && styles.bo3Filled]} />
            <View style={[styles.bo3Box, winsB >= 2 && styles.bo3Filled]} />
          </View>
        </View>
        <View style={styles.lifeRow}>
          <View style={styles.playerBlock}>
            <View style={styles.avatarWrap}>
              {avatarB ? (
                <Image source={{ uri: avatarB }} style={styles.playerAvatar} />
              ) : (
                <View style={[styles.playerAvatar, styles.playerAvatarPlaceholder]} />
              )}
              <TouchableOpacity style={styles.flagBtn} onPress={() => onSurrender('b')}>
                <Text style={styles.flag}>🏳️</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.playerName}>{nameB}</Text>
          </View>
          <View style={styles.lifeControlsVertical}>
            <TouchableOpacity style={styles.lifeBtn} onPress={() => adjustLife('b', 1)}><Text style={styles.lifeBtnTxt}>+1</Text></TouchableOpacity>
            <View style={styles.lifeCenter}>
              <Text style={styles.lifeNumber}>{clampLife(bLife)}</Text>
            </View>
            <TouchableOpacity
              style={[styles.lifeBtn, !canDecreaseB && styles.lifeBtnDisabled]}
              disabled={!canDecreaseB}
              onPress={() => adjustLife('b', -1)}
            >
              <Text style={styles.lifeBtnTxt}>-1</Text>
            </TouchableOpacity>
          </View>
        </View>
        {(pendingB != null || persistingB) ? <Text style={styles.pending}>Pendiente...</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { flexGrow: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' },
  muted: { color: '#666' },
  blockedText: { color: '#111', fontSize: 16, textAlign: 'center', marginBottom: 14 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16 },
  primaryTxt: { color: '#fff', fontWeight: '700' },
  linkBtn: { marginTop: 6 },
  linkTxt: { color: '#3B82F6', fontWeight: '700' },
  menuBtn: { position: 'absolute', right: 16, top: 16, zIndex: 3, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#00000020', borderRadius: 8 },
  menuTxt: { color: '#111', fontWeight: '700' },
  half: { flex: 1, minHeight: 300, padding: 16, justifyContent: 'center' },
  rotated: { transform: [{ rotate: '180deg' }] },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  bo3Wrap: { flexDirection: 'row' },
  bo3Box: { width: 24, height: 10, borderRadius: 3, borderWidth: 1, borderColor: '#9CA3AF', marginRight: 6 },
  bo3Filled: { backgroundColor: '#22C55E', borderColor: '#22C55E' },
  flag: { fontSize: 18 },
  lifeBtn: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center' },
  lifeBtnDisabled: { opacity: 0.4 },
  lifeBtnTxt: { color: '#fff', fontSize: 24, fontWeight: '700' },
  lifeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  playerBlock: { width: '50%', alignItems: 'center', justifyContent: 'center' },
  avatarWrap: { width: '96%', maxWidth: 220, aspectRatio: 1, position: 'relative' },
  flagBtn: {
    position: 'absolute',
    left: 6,
    top: 6,
    backgroundColor: '#00000030',
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  playerAvatar: { width: '100%', height: '100%', borderRadius: 22, backgroundColor: '#f3f4f6' },
  playerAvatarPlaceholder: { backgroundColor: '#FFFFFF99' },
  playerName: { marginTop: 10, fontSize: 24, color: '#111', fontWeight: '700', textAlign: 'center' },
  lifeControlsVertical: { width: '50%', alignItems: 'center', justifyContent: 'space-between' },
  lifeCenter: { alignItems: 'center', flex: 1 },
  lifeNumber: { fontSize: 72, color: '#111', fontWeight: '800', lineHeight: 80 },
  pending: { marginTop: 6, fontSize: 12, color: '#666', textAlign: 'center' },
  undoWrap: { alignItems: 'center', paddingVertical: 8, backgroundColor: '#fff' },
  undoBtn: { borderWidth: 1, borderColor: '#BFDBFE', backgroundColor: '#EFF6FF', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 14 },
  undoDisabled: { opacity: 0.5 },
  undoTxt: { color: '#3B82F6', fontWeight: '700' },
});
