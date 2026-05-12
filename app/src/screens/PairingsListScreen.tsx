import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { getPairingStatusLabel } from '../lib/labels';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';

type Props = NativeStackScreenProps<MainStackParamList, 'PairingsList'>;

type PairingRow = {
  id: string;
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

type ItemView = PairingRow & {
  status: 'in_progress' | 'scheduled' | 'completed';
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  winnerName: string | null;
  winnerUserId: string | null;
  mine: boolean;
  liveScoreA: number | null;
  liveScoreB: number | null;
  winsA: number;
  winsB: number;
  inProgressMatchStartedAt: string | null;
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

type TiebreakOfficialItem = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
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
};

type TiebreakOfficialRoundBlock = {
  round: number;
  items: TiebreakOfficialItem[];
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
};

type RevengeGroupView = {
  pairingId: string;
  aName: string;
  bName: string;
  aUserId: string;
  bUserId: string;
  winsA: number;
  winsB: number;
  items: RevengeItemView[];
};

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
  const [revengeItems, setRevengeItems] = useState<RevengeItemView[]>([]);
  const [tiebreakOfficialSection, setTiebreakOfficialSection] = useState<{
    groupRoundNumber: number;
    rounds: TiebreakOfficialRoundBlock[];
  } | null>(null);
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
      supabase.from('draft_events').select('status').eq('id', eventId).maybeSingle(),
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id')
        .eq('event_id', eventId),
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
        .eq('event_id', eventId)
        .eq('role', 'player'),
    ]);

    if (pairingsRes.error || participantsRes.error) {
      Alert.alert('Error', 'No se pudieron cargar los enfrentamientos.');
      setItems([]);
      setRevengeItems([]);
      setTiebreakOfficialSection(null);
      return false;
    }

    const eventStatus = eventRes.data?.status as string | undefined;
    const pairings = (pairingsRes.data ?? []) as PairingRow[];
    const participants = (participantsRes.data ?? []) as ParticipantRow[];
    const pMap = new Map<string, ParticipantRow>(participants.map((p) => [p.id, p]));

    const pairingIds = pairings.map((p) => p.id);
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
      setRevengeItems([]);
      setTiebreakOfficialSection(null);
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

    const mapped: ItemView[] = pairings.map((pairing) => {
      const pa = pMap.get(pairing.participant_a_id);
      const pb = pMap.get(pairing.participant_b_id);
      const ua = relationOne(pa?.users);
      const ub = relationOne(pb?.users);
      const aName = ua?.display_name || ua?.username || 'Jugador A';
      const bName = ub?.display_name || ub?.username || 'Jugador B';
      const aUserId = pa?.user_id ?? '';
      const bUserId = pb?.user_id ?? '';
      const inProg = (inProgressByPairing.get(pairing.id) ?? 0) > 0;
      const completed = !!pairing.official_winner_participant_id;
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
        winnerUser?.display_name || winnerUser?.username || null;
      const winnerUserId = winnerParticipant?.user_id ?? null;

      const mine =
        !!currentUserId &&
        (pa?.user_id === currentUserId || pb?.user_id === currentUserId);
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
        winnerName,
        winnerUserId,
        mine,
        liveScoreA,
        liveScoreB,
        winsA,
        winsB,
        inProgressMatchStartedAt,
      };
    });

    const rankStatus = (s: ItemView['status']) =>
      s === 'in_progress' ? 0 : s === 'scheduled' ? 1 : 2;

    mapped.sort((x, y) => {
      const s = rankStatus(x.status) - rankStatus(y.status);
      if (s !== 0) return s;
      if (x.mine !== y.mine) return x.mine ? -1 : 1;
      const n = `${x.aName} ${x.bName}`.localeCompare(`${y.aName} ${y.bName}`, 'es', {
        sensitivity: 'base',
      });
      return n;
    });

    const pairingById = new Map(pairings.map((p) => [p.id, p]));
    const revengeMapped: RevengeItemView[] = [];
    for (const m of safeMatches) {
      if (m.match_type !== 'revenge') continue;
      if (m.status === 'aborted') continue;
      const pairing = pairingById.get(m.pairing_id);
      if (!pairing) continue;
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

    setItems(mapped);
    setRevengeItems(revengeMapped);

    let tiebreakSection: { groupRoundNumber: number; rounds: TiebreakOfficialRoundBlock[] } | null = null;
    const agRes = await supabase
      .from('event_tiebreak_groups')
      .select('id, group_type, round_number, champion_user_id, status, created_at')
      .eq('event_id', eventId)
      .in('status', ['active', 'resolved', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!agRes.error && agRes.data) {
      const ag = agRes.data as { id: string; round_number: number; champion_user_id: string | null };
      const gpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id')
        .eq('group_id', ag.id);
      if (!gpRes.error && gpRes.data) {
        const gIds = new Set((gpRes.data as { participant_id: string }[]).map((x) => x.participant_id));
        if (gIds.size >= 2) {
          const groupRoundNumber = ag.round_number ?? 1;
          const buildTiebreakItemsForRound = (roundNum: number): TiebreakOfficialItem[] => {
            const tbItems: TiebreakOfficialItem[] = [];
            for (const pairing of pairings) {
              if (!gIds.has(pairing.participant_a_id) || !gIds.has(pairing.participant_b_id)) continue;
              const pa = pMap.get(pairing.participant_a_id);
              const pb = pMap.get(pairing.participant_b_id);
              const ua = relationOne(pa?.users);
              const ub = relationOne(pb?.users);
              const aName = ua?.display_name || ua?.username || 'Jugador A';
              const bName = ub?.display_name || ub?.username || 'Jugador B';
              const aUserId = pa?.user_id ?? '';
              const bUserId = pb?.user_id ?? '';
              const tbWonA = safeMatches.some(
                (m) =>
                  m.pairing_id === pairing.id &&
                  m.match_type === 'tiebreak' &&
                  m.status === 'completed' &&
                  m.winner_participant_id === pairing.participant_a_id &&
                  (m.tiebreak_round ?? 1) === roundNum
              );
              const tbWonB = safeMatches.some(
                (m) =>
                  m.pairing_id === pairing.id &&
                  m.match_type === 'tiebreak' &&
                  m.status === 'completed' &&
                  m.winner_participant_id === pairing.participant_b_id &&
                  (m.tiebreak_round ?? 1) === roundNum
              );
              const tbInProg = safeMatches.find(
                (m) =>
                  m.pairing_id === pairing.id &&
                  m.match_type === 'tiebreak' &&
                  m.status === 'in_progress' &&
                  (m.tiebreak_round ?? 1) === roundNum
              );
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
              tbItems.push({
                id: pairing.id,
                participant_a_id: pairing.participant_a_id,
                participant_b_id: pairing.participant_b_id,
                official_winner_participant_id: pairing.official_winner_participant_id,
                aName,
                bName,
                aUserId,
                bUserId,
                dimLoserSide,
                tiebreakWinnerParticipantId,
                tiebreakWinnerUserId,
                tiebreakWinnerName,
                status: st,
                liveScoreA,
                liveScoreB,
                inProgressMatchStartedAt: tbInProg?.started_at ?? null,
                mine,
              });
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
          tiebreakSection = { groupRoundNumber, rounds };
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
    .sort((x, y) => {
      if (x.mine && !y.mine) return -1;
      if (!x.mine && y.mine) return 1;
      return 0;
    });
  const revengeGroups: RevengeGroupView[] = [];
  const groupByPairing = new Map<string, RevengeGroupView>();
  for (const item of revengeItems) {
    if (item.status !== 'completed') continue;
    const existing = groupByPairing.get(item.pairingId);
    if (existing) {
      existing.items.push(item);
      if (item.winnerName === item.aName) existing.winsA += 1;
      if (item.winnerName === item.bName) existing.winsB += 1;
      continue;
    }
    const next: RevengeGroupView = {
      pairingId: item.pairingId,
      aName: item.aName,
      bName: item.bName,
      aUserId: item.aUserId,
      bUserId: item.bUserId,
      winsA: item.winnerName === item.aName ? 1 : 0,
      winsB: item.winnerName === item.bName ? 1 : 0,
      items: [item],
    };
    groupByPairing.set(item.pairingId, next);
    revengeGroups.push(next);
  }
  revengeGroups.sort((x, y) => {
    const xMine = !!myUserId && (x.aUserId === myUserId || x.bUserId === myUserId);
    const yMine = !!myUserId && (y.aUserId === myUserId || y.bUserId === myUserId);
    if (xMine && !yMine) return -1;
    if (!xMine && yMine) return 1;
    return 0;
  });

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  const tiebreakCardsTotal =
    tiebreakOfficialSection?.rounds.reduce((sum, b) => sum + b.items.length, 0) ?? 0;

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
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          contentContainerStyle={
            items.length === 0 && tiebreakCardsTotal === 0 ? styles.emptyWrap : styles.listWrap
          }
          ListEmptyComponent={
            items.length === 0 && tiebreakCardsTotal === 0 ? (
              <Text style={styles.empty}>Todavía no hay enfrentamientos.</Text>
            ) : null
          }
          ListHeaderComponent={
            tiebreakOfficialSection && tiebreakCardsTotal > 0 ? (
              <View style={styles.tiebreakOfficialHeaderWrap}>
                <Text style={styles.groupHeader}>Desempate</Text>
                {tiebreakOfficialSection.rounds.map((block) => (
                  <React.Fragment key={`tb-round-${block.round}`}>
                    {tiebreakOfficialSection.groupRoundNumber >= 2 ? (
                      <Text
                        style={[styles.groupHeader, styles.officialListSectionTitle, styles.tiebreakRoundSubheader]}
                      >
                        Ronda {block.round}
                      </Text>
                    ) : null}
                    {block.items.map((it) => {
                      const playedRound = it.dimLoserSide != null;
                      const cardStyles = [styles.card, styles.tiebreakCard];
                      const swapSides = !!myUserId && it.bUserId === myUserId;
                      const leftPid = swapSides ? it.participant_b_id : it.participant_a_id;
                      const rightPid = swapSides ? it.participant_a_id : it.participant_b_id;
                      const leftUserId = swapSides ? it.bUserId : it.aUserId;
                      const rightUserId = swapSides ? it.aUserId : it.bUserId;
                      const leftName = swapSides ? it.bName : it.aName;
                      const rightName = swapSides ? it.aName : it.bName;
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
                            <View
                              style={[styles.inlinePlayer, dimLeft ? styles.tiebreakDimmed : null]}
                            >
                              <PlayerAvatar
                                userId={leftUserId}
                                participantId={leftPid}
                                size="small"
                                withColorBorder
                                borderWidth={3}
                              />
                              <View>
                                <Text style={styles.name}>{leftName}</Text>
                              </View>
                            </View>
                            <View style={styles.scoreWrap}>
                              {it.status === 'in_progress' ? (
                                <Text style={styles.scoreNum}>
                                  {liveL ?? 20} <Text style={styles.vs}>vs</Text> {liveR ?? 20}
                                </Text>
                              ) : (
                                <Text style={styles.scoreNumIdle}>vs</Text>
                              )}
                            </View>
                            <View
                              style={[
                                styles.inlinePlayer,
                                styles.inlinePlayerRight,
                                dimRight ? styles.tiebreakDimmed : null,
                              ]}
                            >
                              <View style={styles.playerRightText}>
                                <Text style={styles.nameRight}>{rightName}</Text>
                              </View>
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
                              {it.inProgressMatchStartedAt ? (
                                <LiveMatchDuration startedAt={it.inProgressMatchStartedAt} />
                              ) : it.tiebreakWinnerName ? (
                                <Text style={styles.tiebreakGanoLine}>Gano: {it.tiebreakWinnerName}</Text>
                              ) : null}
                            </View>
                            <View style={styles.footerCenter}>
                              {it.status === 'in_progress' ? (
                                <Text style={styles.liveCentered}>● EN VIVO</Text>
                              ) : (
                                <Text style={styles.status}>{getPairingStatusLabel(it.status)}</Text>
                              )}
                            </View>
                            <View style={styles.footerRight} />
                          </View>
                        </>
                      );
                      const rowKey = `${it.id}-r${block.round}`;
                      return playedRound ? (
                        <View key={rowKey} style={cardStyles}>
                          {inner}
                        </View>
                      ) : (
                        <TouchableOpacity
                          key={rowKey}
                          style={cardStyles}
                          activeOpacity={0.7}
                          onPress={() =>
                            navigation.navigate('PairingDetail', { pairingId: it.id, fromTab: 'official' })
                          }
                        >
                          {inner}
                        </TouchableOpacity>
                      );
                    })}
                  </React.Fragment>
                ))}
                <Text style={[styles.groupHeader, styles.officialListSectionTitle]}>Enfrentamientos</Text>
              </View>
            ) : null
          }
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={({ item }) => {
            const swapSides = !!myUserId && item.bUserId === myUserId;
            const leftUserId = swapSides ? item.bUserId : item.aUserId;
            const rightUserId = swapSides ? item.aUserId : item.bUserId;
            const leftPid = swapSides ? item.participant_b_id : item.participant_a_id;
            const rightPid = swapSides ? item.participant_a_id : item.participant_b_id;
            const leftName = swapSides ? item.bName : item.aName;
            const rightName = swapSides ? item.aName : item.bName;
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
                  <PlayerAvatar
                    userId={leftUserId}
                    participantId={leftPid}
                    size="small"
                    withColorBorder
                    borderWidth={3}
                  />
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
          }}
        />
      ) : (
        <FlatList
          data={revengeGroups}
          keyExtractor={(it) => it.pairingId}
          contentContainerStyle={
            revengeGroups.length === 0 && liveRevengeItems.length === 0 ? styles.emptyWrap : styles.listWrap
          }
          ListEmptyComponent={
            liveRevengeItems.length === 0 ? <Text style={styles.empty}>Todavía no hay venganzas.</Text> : null
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
  tiebreakRoundSubheader: { marginTop: 12, marginBottom: 2 },
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
