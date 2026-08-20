import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Image,
  Alert,
  RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import type { MainStackParamList } from '../navigation/mainStackParams';
import { hierarchicalHeaderBack } from '../navigation/hierarchicalBack';
import { avatarPublicUrl } from '../lib/avatarUrl';
import PlayerAvatar from '../components/PlayerAvatar';
import type { MtgColor } from '../lib/database.types';
import { MTG_COLOR_HEX } from '../components/ColorFlag';
import ProDeCManaC from '../components/ProDeCManaC';
import { getEventStatusLabel, getEventTypeLabel } from '../lib/labels';
import { resolveGenderedText, type Gender } from '../lib/genderText';
import {
  getTwoWayTieFirstPlaceParticipantIds,
  pairingIsBetweenParticipants,
  type PairingSummary,
} from '../lib/tiebreakLeaders';
import { computePickTimeline, DEFAULT_TIMER_PARAMS } from '../lib/draftTimer';
import { hasTimerSession, clearTimerSession } from '../lib/draftTimerStore';

type Props = NativeStackScreenProps<MainStackParamList, 'EventDetail'>;

type EventRow = {
  id: string;
  workspace_id: string;
  name: string;
  avatar_path: string | null;
  status: 'scheduled' | 'drafting' | 'playing' | 'completed' | 'cancelled';
  event_type: 'draft' | 'tournament' | 'pepidraft' | 'two_headed_giant';
  competition_format?: 'round_robin' | 'swiss' | 'swiss_bo2' | null;
  giant_randomization_done?: boolean | null;
  scheduled_for: string;
  cube_id: string | null;
  venue_id: string | null;
  notes: string | null;
  draft_started_at: string | null;
  draft_ended_at: string | null;
  champion_user_id: string | null;
  champion_decided_by: string | null;
  polemica_winners: string[] | null;
  recognition_winners: string[] | null;
  event_ended_at: string | null;
  final_pending: boolean | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  deleted_at: string | null;
  is_timed_draft?: boolean | null;
  timer_packs?: number[] | null;
  timer_alpha?: number | null;
  timer_beta?: number | null;
  timer_gamma?: number | null;
  timer_delta?: number | null;
  timer_rho?: number | null;
  timer_tmin?: number | null;
  timer_tmax?: number | null;
  timer_color?: string | null;
};

type ParticipantView = {
  id: string;
  user_id: string;
  left_event_at: string | null;
  member_b_user_id?: string | null;
  giant_name?: string | null;
  users:
    | {
        username: string;
        display_name: string;
        gender?: Gender | null;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }
    | {
        username: string;
        display_name: string;
        gender?: Gender | null;
        custom_avatar_path: string | null;
        default_avatars: { storage_path: string } | { storage_path: string }[] | null;
      }[]
    | null;
};

type PairingInsert = {
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  data_source: 'app';
};

type TiebreakGroupParticipantRow = {
  participant_id: string;
  user_id: string;
  seed: number;
  users:
    | { display_name: string | null }
    | { display_name: string | null }[]
    | null;
};

type ActiveTiebreakGroupState = {
  id: string;
  group_type: string;
  round_number: number;
  champion_user_id: string | null;
  /** 'swiss_topcut' = bracket post-suizo; 'tiebreak' = desempate clásico. */
  group_origin?: string | null;
  participants: TiebreakGroupParticipantRow[];
};

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

function formatDraftNetDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  if (m > 0) return s > 0 ? `${m} min ${s}s` : `${m} min`;
  return `${s}s`;
}

