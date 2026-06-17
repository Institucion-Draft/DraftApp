import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';
import { getPairingStatusLabel } from '../lib/labels';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'PairingsList'>;

type PairingRow = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  official_draw: boolean | null;
  swiss_round: number | null;
};

type ParticipantRow = {
  id: string;
  user_id: string;
  member_b_user_id?: string | null;
  giant_name?: string | null;
  bye_rounds?: number[] | null;
  left_event_at?: string | null;
  participant_colors?: { color: string; member?: string | null }[] | { color: string; member?: string | null } | null;
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

type ItemView = PairingRow & {
  status: 'in_progress' | 'scheduled' | 'completed';
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  aMemberBUserId: string | null;
  bMemberBUserId: string | null;
  aMemberBColors: MtgColor[];
  bMemberBColors: MtgColor[];
  aGiantName: string | null;
  bGiantName: string | null;
  winnerName: string | null;
  winnerUserId: string | null;
  mine: boolean;
  liveScoreA: number | null;
  liveScoreB: number | null;
  winsA: number;
  winsB: number;
  inProgressMatchStartedAt: string | null;
  isDraw: boolean;
};

type DbMatchRow = {
  id: string;
  pairing_id: string;
  status: string | null;
  winner_participant_id: string | null;
  match_type: string | null;
  match_number: number | null;
  started_at: string | null;
  tiebreak_round: number | null;
};

type BracketPhase = 'semi' | 'final' | 'third_place';

type TiebreakOfficialItem = {
  id: string;
  /** Pairing real al que apunta (si existe). Null cuando aún no está linkeado. */
  pairingId: string | null;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  /** True si el participant de ese lado aún no se conoce (semi correspondiente sin cerrar). */
  aUnknown: boolean;
  bUnknown: boolean;
  /** Lado atenuado si ya hubo ganador del tiebreak del round actual. */
  dimLoserSide: 'a' | 'b' | null;
  /** Ganador del tiebreak del round actual (para pie de card). */
  tiebreakWinnerParticipantId: string | null;
  tiebreakWinnerUserId: string | null;
  tiebreakWinnerName: string | null;
  status: 'in_progress' | 'scheduled' | 'completed';
  liveScoreA: number | null;
  liveScoreB: number | null;
  inProgressMatchStartedAt: string | null;
  mine: boolean;
  /** Solo presente para grupos bracket: fase a la que pertenece esta card. */
  bracketPhase: BracketPhase | null;
  /** Victorias parciales dentro de la llave (BO3): para mostrar "Va A-B" antes de que se decida. */
  bracketWinsA: number;
  bracketWinsB: number;
};

type TiebreakOfficialRoundBlock = {
  round: number;
  items: TiebreakOfficialItem[];
};

type TiebreakOfficialSection = {
  kind: 'round_robin' | 'bracket';
  groupRoundNumber: number;
  rounds: TiebreakOfficialRoundBlock[];
  groupOrigin: 'tiebreak' | 'swiss_topcut';
};

type RevengeItemView = {
  matchId: string;
  pairingId: string;
  matchNumber: number;
  revengeOrder: number;
  status: 'in_progress' | 'completed';
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  participantAId: string;
  participantBId: string;
  winnerName: string | null;
  liveScoreA: number | null;
  liveScoreB: number | null;
  mine: boolean;
  inProgressMatchStartedAt: string | null;
  activityAt: string;
};

type RevengeGroupView = {
  pairingId: string;
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  participantAId: string;
  participantBId: string;
  winsA: number;
  winsB: number;
  items: RevengeItemView[];
  lastActivityAt: string;
  mine: boolean;
};

type SwissRevengeStandaloneRow = {
  pairingId: string;
  participantAId: string;
  participantBId: string;
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
};

type OfficialByeCard = { participantId: string; userId: string; name: string };

type OfficialListRow =
  | { kind: 'header'; id: string; title: string }
  | { kind: 'pairing'; id: string; item: ItemView }
  | { kind: 'bye'; id: string; round: number; participantId: string; userId: string; name: string };

function rankOfficialItemStatus(s: ItemView['status']): number {
  return s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : 2;
}

function sortOfficialItemsForDisplay(a: ItemView, b: ItemView, currentUserId: string | null): number {
  const s = rankOfficialItemStatus(a.status) - rankOfficialItemStatus(b.status);
  if (s !== 0) return s;
  const mineA = !!currentUserId && (
    a.aUserId === currentUserId || a.bUserId === currentUserId ||
    (a.aMemberBUserId != null && a.aMemberBUserId === currentUserId) ||
    (a.bMemberBUserId != null && a.bMemberBUserId === currentUserId)
  );
  const mineB = !!currentUserId && (
    b.aUserId === currentUserId || b.bUserId === currentUserId ||
    (b.aMemberBUserId != null && b.aMemberBUserId === currentUserId) ||
    (b.bMemberBUserId != null && b.bMemberBUserId === currentUserId)
  );
  if (mineA !== mineB) return mineA ? -1 : 1;
  return `${a.aName} ${a.bName}`.localeCompare(`${b.aName} ${b.bName}`, 'es', { sensitivity: 'base' });
}

function buildSwissOfficialFlatRows(
  items: ItemView[],
  currentSwissRound: number,
  byeByRound: Record<number, OfficialByeCard[]>,
  currentUserId: string | null
): OfficialListRow[] {
  const byRound = new Map<number, ItemView[]>();
  for (const it of items) {
    const r = it.swiss_round;
    if (r == null || typeof r !== 'number') continue;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r)!.push(it);
  }
  for (const arr of byRound.values()) {
    arr.sort((a, b) => sortOfficialItemsForDisplay(a, b, currentUserId));
  }
  const rows: OfficialListRow[] = [];
  for (let r = currentSwissRound; r >= 1; r--) {
    const roundItems = byRound.get(r) ?? [];
    const byes = byeByRound[r] ?? [];
    if (roundItems.length === 0 && byes.length === 0) continue;
    rows.push({ kind: 'header', id: `hdr-swiss-${r}`, title: `Ronda Suiza ${r}` });
    for (const item of roundItems) {
      rows.push({ kind: 'pairing', id: item.id, item });
    }
    for (const b of byes) {
      rows.push({
        kind: 'bye',
        id: `bye-r${r}-${b.participantId}`,
        round: r,
        participantId: b.participantId,
        userId: b.userId,
        name: b.name,
      });
    }
  }
  return rows;
}

function pairingInSwissRevengeTab(p: PairingRow, currentSwissRound: number | null): boolean {
  if (currentSwissRound == null) return p.swiss_round == null;
  return p.swiss_round == null || p.swiss_round !== currentSwissRound;
}

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function shortName(name: string): string {
  return name.trim().slice(0, 3);
}

function LiveMatchDuration({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [startedAt]);
  if (!startedAt) return null;
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const mm = Math.floor(elapsed / 60);
  return <Text style={styles.liveDuration}>{`${mm}'`}</Text>;
}

