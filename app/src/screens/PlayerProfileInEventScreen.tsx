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
import { resolveGenderedText, type Gender } from '../lib/genderText';

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
  official_draw: boolean | null;
  super_cup_winner_participant_id: string | null;
  revenge_cup_winner_participant_id: string | null;
};

type MatchRow = {
  id: string;
  pairing_id: string;
  match_type: string;
  status: string;
  winner_participant_id: string | null;
  ended_at: string | null;
  tiebreak_round: number | null;
};

type EventPlayer = {
  id: string;
  userId: string;
  displayName: string;
  giantName?: string | null;
};

type OfficialH2HRow = {
  opponentId: string;
  opponentName: string;
  pairingId: string | null;
  profileWins: number;
  opponentWins: number;
  sortTier: 0 | 1 | 2;
  isDraw: boolean;
  /** Solo presente en filas de fase mata-mata: identifica el cruce del bracket. */
  bracketMatchId?: string | null;
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

type TiebreakProfileRow = {
  matchId: string;
  pairingId: string;
  opponentParticipantId: string;
  opponentUserId: string;
  opponentName: string;
  profileGames: number;
  opponentGames: number;
  winnerName: string;
  endedAt: string | null;
  tiebreakRound: number;
};

type BracketBmRow = {
  id: string;
  bracket_phase: string;
  pairing_id: string | null;
  participant_a_id: string;
  participant_b_id: string;
  winner_participant_id: string | null;
};

type MataPhaseBuckets = { semi: OfficialH2HRow[]; final: OfficialH2HRow[]; third: OfficialH2HRow[] };

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

function formatWinRate(wins: number, total: number): string {
  if (total <= 0) return '-';
  const pct = (wins / total) * 100;
  const roundedOneDecimal = Math.round(pct * 10) / 10;
  if (Math.abs(roundedOneDecimal - Math.round(roundedOneDecimal)) < 0.00001) {
    return `${Math.round(roundedOneDecimal)}%`;
  }
  return `${roundedOneDecimal.toFixed(1).replace('.', ',')}%`;
}

function getStreakCircleSize(index: number, total: number, baseSize = 18, step = 2): number {
  if (total <= 1) return baseSize;
  const center = (total - 1) / 2;
  return baseSize + (index - center) * step;
}

function formatLeftEventAt(dateIso: string): string {
  return new Date(dateIso).toLocaleString('es-AR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
  const [isCurrentUserOrganizer, setIsCurrentUserOrganizer] = useState(false);
  const [leftEventAt, setLeftEventAt] = useState<string | null>(null);
  const [participantIsShiny, setParticipantIsShiny] = useState(false);
  const [profileGender, setProfileGender] = useState<Gender | null>(null);
  const [memberBUserId, setMemberBUserId] = useState<string | null>(null);
  const [memberBColors, setMemberBColors] = useState<MtgColor[]>([]);
  const [giantName, setGiantName] = useState<string | null>(null);
  const [isGiantEvent, setIsGiantEvent] = useState(false);

  const [tab, setTab] = useState<'official' | 'revenge'>('official');
  const [showRevengeTabs, setShowRevengeTabs] = useState(false);
  const [revengeWon, setRevengeWon] = useState(0);
  const [revengePlayed, setRevengePlayed] = useState(0);
  const [revengeCupsWon, setRevengeCupsWon] = useState(0);
  const [superCupsWon, setSuperCupsWon] = useState(0);
  const [officialH2h, setOfficialH2h] = useState<OfficialH2HRow[]>([]);
  const [revengeH2h, setRevengeH2h] = useState<RevengeH2HRow[]>([]);
  const [workspaceStreak, setWorkspaceStreak] = useState<Array<'V' | 'D'>>([]);
  const [profileInTiebreakGroup, setProfileInTiebreakGroup] = useState(false);
  const [profileTiebreakGroupOrigin, setProfileTiebreakGroupOrigin] = useState<
    'tiebreak' | 'swiss_topcut' | 'round_robin_topcut'
  >('tiebreak');
  const [profileTiebreakRows, setProfileTiebreakRows] = useState<TiebreakProfileRow[]>([]);
  const [profileTiebreakGroupRound, setProfileTiebreakGroupRound] = useState(1);
  const [eventCompetitionFormat, setEventCompetitionFormat] = useState<'swiss' | 'round_robin'>('round_robin');
  /** Mata-mata suizo bracket: filas BO3 por fase (solo cuando aplica). */
  const [profileMataByPhase, setProfileMataByPhase] = useState<MataPhaseBuckets | null>(null);

  const load = useCallback(async () => {
    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);
    setProfileInTiebreakGroup(false);
    setProfileTiebreakGroupOrigin('tiebreak');
    setProfileTiebreakRows([]);
    setProfileTiebreakGroupRound(1);
    setProfileMataByPhase(null);

    const { data: pRow, error: pErr } = await supabase
      .from('event_participants')
      .select(
        `
        id,
        user_id,
        left_event_at,
        self_evaluation,
        is_shiny,
        member_b_user_id,
        giant_name,
        users!event_participants_user_id_fkey (
          display_name,
          username,
          gender,
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

    const { data: evRow } = await supabase
      .from('draft_events')
      .select('workspace_id, competition_format, event_type')
      .eq('id', eventId)
      .maybeSingle();
    const wsId = evRow?.workspace_id as string | undefined;
    const uid = pRow.user_id as string;
    setLeftEventAt((pRow as { left_event_at?: string | null }).left_event_at ?? null);
    setParticipantIsShiny(!!(pRow as { is_shiny?: boolean }).is_shiny);
    setMemberBUserId((pRow as { member_b_user_id?: string | null }).member_b_user_id ?? null);
    setGiantName((pRow as { giant_name?: string | null }).giant_name ?? null);
    setIsGiantEvent(
      ((evRow as { event_type?: string | null } | null)?.event_type ?? null) === 'two_headed_giant'
    );
    setWorkspaceStreak([]);
    if (wsId) {
      const orgRes = await supabase
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', wsId)
        .eq('user_id', uid)
        .maybeSingle();
      setIsWorkspaceOrganizer(!orgRes.error && orgRes.data?.role === 'organizer');
      if (currentUserId) {
        const currentOrgRes = await supabase
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', wsId)
          .eq('user_id', currentUserId)
          .maybeSingle();
        setIsCurrentUserOrganizer(!currentOrgRes.error && currentOrgRes.data?.role === 'organizer');
      } else {
        setIsCurrentUserOrganizer(false);
      }
    } else {
      setIsWorkspaceOrganizer(false);
      setIsCurrentUserOrganizer(false);
    }

    const u = relationOne(
      pRow.users as
        | { display_name: string; username: string; gender?: Gender | null }
        | { display_name: string; username: string; gender?: Gender | null }[]
        | null
    );
    setUserId(pRow.user_id as string);
    setDisplayName(u?.display_name || u?.username || 'Jugador');
    setProfileGender(u?.gender ?? null);
    setSelfEval((pRow as { self_evaluation: number | null }).self_evaluation ?? null);

    if (wsId) {
      const wsEventsRes = await supabase
        .from('draft_events')
        .select('id')
        .eq('workspace_id', wsId)
        .is('deleted_at', null)
        .is('cancelled_at', null);

      const workspaceEventIds = (wsEventsRes.data ?? []).map((row) => row.id as string);

      const wsParticipantsRes =
        workspaceEventIds.length > 0
          ? await supabase
              .from('event_participants')
              .select('id, event_id')
              .eq('user_id', uid)
              .eq('role', 'player')
              .in('event_id', workspaceEventIds)
          : { data: [], error: null };

      if (__DEV__) {
        console.log('[profile streak] workspace events:', workspaceEventIds.length);
      }

      if (__DEV__) {
        console.log('[profile streak] user participants in workspace:', (wsParticipantsRes.data ?? []).length);
      }

      if (!wsParticipantsRes.error) {
        const participantIds = (wsParticipantsRes.data ?? []).map((row: any) => row.id as string);
        if (participantIds.length > 0) {
          const wsPairingsRes = await supabase
            .from('pairings')
            .select('id, participant_a_id, participant_b_id')
            .in('event_id', workspaceEventIds)
            .or(
              `participant_a_id.in.(${participantIds.join(',')}),participant_b_id.in.(${participantIds.join(',')})`
            );

          if (__DEV__) {
            console.log('[profile streak] candidate pairings:', (wsPairingsRes.data ?? []).length);
          }

          if (!wsPairingsRes.error) {
            const pairings = wsPairingsRes.data ?? [];
            const pairingIds = pairings.map((row) => row.id as string);
            const participantSet = new Set(participantIds);
            const pairingById = new Map<string, { participant_a_id: string; participant_b_id: string }>();
            for (const row of pairings) {
              pairingById.set(row.id as string, {
                participant_a_id: row.participant_a_id as string,
                participant_b_id: row.participant_b_id as string,
              });
            }

            const wsMatchesRes =
              pairingIds.length > 0
                ? await supabase
                    .from('matches')
                    .select('pairing_id, winner_participant_id, ended_at')
                    .in('pairing_id', pairingIds)
                    .in('match_type', ['draft', 'final', 'tiebreak'])
                    .eq('status', 'completed')
                    .not('winner_participant_id', 'is', null)
                    .order('ended_at', { ascending: false })
                    .limit(50)
                : { data: [], error: null };

            if (__DEV__) {
              console.log('[profile streak] filtered matches:', (wsMatchesRes.data ?? []).length);
            }

            if (!wsMatchesRes.error) {
              const filtered = (wsMatchesRes.data ?? []).filter((m) => {
                const pair = pairingById.get(String(m.pairing_id));
                if (!pair) return false;
                return participantSet.has(pair.participant_a_id) || participantSet.has(pair.participant_b_id);
              });
              const lastFive = filtered.slice(0, 5);
              const streak = lastFive.map((m) =>
                participantSet.has(String(m.winner_participant_id)) ? 'V' : 'D'
              ) as Array<'V' | 'D'>;
              setWorkspaceStreak([...streak].reverse());
              if (__DEV__) {
                console.log('[profile streak] streak matches used:', lastFive.length);
              }
            }
          }
        }
      }
    }

    const [colorsRes, playersRes, pairingsRes] = await Promise.all([
      supabase.from('participant_colors').select('color, member').eq('participant_id', participantId),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          giant_name,
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
          'id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw, super_cup_winner_participant_id, revenge_cup_winner_participant_id'
        )
        .eq('event_id', eventId),
    ]);

    if (!colorsRes.error) {
      const colorRows = (colorsRes.data ?? []) as { color: string; member?: string | null }[];
      setColors(colorRows.filter((c) => c.member == null || c.member === 'a').map((c) => c.color as MtgColor));
      setMemberBColors(colorRows.filter((c) => c.member === 'b').map((c) => c.color as MtgColor));
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
            .select('id, pairing_id, match_type, status, winner_participant_id, ended_at, tiebreak_round')
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

    const isGiant = evRow?.event_type === 'two_headed_giant';
    const players: EventPlayer[] = (playersRes.data ?? []).map((row: any) => {
      const uu = relationOne(row.users);
      const individualName = uu?.display_name || uu?.username || 'Jugador';
      const giantName: string | null = (row.giant_name as string | null) ?? null;
      return {
        id: row.id as string,
        userId: row.user_id as string,
        displayName: isGiant && giantName ? giantName : individualName,
        giantName,
      };
    });

    const others = players.filter((p) => p.id !== participantId);

    const officialRows: OfficialH2HRow[] = others.map((opp) => {
      const pairing = findPairingBetween(pairings, participantId, opp.id);
      const pairingId = pairing?.id ?? null;
      let profileWins = 0;
      let opponentWins = 0;
      let sortTier: 0 | 1 | 2 = 2;
      const isDraw = pairing?.official_draw === true;
      if (pairing) {
        const pm = matches.filter(
          (m) =>
            m.pairing_id === pairing.id &&
            (m.match_type === 'draft' || m.match_type === 'final') &&
            m.status === 'completed'
        );
        profileWins = pm.filter((m) => m.winner_participant_id === participantId).length;
        opponentWins = pm.filter((m) => m.winner_participant_id === opp.id).length;
        if (pairing.official_winner_participant_id != null || isDraw) sortTier = 0;
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
        isDraw,
      };
    });
    officialRows.sort((a, b) => {
      if (a.sortTier !== b.sortTier) return a.sortTier - b.sortTier;
      return a.opponentName.localeCompare(b.opponentName, 'es');
    });
    const rawCompetitionFormat = (evRow as { competition_format?: string | null } | null)?.competition_format;
    // swiss_bo2 se muestra igual que swiss en el perfil del jugador.
    const competitionFormat =
      rawCompetitionFormat === 'swiss' || rawCompetitionFormat === 'swiss_bo2' ? 'swiss' : 'round_robin';
    setEventCompetitionFormat(competitionFormat);
    const officialH2hFiltered =
      competitionFormat === 'swiss'
        ? officialRows.filter((row) => {
            if (!row.pairingId) return false;
            // Mostrar empates resueltos aunque no tengan partidas individuales jugadas.
            if (row.isDraw) return true;
            return matches.some(
              (m) =>
                m.pairing_id === row.pairingId &&
                (m.match_type === 'draft' || m.match_type === 'final') &&
                (m.status === 'completed' || m.status === 'in_progress')
            );
          })
        : officialRows;
    setOfficialH2h(officialH2hFiltered);

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

    const tgRes = await supabase
      .from('event_tiebreak_groups')
      .select('id, round_number, group_origin, group_type')
      .eq('event_id', eventId)
      .in('status', ['active', 'resolved', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tgRes.error && tgRes.data?.id) {
      const tgRound = (tgRes.data as { round_number?: number }).round_number ?? 1;
      const tgOrigin = (tgRes.data as { group_origin?: string | null }).group_origin;
      const gpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id, user_id')
        .eq('group_id', tgRes.data.id);
      if (!gpRes.error && gpRes.data) {
        const gList = gpRes.data as { participant_id: string; user_id: string }[];
        const gPidSet = new Set(gList.map((r) => r.participant_id));
        const uidByPid = new Map(gList.map((r) => [r.participant_id, r.user_id]));
        if (gPidSet.has(participantId)) {
          setProfileInTiebreakGroup(true);
          setProfileTiebreakGroupOrigin(
            tgOrigin === 'swiss_topcut'
              ? 'swiss_topcut'
              : tgOrigin === 'round_robin_topcut'
                ? 'round_robin_topcut'
                : 'tiebreak'
          );
          setProfileTiebreakGroupRound(tgRound);
          const pairingById = new Map(pairings.map((p) => [p.id, p]));
          const tgType = (tgRes.data as { group_type?: string | null }).group_type ?? '';
          const isSwissBracketMata =
            (tgOrigin === 'swiss_topcut' || tgOrigin === 'round_robin_topcut') &&
            tgType === 'bracket';

          if (isSwissBracketMata) {
            const bmRes = await supabase
              .from('event_tiebreak_bracket_matches')
              .select('id, bracket_phase, pairing_id, participant_a_id, participant_b_id, winner_participant_id')
              .eq('group_id', tgRes.data.id);
            const bmRows = (bmRes.data ?? []) as BracketBmRow[];

            // Fuente de verdad de la fase mata-mata: event_tiebreak_bracket_matches.
            // El rival, la fase y el resultado salen del bracket match, NO del pairing
            // (que en swiss_bo2 puede estar compartido con la ronda suiza y apuntar a
            // otro jugador). El pairing solo se usa para contar el marcador parcial.
            const semiRows: OfficialH2HRow[] = [];
            const finalRows: OfficialH2HRow[] = [];
            const thirdRows: OfficialH2HRow[] = [];

            for (const bm of bmRows) {
              let oppId: string | null = null;
              if (bm.participant_a_id === participantId) oppId = bm.participant_b_id;
              else if (bm.participant_b_id === participantId) oppId = bm.participant_a_id;
              else continue;
              const phase =
                bm.bracket_phase === 'semi' || bm.bracket_phase === 'final' || bm.bracket_phase === 'third_place'
                  ? bm.bracket_phase
                  : null;
              if (!phase) continue;

              // Marcador parcial: matches tiebreak del pairing del bracket match,
              // alineando las victorias a los participantes del bracket match.
              let profileWins = 0;
              let opponentWins = 0;
              if (bm.pairing_id) {
                for (const m of matches) {
                  if (m.match_type !== 'tiebreak' || m.status !== 'completed' || !m.winner_participant_id) continue;
                  if (m.pairing_id !== bm.pairing_id) continue;
                  const w = String(m.winner_participant_id);
                  if (w === participantId) profileWins += 1;
                  else if (w === oppId) opponentWins += 1;
                }
              }
              const oppPlayer = players.find((p) => p.id === oppId);
              const row: OfficialH2HRow = {
                opponentId: oppId,
                opponentName: oppPlayer?.displayName ?? 'Jugador',
                pairingId: bm.pairing_id,
                profileWins,
                opponentWins,
                sortTier: 0,
                isDraw: false,
                bracketMatchId: bm.id,
              };
              (phase === 'semi' ? semiRows : phase === 'final' ? finalRows : thirdRows).push(row);
            }
            setProfileMataByPhase({ semi: semiRows, final: finalRows, third: thirdRows });
            setProfileTiebreakRows([]);
          } else {
            setProfileMataByPhase(null);
            const tbRows: TiebreakProfileRow[] = [];
            for (const m of matches) {
              if (m.match_type !== 'tiebreak' || m.status !== 'completed' || !m.winner_participant_id) continue;
              const pr = pairingById.get(m.pairing_id);
              if (!pr) continue;
              if (!gPidSet.has(pr.participant_a_id) || !gPidSet.has(pr.participant_b_id)) continue;
              let oppId: string | null = null;
              if (pr.participant_a_id === participantId) oppId = pr.participant_b_id;
              else if (pr.participant_b_id === participantId) oppId = pr.participant_a_id;
              else continue;
              const oppPlayer = players.find((p) => p.id === oppId);
              const winPid = String(m.winner_participant_id);
              const winnerPlayer = players.find((p) => p.id === winPid);
              const profileWon = winPid === participantId;
              tbRows.push({
                matchId: m.id,
                pairingId: pr.id,
                opponentParticipantId: oppId,
                opponentUserId: oppPlayer?.userId ?? uidByPid.get(oppId) ?? '',
                opponentName: oppPlayer?.displayName ?? 'Jugador',
                profileGames: profileWon ? 1 : 0,
                opponentGames: profileWon ? 0 : 1,
                winnerName: winnerPlayer?.displayName ?? 'Jugador',
                endedAt: m.ended_at,
                tiebreakRound: m.tiebreak_round != null ? Number(m.tiebreak_round) : 1,
              });
            }
            tbRows.sort((a, b) => {
              const ta = a.endedAt ? new Date(a.endedAt).getTime() : 0;
              const tb = b.endedAt ? new Date(b.endedAt).getTime() : 0;
              return ta - tb;
            });
            const merged = new Map<string, TiebreakProfileRow>();
            for (const row of tbRows) {
              const prev = merged.get(row.pairingId);
              if (!prev) merged.set(row.pairingId, { ...row });
              else {
                merged.set(row.pairingId, {
                  ...row,
                  profileGames: prev.profileGames + row.profileGames,
                  opponentGames: prev.opponentGames + row.opponentGames,
                });
              }
            }
            setProfileTiebreakRows(Array.from(merged.values()));
          }
        }
      }
    }

    setLoading(false);
  }, [eventId, participantId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load])
  );

  const isSelf =
    !!myUserId &&
    (myUserId === userId || (isGiantEvent && myUserId === memberBUserId));
  const leftWord = resolveGenderedText(profileGender, 'ido', 'ida');
  const markAsLeftLabel = `Marcar como ${leftWord}`;

  const markAsLeft = async (isSelfAction: boolean) => {
    if (!myUserId) return;
    const actorName = displayName || 'este jugador';
    const confirmation = isSelfAction
      ? `Si te marcás como ${leftWord}, no vas a poder revertirlo vos mismo (solo el organizer puede). Tus enfrentamientos pendientes dejan de trabar el cierre del torneo. ¿Confirmás?`
      : `Vas a marcar a ${actorName} como ${leftWord} del evento. Sus enfrentamientos pendientes dejan de trabar el cierre del torneo. ¿Confirmás?`;
    Alert.alert(isSelfAction ? 'Me estoy yendo' : markAsLeftLabel, confirmation, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Confirmar',
        onPress: async () => {
          const { error } = await supabase
            .from('event_participants')
            .update({ left_event_at: new Date().toISOString(), left_event_by: myUserId })
            .eq('id', participantId);
          if (error) {
            Alert.alert('Error', error.message ?? 'No se pudo marcar como ido.');
            return;
          }
          await supabase.rpc('compute_event_champion', { p_event_id: eventId });
          await load();
        },
      },
    ]);
  };

  const revertLeft = async () => {
    const { error } = await supabase
      .from('event_participants')
      .update({ left_event_at: null, left_event_by: null })
      .eq('id', participantId);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo revertir el estado.');
      return;
    }
    await supabase.rpc('compute_event_champion', { p_event_id: eventId });
    await load();
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const renderOfficialContent = () => {
    const bo3Pills = (winsProfile: number, winsOpp: number, tint: 'blue' | 'green') => {
      const filled = tint === 'blue' ? styles.bo3FilledBlue : styles.bo3FilledGreen;
      return (
        <View style={styles.h2hBo3Outer}>
          <View style={styles.h2hBo3Group}>
            <View style={styles.bo3Row}>
              <View style={[styles.bo3Box, winsProfile >= 1 && filled]} />
              <View style={[styles.bo3Box, winsProfile >= 2 && filled]} />
            </View>
          </View>
          <View style={styles.h2hBo3Group}>
            <View style={[styles.bo3Row, styles.bo3RowRight]}>
              <View style={[styles.bo3Box, winsOpp >= 1 && filled]} />
              <View style={[styles.bo3Box, winsOpp >= 2 && filled]} />
            </View>
          </View>
        </View>
      );
    };

    const officialPairingCard = (row: OfficialH2HRow, tint: 'blue' | 'green') => (
      <TouchableOpacity
        key={`${tint}-${row.pairingId}`}
        style={styles.h2hCard}
        activeOpacity={row.pairingId ? 0.7 : 1}
        disabled={!row.pairingId}
        onPress={() => {
          if (!row.pairingId) return;
          navigation.navigate('PairingDetail', {
            pairingId: row.pairingId,
            fromTab: 'official',
            fromPlayerProfile: { eventId, participantId, from: profileFrom },
            ...(row.bracketMatchId ? { bracketMatchId: row.bracketMatchId } : {}),
          });
        }}
      >
        <View style={styles.h2hNamesRow}>
          <Text style={styles.h2hNameSide} numberOfLines={1}>
            {isGiantEvent ? (giantName ?? displayName) : displayName}
          </Text>
          <Text style={styles.h2hVs}>vs</Text>
          <Text style={[styles.h2hNameSide, styles.h2hNameSideRight]} numberOfLines={1}>
            {row.opponentName}
          </Text>
        </View>
        {bo3Pills(row.profileWins, row.opponentWins, tint)}
      </TouchableOpacity>
    );

    const tiebreakRoundRobinCards = () => {
      if (!profileInTiebreakGroup) return null;
      if (eventCompetitionFormat === 'swiss') return null;
      // round_robin_topcut se muestra con la sección de fases (swissMataBracketSection).
      if (profileTiebreakGroupOrigin === 'round_robin_topcut') return null;
      return (
        <>
          <Text style={styles.sectionTitle}>
            {profileTiebreakGroupOrigin === 'swiss_topcut' ? 'Fase mata-mata' : 'Desempate'}
          </Text>
          {profileTiebreakRows.length === 0 ? (
            <Text style={styles.muted}>Sin partidas de desempate jugadas.</Text>
          ) : profileTiebreakGroupRound >= 2 ? (
            <>
              {[2, 1].map((rn) => {
                const rows = profileTiebreakRows.filter((r) => r.tiebreakRound === rn);
                if (rows.length === 0) return null;
                return (
                  <React.Fragment key={`tb-prof-${rn}`}>
                    <Text style={styles.tiebreakProfileRoundTitle}>Ronda {rn}</Text>
                    {rows.map((row) => (
                      <TouchableOpacity
                        key={row.matchId}
                        style={styles.h2hCard}
                        activeOpacity={0.7}
                        onPress={() => navigation.navigate('MatchResult', { matchId: row.matchId })}
                      >
                        <View style={styles.tiebreakVsRow}>
                          <View style={styles.tiebreakVsLeft}>
                            {userId ? (
                              <PlayerAvatar
                                userId={userId}
                                participantId={participantId}
                                size="small"
                                withColorBorder
                                borderWidth={3}
                              />
                            ) : null}
                            <View style={styles.tiebreakVsLeftText}>
                              <Text style={styles.tiebreakH2hOpponentName} numberOfLines={1}>
                                {isGiantEvent ? (giantName ?? displayName) : displayName}
                              </Text>
                            </View>
                          </View>
                          <View style={styles.tiebreakVsMid}>
                            <Text style={styles.tiebreakH2hScore}>
                              {row.profileGames} - {row.opponentGames}
                            </Text>
                            <Text style={styles.tiebreakH2hWinner}>Ganó: {row.winnerName}</Text>
                          </View>
                          <View style={styles.tiebreakVsRight}>
                            <View style={styles.tiebreakVsRightText}>
                              <Text
                                style={[styles.tiebreakH2hOpponentName, styles.tiebreakH2hNameRight]}
                                numberOfLines={1}
                              >
                                {row.opponentName}
                              </Text>
                            </View>
                            <PlayerAvatar
                              userId={row.opponentUserId}
                              participantId={row.opponentParticipantId}
                              size="small"
                              withColorBorder
                              borderWidth={3}
                            />
                          </View>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </React.Fragment>
                );
              })}
            </>
          ) : (
            profileTiebreakRows.map((row) => (
              <TouchableOpacity
                key={row.matchId}
                style={styles.h2hCard}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('MatchResult', { matchId: row.matchId })}
              >
                <View style={styles.tiebreakVsRow}>
                  <View style={styles.tiebreakVsLeft}>
                    {userId ? (
                      <PlayerAvatar
                        userId={userId}
                        participantId={participantId}
                        size="small"
                        withColorBorder
                        borderWidth={3}
                      />
                    ) : null}
                    <View style={styles.tiebreakVsLeftText}>
                      <Text style={styles.tiebreakH2hOpponentName} numberOfLines={1}>
                        {displayName}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.tiebreakVsMid}>
                    <Text style={styles.tiebreakH2hScore}>
                      {row.profileGames} - {row.opponentGames}
                    </Text>
                    <Text style={styles.tiebreakH2hWinner}>Ganó: {row.winnerName}</Text>
                  </View>
                  <View style={styles.tiebreakVsRight}>
                    <View style={styles.tiebreakVsRightText}>
                      <Text
                        style={[styles.tiebreakH2hOpponentName, styles.tiebreakH2hNameRight]}
                        numberOfLines={1}
                      >
                        {row.opponentName}
                      </Text>
                    </View>
                    <PlayerAvatar
                      userId={row.opponentUserId}
                      participantId={row.opponentParticipantId}
                      size="small"
                      withColorBorder
                      borderWidth={3}
                    />
                  </View>
                </View>
              </TouchableOpacity>
            ))
          )}
        </>
      );
    };

    const swissTiebreakGreenCards = () => {
      if (!profileInTiebreakGroup || profileTiebreakRows.length === 0) {
        return <Text style={styles.muted}>Sin partidas de desempate jugadas.</Text>;
      }
      return profileTiebreakRows.map((row) => (
        <TouchableOpacity
          key={row.matchId}
          style={styles.h2hCard}
          activeOpacity={0.7}
          onPress={() => navigation.navigate('MatchResult', { matchId: row.matchId })}
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
          {bo3Pills(row.profileGames, row.opponentGames, 'green')}
        </TouchableOpacity>
      ));
    };

    const swissMataBracketSection = () => {
      if (
        !profileInTiebreakGroup ||
        (profileTiebreakGroupOrigin !== 'swiss_topcut' &&
          profileTiebreakGroupOrigin !== 'round_robin_topcut')
      ) {
        return null;
      }
      if (!profileMataByPhase) {
        return (
          <>
            <Text style={styles.sectionTitle}>Fase mata-mata</Text>
            {profileTiebreakRows.length === 0 ? (
              <Text style={styles.muted}>Sin partidas de desempate jugadas.</Text>
            ) : (
              swissTiebreakGreenCards()
            )}
          </>
        );
      }
      const total =
        profileMataByPhase.semi.length + profileMataByPhase.final.length + profileMataByPhase.third.length;
      return (
        <>
          <Text style={styles.sectionTitle}>Fase mata-mata</Text>
          {total === 0 ? (
            <Text style={styles.muted}>Sin partidas de desempate jugadas.</Text>
          ) : (
            <>
              {profileMataByPhase.semi.length > 0 ? (
                <>
                  <Text style={styles.profilePhaseSubtitle}>Semifinal</Text>
                  {profileMataByPhase.semi.map((row) => officialPairingCard(row, 'green'))}
                </>
              ) : null}
              {profileMataByPhase.final.length > 0 ? (
                <>
                  <Text style={styles.profilePhaseSubtitle}>Final</Text>
                  {profileMataByPhase.final.map((row) => officialPairingCard(row, 'green'))}
                </>
              ) : null}
              {profileMataByPhase.third.length > 0 ? (
                <>
                  <Text style={styles.profilePhaseSubtitle}>3er y 4to puesto</Text>
                  {profileMataByPhase.third.map((row) => officialPairingCard(row, 'green'))}
                </>
              ) : null}
            </>
          )}
        </>
      );
    };

    return (
      <>
        <View style={styles.statCard}>
          <View style={styles.statCardLeft}>
            <Text style={styles.statLine}>Enfrentamientos ganados: {pairingsWon}</Text>
            <Text style={styles.statLine}>Enfrentamientos completados: {pairingsCompleted}</Text>
          </View>
          <View style={styles.winRateBox}>
            <Text style={styles.winRateLabel}>Win Rate</Text>
            <Text style={styles.winRateValue}>{formatWinRate(pairingsWon, pairingsCompleted)}</Text>
          </View>
        </View>
        <View style={styles.statCard}>
          <View style={styles.statCardLeft}>
            <Text style={styles.statLine}>Partidas jugadas: {matchesPlayed}</Text>
            <Text style={styles.statLine}>Partidas ganadas: {matchesWon}</Text>
          </View>
          <View style={styles.winRateBox}>
            <Text style={styles.winRateLabel}>Win Rate</Text>
            <Text style={styles.winRateValue}>{formatWinRate(matchesWon, matchesPlayed)}</Text>
          </View>
        </View>
        {eventCompetitionFormat === 'swiss' ? (
          <>
            {swissMataBracketSection()}
            {profileInTiebreakGroup && profileTiebreakGroupOrigin !== 'swiss_topcut' ? (
              <>
                <Text style={styles.sectionTitle}>Desempate</Text>
                {profileTiebreakRows.length === 0 ? (
                  <Text style={styles.muted}>Sin partidas de desempate jugadas.</Text>
                ) : (
                  swissTiebreakGreenCards()
                )}
              </>
            ) : null}
            <Text style={styles.sectionTitle}>Rondas suizas</Text>
            {officialH2h.map((row) => officialPairingCard(row, 'blue'))}
          </>
        ) : (
          <>
            {swissMataBracketSection()}
            {tiebreakRoundRobinCards()}
            <Text style={styles.sectionTitle}>Enfrentamientos</Text>
            {officialH2h.map((row) => officialPairingCard(row, 'blue'))}
          </>
        )}
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
      </>
    );
  };

  const renderRevengeContent = () => (
    <>
      <View style={styles.statCard}>
        <View style={styles.statCardLeft}>
          <Text style={styles.statLine}>Venganzas ganadas: {revengeWon}</Text>
          <Text style={styles.statLine}>Venganzas jugadas: {revengePlayed}</Text>
        </View>
        <View style={styles.winRateBox}>
          <Text style={styles.winRateLabel}>Win Rate</Text>
          <Text style={styles.winRateValue}>{formatWinRate(revengeWon, revengePlayed)}</Text>
        </View>
      </View>
      <View style={styles.statCard}>
        <View style={styles.statCardLeft}>
          <Text style={styles.statLine}>Copas Venganza ganadas: {revengeCupsWon}</Text>
          <Text style={styles.statLine}>Súper Copas ganadas: {superCupsWon}</Text>
        </View>
      </View>
      <Text style={styles.sectionTitle}>Cruces</Text>
      {revengeH2h.map((row) => (
        <TouchableOpacity
          key={row.opponentId}
          style={styles.h2hCard}
          activeOpacity={0.7}
          onPress={() =>
            navigation.navigate('PairingDetail', {
              pairingId: row.pairingId,
              fromTab: 'revenge',
              fromPlayerProfile: { eventId, participantId, from: profileFrom },
            })
          }
        >
          <View style={styles.revengeH2hRow}>
            <View style={styles.revengeH2hLeft}>
              <Text style={styles.revengeH2hNameLeft} numberOfLines={1}>
                {isGiantEvent ? (giantName ?? displayName) : displayName}
              </Text>
              {row.profileHasRevengeCup || row.profileHasSuperCup ? (
                <View style={styles.cupsColumn}>
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
              ) : null}
            </View>
            <Text style={styles.revengeH2hScore} numberOfLines={1}>
              {row.profileWins} - {row.opponentWins}
            </Text>
            <View style={styles.revengeH2hRight}>
              {row.opponentHasRevengeCup || row.opponentHasSuperCup ? (
                <View style={styles.cupsColumn}>
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
        {!isGiantEvent ? (
          <View style={styles.profileStreakAbsolute}>
            {workspaceStreak.length > 0 ? (
              <View style={styles.profileStreakDots}>
                {workspaceStreak.map((result, idx) => (
                  (() => {
                    const size = getStreakCircleSize(idx, workspaceStreak.length);
                    return (
                  <View
                    key={`${result}-${idx}`}
                    style={[
                      styles.profileStreakDot,
                      { width: size, height: size, borderRadius: size / 2 },
                      result === 'V' ? styles.profileStreakWin : styles.profileStreakLoss,
                    ]}
                  >
                    <Text style={styles.profileStreakDotTxt}>{result}</Text>
                  </View>
                    );
                  })()
                ))}
              </View>
            ) : (
              <Text style={styles.profileStreakEmpty}>Racha: -</Text>
            )}
          </View>
        ) : null}
        {isGiantEvent ? (
          <View style={styles.giantAvatarPairProfile}>
            <PlayerAvatar
              userId={userId ?? ''}
              participantId={participantId}
              size="xlarge"
              withColorBorder
              borderWidth={5}
              giantSide="left"
              showShinyAnimation={participantIsShiny}
            />
            {memberBUserId ? (
              <PlayerAvatar
                userId={memberBUserId}
                size="xlarge"
                withColorBorder
                borderWidth={5}
                giantSide="right"
                memberColors={memberBColors}
                style={{ marginLeft: -20 }}
              />
            ) : null}
          </View>
        ) : (
          <PlayerAvatar
            userId={userId ?? ''}
            participantId={participantId}
            size="xlarge"
            withColorBorder
            borderWidth={5}
            showShinyAnimation={participantIsShiny}
          />
        )}
        <Text style={styles.name}>
          {isGiantEvent ? (giantName ?? displayName) : displayName}
        </Text>
        {leftEventAt ? (
          <View style={styles.leftEventChip}>
            <Text style={styles.leftEventChipText}>{isSelf ? 'Te fuiste' : 'Se fue'}</Text>
          </View>
        ) : null}
        <View style={styles.heroChipsColumn}>
          {isWorkspaceOrganizer ? (
            <View style={styles.orgChip}>
              <Text style={styles.orgChipTxt}>Organizador</Text>
            </View>
          ) : null}
          {isSelf && !isGiantEvent ? (
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

      {!isGiantEvent ? (
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
      ) : null}

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
      <View style={styles.leaveActionWrap}>
        {isSelf ? (
          leftEventAt ? (
            <>
              <Text style={styles.leftEventText}>
                Te marcaste como {leftWord} el {formatLeftEventAt(leftEventAt)}
              </Text>
              {isCurrentUserOrganizer ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={() => void revertLeft()}>
                  <Text style={styles.primaryBtnTxt}>Revertir</Text>
                </TouchableOpacity>
              ) : null}
            </>
          ) : (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => void markAsLeft(true)}>
              <Text style={styles.secondaryBtnTxt}>Me estoy yendo</Text>
            </TouchableOpacity>
          )
        ) : isCurrentUserOrganizer ? (
          leftEventAt ? (
            <>
              <Text style={styles.leftEventText}>
                {displayName} se marcó como {leftWord} el {formatLeftEventAt(leftEventAt)}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => void revertLeft()}>
                <Text style={styles.primaryBtnTxt}>Revertir</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => void markAsLeft(false)}>
              <Text style={styles.secondaryBtnTxt}>{markAsLeftLabel}</Text>
            </TouchableOpacity>
          )
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 24, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  hero: { alignItems: 'center', marginBottom: 7, position: 'relative', width: '100%' },
  giantAvatarPairProfile: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  name: { marginTop: 14, fontSize: 22, fontWeight: '800', color: '#111', textAlign: 'center' },
  profileStreakAbsolute: { position: 'absolute', left: 0, top: 78 },
  profileStreakDots: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  profileStreakDot: {
    width: 18,
    height: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileStreakWin: { backgroundColor: '#15803D' },
  profileStreakLoss: { backgroundColor: '#B91C1C' },
  profileStreakDotTxt: { color: '#fff', fontSize: 10, fontWeight: '700' },
  profileStreakEmpty: { color: '#6B7280', fontSize: 11, fontWeight: '600' },
  heroChipsColumn: { marginTop: 10, alignItems: 'center', gap: 16, width: '100%' },
  leftEventChip: {
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#F3F4F6',
    borderColor: '#D1D5DB',
  },
  leftEventChipText: { fontSize: 11, fontWeight: '700', color: '#6B7280' },
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
  statCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  statCardLeft: { flex: 1, marginRight: 12 },
  statLine: { fontSize: 15, color: '#374151', marginBottom: 6 },
  winRateBox: {
    borderWidth: 1,
    borderColor: '#B45309',
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  winRateLabel: { fontSize: 9, color: '#B45309', fontWeight: '600' },
  winRateValue: { fontSize: 14, color: '#B45309', fontWeight: '800' },
  leaveActionWrap: { marginTop: 12, marginBottom: 8, gap: 8 },
  secondaryBtn: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryBtnTxt: { color: '#374151', fontSize: 14, fontWeight: '600' },
  primaryBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  leftEventText: { color: '#6B7280', fontSize: 13, fontWeight: '600' },
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
  tiebreakVsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  tiebreakVsLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  tiebreakVsLeftText: { flex: 1, minWidth: 0 },
  tiebreakVsMid: { alignItems: 'center', minWidth: 76, paddingHorizontal: 4 },
  tiebreakVsRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    minWidth: 0,
  },
  tiebreakVsRightText: { flex: 1, minWidth: 0, alignItems: 'flex-end' },
  tiebreakH2hNameRight: { textAlign: 'right', alignSelf: 'stretch' },
  tiebreakH2hOpponentName: { fontSize: 13, fontWeight: '700', color: '#111827' },
  tiebreakH2hScore: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
    marginTop: 4,
  },
  tiebreakH2hWinner: { fontSize: 12, fontWeight: '600', color: '#166534', marginTop: 4 },
  h2hDrawLabel: { fontSize: 13, fontWeight: '700', color: '#6B7280', marginTop: 6, textAlign: 'center' },
  tiebreakProfileRoundTitle: { fontSize: 15, fontWeight: '800', color: '#111827', marginTop: 12, marginBottom: 8 },
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
  bo3FilledBlue: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  bo3FilledGreen: { backgroundColor: '#15803D', borderColor: '#15803D' },
  profilePhaseSubtitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#14532D',
    marginTop: 14,
    marginBottom: 8,
  },
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
  cupsColumn: { flexDirection: 'column', gap: 4, alignItems: 'center' },
});
