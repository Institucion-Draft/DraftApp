import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import type { MtgColor } from '../lib/database.types';
import { avatarPublicUrl } from '../lib/avatarUrl';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'PairingDetail'>;

type PairingInfo = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
};

type MatchRow = {
  id: string;
  match_number: number;
  match_type: string;
  status: 'in_progress' | 'completed' | 'aborted';
  winner_participant_id: string | null;
  ended_by_surrender: boolean;
  started_at: string;
  ended_at: string | null;
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

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function shortName(name: string): string {
  return name.trim().slice(0, 3);
}

export default function PairingDetailScreen({ route, navigation }: Props) {
  const { pairingId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [a, setA] = useState<ParticipantRow | null>(null);
  const [b, setB] = useState<ParticipantRow | null>(null);
  const [aColors, setAColors] = useState<MtgColor[]>([]);
  const [bColors, setBColors] = useState<MtgColor[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [status, setStatus] = useState<'scheduled' | 'in_progress' | 'completed'>('scheduled');
  const [matches, setMatches] = useState<MatchRow[]>([]);
  /** Vidas actuales del match in_progress (si hay). */
  const [inProgressLives, setInProgressLives] = useState<{ a: number; b: number } | null>(null);
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id, official_winner_participant_id')
      .eq('id', pairingId)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setPairing(null);
      return;
    }
    const p = pData as PairingInfo;
    setPairing(p);

    const [meRes, eventRes, partRes, matchesRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('draft_events').select('workspace_id').eq('id', p.event_id).maybeSingle(),
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
        .in('id', [p.participant_a_id, p.participant_b_id]),
      supabase
        .from('matches')
        .select(
          'id, match_number, match_type, status, winner_participant_id, ended_by_surrender, started_at, ended_at'
        )
        .eq('pairing_id', p.id)
        .order('match_number', { ascending: true }),
    ]);

    setMyUserId(meRes.data.user?.id ?? null);
    if (eventRes.data?.workspace_id) {
      const roleRes = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', eventRes.data.workspace_id as string)
        .maybeSingle();
      setIsOrganizer(roleRes.data?.role === 'organizer');
    } else {
      setIsOrganizer(false);
    }

    const participants = (partRes.data ?? []) as ParticipantRow[];
    const map = new Map(participants.map((x) => [x.id, x]));
    const pa = map.get(p.participant_a_id) ?? null;
    const pb = map.get(p.participant_b_id) ?? null;
    setA(pa);
    setB(pb);

    const matchRows = (matchesRes.data ?? []) as MatchRow[];
    setMatches(matchRows);
    const inProgRow = matchRows.find((m) => m.status === 'in_progress') ?? null;
    if (inProgRow?.id) {
      const lifeRes = await supabase
        .from('life_events')
        .select('participant_id, resulting_life, occurred_at')
        .eq('match_id', inProgRow.id);
      const latest: Record<string, { life: number; at: string }> = {};
      if (!lifeRes.error) {
        for (const row of lifeRes.data ?? []) {
          const pid = String(row.participant_id);
          const at = String(row.occurred_at);
          if (!latest[pid] || latest[pid].at < at) {
            latest[pid] = { life: Number(row.resulting_life), at };
          }
        }
      }
      setInProgressLives({
        a: latest[p.participant_a_id]?.life ?? 20,
        b: latest[p.participant_b_id]?.life ?? 20,
      });
    } else {
      setInProgressLives(null);
    }

    const inProg = matchRows.some((m) => m.status === 'in_progress');
    if (inProg) setStatus('in_progress');
    else if (p.official_winner_participant_id) setStatus('completed');
    else setStatus('scheduled');

    const colorsRes = await supabase
      .from('participant_colors')
      .select('participant_id, color')
      .in('participant_id', [p.participant_a_id, p.participant_b_id]);
    const byP: Record<string, MtgColor[]> = {};
    for (const c of colorsRes.data ?? []) {
      const pid = c.participant_id as string;
      if (!byP[pid]) byP[pid] = [];
      byP[pid].push(c.color as MtgColor);
    }
    setAColors(byP[p.participant_a_id] ?? []);
    setBColors(byP[p.participant_b_id] ?? []);
  }, [pairingId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const first = firstRef.current;
        if (first) {
          setLoading(true);
          firstRef.current = false;
        }
        await load();
        if (!cancelled && first) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useLayoutEffect(() => {
    if (!pairing?.event_id) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingsList', { eventId: pairing.event_id }),
    });
  }, [navigation, pairing?.event_id]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }
  if (!pairing) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el enfrentamiento.</Text>
      </View>
    );
  }

  const au = relationOne(a?.users);
  const bu = relationOne(b?.users);
  const ada = relationOne(au?.default_avatars);
  const bda = relationOne(bu?.default_avatars);
  const aAvatar = au ? avatarPublicUrl(au.custom_avatar_path) ?? avatarPublicUrl(ada?.storage_path ?? null) : null;
  const bAvatar = bu ? avatarPublicUrl(bu.custom_avatar_path) ?? avatarPublicUrl(bda?.storage_path ?? null) : null;
  const aName = au?.display_name || au?.username || 'Jugador A';
  const bName = bu?.display_name || bu?.username || 'Jugador B';
  const isParticipant = !!myUserId && (a?.user_id === myUserId || b?.user_id === myUserId);
  const inProgressMatch = matches.find((m) => m.status === 'in_progress') ?? null;
  const officialMs = matches
    .filter((m) => m.match_type === 'draft' || m.match_type === 'final')
    .sort((a, b) => a.match_number - b.match_number);
  const revengeMs = matches
    .filter((m) => m.match_type === 'revenge')
    .sort((a, b) => a.match_number - b.match_number);
  const winsA = officialMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_a_id
  ).length;
  const winsB = officialMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_b_id
  ).length;
  const revengeCompleted = revengeMs.filter((m) => m.status === 'completed');
  const revengeWinsA = revengeCompleted.filter(
    (m) => m.winner_participant_id === pairing.participant_a_id
  ).length;
  const revengeWinsB = revengeCompleted.filter(
    (m) => m.winner_participant_id === pairing.participant_b_id
  ).length;

  const startMatch = async () => {
    if (!pairing) return;
    const activeRes = await supabase
      .from('matches')
      .select('id')
      .eq('pairing_id', pairing.id)
      .eq('status', 'in_progress')
      .limit(1)
      .maybeSingle();
    if (activeRes.error) {
      Alert.alert('Error', activeRes.error.message ?? 'No se pudo consultar la partida en curso.');
      return;
    }
    if (activeRes.data?.id) {
      navigation.navigate('LifeTracker', { matchId: String(activeRes.data.id) });
      return;
    }

    const nextNumber = (matches[matches.length - 1]?.match_number ?? 0) + 1;
    const matchType = pairing.official_winner_participant_id ? 'revenge' : 'draft';
    const { data, error } = await supabase
      .from('matches')
      .insert({
        pairing_id: pairing.id,
        match_number: nextNumber,
        match_type: matchType,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();
    if (error || !data?.id) {
      Alert.alert('Error', error?.message ?? 'No se pudo iniciar la partida.');
      return;
    }
    navigation.navigate('LifeTracker', { matchId: String(data.id) });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.hero}>
        <View style={styles.heroThreeCol}>
          <View style={[styles.heroSide, styles.heroSideLeft]}>
            {aAvatar ? <Image source={{ uri: aAvatar }} style={styles.heroAvatarBig} /> : <View style={[styles.heroAvatarBig, styles.ph]} />}
            <Text style={styles.heroPlayerName}>{aName}</Text>
            <View style={styles.heroBo3RowLeft}>
              <View style={[styles.heroBo3Box, winsA >= 1 && styles.heroBo3Filled]} />
              <View style={[styles.heroBo3Box, winsA >= 2 && styles.heroBo3Filled]} />
            </View>
          </View>
          <View style={styles.heroCenter}>
            <Text style={styles.heroVsBig}>vs</Text>
          </View>
          <View style={[styles.heroSide, styles.heroSideRight]}>
            {bAvatar ? <Image source={{ uri: bAvatar }} style={styles.heroAvatarBig} /> : <View style={[styles.heroAvatarBig, styles.ph]} />}
            <Text style={styles.heroPlayerName}>{bName}</Text>
            <View style={styles.heroBo3RowRight}>
              <View style={[styles.heroBo3Box, winsB >= 1 && styles.heroBo3Filled]} />
              <View style={[styles.heroBo3Box, winsB >= 2 && styles.heroBo3Filled]} />
            </View>
          </View>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Jugadores</Text>
        <Text style={styles.meta}>{aName} · Colores: {aColors.join(' ') || '—'}</Text>
        <Text style={styles.meta}>{bName} · Colores: {bColors.join(' ') || '—'}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Partidas</Text>
        {matches.length === 0 ? (
          <Text style={styles.muted}>Todavía no hay partidas.</Text>
        ) : (
          <>
            <Text style={styles.sectionSubtitle}>Partidas oficiales</Text>
            {officialMs.length === 0 ? (
              <Text style={styles.muted}>Todavía no hay partidas oficiales.</Text>
            ) : (
              officialMs.map((m, idx) => {
                const displayNum = idx + 1;
                const showLive =
                  m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
                return (
                  <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
                    <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                      #{displayNum} ·{' '}
                      {m.status === 'in_progress' ? '● EN VIVO' : m.status === 'aborted' ? 'Abortado' : 'Completado'}
                    </Text>
                    {showLive ? (
                      <Text style={styles.matchLiveScore}>
                        {aName} {inProgressLives.a} vs {inProgressLives.b} {bName}
                      </Text>
                    ) : null}
                    {m.status === 'in_progress' ? (
                      <Text style={styles.matchTime}>
                        Inicio{' '}
                        {new Date(m.started_at).toLocaleTimeString('es-AR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </Text>
                    ) : null}
                    {m.status === 'completed' && m.winner_participant_id ? (
                      <Text style={styles.matchWinner}>
                        Ganó {m.winner_participant_id === pairing.participant_a_id ? aName : bName}
                      </Text>
                    ) : null}
                    {m.status === 'completed' && !m.winner_participant_id ? (
                      <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                    ) : null}
                    {m.status === 'aborted' ? (
                      <Text style={styles.matchWinner}>Partida abortada.</Text>
                    ) : null}
                    {(m.status === 'completed' || m.status === 'aborted') && m.ended_at ? (
                      <Text style={styles.matchTime}>
                        Cierre: {new Date(m.ended_at).toLocaleString('es-AR')}
                      </Text>
                    ) : null}
                    {m.status === 'completed' && !m.ended_at ? (
                      <Text style={styles.matchTime}>Cierre pendiente.</Text>
                    ) : null}
                  </View>
                );
              })
            )}
            {revengeMs.length > 0 ? (
              <>
                <Text style={[styles.sectionSubtitle, styles.sectionSubtitleSpaced]}>Venganzas</Text>
                <Text style={styles.revengeCounter}>
                  {shortName(aName)} {revengeWinsA} - {revengeWinsB} {shortName(bName)}
                </Text>
                {revengeMs.map((m, idx) => {
                  const revengeNum = idx + 1;
                  const showLive =
                    m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
                  const winnerName =
                    m.winner_participant_id === pairing.participant_a_id
                      ? aName
                      : m.winner_participant_id === pairing.participant_b_id
                      ? bName
                      : null;
                  return (
                    <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
                      <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                        {m.status === 'completed' && winnerName
                          ? `Venganza N°${revengeNum} - Ganó ${winnerName}`
                          : `Venganza N°${revengeNum} · ${
                              m.status === 'in_progress'
                                ? '● EN VIVO'
                                : m.status === 'aborted'
                                ? 'Abortado'
                                : 'Completado'
                            }`}
                      </Text>
                      {showLive ? (
                        <Text style={styles.matchLiveScore}>
                          {aName} {inProgressLives.a} vs {inProgressLives.b} {bName}
                        </Text>
                      ) : null}
                      {m.status === 'in_progress' ? (
                        <Text style={styles.matchTime}>
                          Inicio{' '}
                          {new Date(m.started_at).toLocaleTimeString('es-AR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                      ) : null}
                      {m.status === 'completed' && !winnerName ? (
                        <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                      ) : null}
                      {m.status === 'aborted' ? (
                        <Text style={styles.matchWinner}>Partida abortada.</Text>
                      ) : null}
                      {(m.status === 'completed' || m.status === 'aborted') && m.ended_at ? (
                        <Text style={styles.matchTime}>
                          Cierre: {new Date(m.ended_at).toLocaleString('es-AR')}
                        </Text>
                      ) : null}
                      {m.status === 'completed' && !m.ended_at ? (
                        <Text style={styles.matchTime}>Cierre pendiente.</Text>
                      ) : null}
                    </View>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </View>

      {(isParticipant && status === 'scheduled') || isOrganizer ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={[styles.primaryBtn, inProgressMatch ? styles.resumeBtn : null]}
            onPress={() => void startMatch()}
          >
            <Text style={[styles.primaryBtnTxt, inProgressMatch ? styles.resumeBtnTxt : null]}>
              {inProgressMatch ? 'Retomar partida en curso' : 'Iniciar partida'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  muted: { color: '#666', fontSize: 14 },
  scroll: { paddingBottom: 30 },
  hero: { paddingVertical: 20, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  heroThreeCol: { flexDirection: 'row', alignItems: 'stretch', width: '100%' },
  heroSide: { flex: 1, alignItems: 'center', minWidth: 0 },
  heroSideLeft: { paddingRight: 4 },
  heroSideRight: { paddingLeft: 4 },
  heroCenter: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16 },
  heroVsBig: { fontSize: 22, fontWeight: '800', color: '#6B7280' },
  heroAvatarBig: { width: 88, height: 88, borderRadius: 18, backgroundColor: '#f3f4f6' },
  ph: { backgroundColor: '#E5E7EB' },
  heroPlayerName: { marginTop: 8, fontSize: 14, fontWeight: '700', color: '#111', textAlign: 'center' },
  heroBo3RowLeft: { flexDirection: 'row', marginTop: 10, alignSelf: 'flex-start', paddingLeft: 4 },
  heroBo3RowRight: { flexDirection: 'row', marginTop: 10, alignSelf: 'flex-end', paddingRight: 4 },
  heroBo3Box: {
    width: 26,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 6,
  },
  heroBo3Filled: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 8 },
  sectionSubtitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 6 },
  sectionSubtitleSpaced: { marginTop: 14 },
  revengeCounter: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 8 },
  meta: { fontSize: 14, color: '#666', marginBottom: 4 },
  matchRow: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  matchRowLive: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF' },
  matchLiveTxt: { color: '#1D4ED8', fontWeight: '700' },
  matchLiveScore: { color: '#111', fontWeight: '600', fontSize: 13, marginTop: 4 },
  matchWinner: { color: '#111', fontWeight: '600', fontSize: 13, marginTop: 2 },
  matchTime: { color: '#6B7280', fontSize: 12, marginTop: 2 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 12 },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  resumeBtn: { backgroundColor: '#FACC15' },
  resumeBtnTxt: { color: '#111827' },
});
