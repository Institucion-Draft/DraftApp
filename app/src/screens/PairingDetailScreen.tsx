import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import PlayerAvatar from '../components/PlayerAvatar';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import {
  findConcurrentInProgressDetailsForPairParticipants,
  formatConcurrentMatchBlockMessage,
} from '../lib/participantConcurrentMatch';
import {
  getTwoWayTieFirstPlaceParticipantIds,
  pairingIsBetweenParticipants,
  type PairingSummary,
} from '../lib/tiebreakLeaders';

const ABORT_WINDOW_MS = 3 * 60 * 1000;

type Props = NativeStackScreenProps<MainStackParamList, 'PairingDetail'>;

type PairingInfo = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  tiebreak_winner_participant_id: string | null;
  tiebreak_resolved_at: string | null;
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
  abort_requested_by: string | null;
  abort_requested_at: string | null;
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

/** Fecha y hora local en 24 h: DD/MM/YYYY HH:mm (sin segundos). */
function formatMatchTimestamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

/** Duración legible entre inicio y cierre de partida (solo si hay timestamps válidos). */
function formatCompletedMatchDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const a = new Date(startedAt).getTime();
  const b = new Date(endedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const totalSec = Math.round((b - a) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m} min` : `${h}h`;
  if (m > 0) return s > 0 ? `${m} min ${s}s` : `${m} min`;
  return `${s}s`;
}

export default function PairingDetailScreen({ route, navigation }: Props) {
  const { pairingId, fromTab: fromPairingsTab = 'official' } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [a, setA] = useState<ParticipantRow | null>(null);
  const [b, setB] = useState<ParticipantRow | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [status, setStatus] = useState<'scheduled' | 'in_progress' | 'completed'>('scheduled');
  const [matches, setMatches] = useState<MatchRow[]>([]);
  /** Vidas actuales del match in_progress (si hay). */
  const [inProgressLives, setInProgressLives] = useState<{ a: number; b: number } | null>(null);
  const [isTiebreakPairing, setIsTiebreakPairing] = useState(false);
  const [draftEventStatus, setDraftEventStatus] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select(
        'id, event_id, participant_a_id, participant_b_id, official_winner_participant_id, tiebreak_winner_participant_id, tiebreak_resolved_at'
      )
      .eq('id', pairingId)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setPairing(null);
      setDraftEventStatus(null);
      return;
    }
    const p = pData as PairingInfo;
    setPairing(p);

    const [meRes, eventRes, partRes, matchesRes, allPlayersRes, allPairingsRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase
        .from('draft_events')
        .select('workspace_id, status, final_pending, champion_user_id')
        .eq('id', p.event_id)
        .maybeSingle(),
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
          'id, match_number, match_type, status, winner_participant_id, ended_by_surrender, started_at, ended_at, abort_requested_by, abort_requested_at'
        )
        .eq('pairing_id', p.id)
        .order('match_number', { ascending: true }),
      supabase.from('event_participants').select('id').eq('event_id', p.event_id).eq('role', 'player'),
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id')
        .eq('event_id', p.event_id),
    ]);

    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);
    if (eventRes.data?.workspace_id && currentUserId) {
      const roleRes = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', eventRes.data.workspace_id as string)
        .eq('user_id', currentUserId)
        .maybeSingle();
      if (roleRes.error) {
        if (__DEV__) {
          console.error('Error cargando rol del workspace:', roleRes.error);
        }
      }
      setIsOrganizer(!roleRes.error && roleRes.data?.role === 'organizer');
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

    const ev = eventRes.data as {
      status?: string;
      final_pending?: boolean | null;
      champion_user_id?: string | null;
    } | null;
    setDraftEventStatus(ev?.status ?? null);
    let tiebreakHere = false;
    if (
      ev?.status === 'playing' &&
      ev?.final_pending === true &&
      (ev?.champion_user_id == null || ev.champion_user_id === '') &&
      !allPlayersRes.error &&
      !allPairingsRes.error &&
      allPlayersRes.data &&
      allPairingsRes.data
    ) {
      const playerIds = (allPlayersRes.data as { id: string }[]).map((x) => x.id);
      const pairSumm = allPairingsRes.data as PairingSummary[];
      const leaders = getTwoWayTieFirstPlaceParticipantIds(playerIds, pairSumm);
      if (
        leaders &&
        pairingIsBetweenParticipants(p, leaders[0], leaders[1]) &&
        p.official_winner_participant_id != null &&
        p.tiebreak_winner_participant_id == null
      ) {
        tiebreakHere = true;
      }
    }
    setIsTiebreakPairing(tiebreakHere);
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

  }, [pairingId]);

  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel(`pairing-matches:${pairingId}:${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'matches',
          filter: `pairing_id=eq.${pairingId}`,
        },
        () => {
          void load();
        }
      )
      .subscribe();
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [pairingId, load]);

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

  const requestAbortMatch = useCallback(
    async (m: MatchRow) => {
      if (!myUserId) return;
      const { error } = await supabase
        .from('matches')
        .update({ abort_requested_by: myUserId, abort_requested_at: new Date().toISOString() })
        .eq('id', m.id);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudo solicitar el aborto.');
        return;
      }
      await load();
    },
    [myUserId, load]
  );

  const confirmAbortMatch = useCallback(
    async (m: MatchRow) => {
      const { error } = await supabase
        .from('matches')
        .update({
          status: 'aborted',
          ended_at: new Date().toISOString(),
          abort_requested_by: null,
          abort_requested_at: null,
        })
        .eq('id', m.id);
      if (error) {
        Alert.alert('Error', error.message ?? 'No se pudo abortar la partida.');
        return;
      }
      await load();
    },
    [load]
  );

  const renderMatchAbortControl = useCallback(
    (m: MatchRow) => {
      if (m.status !== 'in_progress') return null;
      if (!myUserId || !a || !b) return null;
      if (a.user_id !== myUserId && b.user_id !== myUserId) return null;

      const isAbortRequestActive = Boolean(
        m.abort_requested_by &&
          m.abort_requested_at &&
          nowTs - new Date(m.abort_requested_at).getTime() < ABORT_WINDOW_MS
      );

      const iRequested = isAbortRequestActive && m.abort_requested_by === myUserId;
      const otherRequested = isAbortRequestActive && m.abort_requested_by !== myUserId;

      const onTrashPress = () => {
        if (iRequested) return;
        if (otherRequested) {
          Alert.alert(
            'Confirmar aborto',
            '¿Confirmás abortar la partida? Va a desaparecer como si nunca hubiera existido.',
            [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Sí, abortar', onPress: () => void confirmAbortMatch(m) },
            ]
          );
          return;
        }
        const otherP = myUserId === a.user_id ? b : a;
        const ou = relationOne(otherP.users);
        const otherName = ou?.display_name || ou?.username || 'el otro jugador';
        Alert.alert(
          'Solicitar aborto',
          `¿Solicitar abortar partida? ${otherName} tiene 3 minutos para aceptar la solicitud.`,
          [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Solicitar', onPress: () => void requestAbortMatch(m) },
          ]
        );
      };

      return (
        <View style={styles.matchAbortActions}>
          <TouchableOpacity style={styles.abortTrashBtn} onPress={onTrashPress} disabled={iRequested}>
            <Text style={styles.abortTrashEmoji}>🗑️</Text>
          </TouchableOpacity>
          {isAbortRequestActive ? (
            <Text style={[styles.abortBadge, otherRequested ? styles.abortBadgeAlert : styles.abortBadgeMuted]}>
              1/2
            </Text>
          ) : null}
        </View>
      );
    },
    [a, b, myUserId, nowTs, requestAbortMatch, confirmAbortMatch]
  );

  useLayoutEffect(() => {
    if (!pairing?.event_id) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingsList', {
        eventId: pairing.event_id,
        initialTab: fromPairingsTab,
      }),
    });
  }, [navigation, pairing?.event_id, fromPairingsTab]);

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
  const aName = au?.display_name || au?.username || 'Jugador A';
  const bName = bu?.display_name || bu?.username || 'Jugador B';
  const isParticipant = !!myUserId && (a?.user_id === myUserId || b?.user_id === myUserId);
  const inProgressMatch = matches.find((m) => m.status === 'in_progress') ?? null;
  const officialMs = matches
    .filter((m) => (m.match_type === 'draft' || m.match_type === 'final') && m.status !== 'aborted')
    .sort((a, b) => a.match_number - b.match_number);
  const revengeMs = matches
    .filter((m) => m.match_type === 'revenge' && m.status !== 'aborted')
    .sort((a, b) => a.match_number - b.match_number);
  const tiebreakMs = matches
    .filter((m) => m.match_type === 'tiebreak' && m.status !== 'aborted')
    .sort((a, b) => a.match_number - b.match_number);
  const tiebreakWinsA = tiebreakMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_a_id
  ).length;
  const tiebreakWinsB = tiebreakMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_b_id
  ).length;
  const tiebreakWinnerName =
    pairing.tiebreak_winner_participant_id === pairing.participant_a_id
      ? aName
      : pairing.tiebreak_winner_participant_id === pairing.participant_b_id
      ? bName
      : null;
  const showTiebreakSection = tiebreakMs.length > 0 || isTiebreakPairing;
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
  const eventIsCancelled = draftEventStatus === 'cancelled';

  const startButtonLabel = inProgressMatch
    ? inProgressMatch.match_type === 'tiebreak'
      ? 'Retomar desempate en curso'
      : inProgressMatch.match_type === 'revenge'
      ? 'Retomar venganza en curso'
      : 'Retomar partida en curso'
    : isTiebreakPairing && pairing.tiebreak_winner_participant_id == null
    ? 'Iniciar desempate'
    : pairing.official_winner_participant_id != null
    ? 'Iniciar venganza'
    : 'Iniciar partida';
  const showResumeStyle = startButtonLabel.startsWith('Retomar');

  const startMatch = async () => {
    if (!pairing) return;
    if (eventIsCancelled) {
      Alert.alert('Evento cancelado', 'No se pueden iniciar partidas en un evento cancelado.');
      return;
    }
    const details = await findConcurrentInProgressDetailsForPairParticipants({
      eventId: pairing.event_id,
      excludePairingId: pairing.id,
      participantAId: pairing.participant_a_id,
      participantBId: pairing.participant_b_id,
    });
    const blockMsg = formatConcurrentMatchBlockMessage({
      nameA: aName,
      nameB: bName,
      participantAId: pairing.participant_a_id,
      participantBId: pairing.participant_b_id,
      userIdA: a?.user_id ?? '',
      userIdB: b?.user_id ?? '',
      myUserId,
      isWorkspaceOrganizer: isOrganizer,
      aInOtherMatchId: details.participantAInOtherMatchId,
      bInOtherMatchId: details.participantBInOtherMatchId,
    });
    if (blockMsg) {
      Alert.alert('Partida en curso', blockMsg);
      return;
    }
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
      navigation.navigate('LifeTracker', {
        matchId: String(activeRes.data.id),
        fromTab: fromPairingsTab,
      });
      return;
    }

    const nextNumber = (matches[matches.length - 1]?.match_number ?? 0) + 1;
    let matchType: 'draft' | 'revenge' | 'tiebreak';
    if (!pairing.official_winner_participant_id) {
      matchType = 'draft';
    } else if (isTiebreakPairing && !pairing.tiebreak_winner_participant_id) {
      matchType = 'tiebreak';
    } else {
      matchType = 'revenge';
    }
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
    navigation.navigate('LifeTracker', { matchId: String(data.id), fromTab: fromPairingsTab });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.hero}>
        <View style={styles.heroThreeCol}>
          <View style={[styles.heroSide, styles.heroSideLeft]}>
            {a ? (
              <PlayerAvatar
                userId={a.user_id}
                participantId={a.id}
                size="large"
                withColorBorder
                borderWidth={4}
              />
            ) : null}
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
            {b ? (
              <PlayerAvatar
                userId={b.user_id}
                participantId={b.id}
                size="large"
                withColorBorder
                borderWidth={4}
              />
            ) : null}
            <Text style={styles.heroPlayerName}>{bName}</Text>
            <View style={styles.heroBo3RowRight}>
              <View style={[styles.heroBo3Box, winsB >= 1 && styles.heroBo3Filled]} />
              <View style={[styles.heroBo3Box, winsB >= 2 && styles.heroBo3Filled]} />
            </View>
          </View>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Partidas</Text>
        {officialMs.length === 0 && revengeMs.length === 0 && tiebreakMs.length === 0 && !isTiebreakPairing ? (
          <Text style={styles.muted}>Todavía no hay partidas.</Text>
        ) : (
          <>
            <Text style={styles.sectionSubtitle}>Partidas oficiales</Text>
            {officialMs.length === 0 ? (
              <Text style={styles.muted}>Todavía no hay partidas oficiales.</Text>
            ) : (
              officialMs.map((m, idx) => {
                const displayNum = idx + 1;
                const durationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
                const showLive =
                  m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
                return (
                  <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
                    <View style={styles.matchRowMain}>
                      <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                        #{displayNum} ·{' '}
                        {m.status === 'in_progress' ? '● EN VIVO' : 'Completado'}
                      </Text>
                      {showLive ? (
                        <Text style={styles.matchLiveScore}>
                          {aName} {inProgressLives.a} vs {inProgressLives.b} {bName}
                        </Text>
                      ) : null}
                      {m.status === 'in_progress' ? (
                        <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text>
                      ) : null}
                      {m.status === 'completed' && m.winner_participant_id ? (
                        <View>
                          <Text style={styles.matchWinner}>
                            Ganó {m.winner_participant_id === pairing.participant_a_id ? aName : bName}
                          </Text>
                          {durationLabel ? (
                            <Text style={styles.matchDuration}>Duración: {durationLabel}</Text>
                          ) : null}
                        </View>
                      ) : null}
                      {m.status === 'completed' && !m.winner_participant_id ? (
                        <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                      ) : null}
                      {m.status === 'completed' && m.ended_at ? (
                        <Text style={styles.matchTime}>{formatMatchTimestamp(m.ended_at)}</Text>
                      ) : null}
                      {m.status === 'completed' && !m.ended_at ? (
                        <Text style={styles.matchTime}>Cierre pendiente.</Text>
                      ) : null}
                    </View>
                    {renderMatchAbortControl(m)}
                  </View>
                );
              })
            )}
            {showTiebreakSection ? (
              <>
                <Text style={[styles.sectionSubtitle, styles.sectionSubtitleSpaced]}>Desempate</Text>
                <Text style={styles.revengeCounter}>
                  {shortName(aName)} {tiebreakWinsA} - {tiebreakWinsB} {shortName(bName)}
                  {tiebreakWinnerName ? ` · Ganó ${tiebreakWinnerName}` : ''}
                </Text>
                {tiebreakMs.length === 0 ? (
                  <Text style={styles.muted}>Todavía no hay partidas de desempate.</Text>
                ) : (
                  tiebreakMs.map((m, idx) => {
                    const displayNum = idx + 1;
                    const durationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
                    const showLive =
                      m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
                    return (
                      <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
                        <View style={styles.matchRowMain}>
                          <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                            #{displayNum} ·{' '}
                            {m.status === 'in_progress' ? '● EN VIVO' : 'Completado'}
                          </Text>
                          {showLive ? (
                            <Text style={styles.matchLiveScore}>
                              {aName} {inProgressLives.a} vs {inProgressLives.b} {bName}
                            </Text>
                          ) : null}
                          {m.status === 'in_progress' ? (
                            <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text>
                          ) : null}
                          {m.status === 'completed' && m.winner_participant_id ? (
                            <View>
                              <Text style={styles.matchWinner}>
                                Ganó {m.winner_participant_id === pairing.participant_a_id ? aName : bName}
                              </Text>
                              {durationLabel ? (
                                <Text style={styles.matchDuration}>Duración: {durationLabel}</Text>
                              ) : null}
                            </View>
                          ) : null}
                          {m.status === 'completed' && !m.winner_participant_id ? (
                            <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                          ) : null}
                          {m.status === 'completed' && m.ended_at ? (
                            <Text style={styles.matchTime}>{formatMatchTimestamp(m.ended_at)}</Text>
                          ) : null}
                          {m.status === 'completed' && !m.ended_at ? (
                            <Text style={styles.matchTime}>Cierre pendiente.</Text>
                          ) : null}
                        </View>
                        {renderMatchAbortControl(m)}
                      </View>
                    );
                  })
                )}
              </>
            ) : null}
            {revengeMs.length > 0 ? (
              <>
                <Text style={[styles.sectionSubtitle, styles.sectionSubtitleSpaced]}>Venganzas</Text>
                <Text style={styles.revengeCounter}>
                  {shortName(aName)} {revengeWinsA} - {revengeWinsB} {shortName(bName)}
                </Text>
                {revengeMs.map((m, idx) => {
                  const revengeNum = idx + 1;
                  const revengeDurationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
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
                      <View style={styles.matchRowMain}>
                        <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                          {m.status === 'completed' && winnerName
                            ? `Venganza N°${revengeNum} - Ganó ${winnerName}`
                            : `Venganza N°${revengeNum} · ${
                                m.status === 'in_progress' ? '● EN VIVO' : 'Completado'
                              }`}
                        </Text>
                        {showLive ? (
                          <Text style={styles.matchLiveScore}>
                            {aName} {inProgressLives.a} vs {inProgressLives.b} {bName}
                          </Text>
                        ) : null}
                        {m.status === 'in_progress' ? (
                          <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text>
                        ) : null}
                        {m.status === 'completed' && winnerName && revengeDurationLabel ? (
                          <Text style={styles.matchDuration}>Duración: {revengeDurationLabel}</Text>
                        ) : null}
                        {m.status === 'completed' && !winnerName ? (
                          <View>
                            <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                            {revengeDurationLabel ? (
                              <Text style={styles.matchDuration}>Duración: {revengeDurationLabel}</Text>
                            ) : null}
                          </View>
                        ) : null}
                        {m.status === 'completed' && m.ended_at ? (
                          <Text style={styles.matchTime}>{formatMatchTimestamp(m.ended_at)}</Text>
                        ) : null}
                        {m.status === 'completed' && !m.ended_at ? (
                          <Text style={styles.matchTime}>Cierre pendiente.</Text>
                        ) : null}
                      </View>
                      {renderMatchAbortControl(m)}
                    </View>
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </View>

      {isParticipant || isOrganizer ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              showResumeStyle ? styles.resumeBtn : null,
              eventIsCancelled ? styles.primaryBtnDisabled : null,
            ]}
            disabled={eventIsCancelled}
            onPress={() => void startMatch()}
          >
            <Text style={[styles.primaryBtnTxt, showResumeStyle ? styles.resumeBtnTxt : null]}>{startButtonLabel}</Text>
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
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  matchRowMain: { flex: 1, minWidth: 0 },
  matchAbortActions: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginLeft: 'auto',
    alignSelf: 'flex-start',
  },
  abortTrashBtn: { padding: 4, alignSelf: 'flex-start' },
  abortTrashEmoji: { fontSize: 14 },
  abortBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
  },
  abortBadgeMuted: { backgroundColor: '#E5E7EB', color: '#6B7280' },
  abortBadgeAlert: { backgroundColor: '#FEE2E2', color: '#DC2626' },
  matchRowLive: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF' },
  matchLiveTxt: { color: '#1D4ED8', fontWeight: '700' },
  matchLiveScore: { color: '#111', fontWeight: '600', fontSize: 13, marginTop: 4 },
  matchWinner: { color: '#111', fontWeight: '600', fontSize: 13, marginTop: 2 },
  matchDuration: { color: '#4B5563', fontSize: 12, marginTop: 4, fontWeight: '500' },
  matchTime: { color: '#6B7280', fontSize: 12, marginTop: 2 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, alignItems: 'center', paddingVertical: 12 },
  primaryBtnDisabled: { opacity: 0.45 },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  resumeBtn: { backgroundColor: '#FACC15' },
  resumeBtnTxt: { color: '#111827' },
});