/** Lista legible en español: "A, B y C". */
function formatNamesList(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length === 0) return '';
  if (n.length === 1) return n[0]!;
  if (n.length === 2) return `${n[0]} y ${n[1]}`;
  return `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}


function isBuenosAiresSameCalendarDay(scheduledFor: string, when: Date = new Date()): boolean {
  const dayA = new Date(scheduledFor).toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const dayB = when.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  return dayA === dayB;
}

export default function EventDetailScreen({ route, navigation }: Props) {
  const isFocused = useIsFocused();
  const [participantColors, setParticipantColors] = useState<Record<string, MtgColor[]>>({});
  const { eventId } = route.params;
  const [event, setEvent] = useState<EventRow | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [isWorkspaceMember, setIsWorkspaceMember] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myParticipantId, setMyParticipantId] = useState<string | null>(null);
  const [myMemberDeclared, setMyMemberDeclared] = useState(false);
  const [prodeCVoteCount, setProdeCVoteCount] = useState<number | null>(null);
  const [prodeCCompact, setProdeCCompact] = useState(false);
  const [cubeName, setCubeName] = useState<string | null>(null);
  const [venueName, setVenueName] = useState<string | null>(null);
  const [championName, setChampionName] = useState<string | null>(null);
  const [championGender, setChampionGender] = useState<Gender | null>(null);
  const [tiebreakBanner, setTiebreakBanner] = useState<{
    pairingId: string;
    nameA: string;
    nameB: string;
  } | null>(null);
  const [activeTiebreakGroup, setActiveTiebreakGroup] = useState<ActiveTiebreakGroupState | null>(null);
  const [tiebreakVsNav, setTiebreakVsNav] = useState<{ pairingId: string; opponentName: string }[]>([]);
  const [currentUserInBracketWaiting, setCurrentUserInBracketWaiting] = useState(false);
  const firstRef = useRef(true);
  const [, setDraftDurationTick] = useState(0);

  const load = useCallback(async () => {
    setProdeCVoteCount(null);
    const { data, error } = await supabase
      .from('draft_events')
      .select(
        'id, workspace_id, name, avatar_path, status, event_type, competition_format, scheduled_for, cube_id, venue_id, notes, draft_started_at, draft_ended_at, champion_user_id, champion_decided_by, polemica_winners, recognition_winners, event_ended_at, final_pending, cancelled_at, cancelled_by, deleted_at, giant_randomization_done, is_timed_draft, timer_packs, timer_alpha, timer_beta, timer_gamma, timer_delta, timer_rho, timer_tmin, timer_tmax, timer_color'
      )
      .eq('id', eventId)
      .maybeSingle();

    if (error || !data) {
      console.error('EVENT LOAD ERROR:', JSON.stringify(error));
      Alert.alert('Error', 'No se pudo cargar el evento.');
      setEvent(null);
      setActiveTiebreakGroup(null);
      setTiebreakVsNav([]);
      setCurrentUserInBracketWaiting(false);
      return;
    }
    const e = data as EventRow;
    setEvent(e);
    setTiebreakBanner(null);
    setActiveTiebreakGroup(null);
    setTiebreakVsNav([]);
    setCurrentUserInBracketWaiting(false);
    setChampionName(null);
    setChampionGender(null);

    if (e.champion_user_id) {
      const championRes = await supabase
        .from('users')
        .select('display_name, gender')
        .eq('id', e.champion_user_id)
        .maybeSingle();
      if (!championRes.error) {
        const championUser = championRes.data as { display_name?: string | null; gender?: Gender | null } | null;
        setChampionName(championUser?.display_name ?? null);
        setChampionGender(championUser?.gender ?? null);
      }
    }

    const meRes = await supabase.auth.getUser();
    const currentUserId = meRes.data.user?.id ?? null;
    setMyUserId(currentUserId);

    const [roleRes, partsRes, cubeRes, venueRes] = await Promise.all([
      currentUserId
        ? supabase
            .from('workspace_members')
            .select('role')
            .eq('workspace_id', e.workspace_id)
            .eq('user_id', currentUserId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          left_event_at,
          member_b_user_id,
          giant_name,
          users!event_participants_user_id_fkey (
            username,
            display_name,
            gender,
            custom_avatar_path,
            default_avatars (storage_path)
          )
        `
        )
        .eq('event_id', e.id)
        .eq('role', 'player'),
      e.cube_id ? supabase.from('cubes').select('name').eq('id', e.cube_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      e.venue_id ? supabase.from('venues').select('name').eq('id', e.venue_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);

    if (roleRes.error) {
      if (__DEV__) {
        console.error('Error cargando rol del workspace:', roleRes.error);
      }
    }
    const role = roleRes.data?.role as 'organizer' | 'member' | undefined;
    setIsOrganizer(role === 'organizer');
    setIsWorkspaceMember(role === 'organizer' || role === 'member');
    if (partsRes.error) {
      if (__DEV__) {
        console.error('Error cargando participantes del evento:', partsRes.error);
      }
      setActiveTiebreakGroup(null);
      Alert.alert(
        'Error',
        partsRes.error.message ?? 'No se pudieron cargar los participantes.'
      );
      return;
    }

    const p = (partsRes.data ?? []) as ParticipantView[];
    // Deduplicate by id — the nested default_avatars join can return duplicate rows when
    // a user has multiple default_avatars entries.
    const seen = new Set<string>();
    setParticipants(p.filter((ep) => (seen.has(ep.id) ? false : (seen.add(ep.id), true))));

    let multiTiebreakGroup: ActiveTiebreakGroupState | null = null;
    const activeGroupRes = await supabase
      .from('event_tiebreak_groups')
      .select('id, group_type, round_number, champion_user_id, group_origin')
      .eq('event_id', e.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!activeGroupRes.error && activeGroupRes.data) {
      const ag = activeGroupRes.data as {
        id: string;
        group_type: string;
        round_number: number;
        champion_user_id: string | null;
        group_origin?: string | null;
      };
      const gpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id, user_id, seed, users:user_id (display_name)')
        .eq('group_id', ag.id);
      if (!gpRes.error && gpRes.data) {
        multiTiebreakGroup = {
          ...ag,
          participants: gpRes.data as TiebreakGroupParticipantRow[],
        };
      }
    }
    setActiveTiebreakGroup(multiTiebreakGroup);

    const groupHasChampionOnRow =
      multiTiebreakGroup?.champion_user_id != null &&
      String(multiTiebreakGroup.champion_user_id).trim() !== '';
    const vsNav: { pairingId: string; opponentName: string }[] = [];
    let inBracketWaiting = false;
    if (multiTiebreakGroup && !groupHasChampionOnRow && currentUserId) {
      const meGp = multiTiebreakGroup.participants.find((x) => x.user_id === currentUserId);
      if (meGp) {
        if (multiTiebreakGroup.group_type === 'bracket') {
          const bmRes = await supabase
            .from('event_tiebreak_bracket_matches')
            .select('id, bracket_phase, pairing_id, participant_a_id, participant_b_id, winner_participant_id')
            .eq('group_id', multiTiebreakGroup.id);
          if (!bmRes.error && bmRes.data) {
            const rows = bmRes.data as {
              id: string;
              bracket_phase: string;
              pairing_id: string | null;
              participant_a_id: string;
              participant_b_id: string;
              winner_participant_id: string | null;
            }[];
            const mine = rows.find(
              (bm) =>
                bm.winner_participant_id == null &&
                (bm.participant_a_id === meGp.participant_id || bm.participant_b_id === meGp.participant_id)
            );
            if (mine) {
              const oppPid =
                mine.participant_a_id === meGp.participant_id ? mine.participant_b_id : mine.participant_a_id;
              const opp = multiTiebreakGroup.participants.find((p) => p.participant_id === oppPid);
              const oppName = relationOne(opp?.users)?.display_name?.trim() || 'Jugador';
              let pairingId = mine.pairing_id;
              if (!pairingId) {
                const prRes = await supabase
                  .from('pairings')
                  .select('id, participant_a_id, participant_b_id')
                  .eq('event_id', e.id);
                if (!prRes.error && prRes.data) {
                  const row = (prRes.data as { id: string; participant_a_id: string; participant_b_id: string }[]).find(
                    (r) =>
                      (r.participant_a_id === meGp.participant_id && r.participant_b_id === oppPid) ||
                      (r.participant_b_id === meGp.participant_id && r.participant_a_id === oppPid)
                  );
                  if (row) pairingId = row.id;
                }
              }
              if (pairingId) {
                vsNav.push({ pairingId, opponentName: oppName });
              }
            } else {
              inBracketWaiting = true;
            }
          }
        } else {
          const prRes = await supabase
            .from('pairings')
            .select('id, participant_a_id, participant_b_id')
            .eq('event_id', e.id);
          if (!prRes.error && prRes.data) {
            for (const opp of multiTiebreakGroup.participants) {
              if (opp.participant_id === meGp.participant_id) continue;
              const row = (prRes.data as { id: string; participant_a_id: string; participant_b_id: string }[]).find(
                (r) =>
                  (r.participant_a_id === meGp.participant_id && r.participant_b_id === opp.participant_id) ||
                  (r.participant_b_id === meGp.participant_id && r.participant_a_id === opp.participant_id)
              );
              if (row) {
                vsNav.push({
                  pairingId: row.id,
                  opponentName: relationOne(opp.users)?.display_name?.trim() || 'Jugador',
                });
              }
            }
          }
        }
      }
    }
    setTiebreakVsNav(vsNav);
    setCurrentUserInBracketWaiting(inBracketWaiting);

    if (
      !multiTiebreakGroup &&
      e.status === 'playing' &&
      e.final_pending === true &&
      !e.champion_user_id &&
      p.length >= 2
    ) {
      const prRes = await supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id')
        .eq('event_id', e.id);
      if (!prRes.error && prRes.data) {
        const playerIds = p.map((x) => x.id);
        const leaders = getTwoWayTieFirstPlaceParticipantIds(playerIds, prRes.data as PairingSummary[]);
        if (leaders) {
          const row = prRes.data.find((pr) =>
            pairingIsBetweenParticipants(pr as PairingSummary, leaders[0], leaders[1])
          );
          if (row?.id) {
            const pa = p.find((x) => x.id === leaders[0]);
            const pb = p.find((x) => x.id === leaders[1]);
            const ua = relationOne(pa?.users);
            const ub = relationOne(pb?.users);
            const na = ua?.display_name || ua?.username || 'Jugador';
            const nb = ub?.display_name || ub?.username || 'Jugador';
            setTiebreakBanner({ pairingId: row.id, nameA: na, nameB: nb });
          }
        }
      }
    }

    const mine = p.find((x) => x.user_id === currentUserId || x.member_b_user_id === currentUserId);
    setMyParticipantId(mine?.id ?? null);
    setCubeName((cubeRes.data as any)?.name ?? null);
    setVenueName((venueRes.data as any)?.name ?? null);

    if (p.length > 0) {
      const ids = p.map((x) => x.id);
      const cRes = await supabase.from('participant_colors').select('participant_id, color, member').in('participant_id', ids);
      if (!cRes.error) {
        const map: Record<string, MtgColor[]> = {};
        for (const row of cRes.data ?? []) {
          const pid = row.participant_id as string;
          if (!map[pid]) map[pid] = [];
          map[pid].push(row.color as MtgColor);
        }
        setParticipantColors(map);
        if (mine) {
          const isMemberBOfPair = mine.member_b_user_id != null && mine.member_b_user_id === currentUserId;
          const myRows = (cRes.data ?? []).filter((r: any) =>
            r.participant_id === mine.id &&
            (isMemberBOfPair ? r.member === 'b' : (r.member === 'a' || r.member == null))
          );
          setMyMemberDeclared(myRows.length > 0);
        } else {
          setMyMemberDeclared(false);
        }
      }
    } else {
      setParticipantColors({});
    }

    const predCountRes = await supabase
      .from('event_color_predictions')
      .select('user_id', { count: 'exact', head: true })
      .eq('event_id', e.id);
    if (predCountRes.error) {
      if (__DEV__) console.warn('[EventDetail] prodec count', predCountRes.error);
      setProdeCVoteCount(0);
    } else {
      setProdeCVoteCount(predCountRes.count ?? 0);
    }
  }, [eventId]);

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

  useFocusEffect(
    useCallback(() => {
      if (!myUserId || !eventId) return;
      void AsyncStorage.getItem(`prodec_detail_compact_${myUserId}_${eventId}`).then((v) =>
        setProdeCCompact(v === '1')
      );
    }, [myUserId, eventId])
  );

  useEffect(() => {
    if (!event?.draft_started_at || event.draft_ended_at || !isFocused) return;
    const id = setInterval(() => setDraftDurationTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [event?.draft_started_at, event?.draft_ended_at, isFocused]);

  useLayoutEffect(() => {
    const wsId = event?.workspace_id;
    navigation.setOptions({
      title: event?.name ?? 'Evento',
      headerLeft: wsId
        ? hierarchicalHeaderBack(navigation, 'EventsList', { workspaceId: wsId })
        : undefined,
    });
  }, [event?.name, event?.workspace_id, navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const patchEvent = async (patch: Partial<EventRow>) => {
    if (!event) return;
    const { error } = await supabase.from('draft_events').update(patch).eq('id', event.id);
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo actualizar el evento.');
      return;
    }
    await load();
  };

  const softDeleteEvent = async () => {
    if (!event) return;
    const { error } = await supabase.rpc('soft_delete_event', { p_event_id: event.id });
    if (error) {
      Alert.alert('Error', error.message ?? 'No se pudo eliminar el evento.');
      return;
    }
    navigation.navigate('EventsList', { workspaceId: event.workspace_id });
  };

  const finishDraftAndGeneratePairings = async () => {
    if (!event) return;

    const toPlaying = await supabase
      .from('draft_events')
      .update({ draft_ended_at: new Date().toISOString(), status: 'playing' })
      .eq('id', event.id);
    if (toPlaying.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error actualizando evento a playing', toPlaying.error);
      }
      Alert.alert('Error', toPlaying.error.message ?? 'No se pudo marcar fin del draft.');
      return;
    }

    const partsRes = await supabase
      .from('event_participants')
      .select(
        `
        id,
        users!event_participants_user_id_fkey (
          display_name,
          username
        )
      `
      )
      .eq('event_id', event.id)
      .eq('role', 'player');

    if (partsRes.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error cargando participantes', partsRes.error);
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', partsRes.error.message ?? 'No se pudieron generar los enfrentamientos.');
      await load();
      return;
    }

    const players = ((partsRes.data ?? []) as Array<{ id: string; users: any }>).map((p) => {
      const u = relationOne(p.users) as { display_name?: string; username?: string } | null;
      const name = (u?.display_name || u?.username || '').trim();
      return { id: p.id, sortName: name.toLocaleLowerCase('es-AR') };
    });

    if (players.length < 2) {
      if (__DEV__) {
        console.error('[finishDraft] Jugadores insuficientes para generar pairings', {
          eventId: event.id,
          playersLength: players.length,
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'Se necesitan al menos 2 jugadores para generar enfrentamientos.');
      await load();
      return;
    }

    players.sort((a, b) => a.sortName.localeCompare(b.sortName, 'es', { sensitivity: 'base' }));

    const competitionFormat = event.competition_format ?? 'round_robin';
    if (competitionFormat === 'swiss' || competitionFormat === 'swiss_bo2') {
      const isBo2 = competitionFormat === 'swiss_bo2';
      const roundRpc = isBo2 ? 'generate_swiss_bo2_round' : 'generate_swiss_round';
      const nPlayers = players.length;
      const swiss_rounds_total = Math.max(1, Math.ceil(Math.log2(Math.max(nPlayers, 2))));
      const updSwiss = await supabase.from('draft_events').update({ swiss_rounds_total }).eq('id', event.id);
      if (updSwiss.error) {
        if (__DEV__) {
          console.error('[finishDraft] Error guardando swiss_rounds_total', updSwiss.error);
        }
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', event.id);
        Alert.alert('Error', updSwiss.error.message ?? 'No se pudo configurar el formato suizo.');
        await load();
        return;
      }

      const allPairRes = await supabase.rpc('generate_all_pairings', { p_event_id: event.id });
      if (allPairRes.error) {
        if (__DEV__) {
          console.error('[finishDraft] Error generate_all_pairings', allPairRes.error);
        }
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', event.id);
        Alert.alert('Error', allPairRes.error.message ?? 'No se pudieron crear los enfrentamientos.');
        await load();
        return;
      }

      const rpcRes = await supabase.rpc(roundRpc, { p_event_id: event.id, p_round: 1 });
      if (rpcRes.error) {
        if (__DEV__) {
          console.error(`[finishDraft] Error ${roundRpc}`, rpcRes.error);
        }
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', event.id);
        Alert.alert('Error', rpcRes.error.message ?? 'No se pudo generar la ronda suiza.');
        await load();
        return;
      }

      Alert.alert('Listo', 'Se generó la ronda 1 (formato suizo).');
      await load();
      return;
    }

    const inserts: PairingInsert[] = [];
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const aId = players[i]?.id ?? '';
        const bId = players[j]?.id ?? '';
        if (!aId || !bId || aId === bId) continue;
        const participant_a_id = aId < bId ? aId : bId;
        const participant_b_id = aId < bId ? bId : aId;
        inserts.push({
          event_id: event.id,
          participant_a_id,
          participant_b_id,
          data_source: 'app',
        });
      }
    }

    if (inserts.length === 0) {
      if (__DEV__) {
        console.error('[finishDraft] inserts vacío con jugadores suficientes', {
          eventId: event.id,
          playersLength: players.length,
          playerIds: players.map((p) => p.id),
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'No se pudieron generar enfrentamientos. Probá de nuevo.');
      await load();
      return;
    }

    if (inserts.length > 0) {
      const insertRes = await supabase.from('pairings').upsert(inserts, {
        onConflict: 'event_id,participant_a_id,participant_b_id',
        ignoreDuplicates: true,
      });
      if (insertRes.error) {
        if (__DEV__) {
          console.error('[finishDraft] Error insertando/upsert pairings', insertRes.error);
        }
        await supabase
          .from('draft_events')
          .update({ status: 'drafting', draft_ended_at: null })
          .eq('id', event.id);
        Alert.alert('Error', insertRes.error.message ?? 'No se pudieron crear los enfrentamientos.');
        await load();
        return;
      }
    }

    const verifyRes = await supabase
      .from('pairings')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event.id);
    if (verifyRes.error) {
      if (__DEV__) {
        console.error('[finishDraft] Error verificando pairings insertados', verifyRes.error);
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', verifyRes.error.message ?? 'No se pudieron verificar los enfrentamientos generados.');
      await load();
      return;
    }
    const totalInDb = verifyRes.count ?? 0;
    if (totalInDb !== inserts.length) {
      if (__DEV__) {
        console.error('[finishDraft] Verificación inconsistente de pairings', {
          eventId: event.id,
          expected: inserts.length,
          actual: totalInDb,
        });
      }
      await supabase
        .from('draft_events')
        .update({ status: 'drafting', draft_ended_at: null })
        .eq('id', event.id);
      Alert.alert('Error', 'No se pudieron generar enfrentamientos. Probá de nuevo.');
      await load();
      return;
    }

    if (inserts.length > 0) {
      Alert.alert('Listo', `Se generaron ${inserts.length} enfrentamientos`);
    }
    await load();
  };

  const participantCount = participants.length;
  const hasDeclaredColors = myMemberDeclared;
  const missingCube = !event?.cube_id;
  const missingVenue = !event?.venue_id;
  const missingParticipants = participantCount < 1;
  const missingGiantRandomization =
    event?.event_type === 'two_headed_giant' && !event?.giant_randomization_done;
  const startDraftDisabled =
    missingCube || missingVenue || missingParticipants || missingGiantRandomization;
  const missingStartRequirements: string[] = [];
  if (missingCube) missingStartRequirements.push('seleccionar el cubo');
  if (missingVenue) missingStartRequirements.push('seleccionar la sede');
  if (missingParticipants) {
    missingStartRequirements.push('que se inscriba al menos un jugador');
  }
  if (missingGiantRandomization) {
    missingStartRequirements.push('sortear los equipos primero');
  }
  const startDraftDisabledHint = missingStartRequirements.length
    ? `Falta ${missingStartRequirements.join(', ')}`
    : '';

  const insertMyRegistration = async () => {
    if (!event || !myUserId) return;
    // rotated_avatar_id, is_shiny (1/4096) y has_shiny_participant los asigna assign_rotated_avatar (trigger).
    const { error } = await supabase.from('event_participants').insert({
      event_id: event.id,
      user_id: myUserId,
      role: 'player',
    });
    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      const isDup =
        error.code === '23505' ||
        msg.includes('duplicate') ||
        msg.includes('unique');
      if (isDup) {
        await load();
        return;
      }
      Alert.alert('Error', error.message ?? 'No se pudo completar la inscripción.');
      return;
    }
    await load();
  };

  const cancelMyRegistration = () => {
    if (!myParticipantId) return;
    Alert.alert('Cancelar inscripción', '¿Seguro que querés cancelar tu inscripción al evento?', [
      { text: 'Volver', style: 'cancel' },
      {
        text: 'Cancelar inscripción',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('event_participants').delete().eq('id', myParticipantId);
          if (error) {
            const msg = error.message?.toLowerCase() ?? '';
            const alreadyGone =
              msg.includes('no rows') ||
              msg.includes('not found') ||
              msg.includes('0 rows');
            if (alreadyGone) {
              await load();
              return;
            }
            Alert.alert('Error', error.message ?? 'No se pudo cancelar la inscripción.');
            return;
          }
          await load();
        },
      },
    ]);
  };

  const randomizeGiants = async () => {
    if (!event) return;
    const { error } = await supabase.rpc('randomize_giant_pairs', { p_event_id: event.id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('INVALID_COUNT')) {
        Alert.alert('No se puede sortear', 'Se necesitan al menos 4 jugadores y un número par de inscriptos.');
      } else {
        Alert.alert('Error', msg || 'No se pudo sortear los gigantes.');
      }
      return;
    }
    await load();
  };

  const reRandomizeGiants = () => {
    if (!event) return;
    Alert.alert(
      'Re-sortear equipos',
      '¿Querés re-sortear los equipos? Se van a deshacer los equipos actuales.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Re-sortear',
          onPress: () => void (async () => {
            const { error } = await supabase.rpc('re_randomize_giant_pairs', { p_event_id: event.id });
            if (error) {
              Alert.alert('Error', error.message ?? 'No se pudo re-sortear los gigantes.');
              return;
            }
            await load();
          })(),
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No se encontró el evento.</Text>
      </View>
    );
  }

  const eventAvatar = avatarPublicUrl(event.avatar_path);
  const playingOrDone = event.status === 'playing' || event.status === 'completed';
  const showEnfrentamientosBtn = playingOrDone && (myParticipantId != null || isWorkspaceMember);
  const showStandingsBtn =
    isOrganizer || hasDeclaredColors || (playingOrDone && isWorkspaceMember && !myParticipantId);
  const championParticipant = event.champion_user_id
    ? (participants.find((p) => p.user_id === event.champion_user_id) ??
       participants.find((p) => p.member_b_user_id === event.champion_user_id) ??
       null)
    : null;
  const championDisplayName =
    (event.event_type === 'two_headed_giant' && championParticipant?.giant_name?.trim())
      ? championParticipant.giant_name.trim()
      : (championName?.trim() || 'Campeón');
  const championHonorific = resolveGenderedText(championGender, 'campeón', 'campeona');

  const multiTiebreakBannerVisible =
    activeTiebreakGroup != null &&
    activeTiebreakGroup.group_origin !== 'swiss_topcut' &&
    (activeTiebreakGroup.champion_user_id == null || String(activeTiebreakGroup.champion_user_id).trim() === '');

  const showTiebreakPendingBanner =
    event.competition_format !== 'swiss_bo2' &&
    activeTiebreakGroup?.group_origin !== 'swiss_topcut' &&
    (multiTiebreakBannerVisible ||
      (event.status === 'playing' && event.final_pending && !event.champion_user_id));

  const participantNamesOrdered = activeTiebreakGroup
    ? [...activeTiebreakGroup.participants]
        .sort((x, y) => x.seed - y.seed)
        .map((row) => relationOne(row.users)?.display_name?.trim() || 'Jugador')
    : [];
  const namesJoined = formatNamesList(participantNamesOrdered);

  let multiTiebreakBodyMain = '';
  if (activeTiebreakGroup && multiTiebreakBannerVisible) {
    const n = activeTiebreakGroup.participants.length;
    if (n === 3) {
      multiTiebreakBodyMain = `Triple empate entre ${namesJoined}`;
    } else if (n === 4) {
      multiTiebreakBodyMain = `Cuádruple empate entre ${namesJoined}`;
    } else {
      multiTiebreakBodyMain = `Empate entre ${namesJoined}`;
    }
  }

  const proDeCThreshold =
    event.event_type === 'two_headed_giant' ? participantCount * 2 : participantCount;
  const showProDeCEntry =
    isWorkspaceMember &&
    participantCount > 0 &&
    prodeCVoteCount != null &&
    prodeCVoteCount >= proDeCThreshold;

  const showDiaryBlock =
    event.status !== 'cancelled' && (myParticipantId != null || isOrganizer);
  const diaryNavigateAllowed =
    showDiaryBlock &&
    (isOrganizer ||
      (myParticipantId != null &&
        (event.status === 'completed' ||
          event.status === 'drafting' ||
          event.status === 'playing' ||
          isBuenosAiresSameCalendarDay(event.scheduled_for))));

  const goEnfrentamientos = () => {
    if (myParticipantId && !hasDeclaredColors && playingOrDone) {
      navigation.navigate('EventCheckIn', { eventId: event.id, returnTo: 'EventDetail' });
      return;
    }
    navigation.navigate('PairingsList', { eventId: event.id });
  };

  const cancelledAtLabel =
    event.cancelled_at &&
    new Date(event.cancelled_at).toLocaleString('es-AR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      {event.status === 'cancelled' ? (
        <View style={styles.cancelledBanner}>
          <Text style={styles.cancelledBannerTitle}>Evento cancelado</Text>
          {cancelledAtLabel ? (
            <Text style={styles.cancelledBannerMeta}>Cancelado el {cancelledAtLabel}</Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.header}>
        {eventAvatar ? (
          <Image source={{ uri: eventAvatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPh]}>
            <Text style={styles.avatarTxt}>{event.name.slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.title}>{event.name}</Text>
        <Text style={styles.meta}>Estado: {getEventStatusLabel(event.status)}</Text>
        <Text style={styles.meta}>Tipo de evento: {getEventTypeLabel(event.event_type)}</Text>
      </View>

      {showTiebreakPendingBanner ? (
        <View style={styles.tiebreakNotice}>
          <Text style={styles.tiebreakNoticeTitle}>Desempate pendiente</Text>
          {activeTiebreakGroup && multiTiebreakBannerVisible ? (
            <>
              <Text style={styles.tiebreakNoticeBody}>{multiTiebreakBodyMain}</Text>
              {tiebreakVsNav.length > 0 ? (
                <View style={styles.tiebreakVsRow}>
                  {tiebreakVsNav.map((v) => (
                    <TouchableOpacity
                      key={v.pairingId}
                      style={styles.tiebreakVsBtn}
                      onPress={() =>
                        navigation.navigate('PairingDetail', {
                          pairingId: v.pairingId,
                          fromTab: 'official',
                        })
                      }
                    >
                      <Text style={styles.tiebreakVsBtnTxt}>vs {v.opponentName}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : currentUserInBracketWaiting ? null : (
                <TouchableOpacity
                  style={styles.tiebreakNoticeBtn}
                  onPress={() => navigation.navigate('PairingsList', { eventId: event.id })}
                >
                  <Text style={styles.tiebreakNoticeBtnTxt}>Ver enfrentamientos</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Text style={styles.tiebreakNoticeBody}>
                Hay empate por el primer lugar.
                {tiebreakBanner
                  ? ` El desempate (BO3) se juega en el enfrentamiento entre ${tiebreakBanner.nameA} y ${tiebreakBanner.nameB}.`
                  : ' Cuando el empatado sea entre dos jugadores, vas a poder abrir ese enfrentamiento desde acá.'}
              </Text>
              {tiebreakBanner ? (
                <TouchableOpacity
                  style={styles.tiebreakNoticeBtn}
                  onPress={() =>
                    navigation.navigate('PairingDetail', {
                      pairingId: tiebreakBanner.pairingId,
                      fromTab: 'official',
                    })
                  }
                >
                  <Text style={styles.tiebreakNoticeBtnTxt}>Ir al desempate</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {event.champion_user_id ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={styles.championRow}
            disabled={!championParticipant}
            onPress={() =>
              championParticipant
                ? navigation.navigate('PlayerProfileInEvent', {
                    eventId: event.id,
                    participantId: championParticipant.id,
                    from: 'EventDetail',
                  })
                : undefined
            }
          >
            <View style={styles.championAvatarWrap}>
              {event.event_type === 'two_headed_giant' && championParticipant?.member_b_user_id ? (
                <View style={{ flexDirection: 'row' }}>
                  <PlayerAvatar
                    userId={championParticipant.user_id}
                    participantId={championParticipant.id}
                    size="small"
                    withColorBorder={true}
                    giantSide="left"
                  />
                  <PlayerAvatar
                    userId={championParticipant.member_b_user_id}
                    participantId={championParticipant.id}
                    isMemberB
                    size="small"
                    withColorBorder={true}
                    giantSide="right"
                    style={{ marginLeft: -8 }}
                  />
                </View>
              ) : (
                <PlayerAvatar
                  userId={event.champion_user_id}
                  participantId={championParticipant?.id}
                  size="large"
                  withColorBorder={true}
                />
              )}
            </View>
            <View style={styles.championBody}>
              <View style={styles.championRightContent}>
                <Text style={styles.championName}>{championDisplayName}</Text>
                <View style={styles.championHeroBadge}>
                  <Text style={styles.championBadgeText}>
                    🏆 {championHonorific}
                  </Text>
                </View>
              </View>
            </View>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text style={styles.meta}>
          Fecha: {new Date(event.scheduled_for).toLocaleString('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </Text>
        <TouchableOpacity disabled={!event.cube_id} onPress={() => event.cube_id && navigation.navigate('CubeDetail', { cubeId: event.cube_id })}>
          <Text style={[styles.meta, event.cube_id ? styles.link : null]}>Cubo: {cubeName ?? 'Sin definir'}</Text>
        </TouchableOpacity>
        <Text style={styles.meta}>Sede: {venueName ?? 'Sin definir'}</Text>
        {event.draft_started_at && event.draft_ended_at ? (
          <Text style={styles.meta}>
            Duración del draft:{' '}
            {formatDraftNetDuration(
              new Date(event.draft_ended_at).getTime() - new Date(event.draft_started_at).getTime()
            )}
          </Text>
        ) : null}
        {event.draft_started_at && !event.draft_ended_at ? (
          <Text style={styles.meta}>
            Drafteando: {formatDraftNetDuration(Date.now() - new Date(event.draft_started_at).getTime())}
          </Text>
        ) : null}
        <Text style={styles.meta}>Notas: {event.notes?.trim() || 'Sin notas.'}</Text>
      </View>

      {isOrganizer ? (
        <View style={styles.block}>
          {event.status === 'cancelled' ? (
            <TouchableOpacity
              style={styles.dangerBtn}
              onPress={() =>
                Alert.alert(
                  'Eliminar evento',
                  '¿Seguro que querés eliminar este evento? Va a quedar oculto de los listados pero los datos se conservan.',
                  [
                    { text: 'Volver', style: 'cancel' },
                    { text: 'Eliminar', style: 'destructive', onPress: () => void softDeleteEvent() },
                  ]
                )
              }
            >
              <Text style={styles.dangerTxt}>Eliminar evento</Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('EditEvent', { eventId: event.id })}>
                <Text style={styles.primaryBtnTxt}>Editar evento</Text>
              </TouchableOpacity>
              {event.status === 'scheduled' &&
               !event.draft_started_at &&
               event.event_type === 'two_headed_giant' &&
               !event.giant_randomization_done ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => void randomizeGiants()}
                >
                  <Text style={styles.secondaryBtnTxt}>Randomizar gigantes</Text>
                </TouchableOpacity>
              ) : null}
              {event.status === 'scheduled' &&
               !event.draft_started_at &&
               event.event_type === 'two_headed_giant' &&
               !!event.giant_randomization_done ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={reRandomizeGiants}
                >
                  <Text style={styles.secondaryBtnTxt}>Re-randomizar gigantes</Text>
                </TouchableOpacity>
              ) : null}
              {event.is_timed_draft ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => navigation.navigate('DraftTimerConfig', {
                    mode: 'event',
                    eventId: event.id,
                    readOnly: !!event.draft_started_at,
                  })}
                >
                  <Text style={styles.secondaryBtnTxt}>⏱ Configuración rondas cronometradas</Text>
                </TouchableOpacity>
              ) : null}
              {event.status === 'scheduled' && !event.draft_started_at ? (
                <TouchableOpacity
                  style={[styles.secondaryBtn, startDraftDisabled && styles.disabledBtn]}
                  disabled={startDraftDisabled}
                  onPress={() => {
                    if (event.is_timed_draft) {
                      if (!Array.isArray(event.timer_packs) || event.timer_packs.length === 0) {
                        Alert.alert('Pendiente: configurá el cronómetro');
                        return;
                      }
                      const timerPacks: number[] = event.timer_packs;
                      const numPlayers = Math.max(participantCount, 1);
                      const params = {
                        alpha: event.timer_alpha ?? DEFAULT_TIMER_PARAMS.alpha,
                        beta:  event.timer_beta  ?? DEFAULT_TIMER_PARAMS.beta,
                        gamma: event.timer_gamma ?? DEFAULT_TIMER_PARAMS.gamma,
                        delta: event.timer_delta ?? DEFAULT_TIMER_PARAMS.delta,
                        rho:   event.timer_rho   ?? DEFAULT_TIMER_PARAMS.rho,
                        tMin:  event.timer_tmin  ?? DEFAULT_TIMER_PARAMS.tMin,
                        tMax:  event.timer_tmax  ?? DEFAULT_TIMER_PARAMS.tMax,
                      };
                      const tl = computePickTimeline(timerPacks, numPlayers, params);
                      const totalSec = tl.reduce((a, p) => a + p.timeSeconds, 0);
                      const mins = Math.floor(totalSec / 60);
                      const secs = totalSec % 60;
                      const timeStr = secs > 0 ? `${mins} min ${secs} seg` : `${mins} min`;
                      Alert.alert('Iniciar draft', `¿Iniciar el draft? Tiempo estimado: ${timeStr}`, [
                        { text: 'Volver', style: 'cancel' },
                        {
                          text: 'Iniciar',
                          onPress: async () => {
                            await patchEvent({ draft_started_at: new Date().toISOString(), status: 'drafting' });
                            navigation.navigate('DraftTimer', { eventId: event.id });
                          },
                        },
                      ]);
                    } else {
                      Alert.alert('Iniciar draft', '¿Iniciar el draft? Se cierran las inscripciones.', [
                        { text: 'Volver', style: 'cancel' },
                        {
                          text: 'Iniciar',
                          onPress: async () => {
                            await patchEvent({ draft_started_at: new Date().toISOString(), status: 'drafting' });
                          },
                        },
                      ]);
                    }
                  }}
                >
                  <Text style={styles.secondaryBtnTxt}>Arrancar a draftear</Text>
                </TouchableOpacity>
              ) : null}
              {event.status === 'scheduled' && startDraftDisabled ? (
                <Text style={styles.disabledHint}>
                  {startDraftDisabledHint}
                </Text>
              ) : null}
              {event.is_timed_draft && event.draft_started_at && !event.draft_ended_at && hasTimerSession(event.id) ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => navigation.navigate('DraftTimer', { eventId: event.id })}
                >
                  <Text style={styles.secondaryBtnTxt}>Continuar cronómetro</Text>
                </TouchableOpacity>
              ) : null}
              {event.draft_started_at && !event.draft_ended_at ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() =>
                    Alert.alert(
                      'Fin del draft',
                      '¿Finalizar draft? Queda habilitado Enfrentamientos.',
                      [
                        { text: 'Volver', style: 'cancel' },
                        {
                          text: 'Finalizar',
                          onPress: () => {
                            clearTimerSession(event.id);
                            void finishDraftAndGeneratePairings();
                          },
                        },
                      ]
                    )
                  }
                >
                  <Text style={styles.secondaryBtnTxt}>Finalizar draft</Text>
                </TouchableOpacity>
              ) : null}
              {(event.status === 'scheduled' || event.status === 'drafting') && !event.cube_id ? (
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => navigation.navigate('CubeRoulette', { eventId: event.id })}
                >
                  <Text style={styles.secondaryBtnTxt}>Ruleta</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={() =>
                  Alert.alert('Cancelar evento', '¿Seguro que querés cancelar este evento?', [
                    { text: 'Volver', style: 'cancel' },
                    {
                      text: 'Cancelar evento',
                      style: 'destructive',
                      onPress: () => {
                        void (async () => {
                          const me = await supabase.auth.getUser();
                          const uid = me.data.user?.id;
                          if (!uid) {
                            Alert.alert('Error', 'Tenés que iniciar sesión para cancelar el evento.');
                            return;
                          }
                          await patchEvent({
                            status: 'cancelled',
                            cancelled_at: new Date().toISOString(),
                            cancelled_by: uid,
                          });
                        })();
                      },
                    },
                  ])
                }
              >
                <Text style={styles.dangerTxt}>Cancelar evento</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : null}

      {event.status === 'scheduled' ? (
        <View style={styles.block}>
          {!myParticipantId &&
           isWorkspaceMember &&
           !(event.event_type === 'two_headed_giant' && !!event.giant_randomization_done) ? (
            <TouchableOpacity style={styles.primaryBtn} onPress={() => void insertMyRegistration()}>
              <Text style={styles.primaryBtnTxt}>Inscribirme al evento</Text>
            </TouchableOpacity>
          ) : null}
          {myParticipantId ? (
            <View style={styles.inlineRow}>
              <Text style={styles.registeredTxt}>Estás inscripto</Text>
              <TouchableOpacity onPress={cancelMyRegistration} style={styles.smallDangerBtn}>
                <Text style={styles.smallDangerTxt}>Cancelar inscripción</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      ) : null}

      {event.status === 'drafting' ? (
        <View style={styles.block}>
          {!myParticipantId ? (
            <Text style={styles.muted}>Las inscripciones cerraron al iniciar el draft.</Text>
          ) : (
            <Text style={styles.muted}>Estás inscripto en este evento.</Text>
          )}
        </View>
      ) : null}

      {showEnfrentamientosBtn ? (
        <View style={styles.block}>
          <TouchableOpacity style={styles.primaryBtn} onPress={goEnfrentamientos}>
            <Text style={styles.primaryBtnTxt}>Enfrentamientos</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {showStandingsBtn ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('Standings', { eventId: event.id })}
          >
            <Text style={styles.primaryBtnTxt}>Tabla de posiciones</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Participantes</Text>
        {participants.length === 0 ? <Text style={styles.muted}>Todavía no hay participantes.</Text> : null}
        {event.event_type === 'two_headed_giant' && !!event.giant_randomization_done
          ? participants.map((p) => {
              const u = relationOne(p.users);
              const giantLabel = p.giant_name ?? (u?.display_name || u?.username || 'Gigante');
              return (
                <TouchableOpacity
                  key={p.id}
                  style={styles.participantRow}
                  onPress={() =>
                    navigation.navigate('PlayerProfileInEvent', {
                      eventId: event.id,
                      participantId: p.id,
                      from: 'EventDetail',
                    })
                  }
                >
                  <View style={styles.giantAvatarPair}>
                    <PlayerAvatar
                      userId={p.user_id}
                      participantId={p.id}
                      size="small"
                      withColorBorder={false}
                    />
                    {p.member_b_user_id ? (
                      <PlayerAvatar
                        userId={p.member_b_user_id}
                        participantId={p.id}
                        isMemberB
                        size="small"
                        withColorBorder={false}
                        style={{ marginLeft: -8 }}
                      />
                    ) : null}
                  </View>
                  <View style={styles.participantBody}>
                    <View style={styles.participantNameRow}>
                      <Text style={styles.participantName}>{giantLabel}</Text>
                      {p.left_event_at ? (
                        <View style={styles.leftEventChip}>
                          <Text style={styles.leftEventChipText}>Se fue</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          : participants.map((p) => {
              const u = relationOne(p.users);
              const uname = u?.display_name || u?.username || 'sin nombre';
              const participantChampionLabel = resolveGenderedText(u?.gender, 'Campeón', 'Campeona');
              const polemicaSet = new Set((event?.polemica_winners ?? []).filter(Boolean).map(String));
              const recognitionSet = new Set((event?.recognition_winners ?? []).filter(Boolean).map(String));
              const isFragmentadaEvent = event?.champion_decided_by === 'fragmentada';
              return (
                <TouchableOpacity
                  key={p.id}
                  style={styles.participantRow}
                  onPress={() =>
                    navigation.navigate('PlayerProfileInEvent', {
                      eventId: event.id,
                      participantId: p.id,
                      from: 'EventDetail',
                    })
                  }
                >
                  <PlayerAvatar
                    userId={p.user_id}
                    participantId={p.id}
                    size="small"
                    withColorBorder={false}
                    style={{ marginRight: 10 }}
                  />
                  <View style={styles.participantBody}>
                    <View style={styles.participantNameRow}>
                      <Text style={styles.participantName}>{uname}</Text>
                      {event.champion_user_id && p.user_id === event.champion_user_id ? (
                        <View style={styles.championBadge}>
                          <Text style={styles.championBadgeText}>{participantChampionLabel}</Text>
                        </View>
                      ) : null}
                      {polemicaSet.has(p.user_id) ? (
                        isFragmentadaEvent ? (
                          <View style={styles.fragmentadaBadge}>
                            <Text style={styles.fragmentadaBadgeText}>🏆 Copa Fragmentada</Text>
                          </View>
                        ) : (
                          <View style={styles.polemicaBadge}>
                            <Text style={styles.polemicaBadgeText}>🏆 Copa Polémica</Text>
                          </View>
                        )
                      ) : null}
                      {recognitionSet.has(p.user_id) ? (
                        <View style={styles.recognitionBadge}>
                          <Text style={styles.recognitionBadgeText}>🏅 Copa Reconocimiento</Text>
                        </View>
                      ) : null}
                      {p.left_event_at ? (
                        <View style={styles.leftEventChip}>
                          <Text style={styles.leftEventChipText}>{p.user_id === myUserId ? 'Te fuiste' : 'Se fue'}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
      </View>

      {showProDeCEntry ? (
        <View style={styles.block}>
          <TouchableOpacity
            style={[styles.prodecPill, prodeCCompact && styles.prodecPillCompact]}
            onPress={() => navigation.navigate('ProDeC', { eventId: event.id })}
            activeOpacity={0.8}
          >
            <View style={[styles.prodecStripePack, prodeCCompact && styles.prodecStripePackCompact]}>
              {(['W', 'U', 'B', 'R', 'G'] as const).map((c) => (
                <View key={c} style={[styles.prodecStripe, { backgroundColor: MTG_COLOR_HEX[c] }]} />
              ))}
            </View>
            <View style={styles.prodecTitleRow}>
              <Text style={[styles.prodecPillLabel, prodeCCompact && styles.prodecPillLabelCompact]}>ProDe</Text>
              <ProDeCManaC size={prodeCCompact ? 26 : 34} />
            </View>
          </TouchableOpacity>
        </View>
      ) : null}

      {showDiaryBlock ? (
        <View style={[styles.block, styles.blockLast]}>
          <Text style={styles.blockTitle}>Bitácora digital</Text>
          {diaryNavigateAllowed ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => navigation.navigate('EventDiary', { eventId: event.id })}
            >
              <Text style={styles.primaryBtnTxt}>Bitácora digital</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.muted}>Bitácora digital (próximamente)</Text>
          )}
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
  cancelledBanner: {
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    marginHorizontal: 24,
    marginTop: 8,
  },
  cancelledBannerTitle: { color: '#991B1B', fontWeight: '700', fontSize: 14, textAlign: 'center' },
  cancelledBannerMeta: { color: '#991B1B', fontWeight: '600', fontSize: 12, textAlign: 'center', marginTop: 6 },
  header: { alignItems: 'center', padding: 24, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#eee' },
  avatar: { width: 84, height: 84, borderRadius: 16, backgroundColor: '#f3f4f6', marginBottom: 10 },
  avatarPh: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#E0E7FF' },
  avatarTxt: { fontSize: 34, fontWeight: '700', color: '#4338CA' },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 6, textAlign: 'center' },
  meta: { color: '#666', fontSize: 14, marginBottom: 4 },
  link: { color: '#3B82F6' },
  tiebreakNotice: {
    marginHorizontal: 24,
    marginTop: 4,
    marginBottom: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FDE68A',
    backgroundColor: '#FFFBEB',
  },
  tiebreakNoticeTitle: { fontSize: 15, fontWeight: '700', color: '#92400E', marginBottom: 6 },
  tiebreakNoticeBody: { fontSize: 14, color: '#78350F', lineHeight: 20 },
  tiebreakNoticeBtn: {
    marginTop: 12,
    backgroundColor: '#F59E0B',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tiebreakNoticeBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  tiebreakVsRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 6,
  },
  tiebreakVsBtn: {
    flex: 1,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  tiebreakVsBtnTxt: { color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 13 },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 10 },
  primaryBtn: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  primaryBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondaryBtn: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryBtnTxt: { color: '#3B82F6', fontSize: 15, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },
  disabledHint: { color: '#666', fontSize: 12, marginTop: -4, marginBottom: 10 },
  dangerBtn: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 4,
  },
  dangerTxt: { color: '#DC2626', fontSize: 15, fontWeight: '600' },
  prodecPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
  },
  prodecPillCompact: { paddingVertical: 8, paddingHorizontal: 12, gap: 8 },
  prodecStripePack: {
    flexDirection: 'row',
    height: 28,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  prodecStripePackCompact: { height: 20 },
  prodecStripe: { flex: 1, minWidth: 4 },
  prodecTitleRow: { flexDirection: 'row', alignItems: 'center' },
  prodecPillLabel: { fontSize: 18, fontWeight: '800', color: '#111' },
  prodecPillLabelCompact: { fontSize: 14 },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  giantAvatarPair: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  participantBody: { flex: 1, minWidth: 0 },
  participantName: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 2 },
  participantNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  championRow: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    backgroundColor: '#fafafa',
    minHeight: 94,
  },
  championAvatarWrap: { marginRight: 18 },
  championBody: { flex: 1, minWidth: 0, minHeight: 72, justifyContent: 'flex-start' },
  championRightContent: { flex: 1, minHeight: 72, justifyContent: 'flex-start' },
  championName: { fontSize: 18, fontWeight: '700', color: '#111' },
  championBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#FEF3C7',
    borderColor: '#FBBF24',
  },
  championHeroBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#FEF3C7',
    borderColor: '#FBBF24',
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  championBadgeText: { fontSize: 11, fontWeight: '700', color: '#B45309' },
  polemicaBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#FEE2E2',
    borderColor: '#DC2626',
  },
  polemicaBadgeText: { fontSize: 11, fontWeight: '700', color: '#991B1B' },
  fragmentadaBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#DBEAFE',
    borderColor: '#3B82F6',
  },
  fragmentadaBadgeText: { fontSize: 11, fontWeight: '700', color: '#1E40AF' },
  recognitionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#DBEAFE',
    borderColor: '#3B82F6',
  },
  recognitionBadgeText: { fontSize: 11, fontWeight: '700', color: '#1E40AF' },
  leftEventChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: '#F3F4F6',
    borderColor: '#D1D5DB',
  },
  leftEventChipText: { fontSize: 11, fontWeight: '700', color: '#6B7280' },
  metaSmall: { fontSize: 12, color: '#666' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  registeredTxt: { color: '#166534', fontSize: 14, fontWeight: '600' },
  smallDangerBtn: {
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  smallDangerTxt: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  placeholderBtn: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: '#fafafa',
  },
  placeholderTxt: { color: '#374151', fontSize: 14, fontWeight: '600' },
  placeholderSub: { color: '#9CA3AF', fontSize: 12, marginTop: 4, fontWeight: '500' },
  blockLast: { paddingBottom: 28 },
});
