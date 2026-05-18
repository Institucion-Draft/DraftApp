import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';

type Props = NativeStackScreenProps<MainStackParamList, 'MatchResult'>;

type MatchRow = {
  id: string;
  pairing_id: string;
  winner_participant_id: string | null;
  match_type: 'draft' | 'revenge' | 'final' | 'two_headed_giant' | 'tiebreak';
  started_at: string;
  ended_at: string | null;
};

type PairingRow = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  swiss_round: number | null;
  official_winner_participant_id: string | null;
  tiebreak_winner_participant_id: string | null;
  super_cup_winner_participant_id: string | null;
  super_cup_resolved_at: string | null;
  revenge_cup_winner_participant_id: string | null;
  revenge_cup_resolved_at: string | null;
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

/** Alineado con `public.topcut_wins_needed` (migración 0039). */
function topcutWinsNeededClient(
  format: string | null | undefined,
  phase: 'semi' | 'final' | 'third_place'
): number {
  const f = format ?? 'bo3';
  if (f === 'bo1') return 1;
  if (f === 'sf_bo1_f_bo3') return phase === 'semi' ? 1 : 2;
  return 2;
}

export default function MatchResultScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [pairing, setPairing] = useState<PairingRow | null>(null);
  const [pa, setPa] = useState<ParticipantRow | null>(null);
  const [pb, setPb] = useState<ParticipantRow | null>(null);
  const [winsA, setWinsA] = useState(0);
  const [winsB, setWinsB] = useState(0);
  const [completedPairingMatchCount, setCompletedPairingMatchCount] = useState(0);
  const [tiebreakWinsA, setTiebreakWinsA] = useState(0);
  const [tiebreakWinsB, setTiebreakWinsB] = useState(0);
  const [superCupWinnerName, setSuperCupWinnerName] = useState<string | null>(null);
  const [revengeCupWinnerName, setRevengeCupWinnerName] = useState<string | null>(null);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [competitionFormat, setCompetitionFormat] = useState<'round_robin' | 'swiss'>('round_robin');
  const [currentSwissRound, setCurrentSwissRound] = useState<number | null>(null);
  /** Solo mata-mata suizo bracket: victorias necesarias en la llave; null si no aplica. */
  const [bracketTiebreakWinsNeeded, setBracketTiebreakWinsNeeded] = useState<number | null>(null);
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const mRes = await supabase
      .from('matches')
      .select('id, pairing_id, winner_participant_id, match_type, started_at, ended_at')
      .eq('id', matchId)
      .maybeSingle();
    if (mRes.error || !mRes.data) {
      Alert.alert('Error', 'No se pudo cargar el resultado.');
      setLoading(false);
      return;
    }
    const m = mRes.data as MatchRow;
    setMatch(m);
    setBracketTiebreakWinsNeeded(null);

    const pRes = await supabase
      .from('pairings')
      .select(
        'id, event_id, participant_a_id, participant_b_id, swiss_round, official_winner_participant_id, tiebreak_winner_participant_id, super_cup_winner_participant_id, super_cup_resolved_at, revenge_cup_winner_participant_id, revenge_cup_resolved_at'
      )
      .eq('id', m.pairing_id)
      .maybeSingle();
    if (pRes.error || !pRes.data) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setLoading(false);
      return;
    }
    const p = pRes.data as PairingRow;
    setPairing(p);
    setSuperCupWinnerName(null);
    setRevengeCupWinnerName(null);

    const [partsRes, winsRes, tiebreakWinsRes, completedCountRes, superCupWinnerRes, revengeCupWinnerRes, eventFlagsRes, tiebreakGroupRes] =
      await Promise.all([
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
        .select('winner_participant_id, match_type')
        .eq('pairing_id', p.id)
        .not('winner_participant_id', 'is', null)
        .in('match_type', ['draft', 'final']),
      supabase
        .from('matches')
        .select('winner_participant_id')
        .eq('pairing_id', p.id)
        .eq('match_type', 'tiebreak')
        .eq('status', 'completed')
        .not('winner_participant_id', 'is', null),
      supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('pairing_id', p.id)
        .eq('status', 'completed'),
      p.super_cup_winner_participant_id
        ? supabase
            .from('event_participants')
            .select(
              `
              users!event_participants_user_id_fkey (
                display_name
              )
            `
            )
            .eq('id', p.super_cup_winner_participant_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      p.revenge_cup_winner_participant_id
        ? supabase
            .from('event_participants')
            .select(
              `
              users!event_participants_user_id_fkey (
                display_name
              )
            `
            )
            .eq('id', p.revenge_cup_winner_participant_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as const),
      supabase
        .from('draft_events')
        .select('turn_tracking_enabled, topcut_format, competition_format, current_swiss_round')
        .eq('id', p.event_id)
        .maybeSingle(),
      supabase
        .from('event_tiebreak_groups')
        .select('id, group_type, group_origin')
        .eq('event_id', p.event_id)
        .in('status', ['active', 'resolved'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (
      partsRes.error ||
      winsRes.error ||
      tiebreakWinsRes.error ||
      completedCountRes.error ||
      superCupWinnerRes.error ||
      revengeCupWinnerRes.error ||
      eventFlagsRes.error ||
      tiebreakGroupRes.error
    ) {
      Alert.alert('Error', 'No se pudo cargar el estado del resultado.');
      setLoading(false);
      return;
    }
    const map = new Map((partsRes.data ?? []).map((x: any) => [x.id, x as ParticipantRow]));
    setPa(map.get(p.participant_a_id) ?? null);
    setPb(map.get(p.participant_b_id) ?? null);
    setWinsA((winsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_a_id).length);
    setWinsB((winsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_b_id).length);
    setTiebreakWinsA(
      (tiebreakWinsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_a_id).length
    );
    setTiebreakWinsB(
      (tiebreakWinsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_b_id).length
    );
    const superWinnerUser = relationOne(
      (superCupWinnerRes.data as { users?: { display_name?: string | null } | { display_name?: string | null }[] | null } | null)
        ?.users
    );
    const revengeWinnerUser = relationOne(
      (revengeCupWinnerRes.data as { users?: { display_name?: string | null } | { display_name?: string | null }[] | null } | null)
        ?.users
    );
    setSuperCupWinnerName(superWinnerUser?.display_name ?? null);
    setRevengeCupWinnerName(revengeWinnerUser?.display_name ?? null);
    setCompletedPairingMatchCount(completedCountRes.count ?? 0);
    const eventFlags = eventFlagsRes.data as {
      turn_tracking_enabled?: boolean | null;
      topcut_format?: string | null;
      competition_format?: string | null;
      current_swiss_round?: number | string | null;
    } | null;
    setTurnTrackingEnabled(!!eventFlags?.turn_tracking_enabled);
    const fmt = eventFlags?.competition_format === 'swiss' ? 'swiss' : 'round_robin';
    setCompetitionFormat(fmt);
    const csrRaw = eventFlags?.current_swiss_round;
    const csrNum = csrRaw != null && csrRaw !== '' ? Number(csrRaw) : null;
    setCurrentSwissRound(csrNum != null && Number.isFinite(csrNum) ? csrNum : null);

    const tfRaw = eventFlags?.topcut_format;
    const tf = tfRaw === 'bo1' || tfRaw === 'sf_bo1_f_bo3' || tfRaw === 'bo3' ? tfRaw : 'bo3';
    let bracketWN: number | null = null;
    if (m.match_type === 'tiebreak') {
      const tgd = tiebreakGroupRes.data as {
        id: string;
        group_type: string;
        group_origin: string | null;
      } | null;
      if (tgd?.group_type === 'bracket' && tgd.group_origin === 'swiss_topcut') {
        const bmRes = await supabase
          .from('event_tiebreak_bracket_matches')
          .select('bracket_phase, pairing_id, participant_a_id, participant_b_id')
          .eq('group_id', tgd.id);
        if (!bmRes.error && bmRes.data) {
          const rows = bmRes.data as {
            bracket_phase: 'semi' | 'final' | 'third_place';
            pairing_id: string | null;
            participant_a_id: string;
            participant_b_id: string;
          }[];
          const row =
            rows.find((r) => r.pairing_id === p.id) ??
            rows.find(
              (r) =>
                (r.participant_a_id === p.participant_a_id && r.participant_b_id === p.participant_b_id) ||
                (r.participant_a_id === p.participant_b_id && r.participant_b_id === p.participant_a_id)
            ) ??
            null;
          if (row) {
            bracketWN = topcutWinsNeededClient(tf, row.bracket_phase);
          }
        }
      }
    }
    setBracketTiebreakWinsNeeded(bracketWN);

    setLoading(false);
  }, [matchId]);

  useFocusEffect(
    useCallback(() => {
      void (async () => {
        if (firstRef.current) setLoading(true);
        await load();
        firstRef.current = false;
      })();
    }, [load])
  );

  useLayoutEffect(() => {
    if (!pairing) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingDetail', { pairingId: pairing.id }),
    });
  }, [navigation, pairing?.id]);

  if (loading || !match || !pairing || !pa || !pb) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const ua = relationOne(pa.users);
  const ub = relationOne(pb.users);
  const aName = ua?.display_name || ua?.username || 'Jugador A';
  const bName = ub?.display_name || ub?.username || 'Jugador B';
  const winnerIsA = match.winner_participant_id === pairing.participant_a_id;
  const winnerIsB = match.winner_participant_id === pairing.participant_b_id;
  const winnerName = winnerIsA ? aName : winnerIsB ? bName : 'Sin definir';
  const rematchLabel =
    match.match_type === 'tiebreak'
      ? tiebreakWinsA >= 1 && tiebreakWinsB >= 1
        ? 'Jugar el bueno'
        : 'Jugar la vuelta'
      : match.match_type === 'revenge'
        ? 'Otra venganza'
        : completedPairingMatchCount >= 2
          ? 'Jugar el bueno'
          : 'Jugar la vuelta';
  const durationMs =
    match.ended_at != null
      ? new Date(match.ended_at).getTime() - new Date(match.started_at).getTime()
      : 0;
  const durSec = Math.max(0, Math.floor(durationMs / 1000));
  const durMm = String(Math.floor(durSec / 60)).padStart(2, '0');
  const durSs = String(durSec % 60).padStart(2, '0');
  const officialBo3StillOpen =
    (match.match_type === 'draft' || match.match_type === 'final') &&
    pairing.official_winner_participant_id == null &&
    winsA < 2 &&
    winsB < 2;
  const bracketTiebreakSeriesStillOpen =
    match.match_type === 'tiebreak' &&
    bracketTiebreakWinsNeeded != null &&
    Math.max(tiebreakWinsA, tiebreakWinsB) < bracketTiebreakWinsNeeded;
  const showRematchBtn =
    bracketTiebreakSeriesStillOpen ||
    (match.match_type !== 'tiebreak' && (match.match_type === 'revenge' || officialBo3StillOpen));

  const isOfficialOpen =
    (match.match_type === 'draft' || match.match_type === 'final') && winsA < 2 && winsB < 2;
  const matchEndedAt = match.ended_at ? new Date(match.ended_at).getTime() : 0;
  const superCupTriggeredHere =
    match.match_type === 'revenge' &&
    pairing.super_cup_resolved_at != null &&
    Math.abs(new Date(pairing.super_cup_resolved_at).getTime() - matchEndedAt) < 5000;
  const revengeCupTriggeredHere =
    match.match_type === 'revenge' &&
    pairing.revenge_cup_resolved_at != null &&
    Math.abs(new Date(pairing.revenge_cup_resolved_at).getTime() - matchEndedAt) < 5000;
  const scoreLine1 =
    match.match_type === 'tiebreak'
      ? `${aName}: ${tiebreakWinsA} · ${bName}: ${tiebreakWinsB}`
      : `${aName}: ${winsA} · ${bName}: ${winsB}`;
  const extraLines: string[] = [];
  if (match.match_type === 'revenge') {
    if (superCupTriggeredHere) {
      extraLines.push(`${superCupWinnerName ?? '...'} gana la Super Copa 🏆`);
    }
    if (revengeCupTriggeredHere) {
      extraLines.push(`${revengeCupWinnerName ?? '...'} gana la Copa Venganza 🏆`);
    }
  } else if (!isOfficialOpen) {
    extraLines.push(`${winsA >= 2 ? aName : bName} gana el enfrentamiento`);
  }

  const createRematch = async () => {
    const countRes = await supabase
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('pairing_id', pairing.id);
    if (countRes.error) {
      Alert.alert('Error', 'No se pudo crear la revancha.');
      return;
    }
    const number = (countRes.count ?? 0) + 1;
    const type =
      match.match_type === 'tiebreak'
        ? 'tiebreak'
        : competitionFormat === 'swiss' &&
            (pairing.swiss_round == null ||
              currentSwissRound == null ||
              pairing.swiss_round !== currentSwissRound)
          ? 'revenge'
          : pairing.official_winner_participant_id
            ? 'revenge'
            : 'draft';
    const insRes = await supabase
      .from('matches')
      .insert({ pairing_id: pairing.id, match_number: number, match_type: type, started_at: new Date().toISOString() })
      .select('id')
      .maybeSingle();
    if (insRes.error || !insRes.data?.id) {
      Alert.alert('Error', insRes.error?.message ?? 'No se pudo iniciar la revancha.');
      return;
    }
    navigation.replace('LifeTracker', { matchId: insRes.data.id as string });
  };

  return (
    <View style={styles.container}>
      {(winnerIsA || winnerIsB) ? <ConfettiCannon count={100} origin={{ x: winnerIsA ? 80 : 300, y: 0 }} fadeOut /> : null}
      <View style={styles.hero}>
        <Text style={styles.winText}>Gana {winnerName}</Text>
        <View style={styles.avatarHeroRow}>
          {winnerIsA ? (
            <>
              <PlayerAvatar
                userId={pa.user_id}
                participantId={pa.id}
                size="xlarge"
                withColorBorder={false}
              />
              <View style={styles.loserAvatarWrap}>
                <PlayerAvatar
                  userId={pb.user_id}
                  participantId={pb.id}
                  size="medium"
                  withColorBorder={false}
                />
              </View>
            </>
          ) : (
            <>
              <PlayerAvatar
                userId={pb.user_id}
                participantId={pb.id}
                size="xlarge"
                withColorBorder={false}
              />
              <View style={styles.loserAvatarWrap}>
                <PlayerAvatar
                  userId={pa.user_id}
                  participantId={pa.id}
                  size="medium"
                  withColorBorder={false}
                />
              </View>
            </>
          )}
        </View>
        <Text style={styles.sub}>Duración: {durMm}:{durSs}</Text>
      </View>

      {match.match_type !== 'tiebreak' ? (
        <View style={styles.block}>
          <Text style={styles.meta}>{scoreLine1}</Text>
          {extraLines.map((line, idx) => (
            <Text key={idx} style={styles.meta}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        {turnTrackingEnabled ? (
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => navigation.navigate('LifeChart', { matchId })}
          >
            <Text style={styles.secondaryTxt}>Evolución de vida</Text>
          </TouchableOpacity>
        ) : null}
        {showRematchBtn ? (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => void createRematch()}>
            <Text style={styles.primaryTxt}>{rematchLabel}</Text>
          </TouchableOpacity>
        ) : null}
        {match.match_type === 'tiebreak' ? (
          <>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('PairingsList', { eventId: pairing.event_id })}>
              <Text style={styles.primaryTxt}>Enfrentamientos</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('EventDetail', { eventId: pairing.event_id })}>
              <Text style={styles.primaryTxt}>Volver al evento</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('PairingsList', { eventId: pairing.event_id })}>
              <Text style={styles.secondaryTxt}>Enfrentamientos</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('EventDetail', { eventId: pairing.event_id })}>
              <Text style={styles.secondaryTxt}>Volver al evento</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 24 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  hero: { alignItems: 'center', marginBottom: 22, marginTop: 12 },
  winText: { fontSize: 30, fontWeight: '900', color: '#111', textAlign: 'center', marginBottom: 12 },
  avatarHeroRow: { width: '100%', alignItems: 'center', justifyContent: 'center', minHeight: 160 },
  loserAvatarWrap: {
    position: 'absolute',
    right: 16,
    bottom: 4,
    opacity: 0.5,
  },
  sub: { color: '#666', marginTop: 4 },
  block: { borderWidth: 1, borderColor: '#eee', borderRadius: 10, padding: 12, marginBottom: 18 },
  meta: { color: '#111', marginBottom: 4 },
  actions: { gap: 10 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  primaryTxt: { color: '#fff', fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  secondaryTxt: { color: '#374151', fontWeight: '700' },
});
