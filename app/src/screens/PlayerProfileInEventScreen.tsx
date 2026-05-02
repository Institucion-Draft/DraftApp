import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';

type Props = NativeStackScreenProps<MainStackParamList, 'PlayerProfileInEvent'>;

const COLOR_BG: Record<MtgColor, string> = {
  W: '#F8FAFC',
  U: '#DBEAFE',
  B: '#1F2937',
  R: '#FEE2E2',
  G: '#DCFCE7',
  C: '#E5E7EB',
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export default function PlayerProfileInEventScreen({ route, navigation }: Props) {
  const { eventId, participantId, from: profileFrom = 'EventDetail' } = route.params;
  useLayoutEffect(() => {
    const backTarget = profileFrom === 'Standings' ? 'Standings' : 'EventDetail';
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, backTarget, { eventId }),
    });
  }, [navigation, eventId, profileFrom]);

  const [loading, setLoading] = useState(true);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [colors, setColors] = useState<MtgColor[]>([]);
  const [selfEval, setSelfEval] = useState<number | null>(null);
  const [matchesPlayed, setMatchesPlayed] = useState(0);
  const [matchesWon, setMatchesWon] = useState(0);
  const [pairingsWon, setPairingsWon] = useState(0);
  const [isWorkspaceOrganizer, setIsWorkspaceOrganizer] = useState(false);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    setMyUserId(meRes.data.user?.id ?? null);

    const { data: pRow, error: pErr } = await supabase
      .from('event_participants')
      .select(
        `
        id,
        user_id,
        self_evaluation,
        users!event_participants_user_id_fkey (
          display_name,
          username,
          custom_avatar_path,
          default_avatars (storage_path)
        )
      `
      )
      .eq('id', participantId)
      .eq('event_id', eventId)
      .maybeSingle();

    if (pErr || !pRow) {
      Alert.alert('Error', 'No se pudo cargar el jugador.');
      setLoading(false);
      return;
    }

    const { data: evRow } = await supabase.from('draft_events').select('workspace_id').eq('id', eventId).maybeSingle();
    const wsId = evRow?.workspace_id as string | undefined;
    const uid = pRow.user_id as string;
    if (wsId) {
      const orgRes = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', wsId)
        .eq('user_id', uid)
        .maybeSingle();
      setIsWorkspaceOrganizer(!orgRes.error && orgRes.data?.role === 'organizer');
    } else {
      setIsWorkspaceOrganizer(false);
    }

    const u = relationOne(
      pRow.users as
        | { display_name: string; username: string }
        | { display_name: string; username: string }[]
        | null
    );
    setUserId(pRow.user_id as string);
    setDisplayName(u?.display_name || u?.username || 'Jugador');
    setSelfEval((pRow as { self_evaluation: number | null }).self_evaluation ?? null);

    const [colorsRes, pairingsRes] = await Promise.all([
      supabase.from('participant_colors').select('color').eq('participant_id', participantId),
      supabase
        .from('pairings')
        .select('id, official_winner_participant_id')
        .eq('event_id', eventId)
        .or(`participant_a_id.eq.${participantId},participant_b_id.eq.${participantId}`),
    ]);

    if (!colorsRes.error) {
      setColors((colorsRes.data ?? []).map((c) => c.color as MtgColor));
    }

    const pairRows = (pairingsRes.data ?? []) as {
      id: string;
      official_winner_participant_id: string | null;
    }[];
    setPairingsWon(pairRows.filter((p) => p.official_winner_participant_id === participantId).length);

    const pairingIds = pairRows.map((p) => p.id);
    let played = 0;
    let won = 0;
    if (pairingIds.length > 0) {
      const { data: mRows } = await supabase
        .from('matches')
        .select('status, winner_participant_id')
        .in('pairing_id', pairingIds);
      for (const m of mRows ?? []) {
        if (m.status === 'aborted') continue;
        played += 1;
        if (m.status === 'completed' && m.winner_participant_id === participantId) {
          won += 1;
        }
      }
    }
    setMatchesPlayed(played);
    setMatchesWon(won);
    setLoading(false);
  }, [eventId, participantId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  const isSelf = !!myUserId && myUserId === userId;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <View style={styles.hero}>
        <PlayerAvatar
          userId={userId ?? ''}
          participantId={participantId}
          size="xlarge"
          withColorBorder
          borderWidth={5}
        />
        <View style={styles.nameRow}>
          <Text style={styles.name}>{displayName}</Text>
          {isWorkspaceOrganizer ? (
            <View style={styles.orgChip}>
              <Text style={styles.orgChipTxt}>Organizador</Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={styles.flagRow}>
        {colors.length === 0 ? (
          <Text style={styles.muted}>Sin declarar</Text>
        ) : (
          colors.map((c) => (
            <View key={c} style={[styles.flagSeg, { backgroundColor: COLOR_BG[c] }]}>
              <Text style={[styles.flagLetter, c === 'B' && styles.flagLetterOnDark]}>{c}</Text>
            </View>
          ))
        )}
      </View>

      <Text style={styles.sectionTitle}>En este evento</Text>
      <Text style={styles.statLine}>Partidas jugadas: {matchesPlayed}</Text>
      <Text style={styles.statLine}>Partidas ganadas: {matchesWon}</Text>
      <Text style={styles.statLine}>Enfrentamientos ganados (BO3): {pairingsWon}</Text>

      {isSelf ? (
        <View style={styles.selfBlock}>
          <Text style={styles.sectionTitle}>Tu valoración para hoy</Text>
          {selfEval != null ? (
            <Text style={styles.stars}>
              {Array.from({ length: 10 }, (_, i) => (i < selfEval ? '★' : '☆')).join('')}
            </Text>
          ) : (
            <Text style={styles.muted}>Sin valorar</Text>
          )}
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() =>
              navigation.navigate('EventCheckIn', {
                eventId,
                returnTo: 'PlayerProfileInEvent',
                participantId,
                profileReturnFrom: profileFrom,
              })
            }
          >
            <Text style={styles.primaryBtnTxt}>Editar los colores del mazo</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  hero: { alignItems: 'center', marginBottom: 24 },
  nameRow: { marginTop: 14, alignItems: 'center', gap: 8 },
  name: { fontSize: 22, fontWeight: '800', color: '#111', textAlign: 'center' },
  orgChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  orgChipTxt: { fontSize: 12, fontWeight: '700', color: '#4338CA' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginTop: 18, marginBottom: 10 },
  flagRow: { flexDirection: 'row', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#E5E7EB' },
  flagSeg: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  flagLetter: { fontSize: 22, fontWeight: '900', color: '#111' },
  flagLetterOnDark: { color: '#fff' },
  statLine: { fontSize: 15, color: '#374151', marginBottom: 6 },
  muted: { color: '#6B7280', fontSize: 15 },
  stars: { fontSize: 22, color: '#F59E0B', marginBottom: 14, letterSpacing: 2 },
  selfBlock: { marginTop: 8 },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
