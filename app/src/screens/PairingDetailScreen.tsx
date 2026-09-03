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
import type { MtgColor } from '../lib/database.types';
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
  official_draw: boolean;
  swiss_round: number | null;
  tiebreak_winner_participant_id: string | null;
  tiebreak_resolved_at: string | null;
};

type MatchRow = {
  id: string;
  match_number: number;
  match_type: string;
  tiebreak_round: number | null;
  status: 'in_progress' | 'completed' | 'aborted';
  winner_participant_id: string | null;
  who_started_participant_id: string | null;
  ended_by_surrender: boolean;
  started_at: string;
  ended_at: string | null;
  abort_requested_by: string | null;
  abort_requested_at: string | null;
};

type MatchTurnTimeRow = {
  match_id: string;
  turn_number: number;
  attacker_participant_id: string;
  started_at: string;
  ended_at: string | null;
};

type TiebreakGroupParticipantRow = {
  participant_id: string;
  user_id: string;
  seed: number;
};

type ActiveTiebreakGroupState = {
  id: string;
  group_type: string;
  round_number: number;
  status: string;
  champion_user_id: string | null;
  group_origin?: string | null;
  participants: TiebreakGroupParticipantRow[];
};

type ParticipantRow = {
  id: string;
  user_id: string;
  member_b_user_id?: string | null;
  giant_name?: string | null;
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

function bracketRowMatchesPairing(
  row: { pairing_id: string | null; participant_a_id: string; participant_b_id: string },
  pairing: { id: string; participant_a_id: string; participant_b_id: string }
): boolean {
  if (row.pairing_id === pairing.id) return true;
  return (
    (row.participant_a_id === pairing.participant_a_id && row.participant_b_id === pairing.participant_b_id) ||
    (row.participant_a_id === pairing.participant_b_id && row.participant_b_id === pairing.participant_a_id)
  );
}

function bracketPhaseDisplayName(phase: 'semi' | 'final' | 'third_place'): string {
  if (phase === 'semi') return 'Semifinal';
  if (phase === 'final') return 'Final';
  return '3er y 4to puesto';
}

function bracketLegRowLabel(
  phase: 'semi' | 'final' | 'third_place',
  legIndex: number,
  winsNeeded: number
): string {
  const name = bracketPhaseDisplayName(phase);
  if (winsNeeded <= 1) return `#${name}`;
  const leg = legIndex === 0 ? 'Ida' : legIndex === 1 ? 'Vuelta' : 'Desempate';
  return `#${name} · ${leg}`;
}

function bracketIniciarPhrase(phase: 'semi' | 'final' | 'third_place'): string {
  if (phase === 'semi') return 'Iniciar semifinal';
  if (phase === 'final') return 'Iniciar final';
  return 'Iniciar 3er y 4to puesto';
}

/**
 * Tiempos por turno (desde turno 2): promedios en segundos y % del jugador con más tiempo acumulado.
 */
function computeMatchTurnTimeLines(
  turns: MatchTurnTimeRow[],
  paId: string,
  pbId: string,
  aName: string,
  bName: string
): { avgA: number; avgB: number; maxPlayerName: string; maxPct: number } | null {
  if (turns.length === 0) return null;
  const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
  const maxTn = sorted[sorted.length - 1]!.turn_number;
  if (maxTn < 2) return null;

  let totalA = 0;
  let totalB = 0;
  let countA = 0;
  let countB = 0;
  for (const t of sorted) {
    if (t.turn_number < 2) continue;
    if (!t.ended_at) continue;
    const dt = new Date(t.ended_at).getTime() - new Date(t.started_at).getTime();
    if (!Number.isFinite(dt) || dt < 0) continue;
    const secs = dt / 1000;
    if (t.attacker_participant_id === paId) {
      totalA += secs;
      countA += 1;
    } else if (t.attacker_participant_id === pbId) {
      totalB += secs;
      countB += 1;
    }
  }
  const totalPartida = totalA + totalB;
  if (totalPartida <= 0 || countA === 0 || countB === 0) return null;

  const avgA = totalA / countA;
  const avgB = totalB / countB;
  const moreA = totalA >= totalB;
  const maxPlayerName = moreA ? aName : bName;
  const maxPct = ((moreA ? totalA : totalB) / totalPartida) * 100;
  return { avgA, avgB, maxPlayerName, maxPct };
}

export default function PairingDetailScreen({ route, navigation }: Props) {
  const { pairingId, fromTab: fromPairingsTab = 'official', fromPlayerProfile, bracketMatchId } = route.params;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [a, setA] = useState<ParticipantRow | null>(null);
  const [b, setB] = useState<ParticipantRow | null>(null);
  /**
   * Participantes reales del cruce de mata-mata (event_tiebreak_bracket_matches).
   * En swiss_bo2 el pairing puede estar compartido con la ronda suiza, así que la
   * sección mata-mata se lee del bracket match, no del pairing.
   */
  const [mataA, setMataA] = useState<ParticipantRow | null>(null);
  const [mataB, setMataB] = useState<ParticipantRow | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [status, setStatus] = useState<'scheduled' | 'in_progress' | 'completed'>('scheduled');
  const [matches, setMatches] = useState<MatchRow[]>([]);
  /** Vidas actuales del match in_progress (si hay). */
  const [inProgressLives, setInProgressLives] = useState<{ a: number; b: number } | null>(null);
  /** Empate a 2 vías (sin fila en event_tiebreak_groups). */
  const [legacyTwoWayTiebreak, setLegacyTwoWayTiebreak] = useState(false);
  const [activeTiebreakGroup, setActiveTiebreakGroup] = useState<ActiveTiebreakGroupState | null>(null);
  const [bracketMatchRow, setBracketMatchRow] = useState<{
    id: string;
    bracket_phase: 'semi' | 'final' | 'third_place';
    pairing_id: string | null;
    participant_a_id: string;
    participant_b_id: string;
    winner_participant_id: string | null;
  } | null>(null);
  /** Hubo (o hay) fila de bracket suizo top cut para este pairing; sirve para el hero cuando el grupo activo ya no es el bracket. */
  const [pairingHadSwissTopcutBracket, setPairingHadSwissTopcutBracket] = useState(false);
  const [draftEventStatus, setDraftEventStatus] = useState<string | null>(null);
  const [topcutFormat, setTopcutFormat] = useState<string>('bo3');
  const [competitionFormat, setCompetitionFormat] = useState<'round_robin' | 'swiss'>('round_robin');
  /** round_robin_bo1_top4: el oficial es a una sola partida. */
  const [officialBo1, setOfficialBo1] = useState(false);
  /** round_robin BO3 clásico (todos contra todos, sin fase mata-mata separada). */
  const [isRoundRobinClassic, setIsRoundRobinClassic] = useState(false);
  /** match_format del evento ('bo1'/'bo2'/'bo3'): usado para detectar el empate BO2 de round_robin. */
  const [matchFormat, setMatchFormat] = useState<string | null>(null);
  const [currentSwissRound, setCurrentSwissRound] = useState<number | null>(null);
  const [isGiantEvent, setIsGiantEvent] = useState(false);
  const [eventStartingLife, setEventStartingLife] = useState(20);
  const [turnTrackingEnabled, setTurnTrackingEnabled] = useState(false);
  const [matchTurnsByMatchId, setMatchTurnsByMatchId] = useState<Record<string, MatchTurnTimeRow[]>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const firstRef = useRef(true);

  const load = useCallback(async () => {
    const { data: pData, error: pErr } = await supabase
      .from('pairings')
      .select(
        'id, event_id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw, swiss_round, tiebreak_winner_participant_id, tiebreak_resolved_at'
      )
      .eq('id', pairingId)
      .maybeSingle();
    if (pErr || !pData) {
      Alert.alert('Error', 'No se pudo cargar el enfrentamiento.');
      setPairing(null);
      setDraftEventStatus(null);
      setTopcutFormat('bo3');
      setCompetitionFormat('round_robin');
      setCurrentSwissRound(null);
      setTurnTrackingEnabled(false);
      setMatchTurnsByMatchId({});
      setActiveTiebreakGroup(null);
      setLegacyTwoWayTiebreak(false);
      setBracketMatchRow(null);
      setMataA(null);
      setMataB(null);
      setPairingHadSwissTopcutBracket(false);
      return;
    }
    const p = pData as PairingInfo;
    setPairing(p);

    const [meRes, eventRes, partRes, matchesRes, allPlayersRes, allPairingsRes, tiebreakGroupRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase
        .from('draft_events')
        .select(
          'workspace_id, status, final_pending, champion_user_id, turn_tracking_enabled, competition_format, top_size, match_format, current_swiss_round, topcut_format, event_type, starting_life'
        )
        .eq('id', p.event_id)
        .maybeSingle(),
      supabase
        .from('event_participants')
        .select(
          `
          id,
          user_id,
          member_b_user_id,
          giant_name,
          participant_colors (color, member),
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
          'id, match_number, match_type, tiebreak_round, status, winner_participant_id, who_started_participant_id, ended_by_surrender, started_at, ended_at, abort_requested_by, abort_requested_at'
        )
        .eq('pairing_id', p.id)
        .order('match_number', { ascending: true }),
      supabase.from('event_participants').select('id').eq('event_id', p.event_id).eq('role', 'player'),
      supabase
        .from('pairings')
        .select('id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw')
        .eq('event_id', p.event_id),
      supabase
        .from('event_tiebreak_groups')
        .select('id, group_type, round_number, status, champion_user_id, group_origin')
        .eq('event_id', p.event_id)
        .in('status', ['active', 'resolved'])
        .order('created_at', { ascending: false }),
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

    const matchRows = (matchesRes.data ?? []).map((row) => ({
      ...(row as MatchRow),
      tiebreak_round: (row as MatchRow).tiebreak_round ?? null,
      who_started_participant_id: (row as MatchRow).who_started_participant_id ?? null,
    })) as MatchRow[];
    setMatches(matchRows);

    const evFlags = eventRes.data as {
      turn_tracking_enabled?: boolean | null;
      competition_format?: string | null;
      top_size?: number | null;
      match_format?: string | null;
      current_swiss_round?: number | null;
      topcut_format?: string | null;
      event_type?: string | null;
      starting_life?: number | null;
    } | null;
    setIsGiantEvent(evFlags?.event_type === 'two_headed_giant');
    setMatchFormat(evFlags?.match_format ?? null);
    setEventStartingLife(typeof evFlags?.starting_life === 'number' ? evFlags.starting_life : 20);
    const tf = evFlags?.topcut_format;
    setTopcutFormat(tf === 'bo1' || tf === 'sf_bo1_f_bo3' || tf === 'bo3' ? tf : 'bo3');
    const turnTrackOn = !!evFlags?.turn_tracking_enabled;
    setTurnTrackingEnabled(turnTrackOn);
    // swiss_bo2 se comporta igual que swiss en esta pantalla.
    setCompetitionFormat(
      evFlags?.competition_format === 'swiss' || evFlags?.competition_format === 'swiss_bo2'
        ? 'swiss'
        : 'round_robin'
    );
    // Paso 1 de la unificación (ver 0076): round_robin_bo1_top4 pasa a ser
    // competition_format='round_robin' + top_size=4 — "todos contra todos con top4" ya no es
    // un competition_format aparte.
    const isRoundRobinWithTop4 = evFlags?.competition_format === 'round_robin' && evFlags?.top_size === 4;
    setOfficialBo1(isRoundRobinWithTop4);
    setIsRoundRobinClassic(evFlags?.competition_format === 'round_robin' && evFlags?.top_size == null);
    const csr = evFlags?.current_swiss_round;
    setCurrentSwissRound(
      csr == null
        ? null
        : (() => {
            const n = Number(csr);
            return Number.isFinite(n) ? n : null;
          })()
    );

    const completedMatchIdsForTurns = matchRows.filter((m) => m.status === 'completed').map((m) => m.id);

    let turnsByMatch: Record<string, MatchTurnTimeRow[]> = {};
    if (turnTrackOn && completedMatchIdsForTurns.length > 0) {
      const trRes = await supabase
        .from('match_turns')
        .select('match_id, turn_number, attacker_participant_id, started_at, ended_at')
        .in('match_id', completedMatchIdsForTurns);
      if (!trRes.error && trRes.data) {
        for (const raw of trRes.data as MatchTurnTimeRow[]) {
          const mid = String(raw.match_id);
          if (!turnsByMatch[mid]) turnsByMatch[mid] = [];
          turnsByMatch[mid].push(raw);
        }
        for (const mid of Object.keys(turnsByMatch)) {
          turnsByMatch[mid].sort((a, b) => a.turn_number - b.turn_number);
        }
      }
    }
    setMatchTurnsByMatchId(turnsByMatch);

    // round_robin_bo1_top4 puede tener DOS grupos "bracket-ish" vivos a la vez para el mismo
    // evento: el desempate por el 4to puesto (group_type='fourth_place') y, una vez resuelto,
    // el bracket real de top4 (group_type='bracket') recién creado — el de 4to puesto queda
    // 'resolved' pero sigue siendo el que corresponde a ESTE pairing específico. Por eso NO
    // alcanza con "el grupo más reciente del evento" (lo que hacían las queries de acá):
    // resolvemos primero cuál de los grupos bracket-ish tiene efectivamente una fila en
    // event_tiebreak_bracket_matches para este pairing, y solo si ninguno aplica caemos al
    // grupo no-bracket más reciente (desempate clásico de 1er puesto — ahí sí solo existe uno
    // relevante por evento, como antes).
    const tgRows = (tiebreakGroupRes.data ?? []) as {
      id: string;
      group_type: string;
      round_number: number;
      status: string;
      champion_user_id: string | null;
      group_origin?: string | null;
    }[];
    const bracketTypeGroups = tgRows.filter((g) => g.group_type === 'bracket' || g.group_type === 'fourth_place');
    const otherGroups = tgRows.filter((g) => g.group_type !== 'bracket' && g.group_type !== 'fourth_place');

    let tgRow: (typeof tgRows)[number] | null = null;
    let bracketRow: typeof bracketMatchRow = null;

    if (bracketTypeGroups.length > 0) {
      const bmRes = await supabase
        .from('event_tiebreak_bracket_matches')
        .select('id, group_id, bracket_phase, pairing_id, participant_a_id, participant_b_id, winner_participant_id')
        .in(
          'group_id',
          bracketTypeGroups.map((g) => g.id)
        );
      if (!bmRes.error && bmRes.data) {
        const rows = bmRes.data as {
          id: string;
          group_id: string;
          bracket_phase: 'semi' | 'final' | 'third_place';
          pairing_id: string | null;
          participant_a_id: string;
          participant_b_id: string;
          winner_participant_id: string | null;
        }[];
        const matchedRow =
          // Si la navegación indicó el cruce de mata-mata, ese manda (identidad real).
          (bracketMatchId ? rows.find((bm) => bm.id === bracketMatchId) : undefined) ??
          rows.find((bm) => bm.pairing_id === p.id) ??
          rows.find((bm) => bracketRowMatchesPairing(bm, p)) ??
          null;
        if (matchedRow) {
          bracketRow = matchedRow;
          tgRow = bracketTypeGroups.find((g) => g.id === matchedRow.group_id) ?? null;
        }
      }
    }
    if (!tgRow) {
      tgRow = otherGroups[0] ?? null;
    }

    let tiebreakGroupState: ActiveTiebreakGroupState | null = null;
    if (tgRow) {
      const tpRes = await supabase
        .from('event_tiebreak_group_participants')
        .select('participant_id, user_id, seed')
        .eq('group_id', tgRow.id);
      if (!tpRes.error) {
        tiebreakGroupState = {
          ...tgRow,
          participants: (tpRes.data ?? []) as TiebreakGroupParticipantRow[],
        };
      }
    }
    setActiveTiebreakGroup(tiebreakGroupState);
    setBracketMatchRow(bracketRow);

    // Identidad del cruce mata-mata desde el bracket match (no desde el pairing,
    // que en swiss_bo2 puede estar compartido con la ronda suiza). Si alguno de los
    // participantes del bracket no está entre los del pairing, lo traemos aparte.
    let mA: ParticipantRow | null = null;
    let mB: ParticipantRow | null = null;
    if (bracketRow) {
      mA = map.get(bracketRow.participant_a_id) ?? null;
      mB = map.get(bracketRow.participant_b_id) ?? null;
      const missingIds = [bracketRow.participant_a_id, bracketRow.participant_b_id].filter(
        (id) => !map.has(id)
      );
      if (missingIds.length > 0) {
        const extraRes = await supabase
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
          .in('id', missingIds);
        if (!extraRes.error) {
          for (const row of (extraRes.data ?? []) as ParticipantRow[]) {
            if (row.id === bracketRow.participant_a_id) mA = row;
            if (row.id === bracketRow.participant_b_id) mB = row;
          }
        }
      }
    }
    setMataA(mA);
    setMataB(mB);

    // bracketRow puede ser una fila del bracket real (group_type='bracket') O del desempate
    // por el 4to puesto (group_type='fourth_place') — ver resolución de tgRow/bracketRow arriba.
    // hadSwissTopcutBracketPairing es específicamente para el bracket real (swiss_topcut /
    // round_robin_topcut): si bracketRow resultó ser el de fourth_place, NO cuenta acá, aunque
    // exista igual — si no, showHeroGreenRow terminaba mostrando las píldoras verdes del
    // bracket real (semis/final) para un pairing que solo jugó el desempate del 4to puesto.
    let hadSwissTopcutBracketPairing = !!bracketRow && tgRow?.group_type === 'bracket';
    const historyTopcutOrigin =
      evFlags?.competition_format === 'swiss'
        ? 'swiss_topcut'
        : isRoundRobinWithTop4
          ? 'round_robin_topcut'
          : null;
    if (!hadSwissTopcutBracketPairing && historyTopcutOrigin != null) {
      const gHistRes = await supabase
        .from('event_tiebreak_groups')
        .select('id')
        .eq('event_id', p.event_id)
        .eq('group_origin', historyTopcutOrigin)
        .eq('group_type', 'bracket');
      const gids = (gHistRes.data ?? []).map((r: { id: string }) => r.id);
      if (!gHistRes.error && gids.length > 0) {
        const bmHistRes = await supabase
          .from('event_tiebreak_bracket_matches')
          .select('pairing_id, participant_a_id, participant_b_id')
          .in('group_id', gids);
        if (!bmHistRes.error && bmHistRes.data) {
          hadSwissTopcutBracketPairing = (bmHistRes.data as {
            pairing_id: string | null;
            participant_a_id: string;
            participant_b_id: string;
          }[]).some((row) => bracketRowMatchesPairing(row, p));
        }
      }
    }
    setPairingHadSwissTopcutBracket(hadSwissTopcutBracketPairing);

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
      const isBo2 = evFlags?.competition_format === 'round_robin' && evFlags?.match_format === 'bo2';
      const leaders = getTwoWayTieFirstPlaceParticipantIds(playerIds, pairSumm, isBo2);
      if (
        leaders &&
        pairingIsBetweenParticipants(p, leaders[0], leaders[1]) &&
        (p.official_winner_participant_id != null || p.official_draw === true) &&
        p.tiebreak_winner_participant_id == null
      ) {
        tiebreakHere = true;
      }
    }
    setLegacyTwoWayTiebreak(tiebreakHere);
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
    else if (p.official_winner_participant_id || p.official_draw) setStatus('completed');
    else setStatus('scheduled');

  }, [pairingId, bracketMatchId]);

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
      const isParticipantHere = a.user_id === myUserId || b.user_id === myUserId;
      if (!isParticipantHere && !isOrganizer) return null;

      const isAbortRequestActive = Boolean(
        m.abort_requested_by &&
          m.abort_requested_at &&
          nowTs - new Date(m.abort_requested_at).getTime() < ABORT_WINDOW_MS
      );

      const iRequested = isAbortRequestActive && m.abort_requested_by === myUserId;
      const otherRequested = isAbortRequestActive && m.abort_requested_by !== myUserId;

      const onTrashPress = () => {
        if (isOrganizer) {
          Alert.alert(
            'Abortar partida',
            'Vas a abortar la partida como organizer. Va a desaparecer como si nunca hubiera existido.',
            [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Sí, abortar', onPress: () => void confirmAbortMatch(m) },
            ]
          );
          return;
        }
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
          <TouchableOpacity
            style={styles.abortTrashBtn}
            onPress={onTrashPress}
            disabled={!isOrganizer && iRequested}
          >
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
    [a, b, myUserId, nowTs, isOrganizer, requestAbortMatch, confirmAbortMatch]
  );

  useLayoutEffect(() => {
    if (fromPlayerProfile) {
      navigation.setOptions({
        headerLeft: hierarchicalHeaderBack(navigation, 'PlayerProfileInEvent', {
          eventId: fromPlayerProfile.eventId,
          participantId: fromPlayerProfile.participantId,
          from: fromPlayerProfile.from ?? 'EventDetail',
        }),
      });
      return;
    }
    if (!pairing?.event_id) return;
    navigation.setOptions({
      headerLeft: hierarchicalHeaderBack(navigation, 'PairingsList', {
        eventId: pairing.event_id,
        initialTab: fromPairingsTab,
      }),
    });
  }, [navigation, fromPlayerProfile, pairing?.event_id, fromPairingsTab]);

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
  const aName = (isGiantEvent && a?.giant_name) ? a.giant_name : (au?.display_name || au?.username || 'Jugador A');
  const bName = (isGiantEvent && b?.giant_name) ? b.giant_name : (bu?.display_name || bu?.username || 'Jugador B');
  const isParticipant = !!myUserId && (
    a?.user_id === myUserId || b?.user_id === myUserId ||
    (isGiantEvent && (a?.member_b_user_id === myUserId || b?.member_b_user_id === myUserId))
  );
  const inProgressMatch = matches.find((m) => m.status === 'in_progress') ?? null;

  const isBracketGroup =
    activeTiebreakGroup?.group_type === 'bracket' || activeTiebreakGroup?.group_type === 'fourth_place';

  const pairingIsInActiveGroup = Boolean(
    activeTiebreakGroup &&
      (isBracketGroup
        ? bracketMatchRow != null
        : activeTiebreakGroup.participants.some((p) => p.participant_id === pairing.participant_a_id) &&
          activeTiebreakGroup.participants.some((p) => p.participant_id === pairing.participant_b_id))
  );

  const currentRoundMatchAlreadyPlayed = Boolean(
    activeTiebreakGroup &&
      (isBracketGroup
        ? bracketMatchRow?.winner_participant_id != null
        : matches.some(
            (m) =>
              m.match_type === 'tiebreak' &&
              m.status === 'completed' &&
              (m.tiebreak_round ?? 1) === activeTiebreakGroup.round_number
          ))
  );

  const isTiebreakPendingMulti =
    Boolean(activeTiebreakGroup) &&
    pairingIsInActiveGroup &&
    !currentRoundMatchAlreadyPlayed &&
    (isBracketGroup || pairing.tiebreak_winner_participant_id == null);

  const isTiebreakPending =
    isTiebreakPendingMulti ||
    (legacyTwoWayTiebreak && pairing.tiebreak_winner_participant_id == null);

  const champId = activeTiebreakGroup?.champion_user_id ?? null;
  const isPlacementMatch = Boolean(
    activeTiebreakGroup &&
      activeTiebreakGroup.group_type === 'round_robin' &&
      champId != null &&
      champId !== '' &&
      pairingIsInActiveGroup &&
      a?.user_id !== champId &&
      b?.user_id !== champId
  );

  const placementButtonPending =
    isPlacementMatch && !currentRoundMatchAlreadyPlayed && pairing.tiebreak_winner_participant_id == null;
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
  // Identidad real del cruce de fase mata-mata: sale del bracket match, no del pairing
  // (que en swiss_bo2 puede estar compartido con la ronda suiza). Sin bracket match
  // (ej. desempate round_robin), cae al pairing, así que estos valores son seguros en
  // ambos casos y se usan para la sección/encabezado de mata-mata.
  const mataAId = bracketMatchRow?.participant_a_id ?? pairing.participant_a_id;
  const mataBId = bracketMatchRow?.participant_b_id ?? pairing.participant_b_id;
  const mauA = relationOne(mataA?.users);
  const mauB = relationOne(mataB?.users);
  const mataAName = mauA?.display_name || mauA?.username || aName;
  const mataBName = mauB?.display_name || mauB?.username || bName;
  const mataTieWinsA = tiebreakMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === mataAId
  ).length;
  const mataTieWinsB = tiebreakMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === mataBId
  ).length;
  const showTiebreakSection = tiebreakMs.length > 0 || isTiebreakPending;
  const tiebreakSectionTitle =
    activeTiebreakGroup?.group_origin === 'swiss_topcut' ||
    activeTiebreakGroup?.group_origin === 'round_robin_topcut'
      ? 'Fase mata-mata'
      : activeTiebreakGroup?.group_origin === 'round_robin_fourth_place'
        ? 'Desempate por el 4to puesto'
        : activeTiebreakGroup?.group_origin === 'round_robin_first_place'
          ? 'Desempate por el 1er puesto'
          : 'Desempate';
  // Layout de bracket: top cut suizo o top 4 de round_robin_bo1_top4.
  const useSwissTopcutBracketDetailLayout =
    bracketMatchRow != null &&
    ((competitionFormat === 'swiss' && activeTiebreakGroup?.group_origin === 'swiss_topcut') ||
      activeTiebreakGroup?.group_origin === 'round_robin_topcut');

  const tiebreakBracketPrimaryLabel = (() => {
    if (!bracketMatchRow) return null;
    const phase = bracketMatchRow.bracket_phase;
    // Desempate por el 4to puesto: siempre BO1 (1 partida decisiva), sin importar topcut_format
    // (eso es solo para el bracket real de semis/final). Desempate por el 1er puesto de
    // round_robin BO3 clásico (0075): BO1 en semi, BO3 (2 victorias) en la final — la que
    // corona campeón se juega con la misma exigencia que tenía antes de esta migración.
    const wn =
      activeTiebreakGroup?.group_origin === 'round_robin_first_place'
        ? phase === 'final'
          ? 2
          : 1
        : activeTiebreakGroup?.group_origin === 'round_robin_fourth_place'
          ? 1
          : topcutWinsNeededClient(topcutFormat, phase);
    if (inProgressMatch?.status === 'in_progress' && inProgressMatch.match_type === 'tiebreak') {
      return `Retomar ${bracketPhaseDisplayName(phase)} en curso`;
    }
    const wa = tiebreakWinsA;
    const wb = tiebreakWinsB;
    if (Math.max(wa, wb) >= wn) return null;
    const total = wa + wb;
    if (wn === 1) return bracketIniciarPhrase(phase);
    if (total === 0) return bracketIniciarPhrase(phase);
    if (Math.max(wa, wb) === 1 && total === 1) return 'Jugar la vuelta';
    if (wa >= 1 && wb >= 1) return 'Jugar el bueno';
    return bracketIniciarPhrase(phase);
  })();
  const winsA = officialMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_a_id
  ).length;
  const winsB = officialMs.filter(
    (m) => m.status === 'completed' && m.winner_participant_id === pairing.participant_b_id
  ).length;
  // round_robin_bo1_top4: oficial resuelto = official_winner seteado o 1 partida oficial ganada
  // (cubre el caso donde el trigger todavía no reflejó el ganador en el pairing). round_robin
  // BO2: oficial resuelto también con official_draw=true (1-1, sin ganador).
  const officialResolved =
    pairing.official_winner_participant_id != null ||
    (competitionFormat === 'round_robin' && matchFormat === 'bo2' && pairing.official_draw === true) ||
    (officialBo1 && (winsA >= 1 || winsB >= 1));
  const revengeCompleted = revengeMs.filter((m) => m.status === 'completed');
  const revengeWinsA = revengeCompleted.filter(
    (m) => m.winner_participant_id === pairing.participant_a_id
  ).length;
  const revengeWinsB = revengeCompleted.filter(
    (m) => m.winner_participant_id === pairing.participant_b_id
  ).length;
  // En el layout de bracket suizo el héroe representa el cruce de mata-mata real (del
  // bracket match); en el resto, el pairing. mata* cae al pairing cuando no hay bracket.
  const heroUsesBracket = useSwissTopcutBracketDetailLayout;
  const heroPartA = heroUsesBracket ? mataA ?? a : a;
  const heroPartB = heroUsesBracket ? mataB ?? b : b;
  const heroAId = heroUsesBracket ? mataAId : pairing.participant_a_id;
  const heroBId = heroUsesBracket ? mataBId : pairing.participant_b_id;
  const heroAName = heroUsesBracket ? mataAName : aName;
  const heroBName = heroUsesBracket ? mataBName : bName;
  const heroOffWinsA = heroUsesBracket
    ? officialMs.filter((m) => m.status === 'completed' && m.winner_participant_id === heroAId).length
    : winsA;
  const heroOffWinsB = heroUsesBracket
    ? officialMs.filter((m) => m.status === 'completed' && m.winner_participant_id === heroBId).length
    : winsB;
  const heroTieWinsA = heroUsesBracket ? mataTieWinsA : tiebreakWinsA;
  const heroTieWinsB = heroUsesBracket ? mataTieWinsB : tiebreakWinsB;
  const swapSides = !!myUserId && (
    heroPartB?.user_id === myUserId ||
    (isGiantEvent && heroPartB?.member_b_user_id === myUserId)
  );
  const leftP = swapSides ? heroPartB : heroPartA;
  const rightP = swapSides ? heroPartA : heroPartB;

  function getMemberBColors(p: typeof leftP): MtgColor[] {
    if (!p?.participant_colors) return [];
    const rows = Array.isArray(p.participant_colors) ? p.participant_colors : [p.participant_colors];
    return rows.filter((r) => r.member === 'b').map((r) => r.color as MtgColor);
  }
  const leftMemberBColors = getMemberBColors(leftP);
  const rightMemberBColors = getMemberBColors(rightP);
  const dispLeftName = swapSides ? heroBName : heroAName;
  const dispRightName = swapSides ? heroAName : heroBName;
  const dispWinsLeftOfficial = swapSides ? heroOffWinsB : heroOffWinsA;
  const dispWinsRightOfficial = swapSides ? heroOffWinsA : heroOffWinsB;
  const dispTieLeft = swapSides ? heroTieWinsB : heroTieWinsA;
  const dispTieRight = swapSides ? heroTieWinsA : heroTieWinsB;
  const dispRevLeft = swapSides ? revengeWinsB : revengeWinsA;
  const dispRevRight = swapSides ? revengeWinsA : revengeWinsB;
  const dispLiveL = inProgressLives ? (swapSides ? inProgressLives.b : inProgressLives.a) : 0;
  const dispLiveR = inProgressLives ? (swapSides ? inProgressLives.a : inProgressLives.b) : 0;
  const eventIsCancelled = draftEventStatus === 'cancelled';

  const swissOfficialPendingThisRound =
    competitionFormat === 'swiss' &&
    pairing.swiss_round != null &&
    currentSwissRound != null &&
    pairing.swiss_round === currentSwissRound &&
    pairing.official_winner_participant_id == null;

  const startButtonLabel = inProgressMatch
    ? inProgressMatch.match_type === 'tiebreak'
      ? bracketMatchRow
        ? `Retomar ${bracketPhaseDisplayName(bracketMatchRow.bracket_phase)} en curso`
        : 'Retomar desempate en curso'
      : inProgressMatch.match_type === 'revenge'
        ? 'Retomar venganza en curso'
        : 'Retomar partida en curso'
    : placementButtonPending
      ? 'Definir 2do y 3er puesto'
      : isTiebreakPending && bracketMatchRow
        ? tiebreakBracketPrimaryLabel ?? bracketIniciarPhrase(bracketMatchRow.bracket_phase)
        : isTiebreakPending
          ? 'Iniciar desempate'
          : officialResolved
            ? 'Iniciar venganza'
            : swissOfficialPendingThisRound || competitionFormat !== 'swiss'
              ? 'Iniciar partida'
              : 'Iniciar venganza';
  const showResumeStyle = startButtonLabel.startsWith('Retomar');
  const movePrimaryBtnAboveRevenge =
    (!inProgressMatch && (placementButtonPending || isTiebreakPending)) ||
    inProgressMatch?.match_type === 'tiebreak' ||
    startButtonLabel === 'Iniciar partida';

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
    if (isTiebreakPending && (isBracketGroup || pairing.tiebreak_winner_participant_id == null)) {
      matchType = 'tiebreak';
    } else if (
      competitionFormat === 'swiss' &&
      (pairing.swiss_round == null ||
        currentSwissRound == null ||
        pairing.swiss_round !== currentSwissRound)
    ) {
      matchType = 'revenge';
    } else if (
      !officialResolved &&
      (competitionFormat !== 'swiss' ||
        (pairing.swiss_round != null &&
          currentSwissRound != null &&
          pairing.swiss_round === currentSwissRound))
    ) {
      matchType = 'draft';
    } else {
      matchType = 'revenge';
    }
    const tiebreakRound =
      matchType === 'tiebreak' ? activeTiebreakGroup?.round_number ?? 1 : undefined;
    const { data, error } = await supabase
      .from('matches')
      .insert({
        pairing_id: pairing.id,
        match_number: nextNumber,
        match_type: matchType,
        started_at: new Date().toISOString(),
        starting_life_a: eventStartingLife,
        starting_life_b: eventStartingLife,
        ...(matchType === 'tiebreak' && tiebreakRound != null ? { tiebreak_round: tiebreakRound } : {}),
      })
      .select('id')
      .maybeSingle();
    if (error || !data?.id) {
      Alert.alert('Error', error?.message ?? 'No se pudo iniciar la partida.');
      return;
    }
    navigation.navigate('LifeTracker', { matchId: String(data.id), fromTab: fromPairingsTab });
  };

  // Mismo criterio que tiebreakBracketPrimaryLabel: el desempate por el 4to puesto siempre es
  // BO1; el de 1er puesto (0075) es BO1 en semi y BO3 en la final.
  const bracketLegWinsNeeded =
    bracketMatchRow != null
      ? activeTiebreakGroup?.group_origin === 'round_robin_first_place'
        ? bracketMatchRow.bracket_phase === 'final'
          ? 2
          : 1
        : activeTiebreakGroup?.group_origin === 'round_robin_fourth_place'
          ? 1
          : topcutWinsNeededClient(topcutFormat, bracketMatchRow.bracket_phase)
      : 2;
  const hasCompletedBracketLegMatches = tiebreakMs.some(
    (m) => m.match_type === 'tiebreak' && m.status === 'completed' && m.winner_participant_id != null
  );
  // Desempate por el 4to o 1er puesto (group_type='fourth_place'): píldora naranja aparte — no
  // comparte la fila verde del bracket real (que es BO3/lo que diga topcut_format).
  const showHeroOrangeRow =
    bracketMatchRow != null && activeTiebreakGroup?.group_type === 'fourth_place';
  // round_robin_first_place: semi es BO1 (1 píldora), la final que corona campeón es BO3 (2
  // píldoras) — mismo criterio fase-dependiente que bracketLegWinsNeeded. round_robin_fourth_place
  // (el 4to puesto real) SIEMPRE es 1 sola píldora, sin importar la fase — no se toca.
  const showSecondOrangeBox =
    activeTiebreakGroup?.group_origin === 'round_robin_first_place' &&
    bracketMatchRow?.bracket_phase === 'final';
  const showHeroGreenRow =
    (bracketMatchRow != null && !showHeroOrangeRow) ||
    (pairingHadSwissTopcutBracket && hasCompletedBracketLegMatches);
  const showHeroBlueRow = competitionFormat !== 'swiss' || officialMs.length > 0;
  const showPrimaryInSwissMata =
    movePrimaryBtnAboveRevenge && useSwissTopcutBracketDetailLayout && (isParticipant || isOrganizer);
  const showPrimaryInOfficialsLegacy =
    movePrimaryBtnAboveRevenge && !useSwissTopcutBracketDetailLayout && (isParticipant || isOrganizer);

  const renderDraftRow = (m: MatchRow, idx: number) => {
    const displayNum = idx + 1;
    const durationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
    const showLive = m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
    const starterName =
      m.status === 'completed' &&
      m.who_started_participant_id &&
      (m.who_started_participant_id === pairing.participant_a_id ||
        m.who_started_participant_id === pairing.participant_b_id)
        ? m.who_started_participant_id === pairing.participant_a_id
          ? aName
          : bName
        : null;
    const turnStats =
      turnTrackingEnabled && m.status === 'completed'
        ? computeMatchTurnTimeLines(
            matchTurnsByMatchId[m.id] ?? [],
            pairing.participant_a_id,
            pairing.participant_b_id,
            aName,
            bName
          )
        : null;
    return (
      <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
        <View style={styles.matchRowMain}>
          <View style={styles.matchMetaRow}>
            <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
              #{displayNum} · {m.status === 'in_progress' ? '● EN VIVO' : 'Completado'}
            </Text>
            {starterName ? <Text style={styles.matchStartedBy}>Empezó: {starterName}</Text> : null}
          </View>
          {showLive ? (
            <Text style={styles.matchLiveScore}>
              {dispLeftName} {dispLiveL} vs {dispLiveR} {dispRightName}
            </Text>
          ) : null}
          {m.status === 'in_progress' ? <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text> : null}
          {m.status === 'completed' && m.winner_participant_id ? (
            <View>
              <Text style={styles.matchWinner}>
                Ganó {m.winner_participant_id === pairing.participant_a_id ? aName : bName}
              </Text>
              {durationLabel ? (
                <Text style={styles.matchDuration}>
                  Duración: {durationLabel}
                  {turnStats ? ` (${turnStats.maxPct.toFixed(0)}% ${turnStats.maxPlayerName})` : ''}
                </Text>
              ) : null}
            </View>
          ) : null}
          {m.status === 'completed' && !m.winner_participant_id ? (
            <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
          ) : null}
          {m.status === 'completed' && m.ended_at ? (
            <Text style={styles.matchTime}>{formatMatchTimestamp(m.ended_at)}</Text>
          ) : null}
          {m.status === 'completed' && !m.ended_at ? <Text style={styles.matchTime}>Cierre pendiente.</Text> : null}
        </View>
        {turnTrackingEnabled && m.status === 'completed' ? (
          <TouchableOpacity
            style={styles.matchChartBtn}
            onPress={() => navigation.navigate('LifeChart', { matchId: m.id })}
            hitSlop={8}
            accessibilityLabel="Evolución de vida"
          >
            <Text style={styles.matchChartEmoji}>📊</Text>
          </TouchableOpacity>
        ) : null}
        {renderMatchAbortControl(m)}
      </View>
    );
  };

  const renderTiebreakRow = (m: MatchRow, idx: number) => {
    const displayNum = idx + 1;
    const durationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
    const showLive = m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
    const roundSuffix = (m.tiebreak_round ?? 1) >= 2 ? ` · Ronda ${m.tiebreak_round}` : '';
    const rowLabel = bracketMatchRow
      ? bracketLegRowLabel(bracketMatchRow.bracket_phase, idx, bracketLegWinsNeeded)
      : `#${displayNum}${roundSuffix}`;
    // Identidad del cruce mata-mata: del bracket match (mata*), no del pairing.
    const starterName =
      m.status === 'completed' &&
      m.who_started_participant_id &&
      (m.who_started_participant_id === mataAId || m.who_started_participant_id === mataBId)
        ? m.who_started_participant_id === mataAId
          ? mataAName
          : mataBName
        : null;
    const turnStats =
      turnTrackingEnabled && m.status === 'completed'
        ? computeMatchTurnTimeLines(
            matchTurnsByMatchId[m.id] ?? [],
            mataAId,
            mataBId,
            mataAName,
            mataBName
          )
        : null;
    return (
      <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
        <View style={styles.matchRowMain}>
          <View style={styles.matchMetaRow}>
            <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
              {rowLabel} · {m.status === 'in_progress' ? '● EN VIVO' : 'Completado'}
            </Text>
            {starterName ? <Text style={styles.matchStartedBy}>Empezó: {starterName}</Text> : null}
          </View>
          {showLive ? (
            <Text style={styles.matchLiveScore}>
              {dispLeftName} {dispLiveL} vs {dispLiveR} {dispRightName}
            </Text>
          ) : null}
          {m.status === 'in_progress' ? <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text> : null}
          {m.status === 'completed' && m.winner_participant_id ? (
            <View>
              <Text style={styles.matchWinner}>
                Ganó {m.winner_participant_id === mataAId ? mataAName : mataBName}
              </Text>
              {durationLabel ? (
                <Text style={styles.matchDuration}>
                  Duración: {durationLabel}
                  {turnStats ? ` (${turnStats.maxPct.toFixed(0)}% ${turnStats.maxPlayerName})` : ''}
                </Text>
              ) : null}
            </View>
          ) : null}
          {m.status === 'completed' && !m.winner_participant_id ? (
            <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
          ) : null}
          {m.status === 'completed' && m.ended_at ? (
            <Text style={styles.matchTime}>{formatMatchTimestamp(m.ended_at)}</Text>
          ) : null}
          {m.status === 'completed' && !m.ended_at ? <Text style={styles.matchTime}>Cierre pendiente.</Text> : null}
        </View>
        {turnTrackingEnabled && m.status === 'completed' ? (
          <TouchableOpacity
            style={styles.matchChartBtn}
            onPress={() => navigation.navigate('LifeChart', { matchId: m.id })}
            hitSlop={8}
            accessibilityLabel="Evolución de vida"
          >
            <Text style={styles.matchChartEmoji}>📊</Text>
          </TouchableOpacity>
        ) : null}
        {renderMatchAbortControl(m)}
      </View>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <View style={styles.hero}>
        <View style={styles.heroThreeCol}>
          <View style={[styles.heroSide, styles.heroSideLeft]}>
            {leftP ? (
              isGiantEvent ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                  <PlayerAvatar userId={leftP.user_id} participantId={leftP.id} size="large" withColorBorder borderWidth={4} giantSide="left" />
                  {leftP.member_b_user_id ? (
                    <PlayerAvatar userId={leftP.member_b_user_id} participantId={leftP.id} isMemberB size="large" withColorBorder borderWidth={4} giantSide="right" memberColors={leftMemberBColors} style={{ marginLeft: -12 }} />
                  ) : null}
                </View>
              ) : (
                <PlayerAvatar userId={leftP.user_id} participantId={leftP.id} size="large" withColorBorder borderWidth={4} />
              )
            ) : null}
            <Text style={styles.heroPlayerName}>{dispLeftName}</Text>
            {showHeroGreenRow ? (
              <View style={[styles.heroBo3RowLeft, styles.heroBo3RowGreen]}>
                <View style={[styles.heroBo3Box, dispTieLeft >= 1 && styles.heroBo3FilledGreen]} />
                <View style={[styles.heroBo3Box, dispTieLeft >= 2 && styles.heroBo3FilledGreen]} />
              </View>
            ) : null}
            {showHeroOrangeRow ? (
              <View style={[styles.heroBo3RowLeft, styles.heroBo3RowOrange]}>
                <View style={[styles.heroBo3Box, dispTieLeft >= 1 && styles.heroBo3FilledOrange]} />
                {showSecondOrangeBox ? (
                  <View style={[styles.heroBo3Box, dispTieLeft >= 2 && styles.heroBo3FilledOrange]} />
                ) : null}
              </View>
            ) : null}
            {showHeroBlueRow ? (
              <View
                style={[
                  styles.heroBo3RowLeft,
                  (showHeroGreenRow || showHeroOrangeRow) && styles.heroBo3RowBlueBelow,
                ]}
              >
                <View style={[styles.heroBo3Box, dispWinsLeftOfficial >= 1 && styles.heroBo3Filled]} />
                {!officialBo1 ? (
                  <View style={[styles.heroBo3Box, dispWinsLeftOfficial >= 2 && styles.heroBo3Filled]} />
                ) : null}
              </View>
            ) : null}
          </View>
          <View style={styles.heroCenter}>
            <Text style={styles.heroVsBig}>vs</Text>
          </View>
          <View style={[styles.heroSide, styles.heroSideRight]}>
            {rightP ? (
              isGiantEvent ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                  <PlayerAvatar userId={rightP.user_id} participantId={rightP.id} size="large" withColorBorder borderWidth={4} giantSide="left" />
                  {rightP.member_b_user_id ? (
                    <PlayerAvatar userId={rightP.member_b_user_id} participantId={rightP.id} isMemberB size="large" withColorBorder borderWidth={4} giantSide="right" memberColors={rightMemberBColors} style={{ marginLeft: -12 }} />
                  ) : null}
                </View>
              ) : (
                <PlayerAvatar userId={rightP.user_id} participantId={rightP.id} size="large" withColorBorder borderWidth={4} />
              )
            ) : null}
            <Text style={styles.heroPlayerName}>{dispRightName}</Text>
            {showHeroGreenRow ? (
              <View style={[styles.heroBo3RowRight, styles.heroBo3RowGreen]}>
                <View style={[styles.heroBo3Box, dispTieRight >= 1 && styles.heroBo3FilledGreen]} />
                <View style={[styles.heroBo3Box, dispTieRight >= 2 && styles.heroBo3FilledGreen]} />
              </View>
            ) : null}
            {showHeroOrangeRow ? (
              <View style={[styles.heroBo3RowRight, styles.heroBo3RowOrange]}>
                <View style={[styles.heroBo3Box, dispTieRight >= 1 && styles.heroBo3FilledOrange]} />
                {showSecondOrangeBox ? (
                  <View style={[styles.heroBo3Box, dispTieRight >= 2 && styles.heroBo3FilledOrange]} />
                ) : null}
              </View>
            ) : null}
            {showHeroBlueRow ? (
              <View
                style={[
                  styles.heroBo3RowRight,
                  (showHeroGreenRow || showHeroOrangeRow) && styles.heroBo3RowBlueBelow,
                ]}
              >
                <View style={[styles.heroBo3Box, dispWinsRightOfficial >= 1 && styles.heroBo3Filled]} />
                {!officialBo1 ? (
                  <View style={[styles.heroBo3Box, dispWinsRightOfficial >= 2 && styles.heroBo3Filled]} />
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Oficiales</Text>
        {useSwissTopcutBracketDetailLayout ? (
          officialMs.length === 0 && !showTiebreakSection ? (
            <Text style={styles.muted}>Todavía no hay partidas.</Text>
          ) : (
            <>
              {officialMs.length > 0 ? (
                <View style={styles.subAccBlue}>
                  <Text style={styles.subTitleSwissBlue}>
                    {officialBo1 ? 'Fase todos contra todos' : 'Ronda suiza'}
                  </Text>
                  {officialMs.map(renderDraftRow)}
                </View>
              ) : null}
              {showTiebreakSection ? (
                <View style={[styles.subAccGreen, officialMs.length > 0 && styles.subAccGreenSpaced]}>
                  <Text style={styles.subTitleSwissGreen}>Fase mata-mata</Text>
                  {tiebreakMs.length === 0 ? null : tiebreakMs.map(renderTiebreakRow)}
                  {showPrimaryInSwissMata ? (
                    <View style={styles.primaryAboveRevengeWrap}>
                      <TouchableOpacity
                        style={[
                          styles.primaryBtn,
                          showResumeStyle ? styles.resumeBtn : null,
                          eventIsCancelled ? styles.primaryBtnDisabled : null,
                        ]}
                        disabled={eventIsCancelled}
                        onPress={() => void startMatch()}
                      >
                        <Text style={[styles.primaryBtnTxt, showResumeStyle ? styles.resumeBtnTxt : null]}>
                          {startButtonLabel}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </>
          )
        ) : officialMs.length === 0 && revengeMs.length === 0 && tiebreakMs.length === 0 && !isTiebreakPending ? (
          <>
            <Text style={styles.muted}>Todavía no hay partidas.</Text>
            {showPrimaryInOfficialsLegacy ? (
              <View style={styles.primaryAboveRevengeWrap}>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    showResumeStyle ? styles.resumeBtn : null,
                    eventIsCancelled ? styles.primaryBtnDisabled : null,
                  ]}
                  disabled={eventIsCancelled}
                  onPress={() => void startMatch()}
                >
                  <Text style={[styles.primaryBtnTxt, showResumeStyle ? styles.resumeBtnTxt : null]}>
                    {startButtonLabel}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        ) : (
          <>
            {officialBo1 ? (
              <View style={styles.subAccBlue}>
                <Text style={styles.subTitleSwissBlue}>Fase todos contra todos</Text>
                {officialMs.length === 0 ? (
                  <Text style={styles.muted}>Todavía no hay partidas oficiales.</Text>
                ) : (
                  officialMs.map(renderDraftRow)
                )}
              </View>
            ) : isRoundRobinClassic ? (
              // round_robin BO3 clásico: no tiene fase mata-mata separada del resto (son los
              // únicos partidos de la temporada regular hasta que eventualmente hay desempate)
              // — mismo tratamiento visual azul que "Fase todos contra todos" de
              // round_robin_bo1_top4, pero con su propio título.
              <View style={styles.subAccBlue}>
                <Text style={styles.subTitleSwissBlue}>Cruces</Text>
                {officialMs.length === 0 ? (
                  <Text style={styles.muted}>Todavía no hay partidas oficiales.</Text>
                ) : (
                  officialMs.map(renderDraftRow)
                )}
              </View>
            ) : (
              <>
                <Text style={styles.sectionSubtitle}>Partidas oficiales</Text>
                {officialMs.length === 0 ? (
                  <Text style={styles.muted}>Todavía no hay partidas oficiales.</Text>
                ) : (
                  officialMs.map(renderDraftRow)
                )}
              </>
            )}
            {showTiebreakSection ? (
              activeTiebreakGroup?.group_type === 'fourth_place' ? (
                <View style={[styles.subAccOrange, officialMs.length > 0 && styles.subAccOrangeSpaced]}>
                  <Text style={styles.subTitleSwissOrange}>{tiebreakSectionTitle}</Text>
                  {bracketMatchRow ? null : (
                    <Text style={styles.revengeCounter}>
                      {shortName(dispLeftName)} {dispTieLeft} - {dispTieRight} {shortName(dispRightName)}
                      {tiebreakWinnerName ? ` · Ganó ${tiebreakWinnerName}` : ''}
                    </Text>
                  )}
                  {tiebreakMs.length === 0 ? (
                    bracketMatchRow ? null : (
                      <Text style={styles.muted}>Todavía no hay partidas de desempate.</Text>
                    )
                  ) : (
                    tiebreakMs.map(renderTiebreakRow)
                  )}
                </View>
              ) : (
                <>
                  <Text style={[styles.sectionSubtitle, styles.sectionSubtitleSpaced]}>{tiebreakSectionTitle}</Text>
                  {bracketMatchRow ? null : (
                    <Text style={styles.revengeCounter}>
                      {shortName(dispLeftName)} {dispTieLeft} - {dispTieRight} {shortName(dispRightName)}
                      {tiebreakWinnerName ? ` · Ganó ${tiebreakWinnerName}` : ''}
                    </Text>
                  )}
                  {tiebreakMs.length === 0 ? (
                    bracketMatchRow ? null : (
                      <Text style={styles.muted}>Todavía no hay partidas de desempate.</Text>
                    )
                  ) : (
                    tiebreakMs.map(renderTiebreakRow)
                  )}
                </>
              )
            ) : null}
            {showPrimaryInOfficialsLegacy ? (
              <View style={styles.primaryAboveRevengeWrap}>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    showResumeStyle ? styles.resumeBtn : null,
                    eventIsCancelled ? styles.primaryBtnDisabled : null,
                  ]}
                  disabled={eventIsCancelled}
                  onPress={() => void startMatch()}
                >
                  <Text style={[styles.primaryBtnTxt, showResumeStyle ? styles.resumeBtnTxt : null]}>
                    {startButtonLabel}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        )}
      </View>

      <View style={styles.block}>
        <Text style={styles.blockTitle}>Venganzas</Text>
        {revengeMs.length === 0 ? (
          <Text style={styles.muted}>Todavía no hay venganzas jugadas.</Text>
        ) : (
          <>
            <Text style={styles.revengeCounter}>
              {shortName(dispLeftName)} {dispRevLeft} - {dispRevRight} {shortName(dispRightName)}
            </Text>
            {revengeMs.map((m, idx) => {
              const revengeNum = idx + 1;
              const revengeDurationLabel = formatCompletedMatchDuration(m.started_at, m.ended_at);
              const showLive = m.status === 'in_progress' && inProgressLives && inProgressMatch?.id === m.id;
              const winnerName =
                m.winner_participant_id === pairing.participant_a_id
                  ? aName
                  : m.winner_participant_id === pairing.participant_b_id
                    ? bName
                    : null;
              const starterName =
                m.status === 'completed' &&
                m.who_started_participant_id &&
                (m.who_started_participant_id === pairing.participant_a_id ||
                  m.who_started_participant_id === pairing.participant_b_id)
                  ? m.who_started_participant_id === pairing.participant_a_id
                    ? aName
                    : bName
                  : null;
              const turnStats =
                turnTrackingEnabled && m.status === 'completed'
                  ? computeMatchTurnTimeLines(
                      matchTurnsByMatchId[m.id] ?? [],
                      pairing.participant_a_id,
                      pairing.participant_b_id,
                      aName,
                      bName
                    )
                  : null;
              return (
                <View key={m.id} style={[styles.matchRow, m.status === 'in_progress' && styles.matchRowLive]}>
                  <View style={styles.matchRowMain}>
                    <View style={styles.matchMetaRow}>
                      <Text style={[styles.meta, m.status === 'in_progress' && styles.matchLiveTxt]}>
                        {m.status === 'completed' && winnerName
                          ? `Venganza N°${revengeNum} - Ganó ${winnerName}`
                          : `Venganza N°${revengeNum} · ${
                              m.status === 'in_progress' ? '● EN VIVO' : 'Completado'
                            }`}
                      </Text>
                      {starterName ? (
                        <Text style={styles.matchStartedBy}>Empezó: {starterName}</Text>
                      ) : null}
                    </View>
                    {showLive ? (
                      <Text style={styles.matchLiveScore}>
                        {dispLeftName} {dispLiveL} vs {dispLiveR} {dispRightName}
                      </Text>
                    ) : null}
                    {m.status === 'in_progress' ? (
                      <Text style={styles.matchTime}>{formatMatchTimestamp(m.started_at)}</Text>
                    ) : null}
                    {m.status === 'completed' && winnerName && revengeDurationLabel ? (
                      <Text style={styles.matchDuration}>
                        Duración: {revengeDurationLabel}
                        {turnStats ? ` (${turnStats.maxPct.toFixed(0)}% ${turnStats.maxPlayerName})` : ''}
                      </Text>
                    ) : null}
                    {m.status === 'completed' && !winnerName ? (
                      <View>
                        <Text style={styles.matchWinner}>Partida completada sin ganador oficial.</Text>
                        {revengeDurationLabel ? (
                          <Text style={styles.matchDuration}>
                            Duración: {revengeDurationLabel}
                            {turnStats ? ` (${turnStats.maxPct.toFixed(0)}% ${turnStats.maxPlayerName})` : ''}
                          </Text>
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
                  {turnTrackingEnabled && m.status === 'completed' ? (
                    <TouchableOpacity
                      style={styles.matchChartBtn}
                      onPress={() => navigation.navigate('LifeChart', { matchId: m.id })}
                      hitSlop={8}
                      accessibilityLabel="Evolución de vida"
                    >
                      <Text style={styles.matchChartEmoji}>📊</Text>
                    </TouchableOpacity>
                  ) : null}
                  {renderMatchAbortControl(m)}
                </View>
              );
            })}
          </>
        )}
      </View>

      {isParticipant || isOrganizer ? (
        !movePrimaryBtnAboveRevenge ? (
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
        ) : null
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
  heroBo3RowGreen: { marginTop: 8 },
  heroBo3RowOrange: { marginTop: 8 },
  heroBo3RowBlueBelow: { marginTop: 6 },
  heroBo3Box: {
    width: 26,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    marginRight: 6,
  },
  heroBo3Filled: { backgroundColor: '#3B82F6', borderColor: '#3B82F6' },
  heroBo3FilledGreen: { backgroundColor: '#15803D', borderColor: '#15803D' },
  heroBo3FilledOrange: { backgroundColor: '#F59E0B', borderColor: '#F59E0B' },
  subAccBlue: {
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
    paddingLeft: 10,
    paddingVertical: 4,
    marginBottom: 4,
  },
  subAccGreen: {
    borderLeftWidth: 3,
    borderLeftColor: '#15803D',
    paddingLeft: 10,
    paddingVertical: 4,
    marginBottom: 4,
  },
  subAccGreenSpaced: { marginTop: 16 },
  subAccOrange: {
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
    paddingLeft: 10,
    paddingVertical: 4,
    marginBottom: 4,
  },
  subAccOrangeSpaced: { marginTop: 16 },
  subTitleSwissBlue: { fontSize: 14, fontWeight: '700', color: '#2563EB', marginBottom: 6 },
  subTitleSwissGreen: { fontSize: 14, fontWeight: '700', color: '#15803D', marginBottom: 6 },
  subTitleSwissOrange: { fontSize: 14, fontWeight: '700', color: '#F59E0B', marginBottom: 6 },
  block: { paddingHorizontal: 24, paddingTop: 18 },
  blockTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 8 },
  sectionSubtitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 6 },
  sectionSubtitleSpaced: { marginTop: 14 },
  primaryAboveRevengeWrap: { marginTop: 16, marginBottom: 4 },
  revengeCounter: { fontSize: 15, fontWeight: '700', color: '#111827', marginBottom: 8 },
  meta: { fontSize: 14, color: '#666', marginBottom: 4 },
  matchMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  matchStartedBy: { fontSize: 12, color: '#6B7280', marginLeft: 6 },
  matchChartBtn: {
    justifyContent: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 4,
    marginRight: 4,
  },
  matchChartEmoji: { fontSize: 18 },
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
