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

type PairingRow = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  super_cup_winner_participant_id: string | null;
  revenge_cup_winner_participant_id: string | null;
};

type MatchRow = {
  pairing_id: string;
  match_type: string;
  status: string;
  winner_participant_id: string | null;
};

type EventPlayer = {
  id: string;
  userId: string;
  displayName: string;
};

type OfficialH2HRow = {
  opponentId: string;
  opponentName: string;
  pairingId: string | null;
  profileWins: number;
  opponentWins: number;
  sortTier: 0 | 1 | 2;
};

type RevengeH2HRow = {
  opponentId: string;
  opponentName: string;
  pairingId: string;
  profileWins: number;
  opponentWins: number;
  profileHasRevengeCup: boolean;
  opponentHasRevengeCup: boolean;
  profileHasSuperCup: boolean;
  opponentHasSuperCup: boolean;
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function findPairingBetween(pairings: PairingRow[], pid: string, oid: string): PairingRow | null {
  return (
    pairings.find(
      (p) =>
        (p.participant_a_id === pid && p.participant_b_id === oid) ||
        (p.participant_a_id === oid && p.participant_b_id === pid)
    ) ?? null
  );
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
  const [pairingsCompleted, setPairingsCompleted] = useState(0);
  const [isWorkspaceOrganizer, setIsWorkspaceOrganizer] = useState(false);

  const [tab, setTab] = useState<'official' | 'revenge'>('official');
  const [showRevengeTabs, setShowRevengeTabs] = useState(false);
  const [revengeWon, setRevengeWon] = useState(0);
  const [revengePlayed, setRevengePlayed] = useState(0);
  const [revengeCupsWon, setRevengeCupsWon] = useState(0);
  const [superCupsWon, setSuperCupsWon] = useState(0);
  const [officialH2h, setOfficialH2h] = useState<OfficialH2HRow[]>([]);
  const [revengeH2h, setRevengeH2h] = useState<RevengeH2HRow[]>([]);

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

    const [colorsRes, playersRes, pairingsRes] = await Promise.all([
      supabase.from('participant_colors').select('color').eq('participant_id', participantId),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          users!event_participants_user_id_fkey (
            display_name,
            username
          )
        `
        )
        .eq('event_id', eventId)
        .eq('role', 'player'),
      supabase
        .from('pairings')
        .select(
          'id, participant_a_id, participant_b_id, official_winner_participant_id, super_cup_winner_participant_id, revenge_cup_winner_participant_id'
        )
        .eq('event_id', eventId),
    ]);

    if (!colorsRes.error) {
      setColors((colorsRes.data ?? []).map((c) => c.color as MtgColor));
    }

    if (playersRes.error || pairingsRes.error) {
      Alert.alert('Error', 'No se pudo cargar los datos del evento.');
      setLoading(false);
      return;
    }

    const pairings = (pairingsRes.data ?? []) as PairingRow[];
    const pairingIds = pairings.map((p) => p.id);

    const matchesRes =
      pairingIds.length > 0
        ? await supabase
            .from('matches')
            .select('pairing_id, match_type, status, winner_participant_id')
            .in('pairing_id', pairingIds)
        : { data: [], error: null };

    if (matchesRes.error) {
      Alert.alert('Error', 'No se pudo cargar las partidas.');
      setLoading(false);
      return;
    }

    const matches = (matchesRes.data ?? []) as MatchRow[];

    const eventHasRevengeCompleted = matches.some((m) => m.match_type === 'revenge' && m.status === 'completed');
    setShowRevengeTabs(eventHasRevengeCompleted);
    if (!eventHasRevengeCompleted) {
      setTab('official');
    }

    const profilePairings = pairings.filter(
      (p) => p.participant_a_id === participantId || p.participant_b_id === participantId
    );

    const officialCompletedForProfile = matches.filter((m) => {
      const pr = pairings.find((p) => p.id === m.pairing_id);
      if (!pr) return false;
      const inPairing = pr.participant_a_id === participantId || pr.participant_b_id === participantId;
      return inPairing && (m.match_type === 'draft' || m.match_type === 'final') && m.status === 'completed';
    });
    setMatchesPlayed(officialCompletedForProfile.length);
    setMatchesWon(officialCompletedForProfile.filter((m) => m.winner_participant_id === participantId).length);

    const ec = profilePairings.filter((p) => p.official_winner_participant_id != null).length;
    const eg = profilePairings.filter((p) => p.official_winner_participant_id === participantId).length;
    setPairingsCompleted(ec);
    setPairingsWon(eg);

    const revengeCompletedForProfile = matches.filter((m) => {
      const pr = pairings.find((p) => p.id === m.pairing_id);
      if (!pr) return false;
      const inPairing = pr.participant_a_id === participantId || pr.participant_b_id === participantId;
      return inPairing && m.match_type === 'revenge' && m.status === 'completed';
    });
    setRevengePlayed(revengeCompletedForProfile.length);
    setRevengeWon(revengeCompletedForProfile.filter((m) => m.winner_participant_id === participantId).length);
    setRevengeCupsWon(
      profilePairings.filter((p) => p.revenge_cup_winner_participant_id === participantId).length
    );
    setSuperCupsWon(profilePairings.filter((p) => p.super_cup_winner_participant_id === participantId).length);

    const players: EventPlayer[] = (playersRes.data ?? []).map((row: any) => {
      const uu = relationOne(row.users);
      return {
        id: row.id as string,
        userId: row.user_id as string,
        displayName: uu?.display_name || uu?.username || 'Jugador',
      };
    });

    const others = players.filter((p) => p.id !== participantId);

    const officialRows: OfficialH2HRow[] = others.map((opp) => {
      const pairing = findPairingBetween(pairings, participantId, opp.id);
      const pairingId = pairing?.id ?? null;
      let profileWins = 0;
      let opponentWins = 0;
      let sortTier: 0 | 1 | 2 = 2;
      if (pairing) {
        const pm = matches.filter(
          (m) =>
            m.pairing_id === pairing.id &&
            (m.match_type === 'draft' || m.match_type === 'final') &&
            m.status === 'completed'
        );
        profileWins = pm.filter((m) => m.winner_participant_id === participantId).length;
        opponentWins = pm.filter((m) => m.winner_participant_id === opp.id).length;
        if (pairing.official_winner_participant_id != null) sortTier = 0;
        else if (pm.length > 0) sortTier = 1;
        else sortTier = 2;
      }
      return {
        opponentId: opp.id,
        opponentName: opp.displayName,
        pairingId,
        profileWins,
        opponentWins,
        sortTier,
      };
    });
    officialRows.sort((a, b) => {
      if (a.sortTier !== b.sortTier) return a.sortTier - b.sortTier;
      return a.opponentName.localeCompare(b.opponentName, 'es');
    });
    setOfficialH2h(officialRows);

    const revRows: RevengeH2HRow[] = [];
    for (const opp of others) {
      const pairing = findPairingBetween(pairings, participantId, opp.id);
      if (!pairing) continue;
      const pm = matches.filter(
        (m) => m.pairing_id === pairing.id && m.match_type === 'revenge' && m.status === 'completed'
      );
      if (pm.length === 0) continue;
      const profileWins = pm.filter((m) => m.winner_participant_id === participantId).length;
      const opponentWins = pm.filter((m) => m.winner_participant_id === opp.id).length;
      const rc = pairing.revenge_cup_winner_participant_id;
      const sc = pairing.super_cup_winner_participant_id;
      revRows.push({
        opponentId: opp.id,
        opponentName: opp.displayName,
        pairingId: pairing.id,
        profileWins,
        opponentWins,
        profileHasRevengeCup: rc === participantId,
        opponentHasRevengeCup: rc === opp.id,
        profileHasSuperCup: sc === participantId,
        opponentHasSuperCup: sc === opp.id,
      });
    }
    revRows.sort((a, b) => {
      const ta = a.profileWins + a.opponentWins;
      const tb = b.profileWins + b.opponentWins;
      if (tb !== ta) return tb - ta;
      return b.profileWins - a.profileWins;
    });
    setRevengeH2h(revRows);

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

  const renderOfficialContent = () => (
    <>
      <Text style={styles.statLine}>Partidas jugadas: {matchesPlayed}</Text>
      <Text style={styles.statLine}>Partidas ganadas: {matchesWon}</Text>
      <Text style={styles.statLine}>
        Enfrentamientos ganados: {pairingsWon} / Enfrentamientos completados: {pairingsCompleted}
      </Text>
      <Text style={styles.sectionTitle}>Enfrentamientos</Text>
      {officialH2h.map((row) => (
        <TouchableOpacity
          key={row.opponentId}
          style={styles.h2hCard}
          activeOpacity={row.pairingId ? 0.7 : 1}
          disabled={!row.pairingId}
          onPress={() => {
            if (!row.pairingId) return;
            navigation.navigate('PairingDetail', { pairingId: row.pairingId, fromTab: 'official' });
          }}
        >
          <View style={styles.h2hNamesRow}>
            <Text style={styles.h2hNameSide} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.h2hVs}>vs</Text>
            <Text style={[styles.h2hNameSide, styles.h2hNameSideRight]} numberOfLines={1}>
              {row.opponentName}
            </Text>
          </View>
          <View style={styles.h2hBo3Outer}>
            <View style={styles.h2hBo3Group}>
              <View style={styles.bo3Row}>
                <View style={[styles.bo3Box, row.profileWins >= 1 && styles.bo3Filled]} />
                <View style={[styles.bo3Box, row.profileWins >= 2 && styles.bo3Filled]} />
              </View>
            </View>
            <View style={styles.h2hBo3Group}>
              <View style={[styles.bo3Row, styles.bo3RowRight]}>
                <View style={[styles.bo3Box, row.opponentWins >= 1 && styles.bo3Filled]} />
                <View style={[styles.bo3Box, row.opponentWins >= 2 && styles.bo3Filled]} />
              </View>
            </View>
          </View>
        </TouchableOpacity>
      ))}
    </>
  );

  const renderRevengeContent = () => (
    <>
      <Text style={styles.statLine}>Venganzas ganadas: {revengeWon}</Text>
      <Text style={styles.statLine}>Venganzas jugadas: {revengePlayed}</Text>
      <Text style={styles.statLine}>Copas Venganza ganadas: {revengeCupsWon}</Text>
      <Text style={styles.statLine}>Súper Copas ganadas: {superCupsWon}</Text>
      <Text style={styles.sectionTitle}>Cruces</Text>
      {revengeH2h.map((row) => (
        <TouchableOpacity
          key={row.opponentId}
          style={styles.h2hCard}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('PairingDetail', { pairingId: row.pairingId, fromTab: 'revenge' })}
        >
          <View style={styles.revengeH2hRow}>
            <View style={styles.revengeH2hLeft}>
              <Text style={styles.revengeH2hNameLeft} numberOfLines={1}>
                {displayName}
              </Text>
              {row.profileHasRevengeCup ? (
                <View style={styles.cupInsignia}>
                  <Text style={styles.cupInsigniaTxt}>🏆 CV</Text>
                </View>
              ) : null}
              {row.profileHasSuperCup ? (
                <View style={styles.cupInsignia}>
                  <Text style={styles.cupInsigniaTxt}>🏆 SC</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.revengeH2hScore} numberOfLines={1}>
              {row.profileWins} - {row.opponentWins}
            </Text>
            <View style={styles.revengeH2hRight}>
              {row.opponentHasRevengeCup ? (
                <View style={styles.cupInsignia}>
                  <Text style={styles.cupInsigniaTxt}>🏆 CV</Text>
                </View>
              ) : null}
              {row.opponentHasSuperCup ? (
                <View style={styles.cupInsignia}>
                  <Text style={styles.cupInsigniaTxt}>🏆 SC</Text>
                </View>
              ) : null}
              <Text style={styles.revengeH2hNameRight} numberOfLines={1}>
                {row.opponentName}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      ))}
    </>
  );

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
        <Text style={styles.name}>{displayName}</Text>
        <View style={styles.heroChipsColumn}>
          {isWorkspaceOrganizer ? (
            <View style={styles.orgChip}>
              <Text style={styles.orgChipTxt}>Organizador</Text>
            </View>
          ) : null}
          {isSelf ? (
            <TouchableOpacity
              style={styles.editColorsBtn}
              onPress={() =>
                navigation.navigate('EventCheckIn', {
                  eventId,
                  returnTo: 'PlayerProfileInEvent',
                  participantId,
                  profileReturnFrom: profileFrom,
                })
              }
              activeOpacity={0.7}
            >
              <Text style={styles.editColorsBtnTxt}>Editar colores del mazo</Text>
            </TouchableOpacity>
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

      {showRevengeTabs ? (
        <View style={styles.tabsRow}>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('official')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'official' && styles.tabLabelActive]}>Oficial</Text>
            <View style={[styles.tabUnderline, tab !== 'official' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('revenge')} activeOpacity={0.7}>
            <Text style={[styles.tabLabel, tab === 'revenge' && styles.tabLabelActive]}>Venganzas</Text>
            <View style={[styles.tabUnderline, tab !== 'revenge' && styles.tabUnderlineHidden]} />
          </TouchableOpacity>
        </View>
      ) : null}

      {showRevengeTabs ? (tab === 'official' ? renderOfficialContent() : renderRevengeContent()) : renderOfficialContent()}

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
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  hero: { alignItems: 'center', marginBottom: 7 },
  name: { marginTop: 14, fontSize: 22, fontWeight: '800', color: '#111', textAlign: 'center' },
  heroChipsColumn: { marginTop: 10, alignItems: 'center', gap: 16, width: '100%' },
  orgChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  orgChipTxt: { fontSize: 12, fontWeight: '700', color: '#4338CA' },
  editColorsBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  editColorsBtnTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginTop: 18, marginBottom: 10 },
  flagRow: { flexDirection: 'row', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#E5E7EB' },
  flagSeg: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  flagLetter: { fontSize: 22, fontWeight: '900', color: '#111' },
  flagLetterOnDark: { color: '#fff' },
  statLine: { fontSize: 15, color: '#374151', marginBottom: 6 },
  muted: { color: '#6B7280', fontSize: 15 },
  stars: { fontSize: 22, color: '#F59E0B', marginBottom: 14, letterSpacing: 2 },
  selfBlock: { marginTop: 24 },
  tabsRow: {
    flexDirection: 'row',
    marginBottom: 12,
    marginTop: 4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  tabBtn: { marginRight: 22, paddingBottom: 4 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: '#6B7280' },
  tabLabelActive: { color: '#111827', fontWeight: '800' },
  tabUnderline: { height: 2, backgroundColor: '#3B82F6', borderRadius: 1, marginTop: 6 },
  tabUnderlineHidden: { backgroundColor: 'transparent' },
  h2hCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#FAFAFA',
  },
  h2hNamesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  h2hNameSide: { flex: 1, fontSize: 13, fontWeight: '700', color: '#111827' },
  h2hNameSideRight: { textAlign: 'right' },
  h2hVs: { fontSize: 12, fontWeight: '700', color: '#6B7280', flexShrink: 0 },
  h2hBo3Outer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  h2hBo3Group: { minWidth: 40 },
  bo3Row: { flexDirection: 'row' },
  bo3RowRight: { justifyContent: 'flex-end' },
  bo3Box: {
    width: 14,
    height: 7,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 4,
  },
  bo3Filled: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  revengeH2hRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  revengeH2hLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexWrap: 'wrap',
    gap: 4,
  },
  revengeH2hNameLeft: { fontSize: 13, fontWeight: '700', color: '#111827', flexShrink: 1 },
  revengeH2hScore: {
    flexShrink: 0,
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
    paddingHorizontal: 4,
  },
  revengeH2hRight: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 4,
  },
  revengeH2hNameRight: { fontSize: 13, fontWeight: '700', color: '#111827', flexShrink: 1, textAlign: 'right' },
  cupInsignia: {
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  cupInsigniaTxt: { fontSize: 11, fontWeight: '700', color: '#4338CA' },
});
