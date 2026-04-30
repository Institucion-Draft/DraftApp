import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import ConfettiCannon from 'react-native-confetti-cannon';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';

type Props = NativeStackScreenProps<MainStackParamList, 'MatchResult'>;

type MatchRow = {
  id: string;
  pairing_id: string;
  winner_participant_id: string | null;
  match_type: 'draft' | 'revenge' | 'final' | 'two_headed_giant';
  started_at: string;
  ended_at: string | null;
};

type PairingRow = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
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

    const pRes = await supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id, official_winner_participant_id')
      .eq('id', m.pairing_id)
      .maybeSingle();
    if (pRes.error || !pRes.data) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setLoading(false);
      return;
    }
    const p = pRes.data as PairingRow;
    setPairing(p);

    const [partsRes, winsRes, completedCountRes] = await Promise.all([
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
      supabase.from('matches').select('winner_participant_id').eq('pairing_id', p.id).not('winner_participant_id', 'is', null),
      supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('pairing_id', p.id)
        .eq('status', 'completed'),
    ]);
    if (partsRes.error || winsRes.error || completedCountRes.error) {
      Alert.alert('Error', 'No se pudo cargar el estado del resultado.');
      setLoading(false);
      return;
    }
    const map = new Map((partsRes.data ?? []).map((x: any) => [x.id, x as ParticipantRow]));
    setPa(map.get(p.participant_a_id) ?? null);
    setPb(map.get(p.participant_b_id) ?? null);
    setWinsA((winsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_a_id).length);
    setWinsB((winsRes.data ?? []).filter((x) => x.winner_participant_id === p.participant_b_id).length);
    setCompletedPairingMatchCount(completedCountRes.count ?? 0);
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
  const ada = relationOne(ua?.default_avatars);
  const bda = relationOne(ub?.default_avatars);
  const aAvatar = ua ? avatarPublicUrl(ua.custom_avatar_path) ?? avatarPublicUrl(ada?.storage_path ?? null) : null;
  const bAvatar = ub ? avatarPublicUrl(ub.custom_avatar_path) ?? avatarPublicUrl(bda?.storage_path ?? null) : null;
  const winnerIsA = match.winner_participant_id === pairing.participant_a_id;
  const winnerIsB = match.winner_participant_id === pairing.participant_b_id;
  const winnerName = winnerIsA ? aName : winnerIsB ? bName : 'Sin definir';
  const rematchLabel =
    match.match_type === 'revenge'
      ? 'Otra venganza'
      : pairing.official_winner_participant_id
        ? 'Venganza'
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
    const type = pairing.official_winner_participant_id ? 'revenge' : 'draft';
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
              {aAvatar ? <Image source={{ uri: aAvatar }} style={styles.winnerAvatar} /> : <View style={[styles.winnerAvatar, styles.ph]} />}
              {bAvatar ? <Image source={{ uri: bAvatar }} style={styles.loserAvatar} /> : <View style={[styles.loserAvatar, styles.ph]} />}
            </>
          ) : (
            <>
              {bAvatar ? <Image source={{ uri: bAvatar }} style={styles.winnerAvatar} /> : <View style={[styles.winnerAvatar, styles.ph]} />}
              {aAvatar ? <Image source={{ uri: aAvatar }} style={styles.loserAvatar} /> : <View style={[styles.loserAvatar, styles.ph]} />}
            </>
          )}
        </View>
        <Text style={styles.sub}>Duración: {durMm}:{durSs}</Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.meta}>{aName}: {winsA} · {bName}: {winsB}</Text>
        <Text style={styles.meta}>
          {(winsA >= 2 || winsB >= 2)
            ? `${winsA >= 2 ? aName : bName} gana el enfrentamiento`
            : 'El enfrentamiento sigue abierto'}
        </Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => void createRematch()}>
          <Text style={styles.primaryTxt}>{rematchLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('PairingsList', { eventId: pairing.event_id })}>
          <Text style={styles.secondaryTxt}>Volver a enfrentamientos</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('EventDetail', { eventId: pairing.event_id })}>
          <Text style={styles.secondaryTxt}>Volver al evento</Text>
        </TouchableOpacity>
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
  winnerAvatar: { width: 132, height: 132, borderRadius: 66, backgroundColor: '#e5e7eb' },
  loserAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#e5e7eb',
    position: 'absolute',
    right: 16,
    bottom: 4,
    opacity: 0.4,
  },
  ph: { backgroundColor: '#E5E7EB' },
  sub: { color: '#666', marginTop: 4 },
  block: { borderWidth: 1, borderColor: '#eee', borderRadius: 10, padding: 12, marginBottom: 18 },
  meta: { color: '#111', marginBottom: 4 },
  actions: { gap: 10 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  primaryTxt: { color: '#fff', fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
  secondaryTxt: { color: '#374151', fontWeight: '700' },
});