export default function PairingsListScreen({ route, navigation }: Props) {
  const { eventId } = route.params;
  const isFocused = useIsFocused();
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [tab, setTab] = useState<'officials' | 'revenge'>('officials');
  const [items, setItems] = useState<ItemView[]>([]);
  const [officialByeByRound, setOfficialByeByRound] = useState<Record<number, OfficialByeCard[]>>({});
  const [currentSwissRoundStored, setCurrentSwissRoundStored] = useState<number | null>(null);
  const [swissRevengeStandalone, setSwissRevengeStandalone] = useState<SwissRevengeStandaloneRow[]>([]);
  const [competitionFormat, setCompetitionFormat] = useState<'round_robin' | 'swiss'>('round_robin');
  const [eventType, setEventType] = useState<string | null>(null);
  const [revengeItems, setRevengeItems] = useState<RevengeItemView[]>([]);
  const [tiebreakOfficialSection, setTiebreakOfficialSection] = useState<TiebreakOfficialSection | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const firstLoadRef = useRef(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'EventDetail', { eventId }),
    });
  }, [navigation, eventId]);

  useLayoutEffect(() => {
    const initialTab = route.params.initialTab;
    if (initialTab === 'revenge') {
      setTab('revenge');
      navigation.setParams({ eventId, initialTab: undefined });
    } else if (initialTab === 'official') {
      setTab('officials');
      navigation.setParams({ eventId, initialTab: undefined });
    }
  }, [route.params.initialTab, eventId, navigation]);

  const load = useCallback(async (): Promise<boolean> => {
    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);

    const [eventRes, pairingsRes, participantsRes] = await Promise.all([
      supabase
        .from('draft_events')
        .select('status, competition_format, current_swiss_round, event_type')
        .eq('id', eventId)
        .maybeSingle(),
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw, swiss_round')
        .eq('event_id', eventId),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          member_b_user_id,
          giant_name,
          bye_rounds,
          left_event_at,
          participant_colors (color, member),
          users!event_participants_user_id_fkey (
            username,
            display_name,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', eventId)
        .eq('role', 'player'),
    ]);

    if (pairingsRes.error || participantsRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los enfrentamientos.');
      setItems([]);
      setOfficialByeByRound({});
      setCurrentSwissRoundStored(null);
      setSwissRevengeStandalone([]);
      setRevengeItems([]);
      setTiebreakOfficialSection(null);
      setCompetitionFormat('round_robin');
      return false;
    }

    const eventStatus = eventRes.data?.status as string | undefined;
    const eventFlags = eventRes.data as {
      competition_format?: string | null;
      current_swiss_round?: number | null;
      event_type?: string | null;
    } | null;
    setEventType(eventFlags?.event_type ?? null);
    // swiss_bo2 se comporta igual que swiss para el render de enfrentamientos.
    const competitionFormat =
      eventFlags?.competition_format === 'swiss' || eventFlags?.competition_format === 'swiss_bo2'
        ? 'swiss'
        : 'round_robin';
    setCompetitionFormat(competitionFormat);
    const csrRaw = eventFlags?.current_swiss_round;
    const currentSwissRound: number | null =
      csrRaw == null
        ? null
        : (() => {
            const n = Number(csrRaw);
            return Number.isFinite(n) ? n : null;
          })();
    setCurrentSwissRoundStored(currentSwissRound);

    const pairingsAll = (pairingsRes.data ?? []) as PairingRow[];
    const pairingsForOfficial: PairingRow[] =
      competitionFormat === 'swiss'
        ? pairingsAll.filter((p) => p.swiss_round != null)
        : pairingsAll;

    const participants = (participantsRes.data ?? []) as ParticipantRow[];
    const pMap = new Map<string, ParticipantRow>(participants.map((p) => [p.id, p]));

    const pairingIds = pairingsAll.map((p) => p.id);
    const matchesRes = await (
      pairingIds.length > 0
        ? supabase
            .from('matches')
            .select('id, pairing_id, status, winner_participant_id, match_type, match_number, started_at, tiebreak_round')
            .in('pairing_id', pairingIds)
        : Promise.resolve({ data: [], error: null } as any)
    );

    if (matchesRes.error) {
      Alert.alert('Error', 'No se pudieron cargar detalles de enfrentamientos.');
      setItems([]);
      setOfficialByeByRound({});
      setCurrentSwissRoundStored(null);
      setSwissRevengeStandalone([]);
      setRevengeItems([]);
      setTiebreakOfficialSection(null);
      setCompetitionFormat('round_robin');
      return false;
    }

    const inProgressByPairing = new Map<string, number>();
    const inProgressMatchByPairing = new Map<string, string>();
    const completedWinsByPairingParticipant = new Map<string, number>();
    const safeMatches = ((matchesRes.data ?? []) as (DbMatchRow | null)[]).filter(
      (x): x is DbMatchRow => x != null
    );
    for (const m of safeMatches) {
      if (m.match_type === 'revenge') continue;
      const pid = m.pairing_id;
      if (m.status === 'in_progress') {
        inProgressByPairing.set(pid, (inProgressByPairing.get(pid) ?? 0) + 1);
        if (!inProgressMatchByPairing.has(pid)) {
          inProgressMatchByPairing.set(pid, m.id);
        }
      }
      if (m.status === 'completed' && m.winner_participant_id) {
        const key = `${pid}:${m.winner_participant_id}`;
        completedWinsByPairingParticipant.set(
          key,
          (completedWinsByPairingParticipant.get(key) ?? 0) + 1
        );
      }
    }

    const inProgressMatchIds = safeMatches
      .filter((m) => m.status === 'in_progress')
      .map((m) => m.id);
    const livesRes = inProgressMatchIds.length
      ? await supabase
          .from('life_events')
          .select('match_id, participant_id, resulting_life, occurred_at')
          .in('match_id', inProgressMatchIds)
      : ({ data: [], error: null } as any);
    const lifeByMatchParticipant: Record<string, Record<string, { life: number; at: string }>> = {};
    if (!livesRes.error) {
      for (const row of livesRes.data ?? []) {
        const mid = String(row.match_id);
        const pid = String(row.participant_id);
        const at = String(row.occurred_at);
        if (!lifeByMatchParticipant[mid]) lifeByMatchParticipant[mid] = {};
        const current = lifeByMatchParticipant[mid]?.[pid];
        if (!current || current.at < at) {
          lifeByMatchParticipant[mid][pid] = { life: Number(row.resulting_life), at };
        }
      }
    }

    const mapped: ItemView[] = pairingsForOfficial.map((pairing) => {
      const pa = pMap.get(pairing.participant_a_id);
      const pb = pMap.get(pairing.participant_b_id);
      const ua = relationOne(pa?.users);
      const ub = relationOne(pb?.users);
      const aName = ua?.display_name || ua?.username || 'Jugador A';
      const bName = ub?.display_name || ub?.username || 'Jugador B';
      const aUserId = pa?.user_id ?? '';
      const bUserId = pb?.user_id ?? '';
      const aMemberBUserId = pa?.member_b_user_id ?? null;
      const bMemberBUserId = pb?.member_b_user_id ?? null;
      const extractMemberBColors = (row: ParticipantRow | undefined): MtgColor[] => {
        if (!row?.participant_colors) return [];
        const arr = Array.isArray(row.participant_colors) ? row.participant_colors : [row.participant_colors];
        return arr.filter((c) => c.member === 'b').map((c) => c.color as MtgColor);
      };
      const aMemberBColors = extractMemberBColors(pa);
      const bMemberBColors = extractMemberBColors(pb);
      const aGiantName = pa?.giant_name ?? null;
      const bGiantName = pb?.giant_name ?? null;
      const inProg = (inProgressByPairing.get(pairing.id) ?? 0) > 0;
      const isDraw = pairing.official_draw === true;
      const completed = !!pairing.official_winner_participant_id || isDraw;
      const status: ItemView['status'] = inProg
        ? 'in_progress'
        : completed
        ? 'completed'
        : 'scheduled';

      const winnerParticipant = pairing.official_winner_participant_id
        ? pMap.get(pairing.official_winner_participant_id)
        : null;
      const winnerUser = relationOne(winnerParticipant?.users);
      const winnerName =
        winnerParticipant?.giant_name ??
        winnerUser?.display_name ?? winnerUser?.username ?? null;
      const winnerUserId = winnerParticipant?.user_id ?? null;

      const mine =
        !!currentUserId &&
        (pa?.user_id === currentUserId ||
          pb?.user_id === currentUserId ||
          aMemberBUserId === currentUserId ||
          bMemberBUserId === currentUserId);
      const inProgressMatchId = inProgressMatchByPairing.get(pairing.id);
      const inProgressMatchStartedAt = inProgressMatchId
        ? safeMatches.find((m) => m.id === inProgressMatchId)?.started_at ?? null
        : null;
      let liveScoreA: number | null = null;
      let liveScoreB: number | null = null;
      if (inProgressMatchId) {
        liveScoreA =
          lifeByMatchParticipant[inProgressMatchId]?.[pairing.participant_a_id]?.life ?? 20;
        liveScoreB =
          lifeByMatchParticipant[inProgressMatchId]?.[pairing.participant_b_id]?.life ?? 20;
      }
      const winsA =
        completedWinsByPairingParticipant.get(
          `${pairing.id}:${pairing.participant_a_id}`
        ) ?? 0;
      const winsB =
        completedWinsByPairingParticipant.get(
          `${pairing.id}:${pairing.participant_b_id}`
        ) ?? 0;

      return {
        ...pairing,
        status,
        aName,
        bName,
        aUserId,
        bUserId,
        aMemberBUserId,
        bMemberBUserId,
        aMemberBColors,
        bMemberBColors,
        aGiantName,
        bGiantName,
        winnerName,
        winnerUserId,
        mine,
        liveScoreA,
        liveScoreB,
        winsA,
        winsB,
        inProgressMatchStartedAt,
        isDraw,
      };
    });

    mapped.sort((a, b) => sortOfficialItemsForDisplay(a, b, currentUserId));

    const pairingById = new Map(pairingsAll.map((p) => [p.id, p]));
    const revengeMapped: RevengeItemView[] = [];
    for (const m of safeMatches) {
      if (m.match_type !== 'revenge') continue;
      if (m.status === 'aborted') continue;
      const pairing = pairingById.get(m.pairing_id);
      if (!pairing) continue;
      // Un match 'revenge' siempre va al tab Venganzas, incluso cuando su pairing
      // pertenece a la ronda actual. El tab Oficial ya excluye 'revenge' de forma
      // incondicional, así que no hay riesgo de duplicado.
      const pa = pMap.get(pairing.participant_a_id);
      const pb = pMap.get(pairing.participant_b_id);
      const ua = relationOne(pa?.users);
      const ub = relationOne(pb?.users);
      const aName = ua?.display_name || ua?.username || 'Jugador A';
      const bName = ub?.display_name || ub?.username || 'Jugador B';
      const aUserId = pa?.user_id ?? '';
      const bUserId = pb?.user_id ?? '';
      if (m.status !== 'in_progress' && m.status !== 'completed') {
        continue;
      }
      const st = m.status;
      const winnerPid = m.winner_participant_id;
      const winnerParticipant = winnerPid ? pMap.get(winnerPid) : null;
      const wu = relationOne(winnerParticipant?.users);
      const winnerName = wu?.display_name || wu?.username || null;
      const mine =
        !!currentUserId && (pa?.user_id === currentUserId || pb?.user_id === currentUserId);
      let liveScoreA: number | null = null;
      let liveScoreB: number | null = null;
      if (m.status === 'in_progress') {
        liveScoreA = lifeByMatchParticipant[m.id]?.[pairing.participant_a_id]?.life ?? 20;
        liveScoreB = lifeByMatchParticipant[m.id]?.[pairing.participant_b_id]?.life ?? 20;
      }
      revengeMapped.push({
        matchId: m.id,
        pairingId: pairing.id,
        matchNumber: m.match_number ?? 0,
        revengeOrder: 0,
        status: st,
        aName,
        bName,
        aUserId,
        bUserId,
        participantAId: pairing.participant_a_id,
        participantBId: pairing.participant_b_id,
        winnerName,
        liveScoreA,
        liveScoreB,
        mine,
        inProgressMatchStartedAt: m.status === 'in_progress' ? m.started_at : null,
        activityAt: m.started_at ?? '',
      });
    }
    revengeMapped.sort((x, y) => {
      const c = x.pairingId.localeCompare(y.pairingId);
      if (c !== 0) return c;
      return x.matchNumber - y.matchNumber;
    });
    const revengeOrderByPairing = new Map<string, number>();
    for (const item of revengeMapped) {
      const next = (revengeOrderByPairing.get(item.pairingId) ?? 0) + 1;
      revengeOrderByPairing.set(item.pairingId, next);
      item.revengeOrder = next;
    }

    const revengeGroupsTemp: RevengeGroupView[] = [];
    const groupByPairingTemp = new Map<string, RevengeGroupView>();
    for (const item of revengeMapped) {
      if (item.status !== 'completed') continue;
      const existing = groupByPairingTemp.get(item.pairingId);
      if (existing) {
        existing.items.push(item);
        if (item.winnerName === item.aName) existing.winsA += 1;
        if (item.winnerName === item.bName) existing.winsB += 1;
        if (item.activityAt > existing.lastActivityAt) existing.lastActivityAt = item.activityAt;
        continue;
      }
      const lastActivityAt = revengeMapped
        .filter((x) => x.pairingId === item.pairingId)
        .reduce((max, x) => (x.activityAt > max ? x.activityAt : max), item.activityAt);
      const next: RevengeGroupView = {
        pairingId: item.pairingId,
        aName: item.aName,
        bName: item.bName,
        aUserId: item.aUserId,
        bUserId: item.bUserId,
        participantAId: item.participantAId,
        participantBId: item.participantBId,
        winsA: item.winnerName === item.aName ? 1 : 0,
        winsB: item.winnerName === item.bName ? 1 : 0,
        items: [item],
        lastActivityAt,
        mine: item.mine,
      };
      groupByPairingTemp.set(item.pairingId, next);
      revengeGroupsTemp.push(next);
    }
    revengeGroupsTemp.sort((x, y) => {
      const xMine = !!currentUserId && (x.aUserId === currentUserId || x.bUserId === currentUserId);
      const yMine = !!currentUserId && (y.aUserId === currentUserId || y.bUserId === currentUserId);
      if (xMine && !yMine) return -1;
      if (!xMine && yMine) return 1;
      return 0;
    });

    const pairedForSwissStandalone = new Set<string>();
    for (const item of revengeMapped) {
      if (item.status === 'in_progress') pairedForSwissStandalone.add(item.pairingId);
    }
    for (const g of revengeGroupsTemp) pairedForSwissStandalone.add(g.pairingId);

    let standaloneRows: SwissRevengeStandaloneRow[] = [];
    if (competitionFormat === 'swiss' && currentUserId) {
      for (const pr of pairingsAll) {
        if (!pairingInSwissRevengeTab(pr, currentSwissRound)) continue;
        const pa2 = pMap.get(pr.participant_a_id);
        const pb2 = pMap.get(pr.participant_b_id);
        if (pa2?.user_id !== currentUserId && pb2?.user_id !== currentUserId) continue;
        if (pairedForSwissStandalone.has(pr.id)) continue;
        const ua2 = relationOne(pa2?.users);
        const ub2 = relationOne(pb2?.users);
        standaloneRows.push({
          pairingId: pr.id,
          participantAId: pr.participant_a_id,
          participantBId: pr.participant_b_id,
          aName: ua2?.display_name || ua2?.username || 'Jugador A',
          bName: ub2?.display_name || ub2?.username || 'Jugador B',
          aUserId: pa2?.user_id ?? '',
          bUserId: pb2?.user_id ?? '',
        });
      }
    }
    setSwissRevengeStandalone(standaloneRows);

    const byeByRound: Record<number, OfficialByeCard[]> = {};
    if (competitionFormat === 'swiss' && currentSwissRound != null) {
      for (let R = 1; R <= currentSwissRound; R += 1) {
        const inRound = new Set<string>();
        for (const p of pairingsAll) {
          if (p.swiss_round !== R) continue;
          inRound.add(p.participant_a_id);
          inRound.add(p.participant_b_id);
        }
        const cards: OfficialByeCard[] = [];
        for (const ep of participants) {
          if (ep.left_event_at) continue;
          const br = Array.isArray(ep.bye_rounds) ? ep.bye_rounds : [];
          if (!br.includes(R)) continue;
          if (inRound.has(ep.id)) continue;
          const u = relationOne(ep.users);
          cards.push({
            participantId: ep.id,
            userId: ep.user_id,
            name: u?.display_name || u?.username || 'Jugador',
          });
        }
        byeByRound[R] = cards;
      }
    }
    setOfficialByeByRound(byeByRound);

    setItems(mapped);
    setRevengeItems(revengeMapped);

    let tiebreakSection: TiebreakOfficialSection | null = null;
    const agRes = await supabase
      .from('event_tiebreak_groups')
      .select('id, group_type, round_number, champion_user_id, status, created_at, group_origin')
      .eq('event_id', eventId)
      .in('status', ['active', 'resolved', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!agRes.error && agRes.data) {
      const ag = agRes.data as {
        id: string;
        group_type: string;
        round_number: number;
        champion_user_id: string | null;
        group_origin?: string | null;
      };
      const gpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id')
        .eq('group_id', ag.id);
      if (!gpRes.error && gpRes.data) {
        const gIds = new Set((gpRes.data as { participant_id: string }[]).map((x) => x.participant_id));
        if (gIds.size >= 2) {
          const groupRoundNumber = ag.round_number ?? 1;
          const groupOrigin: 'tiebreak' | 'swiss_topcut' =
            ag.group_origin === 'swiss_topcut' ? 'swiss_topcut' : 'tiebreak';

          const itemForPairing = (
            pairing: PairingRow,
            roundNum: number,
            bracketPhase: BracketPhase | null,
            bracketWinnerPid: string | null
          ): TiebreakOfficialItem => {
            const pa = pMap.get(pairing.participant_a_id);
            const pb = pMap.get(pairing.participant_b_id);
            const ua = relationOne(pa?.users);
            const ub = relationOne(pb?.users);
            const aName = ua?.display_name || ua?.username || 'Jugador A';
            const bName = ub?.display_name || ub?.username || 'Jugador B';
            const aUserId = pa?.user_id ?? '';
            const bUserId = pb?.user_id ?? '';
            const tbInProg = safeMatches.find(
              (m) =>
                m.pairing_id === pairing.id &&
                m.match_type === 'tiebreak' &&
                m.status === 'in_progress' &&
                (m.tiebreak_round ?? 1) === roundNum
            );
            let tbWonA: boolean;
            let tbWonB: boolean;
            if (bracketPhase != null) {
              tbWonA = bracketWinnerPid === pairing.participant_a_id;
              tbWonB = bracketWinnerPid === pairing.participant_b_id;
            } else {
              tbWonA = safeMatches.some(
                (m) =>
                  m.pairing_id === pairing.id &&
                  m.match_type === 'tiebreak' &&
                  m.status === 'completed' &&
                  m.winner_participant_id === pairing.participant_a_id &&
                  (m.tiebreak_round ?? 1) === roundNum
              );
              tbWonB = safeMatches.some(
                (m) =>
                  m.pairing_id === pairing.id &&
                  m.match_type === 'tiebreak' &&
                  m.status === 'completed' &&
                  m.winner_participant_id === pairing.participant_b_id &&
                  (m.tiebreak_round ?? 1) === roundNum
              );
            }
            const tbRoundFinished = tbWonA || tbWonB;
            const st: TiebreakOfficialItem['status'] = tbInProg
              ? 'in_progress'
              : tbRoundFinished
                ? 'completed'
                : 'scheduled';
            let liveScoreA: number | null = null;
            let liveScoreB: number | null = null;
            if (tbInProg) {
              liveScoreA =
                lifeByMatchParticipant[tbInProg.id]?.[pairing.participant_a_id]?.life ?? 20;
              liveScoreB =
                lifeByMatchParticipant[tbInProg.id]?.[pairing.participant_b_id]?.life ?? 20;
            }
            let dimLoserSide: 'a' | 'b' | null = null;
            if (tbWonA) dimLoserSide = 'b';
            else if (tbWonB) dimLoserSide = 'a';
            const tiebreakWinnerParticipantId = tbWonA
              ? pairing.participant_a_id
              : tbWonB
                ? pairing.participant_b_id
                : null;
            const tiebreakWinnerUserId = tbWonA ? aUserId : tbWonB ? bUserId : null;
            const tiebreakWinnerName = tbWonA ? aName : tbWonB ? bName : null;
            const mine =
              !!currentUserId && (pa?.user_id === currentUserId || pb?.user_id === currentUserId);
            // Victorias parciales dentro de la llave (solo relevante para bracket).
            const bracketWinsA = bracketPhase != null
              ? safeMatches.filter(
                  (m) =>
                    m.pairing_id === pairing.id &&
                    m.match_type === 'tiebreak' &&
                    m.status === 'completed' &&
                    m.winner_participant_id === pairing.participant_a_id
                ).length
              : 0;
            const bracketWinsB = bracketPhase != null
              ? safeMatches.filter(
                  (m) =>
                    m.pairing_id === pairing.id &&
                    m.match_type === 'tiebreak' &&
                    m.status === 'completed' &&
                    m.winner_participant_id === pairing.participant_b_id
                ).length
              : 0;
            return {
              id: pairing.id,
              pairingId: pairing.id,
              participant_a_id: pairing.participant_a_id,
              participant_b_id: pairing.participant_b_id,
              official_winner_participant_id: pairing.official_winner_participant_id,
              aName,
              bName,
              aUserId,
              bUserId,
              aUnknown: pa == null,
              bUnknown: pb == null,
              dimLoserSide,
              tiebreakWinnerParticipantId,
              tiebreakWinnerUserId,
              tiebreakWinnerName,
              status: st,
              liveScoreA,
              liveScoreB,
              inProgressMatchStartedAt: tbInProg?.started_at ?? null,
              mine,
              bracketPhase,
              bracketWinsA,
              bracketWinsB,
            };
          };

          if (ag.group_type === 'bracket') {
            const bmRes = await supabase
              .from('event_tiebreak_bracket_matches')
              .select('id, bracket_phase, pairing_id, participant_a_id, participant_b_id, winner_participant_id, created_at')
              .eq('group_id', ag.id)
              .order('created_at', { ascending: true });
            if (!bmRes.error && bmRes.data) {
              const bracketRows = bmRes.data as {
                id: string;
                bracket_phase: BracketPhase;
                pairing_id: string | null;
                participant_a_id: string;
                participant_b_id: string;
                winner_participant_id: string | null;
              }[];
              const phaseOrder: Record<BracketPhase, number> = { final: 0, third_place: 1, semi: 2 };
              const sortedBracketRows = [...bracketRows].sort(
                (x, y) => phaseOrder[x.bracket_phase] - phaseOrder[y.bracket_phase]
              );
              // Fuente de verdad de la fase mata-mata: event_tiebreak_bracket_matches.
              // El pairing puede estar COMPARTIDO con la ronda suiza (misma fila por la
              // constraint única event_id+a+b), así que NO leemos participantes ni ganador
              // del pairing: los tomamos del bracket match. El pairing solo se usa para el
              // marcador parcial (matches tiebreak) y para el match en vivo / navegación.
              const itemForBracketRow = (
                bm: {
                  id: string;
                  bracket_phase: BracketPhase;
                  participant_a_id: string;
                  participant_b_id: string;
                  winner_participant_id: string | null;
                },
                pairing: PairingRow | null
              ): TiebreakOfficialItem => {
                const pa = pMap.get(bm.participant_a_id);
                const pb = pMap.get(bm.participant_b_id);
                const ua = relationOne(pa?.users);
                const ub = relationOne(pb?.users);
                const aName = ua?.display_name || ua?.username || '?';
                const bName = ub?.display_name || ub?.username || '?';
                const aUserId = pa?.user_id ?? '';
                const bUserId = pb?.user_id ?? '';

                // Estado y ganador de la serie: salen de winner_participant_id del bracket
                // match (igual que swiss bo3). Si no es null, la serie está cerrada.
                const seriesClosed = bm.winner_participant_id != null;
                const tbWonA = bm.winner_participant_id === bm.participant_a_id;
                const tbWonB = bm.winner_participant_id === bm.participant_b_id;

                // Marcador parcial: contar matches tiebreak ganados por cada lado dentro del
                // pairing compartido, asignados según los participantes del bracket match.
                const bracketWinsA = pairing
                  ? safeMatches.filter(
                      (m) =>
                        m.pairing_id === pairing.id &&
                        m.match_type === 'tiebreak' &&
                        m.status === 'completed' &&
                        m.winner_participant_id === bm.participant_a_id
                    ).length
                  : 0;
                const bracketWinsB = pairing
                  ? safeMatches.filter(
                      (m) =>
                        m.pairing_id === pairing.id &&
                        m.match_type === 'tiebreak' &&
                        m.status === 'completed' &&
                        m.winner_participant_id === bm.participant_b_id
                    ).length
                  : 0;

                // Match tiebreak en curso (solo relevante mientras la serie no esté cerrada).
                const tbInProg =
                  pairing && !seriesClosed
                    ? safeMatches.find(
                        (m) =>
                          m.pairing_id === pairing.id &&
                          m.match_type === 'tiebreak' &&
                          m.status === 'in_progress'
                      )
                    : undefined;
                const st: TiebreakOfficialItem['status'] = tbInProg
                  ? 'in_progress'
                  : seriesClosed
                    ? 'completed'
                    : 'scheduled';
                let liveScoreA: number | null = null;
                let liveScoreB: number | null = null;
                if (tbInProg) {
                  liveScoreA =
                    lifeByMatchParticipant[tbInProg.id]?.[bm.participant_a_id]?.life ?? 20;
                  liveScoreB =
                    lifeByMatchParticipant[tbInProg.id]?.[bm.participant_b_id]?.life ?? 20;
                }
                let dimLoserSide: 'a' | 'b' | null = null;
                if (tbWonA) dimLoserSide = 'b';
                else if (tbWonB) dimLoserSide = 'a';
                const winnerName = tbWonA ? aName : tbWonB ? bName : null;
                const mine =
                  !!currentUserId && (pa?.user_id === currentUserId || pb?.user_id === currentUserId);
                return {
                  id: bm.id,
                  pairingId: pairing?.id ?? null,
                  participant_a_id: bm.participant_a_id,
                  participant_b_id: bm.participant_b_id,
                  official_winner_participant_id: null,
                  aName,
                  bName,
                  aUserId,
                  bUserId,
                  aUnknown: pa == null,
                  bUnknown: pb == null,
                  dimLoserSide,
                  tiebreakWinnerParticipantId: tbWonA
                    ? bm.participant_a_id
                    : tbWonB
                      ? bm.participant_b_id
                      : null,
                  tiebreakWinnerUserId: tbWonA ? aUserId : tbWonB ? bUserId : null,
                  tiebreakWinnerName: winnerName,
                  status: st,
                  liveScoreA,
                  liveScoreB,
                  inProgressMatchStartedAt: tbInProg?.started_at ?? null,
                  mine,
                  bracketPhase: bm.bracket_phase,
                  bracketWinsA,
                  bracketWinsB,
                };
              };
              const tbItems: TiebreakOfficialItem[] = [];
              for (const bm of sortedBracketRows) {
                const pairing = bm.pairing_id
                  ? pairingsAll.find((p) => p.id === bm.pairing_id) ?? null
                  : null;
                tbItems.push(itemForBracketRow(bm, pairing));
              }
              if (tbItems.length > 0) {
                tiebreakSection = {
                  kind: 'bracket',
                  groupRoundNumber: 1,
                  rounds: [{ round: 1, items: tbItems }],
                  groupOrigin,
                };
              }
            }
          } else {
            const buildTiebreakItemsForRound = (roundNum: number): TiebreakOfficialItem[] => {
              const tbItems: TiebreakOfficialItem[] = [];
              for (const pairing of pairingsAll) {
                if (!gIds.has(pairing.participant_a_id) || !gIds.has(pairing.participant_b_id)) continue;
                tbItems.push(itemForPairing(pairing, roundNum, null, null));
              }
              tbItems.sort((x, y) => {
                if (x.mine !== y.mine) return x.mine ? -1 : 1;
                return `${x.aName} ${x.bName}`.localeCompare(`${y.aName} ${y.bName}`, 'es', {
                  sensitivity: 'base',
                });
              });
              return tbItems;
            };
            const rounds: TiebreakOfficialRoundBlock[] =
              groupRoundNumber >= 2
                ? [
                    { round: 2, items: buildTiebreakItemsForRound(2) },
                    { round: 1, items: buildTiebreakItemsForRound(1) },
                  ]
                : [{ round: 1, items: buildTiebreakItemsForRound(1) }];
            tiebreakSection = { kind: 'round_robin', groupRoundNumber, rounds, groupOrigin };
          }
        }
      }
    }
    setTiebreakOfficialSection(tiebreakSection);

    let needsCheckIn = false;
    if (eventStatus === 'playing' && currentUserId) {
      const myP = participants.find((p) => p.user_id === currentUserId);
      if (myP?.id) {
        const cr = await supabase
          .from('participant_colors')
          .select('id', { count: 'exact', head: true })
          .eq('participant_id', myP.id);
        if (!cr.error && (cr.count ?? 0) === 0) {
          needsCheckIn = true;
        }
      }
    }
    return needsCheckIn;
  }, [eventId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const first = firstLoadRef.current;
        if (first) {
          setLoading(true);
          firstLoadRef.current = false;
        }
        const needsCheckIn = await load();
        if (!cancelled && needsCheckIn) {
          navigation.navigate('EventCheckIn', { eventId, returnTo: 'PairingsList' });
        }
        if (!cancelled && first) setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [load, navigation, eventId])
  );

  useEffect(() => {
    if (!isFocused) return;
    const intervalMs = 15000;
    const handle = setInterval(() => {
      void load();
    }, intervalMs);
    return () => clearInterval(handle);
  }, [isFocused, load]);

  useEffect(() => {
    if (channelRef.current) return;
    const channel = supabase
      .channel(`pairings-live:${eventId}:${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'life_events' }, () => {
        void load();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => {
        void load();
      })
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'event_tiebreak_groups',
          filter: `event_id=eq.${eventId}`,
        },
        () => {
          void load();
        }
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [eventId, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);
  const liveRevengeItems = revengeItems
    .filter((item) => item.status === 'in_progress')
    .filter((item) => competitionFormat !== 'swiss' || item.mine)
    .sort((x, y) => y.activityAt.localeCompare(x.activityAt));
  const revengeGroups: RevengeGroupView[] = [];
  const groupByPairing = new Map<string, RevengeGroupView>();
  for (const item of revengeItems) {
    if (item.status !== 'completed') continue;
    const existing = groupByPairing.get(item.pairingId);
    if (existing) {
      existing.items.push(item);
      if (item.winnerName === item.aName) existing.winsA += 1;
      if (item.winnerName === item.bName) existing.winsB += 1;
      if (item.activityAt > existing.lastActivityAt) existing.lastActivityAt = item.activityAt;
      continue;
    }
    const lastActivityAt = revengeItems
      .filter((x) => x.pairingId === item.pairingId)
      .reduce((max, x) => (x.activityAt > max ? x.activityAt : max), item.activityAt);
    const next: RevengeGroupView = {
      pairingId: item.pairingId,
      aName: item.aName,
      bName: item.bName,
      aUserId: item.aUserId,
      bUserId: item.bUserId,
      participantAId: item.participantAId,
      participantBId: item.participantBId,
      winsA: item.winnerName === item.aName ? 1 : 0,
      winsB: item.winnerName === item.bName ? 1 : 0,
      items: [item],
      lastActivityAt,
      mine: item.mine,
    };
    groupByPairing.set(item.pairingId, next);
    revengeGroups.push(next);
  }
  const myRevengeGroups =
    competitionFormat === 'swiss'
      ? revengeGroups.filter(
          (g) => !!myUserId && (g.aUserId === myUserId || g.bUserId === myUserId)
        )
      : revengeGroups;
  const otherLiveRevengeItems =
    competitionFormat === 'swiss'
      ? revengeItems
          .filter((item) => item.status === 'in_progress' && !item.mine)
          .sort((x, y) => y.activityAt.localeCompare(x.activityAt))
      : [];
  const otherRevengeGroups =
    competitionFormat === 'swiss'
      ? revengeGroups
          .filter((g) => !myUserId || (g.aUserId !== myUserId && g.bUserId !== myUserId))
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      : [];
  const hasOtherSwissRevenge =
    competitionFormat === 'swiss' &&
    (otherRevengeGroups.length > 0 || otherLiveRevengeItems.length > 0);
  const revengeListEmpty =
    myRevengeGroups.length === 0 &&
    liveRevengeItems.length === 0 &&
    swissRevengeStandalone.length === 0 &&
    !hasOtherSwissRevenge;

  const tiebreakCardsTotal =
    tiebreakOfficialSection?.rounds.reduce((sum, b) => sum + b.items.length, 0) ?? 0;

  const isSwissOfficialSectioned = competitionFormat === 'swiss' && currentSwissRoundStored != null;

  const officialSwissFlatRows = useMemo(() => {
    if (!isSwissOfficialSectioned || currentSwissRoundStored == null) return [];
    return buildSwissOfficialFlatRows(items, currentSwissRoundStored, officialByeByRound, myUserId);
  }, [isSwissOfficialSectioned, items, currentSwissRoundStored, officialByeByRound, myUserId]);

  const officialMainListEmpty = isSwissOfficialSectioned
    ? officialSwissFlatRows.length === 0
    : items.length === 0;

  const renderOfficialPairingCard = useCallback(
    (item: ItemView) => {
      const isGiantEvent = eventType === 'two_headed_giant';
      const swapSides =
        !!myUserId &&
        (item.bUserId === myUserId ||
          (isGiantEvent && item.bMemberBUserId === myUserId));
      const leftUserId = swapSides ? item.bUserId : item.aUserId;
      const rightUserId = swapSides ? item.aUserId : item.bUserId;
      const leftPid = swapSides ? item.participant_b_id : item.participant_a_id;
      const rightPid = swapSides ? item.participant_a_id : item.participant_b_id;
      const leftName = swapSides
        ? (isGiantEvent ? (item.bGiantName ?? item.bName) : item.bName)
        : (isGiantEvent ? (item.aGiantName ?? item.aName) : item.aName);
      const rightName = swapSides
        ? (isGiantEvent ? (item.aGiantName ?? item.aName) : item.aName)
        : (isGiantEvent ? (item.bGiantName ?? item.bName) : item.bName);
      const leftMemberBUserId = swapSides ? item.bMemberBUserId : item.aMemberBUserId;
      const rightMemberBUserId = swapSides ? item.aMemberBUserId : item.bMemberBUserId;
      const leftMemberBColors = swapSides ? item.bMemberBColors : item.aMemberBColors;
      const rightMemberBColors = swapSides ? item.aMemberBColors : item.bMemberBColors;
      const winsLeft = swapSides ? item.winsB : item.winsA;
      const winsRight = swapSides ? item.winsA : item.winsB;
      const liveL = swapSides ? item.liveScoreB : item.liveScoreA;
      const liveR = swapSides ? item.liveScoreA : item.liveScoreB;
      return (
        <TouchableOpacity
          style={styles.card}
          onPress={() =>
            navigation.navigate('PairingDetail', { pairingId: item.id, fromTab: 'official' })
          }
        >
          <View style={styles.compactRow}>
            <View style={styles.inlinePlayer}>
              {isGiantEvent ? (
                <View style={styles.giantAvatarPairCard}>
                  <PlayerAvatar
                    userId={leftUserId}
                    participantId={leftPid}
                    size="small"
                    withColorBorder
                    borderWidth={3}
                    giantSide="left"
                  />
                  {leftMemberBUserId ? (
                    <PlayerAvatar
                      userId={leftMemberBUserId}
                      size="small"
                      withColorBorder
                      borderWidth={3}
                      giantSide="right"
                      memberColors={leftMemberBColors}
                      style={{ marginLeft: -8 }}
                    />
                  ) : null}
                </View>
              ) : (
                <PlayerAvatar
                  userId={leftUserId}
                  participantId={leftPid}
                  size="small"
                  withColorBorder
                  borderWidth={3}
                />
              )}
              <View>
                <Text style={styles.name}>{leftName}</Text>
                <View style={styles.bo3Row}>
                  <View style={[styles.bo3Box, winsLeft >= 1 && styles.bo3Filled]} />
                  <View style={[styles.bo3Box, winsLeft >= 2 && styles.bo3Filled]} />
                </View>
              </View>
            </View>
            <View style={styles.scoreWrap}>
              {item.status === 'in_progress' ? (
                <Text style={styles.scoreNum}>
                  {liveL ?? 20} <Text style={styles.vs}>vs</Text> {liveR ?? 20}
                </Text>
              ) : (
                <Text style={styles.scoreNumIdle}>vs</Text>
              )}
            </View>
            <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
              <View style={styles.playerRightText}>
                <Text style={styles.nameRight}>{rightName}</Text>
                <View style={[styles.bo3Row, styles.bo3RowRight]}>
                  <View style={[styles.bo3Box, winsRight >= 1 && styles.bo3Filled]} />
                  <View style={[styles.bo3Box, winsRight >= 2 && styles.bo3Filled]} />
                </View>
              </View>
              {isGiantEvent ? (
                <View style={styles.giantAvatarPairCard}>
                  {rightMemberBUserId ? (
                    <PlayerAvatar
                      userId={rightMemberBUserId}
                      size="small"
                      withColorBorder
                      borderWidth={3}
                      giantSide="left"
                      memberColors={rightMemberBColors}
                      style={{ marginRight: -8 }}
                    />
                  ) : null}
                  <PlayerAvatar
                    userId={rightUserId}
                    participantId={rightPid}
                    size="small"
                    withColorBorder
                    borderWidth={3}
                    giantSide="right"
                  />
                </View>
              ) : (
                <PlayerAvatar
                  userId={rightUserId}
                  participantId={rightPid}
                  size="small"
                  withColorBorder
                  borderWidth={3}
                />
              )}
            </View>
          </View>
          <View style={styles.footer}>
            <View style={styles.footerLeft}>
              {item.inProgressMatchStartedAt ? (
                <LiveMatchDuration startedAt={item.inProgressMatchStartedAt} />
              ) : item.isDraw ? (
                <Text style={styles.tiebreakGanoLine}>Empate</Text>
              ) : item.winnerName && item.official_winner_participant_id ? (
                <Text style={styles.tiebreakGanoLine}>Ganó: {item.winnerName}</Text>
              ) : null}
            </View>
            <View style={styles.footerCenter}>
              {item.status === 'in_progress' ? (
                <Text style={styles.liveCentered}>● EN VIVO</Text>
              ) : (
                <Text style={styles.status}>{getPairingStatusLabel(item.status)}</Text>
              )}
            </View>
            <View style={styles.footerRight} />
          </View>
        </TouchableOpacity>
      );
    },
    [navigation, myUserId, eventType]
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={styles.tabBtn}
          onPress={() => setTab('officials')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabLabel, tab === 'officials' && styles.tabLabelActive]}>Oficiales</Text>
          <View style={[styles.tabUnderline, tab !== 'officials' && styles.tabUnderlineHidden]} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabBtn} onPress={() => setTab('revenge')} activeOpacity={0.7}>
          <Text style={[styles.tabLabel, tab === 'revenge' && styles.tabLabelActive]}>Venganzas</Text>
          <View style={[styles.tabUnderline, tab !== 'revenge' && styles.tabUnderlineHidden]} />
        </TouchableOpacity>
      </View>
      {tab === 'officials' ? (
        <FlatList<ItemView | OfficialListRow>
          data={isSwissOfficialSectioned ? officialSwissFlatRows : items}
          keyExtractor={(it) => it.id}
          contentContainerStyle={
            officialMainListEmpty && tiebreakCardsTotal === 0 ? styles.emptyWrap : styles.listWrap
          }
          ListEmptyComponent={
            officialMainListEmpty && tiebreakCardsTotal === 0 ? (
              <Text style={styles.empty}>Todavía no hay enfrentamientos.</Text>
            ) : null
          }
          ListHeaderComponent={
            tiebreakOfficialSection && tiebreakCardsTotal > 0 ? (
              <View style={styles.tiebreakOfficialHeaderWrap}>
                <Text style={styles.groupHeader}>
                  {tiebreakOfficialSection.groupOrigin === 'swiss_topcut' ? 'Fase mata-mata' : 'Desempate'}
                </Text>
                {tiebreakOfficialSection.rounds.map((block) => {
                  const isBracket = tiebreakOfficialSection.kind === 'bracket';
                  const itemsToRender = block.items;
                  const firstIdByPhase: Record<BracketPhase, string | null> = isBracket
                    ? {
                        final: itemsToRender.find((it) => it.bracketPhase === 'final')?.id ?? null,
                        third_place:
                          itemsToRender.find((it) => it.bracketPhase === 'third_place')?.id ?? null,
                        semi: itemsToRender.find((it) => it.bracketPhase === 'semi')?.id ?? null,
                      }
                    : { final: null, third_place: null, semi: null };
                  const renderPlayerSide = (opts: {
                    side: 'a' | 'b';
                    userId: string;
                    participantId: string;
                    name: string;
                    unknown: boolean;
                    dim: boolean;
                  }) => {
                    const sideContainer =
                      opts.side === 'a'
                        ? [styles.inlinePlayer, opts.dim ? styles.tiebreakDimmed : null]
                        : [
                            styles.inlinePlayer,
                            styles.inlinePlayerRight,
                            opts.dim ? styles.tiebreakDimmed : null,
                          ];
                    const placeholderAvatar = (
                      <View style={styles.bracketPlaceholderAvatar}>
                        <Text style={styles.bracketPlaceholderQuestion}>?</Text>
                      </View>
                    );
                    const realAvatar = (
                      <PlayerAvatar
                        userId={opts.userId}
                        participantId={opts.participantId}
                        size="small"
                        withColorBorder
                        borderWidth={3}
                      />
                    );
                    const nameLabel = opts.unknown ? '?' : opts.name;
                    if (opts.side === 'a') {
                      return (
                        <View style={sideContainer}>
                          {opts.unknown ? placeholderAvatar : realAvatar}
                          <View>
                            <Text style={styles.name}>{nameLabel}</Text>
                          </View>
                        </View>
                      );
                    }
                    return (
                      <View style={sideContainer}>
                        <View style={styles.playerRightText}>
                          <Text style={styles.nameRight}>{nameLabel}</Text>
                        </View>
                        {opts.unknown ? placeholderAvatar : realAvatar}
                      </View>
                    );
                  };
                  return (
                  <React.Fragment key={`tb-round-${block.round}`}>
                    {tiebreakOfficialSection.kind === 'round_robin' &&
                    tiebreakOfficialSection.groupRoundNumber >= 2 ? (
                      <Text
                        style={[styles.groupHeader, styles.officialListSectionTitle, styles.tiebreakRoundSubheader]}
                      >
                        Ronda {block.round}
                      </Text>
                    ) : null}
                    {itemsToRender.map((it) => {
                      const playedRound = it.dimLoserSide != null;
                      const cardStyles = [styles.card, styles.tiebreakCard];
                      const swapSides = !!myUserId && it.bUserId === myUserId;
                      const leftPid = swapSides ? it.participant_b_id : it.participant_a_id;
                      const rightPid = swapSides ? it.participant_a_id : it.participant_b_id;
                      const leftUserId = swapSides ? it.bUserId : it.aUserId;
                      const rightUserId = swapSides ? it.aUserId : it.bUserId;
                      const leftName = swapSides ? it.bName : it.aName;
                      const rightName = swapSides ? it.aName : it.bName;
                      const leftUnknown = swapSides ? it.bUnknown : it.aUnknown;
                      const rightUnknown = swapSides ? it.aUnknown : it.bUnknown;
                      const liveL = swapSides ? it.liveScoreB : it.liveScoreA;
                      const liveR = swapSides ? it.liveScoreA : it.liveScoreB;
                      const dimLeft =
                        it.dimLoserSide == null
                          ? false
                          : swapSides
                            ? it.dimLoserSide === 'b'
                            : it.dimLoserSide === 'a';
                      const dimRight =
                        it.dimLoserSide == null
                          ? false
                          : swapSides
                            ? it.dimLoserSide === 'a'
                            : it.dimLoserSide === 'b';
                      const inner = (
                        <>
                          <View style={styles.compactRow}>
                            {renderPlayerSide({
                              side: 'a',
                              userId: leftUserId,
                              participantId: leftPid,
                              name: leftName,
                              unknown: leftUnknown,
                              dim: dimLeft,
                            })}
                            <View style={styles.scoreWrap}>
                              {it.status === 'in_progress' ? (
                                <Text style={styles.scoreNum}>
                                  {liveL ?? 20} <Text style={styles.vs}>vs</Text> {liveR ?? 20}
                                </Text>
                              ) : (
                                <Text style={styles.scoreNumIdle}>vs</Text>
                              )}
                            </View>
                            {renderPlayerSide({
                              side: 'b',
                              userId: rightUserId,
                              participantId: rightPid,
                              name: rightName,
                              unknown: rightUnknown,
                              dim: dimRight,
                            })}
                          </View>
                          <View style={styles.footer}>
                            <View style={styles.footerLeft}>
                              {it.inProgressMatchStartedAt ? (
                                <LiveMatchDuration startedAt={it.inProgressMatchStartedAt} />
                              ) : it.tiebreakWinnerName ? (
                                <Text style={styles.tiebreakGanoLine}>Gano: {it.tiebreakWinnerName}</Text>
                              ) : isBracket && (it.bracketWinsA + it.bracketWinsB) > 0 ? (
                                // Marcador parcial dentro de la llave BO3 (ej: "Va 1-0").
                                <Text style={styles.tiebreakGanoLine}>
                                  Va {swapSides ? it.bracketWinsB : it.bracketWinsA}-{swapSides ? it.bracketWinsA : it.bracketWinsB}
                                </Text>
                              ) : null}
                            </View>
                            <View style={styles.footerCenter}>
                              {it.status === 'in_progress' ? (
                                <Text style={styles.liveCentered}>● EN VIVO</Text>
                              ) : it.status === 'completed' ? (
                                <Text style={styles.status}>{getPairingStatusLabel('completed')}</Text>
                              ) : isBracket ? (
                                <Text style={styles.status}>Por jugar</Text>
                              ) : (
                                <Text style={styles.status}>{getPairingStatusLabel(it.status)}</Text>
                              )}
                            </View>
                            <View style={styles.footerRight} />
                          </View>
                        </>
                      );
                      const rowKey = `${it.id}-r${block.round}`;
                      const canNavigate = it.pairingId != null;
                      const tappable = isBracket ? canNavigate : !playedRound;
                      const targetPairingId = it.pairingId;
                      const card = tappable && targetPairingId ? (
                        <TouchableOpacity
                          key={rowKey}
                          style={cardStyles}
                          activeOpacity={0.7}
                          onPress={() =>
                            navigation.navigate('PairingDetail', {
                              pairingId: targetPairingId,
                              fromTab: 'official',
                              // En la fase mata-mata, pasar el bracket match para que el detalle
                              // muestre la identidad real del cruce (no la del pairing compartido).
                              ...(isBracket ? { bracketMatchId: it.id } : {}),
                            })
                          }
                        >
                          {inner}
                        </TouchableOpacity>
                      ) : (
                        <View key={rowKey} style={cardStyles}>
                          {inner}
                        </View>
                      );
                      const phaseSubheader: { label: string; firstId: string | null } | null =
                        isBracket && it.bracketPhase
                          ? it.bracketPhase === 'final'
                            ? { label: 'Final', firstId: firstIdByPhase.final }
                            : it.bracketPhase === 'third_place'
                              ? { label: '3er y 4to puesto', firstId: firstIdByPhase.third_place }
                              : { label: 'Semifinales', firstId: firstIdByPhase.semi }
                          : null;
                      if (phaseSubheader && phaseSubheader.firstId === it.id) {
                        return (
                          <React.Fragment key={`${rowKey}-with-phase-header`}>
                            <Text style={styles.bracketPhaseSubheader}>{phaseSubheader.label}</Text>
                            {card}
                          </React.Fragment>
                        );
                      }
                      return card;
                    })}
                  </React.Fragment>
                  );
                })}
                {!isSwissOfficialSectioned ? (
                  <Text style={[styles.groupHeader, styles.officialListSectionTitle]}>Enfrentamientos</Text>
                ) : null}
              </View>
            ) : null
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => {
            if ('kind' in item) {
              if (item.kind === 'header') {
                return (
                  <Text
                    style={[styles.groupHeader, styles.officialListSectionTitle, styles.swissRoundHeader]}
                  >
                    {item.title}
                  </Text>
                );
              }
              if (item.kind === 'bye') {
                return (
                  <View style={[styles.card, styles.byeCard]}>
                    <Text style={styles.byeLabel}>Libre</Text>
                    <View style={styles.byeRow}>
                      <PlayerAvatar
                        userId={item.userId}
                        participantId={item.participantId}
                        size="small"
                        withColorBorder
                        borderWidth={3}
                      />
                      <Text style={styles.byeName}>{item.name}</Text>
                    </View>
                  </View>
                );
              }
              return renderOfficialPairingCard(item.item);
            }
            return renderOfficialPairingCard(item);
          }}
        />
      ) : (
        <FlatList
          data={myRevengeGroups}
          keyExtractor={(it) => it.pairingId}
          contentContainerStyle={revengeListEmpty ? styles.emptyWrap : styles.listWrap}
          ListEmptyComponent={
            revengeListEmpty ? <Text style={styles.empty}>Todavía no hay venganzas.</Text> : null
          }
          ListHeaderComponent={
            liveRevengeItems.length > 0 ? (
              <>
                {liveRevengeItems.map((item) => {
                  const swapSides = !!myUserId && item.bUserId === myUserId;
                  const leftUserId = swapSides ? item.bUserId : item.aUserId;
                  const rightUserId = swapSides ? item.aUserId : item.bUserId;
                  const leftPid = swapSides ? item.participantBId : item.participantAId;
                  const rightPid = swapSides ? item.participantAId : item.participantBId;
                  const leftName = swapSides ? item.bName : item.aName;
                  const rightName = swapSides ? item.aName : item.bName;
                  const liveL = swapSides ? item.liveScoreB : item.liveScoreA;
                  const liveR = swapSides ? item.liveScoreA : item.liveScoreB;
                  return (
                  <TouchableOpacity
                    key={item.matchId}
                    style={styles.card}
                    onPress={() =>
                      navigation.navigate('PairingDetail', { pairingId: item.pairingId, fromTab: 'revenge' })
                    }
                  >
                    <View style={styles.compactRow}>
                      <View style={styles.inlinePlayer}>
                        <PlayerAvatar
                          userId={leftUserId}
                          participantId={leftPid}
                          size="small"
                          withColorBorder
                          borderWidth={3}
                        />
                        <Text style={styles.name}>{leftName}</Text>
                      </View>
                      <View style={styles.scoreWrap}>
                        <Text style={styles.scoreNum}>
                          {liveL ?? 20} <Text style={styles.vs}>vs</Text> {liveR ?? 20}
                        </Text>
                      </View>
                      <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                        <Text style={styles.nameRight}>{rightName}</Text>
                        <PlayerAvatar
                          userId={rightUserId}
                          participantId={rightPid}
                          size="small"
                          withColorBorder
                          borderWidth={3}
                        />
                      </View>
                    </View>
                    <View style={styles.footer}>
                      <View style={styles.footerLeft}>
                        {item.inProgressMatchStartedAt ? (
                          <LiveMatchDuration startedAt={item.inProgressMatchStartedAt} />
                        ) : null}
                      </View>
                      <View style={styles.footerCenter}>
                        <Text style={styles.liveCentered}>
                          Venganza N°{item.revengeOrder} · ● EN VIVO
                        </Text>
                      </View>
                      <View style={styles.footerRight} />
                    </View>
                  </TouchableOpacity>
                  );
                })}
              </>
            ) : null
          }
          ListFooterComponent={
            swissRevengeStandalone.length > 0 || hasOtherSwissRevenge ? (
              <View style={styles.swissRevengeStandaloneWrap}>
                {swissRevengeStandalone.map((row) => {
                  const swapSides = !!myUserId && row.bUserId === myUserId;
                  const leftUserId = swapSides ? row.bUserId : row.aUserId;
                  const rightUserId = swapSides ? row.aUserId : row.bUserId;
                  const leftPid = swapSides ? row.participantBId : row.participantAId;
                  const rightPid = swapSides ? row.participantAId : row.participantBId;
                  const leftName = swapSides ? row.bName : row.aName;
                  const rightName = swapSides ? row.aName : row.bName;
                  return (
                    <TouchableOpacity
                      key={row.pairingId}
                      style={styles.card}
                      activeOpacity={0.7}
                      onPress={() =>
                        navigation.navigate('PairingDetail', { pairingId: row.pairingId, fromTab: 'revenge' })
                      }
                    >
                      <View style={styles.compactRow}>
                        <View style={styles.inlinePlayer}>
                          <PlayerAvatar
                            userId={leftUserId}
                            participantId={leftPid}
                            size="small"
                            withColorBorder
                            borderWidth={3}
                          />
                          <Text style={styles.name}>{leftName}</Text>
                        </View>
                        <View style={styles.scoreWrap}>
                          <Text style={styles.scoreNumIdle}>vs</Text>
                        </View>
                        <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                          <Text style={styles.nameRight}>{rightName}</Text>
                          <PlayerAvatar
                            userId={rightUserId}
                            participantId={rightPid}
                            size="small"
                            withColorBorder
                            borderWidth={3}
                          />
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
                {hasOtherSwissRevenge ? (
                  <>
                    <Text style={[styles.groupHeader, styles.otherRevengeSectionTitle]}>
                      Otras venganzas en el evento
                    </Text>
                    {otherLiveRevengeItems.map((item) => (
                      <TouchableOpacity
                        key={item.matchId}
                        style={styles.card}
                        onPress={() =>
                          navigation.navigate('PairingDetail', {
                            pairingId: item.pairingId,
                            fromTab: 'revenge',
                          })
                        }
                      >
                        <View style={styles.compactRow}>
                          <View style={styles.inlinePlayer}>
                            <PlayerAvatar
                              userId={item.aUserId}
                              participantId={item.participantAId}
                              size="small"
                              withColorBorder
                              borderWidth={3}
                            />
                            <Text style={styles.name}>{item.aName}</Text>
                          </View>
                          <View style={styles.scoreWrap}>
                            <Text style={styles.scoreNum}>
                              {item.liveScoreA ?? 20} <Text style={styles.vs}>vs</Text> {item.liveScoreB ?? 20}
                            </Text>
                          </View>
                          <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                            <Text style={styles.nameRight}>{item.bName}</Text>
                            <PlayerAvatar
                              userId={item.bUserId}
                              participantId={item.participantBId}
                              size="small"
                              withColorBorder
                              borderWidth={3}
                            />
                          </View>
                        </View>
                        <View style={styles.footer}>
                          <View style={styles.footerLeft}>
                            {item.inProgressMatchStartedAt ? (
                              <LiveMatchDuration startedAt={item.inProgressMatchStartedAt} />
                            ) : null}
                          </View>
                          <View style={styles.footerCenter}>
                            <Text style={styles.liveCentered}>
                              Venganza N°{item.revengeOrder} · ● EN VIVO
                            </Text>
                          </View>
                          <View style={styles.footerRight} />
                        </View>
                      </TouchableOpacity>
                    ))}
                    {otherRevengeGroups.map((group) => (
                      <View key={group.pairingId} style={styles.groupWrap}>
                        <Text style={styles.groupHeader}>
                          {shortName(group.aName)} {group.winsA} - {group.winsB} {shortName(group.bName)}
                        </Text>
                        {group.items.map((item) => (
                          <TouchableOpacity
                            key={item.matchId}
                            style={styles.card}
                            onPress={() =>
                              navigation.navigate('PairingDetail', {
                                pairingId: item.pairingId,
                                fromTab: 'revenge',
                              })
                            }
                          >
                            <View style={styles.compactRow}>
                              <View style={styles.inlinePlayer}>
                                <PlayerAvatar
                                  userId={item.aUserId}
                                  participantId={item.participantAId}
                                  size="small"
                                  withColorBorder
                                  borderWidth={3}
                                />
                                <Text style={styles.name}>{item.aName}</Text>
                              </View>
                              <View style={styles.scoreWrap}>
                                <Text style={styles.scoreNumIdle}>vs</Text>
                              </View>
                              <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                                <Text style={styles.nameRight}>{item.bName}</Text>
                                <PlayerAvatar
                                  userId={item.bUserId}
                                  participantId={item.participantBId}
                                  size="small"
                                  withColorBorder
                                  borderWidth={3}
                                />
                              </View>
                            </View>
                            <View style={styles.footer}>
                              {item.winnerName ? (
                                <Text style={styles.winnerTxt}>
                                  Venganza N°{item.revengeOrder} - Ganó {item.winnerName}
                                </Text>
                              ) : (
                                <Text style={styles.status}>
                                  Venganza N°{item.revengeOrder} · Completada
                                </Text>
                              )}
                            </View>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ))}
                  </>
                ) : null}
              </View>
            ) : null
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item: group }) => (
            <View style={styles.groupWrap}>
              {(() => {
                const currentUserIsB = !!myUserId && group.bUserId === myUserId;
                const leftName = currentUserIsB ? group.bName : group.aName;
                const leftWins = currentUserIsB ? group.winsB : group.winsA;
                const rightName = currentUserIsB ? group.aName : group.bName;
                const rightWins = currentUserIsB ? group.winsA : group.winsB;
                return (
                  <Text style={styles.groupHeader}>
                    {shortName(leftName)} {leftWins} - {rightWins} {shortName(rightName)}
                  </Text>
                );
              })()}
              {group.items.map((item) => {
                const swapSides = !!myUserId && item.bUserId === myUserId;
                const leftUserId = swapSides ? item.bUserId : item.aUserId;
                const rightUserId = swapSides ? item.aUserId : item.bUserId;
                const leftPid = swapSides ? item.participantBId : item.participantAId;
                const rightPid = swapSides ? item.participantAId : item.participantBId;
                const leftName = swapSides ? item.bName : item.aName;
                const rightName = swapSides ? item.aName : item.bName;
                return (
                <TouchableOpacity
                  key={item.matchId}
                  style={styles.card}
                  onPress={() =>
                    navigation.navigate('PairingDetail', { pairingId: item.pairingId, fromTab: 'revenge' })
                  }
                >
                  <View style={styles.compactRow}>
                    <View style={styles.inlinePlayer}>
                      <PlayerAvatar
                        userId={leftUserId}
                        participantId={leftPid}
                        size="small"
                        withColorBorder
                        borderWidth={3}
                      />
                      <Text style={styles.name}>{leftName}</Text>
                    </View>
                    <View style={styles.scoreWrap}>
                      <Text style={styles.scoreNumIdle}>vs</Text>
                    </View>
                    <View style={[styles.inlinePlayer, styles.inlinePlayerRight]}>
                      <Text style={styles.nameRight}>{rightName}</Text>
                      <PlayerAvatar
                        userId={rightUserId}
                        participantId={rightPid}
                        size="small"
                        withColorBorder
                        borderWidth={3}
                      />
                    </View>
                  </View>
                  <View style={styles.footer}>
                    {item.winnerName ? (
                      <Text style={styles.winnerTxt}>Venganza N°{item.revengeOrder} - Ganó {item.winnerName}</Text>
                    ) : (
                      <Text style={styles.status}>Venganza N°{item.revengeOrder} · Completada</Text>
                    )}
                  </View>
                </TouchableOpacity>
                );
              })}
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  tabBtn: { marginRight: 22, paddingBottom: 8 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: '#6B7280' },
  tabLabelActive: { color: '#111827', fontWeight: '800' },
  tabUnderline: { height: 2, backgroundColor: '#3B82F6', borderRadius: 1, marginTop: 6 },
  tabUnderlineHidden: { backgroundColor: 'transparent' },
  listWrap: { padding: 16, paddingBottom: 30 },
  groupWrap: { marginBottom: 12 },
  groupHeader: { fontSize: 16, fontWeight: '800', color: '#111827', marginBottom: 8, marginTop: 2 },
  tiebreakOfficialHeaderWrap: { marginBottom: 4 },
  officialListSectionTitle: { marginTop: 18 },
  swissRoundHeader: { marginBottom: 6 },
  tiebreakRoundSubheader: { marginTop: 12, marginBottom: 2 },
  bracketPhaseSubheader: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
    marginTop: 8,
    marginBottom: 4,
  },
  bracketPlaceholderAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bracketPlaceholderQuestion: {
    color: '#6B7280',
    fontSize: 18,
    fontWeight: '700',
  },
  tiebreakDimmed: { opacity: 0.4 },
  tiebreakCard: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FDE68A',
  },
  tiebreakCardPlayed: { opacity: 0.7 },
  tiebreakGanoLine: {
    alignSelf: 'stretch',
    color: '#166534',
    fontWeight: '600',
    fontSize: 12,
    textAlign: 'left',
  },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { color: '#666', fontSize: 15 },
  byeFooterWrap: { paddingTop: 4, paddingBottom: 8 },
  byeCard: { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' },
  byeLabel: { fontSize: 12, fontWeight: '800', color: '#166534', marginBottom: 6 },
  byeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  byeName: { fontSize: 14, fontWeight: '700', color: '#111827' },
  swissRevengeStandaloneWrap: { paddingTop: 8, paddingBottom: 16 },
  otherRevengeSectionTitle: { marginTop: 16 },
  card: {
    backgroundColor: '#fafafa',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  compactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  inlinePlayer: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  inlinePlayerRight: { justifyContent: 'flex-end' },
  giantAvatarPairCard: { flexDirection: 'row', alignItems: 'center' },
  playerRightText: { alignItems: 'flex-end' },
  winnerAvatarWrap: { marginRight: 6 },
  name: { fontSize: 12, color: '#111', fontWeight: '700' },
  nameRight: { fontSize: 12, color: '#111', fontWeight: '700', textAlign: 'right' },
  scoreWrap: { minWidth: 74, alignItems: 'center' },
  scoreNum: { color: '#111827', fontWeight: '800', fontSize: 16 },
  scoreNumIdle: { color: '#6B7280', fontWeight: '700', fontSize: 14 },
  vs: { color: '#6B7280', fontWeight: '700', fontSize: 13 },
  bo3Row: { flexDirection: 'row', marginTop: 4 },
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
  footer: {
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e8e8e8',
    paddingTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  footerLeft: { flex: 1, alignItems: 'flex-start' },
  footerCenter: { flex: 1, alignItems: 'center' },
  footerRight: { flex: 1 },
  status: { color: '#3B82F6', fontWeight: '700', fontSize: 12 },
  liveCentered: { color: '#3B82F6', fontWeight: '800', fontSize: 12, textAlign: 'center' },
  winnerWrap: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  winnerTxt: { color: '#166534', fontWeight: '600', fontSize: 12 },
  liveDuration: { fontSize: 11, color: '#6B7280', marginTop: 2 },
});
