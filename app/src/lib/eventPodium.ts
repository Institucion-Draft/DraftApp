/**
 * Armado de los datos de entrada de `computePodium` (podium.ts). Extraído de StandingsScreen.load()
 * para que el podio del evento y el podio "asegurado" que se congela en el cierre forzado de una
 * temporada salgan del MISMO código: StandingsScreen usa estas funciones para armar su podio y
 * `fetchEventPodium` las usa para calcular el podio de un evento sin abrir esa pantalla.
 */
import { supabase } from './supabase';
import {
  computePodium,
  type ActiveTiebreakGroupPodiumInput,
  type BracketMatchPodiumInput,
  type PairingRemain,
  type PodiumPlayer,
  type PodiumState,
  type TiebreakMatchPodiumInput,
} from './podium';

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export type PodiumParticipantRow = {
  id: string;
  user_id: string;
  member_b_user_id?: string | null;
  users?: unknown;
};

export type PodiumPairingRow = {
  id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  official_draw?: boolean | null;
};

export type PodiumMatchRow = {
  pairing_id: string;
  winner_participant_id: string | null;
  status: string;
  match_type: string;
  ended_at?: string | null;
  tiebreak_round?: number | null;
};

export type PodiumTiebreakGroupRow = {
  id: string;
  champion_user_id: string | null;
  status: string;
  group_type: string;
  round_number: number;
  group_origin?: string | null;
};

export type PodiumGroupParticipant = { participant_id: string; user_id: string; seed: number };

/** Stats por jugador que consume computePodium (BO3 y partidas oficiales completadas). */
export function buildPodiumPlayers(
  participants: PodiumParticipantRow[],
  pairings: PodiumPairingRow[],
  matches: PodiumMatchRow[]
): PodiumPlayer[] {
  return participants.map((p) => {
    const pid = p.id;
    const userId = p.user_id;
    const u = relationOne(p.users as { display_name?: string; username?: string } | { display_name?: string; username?: string }[] | null);
    const name = u?.display_name || u?.username || 'Jugador';
    const playerPairings = pairings.filter((pr) => pr.participant_a_id === pid || pr.participant_b_id === pid);
    const pairingSet = new Set(playerPairings.map((x) => x.id));
    const playerMatches = matches.filter((m) => pairingSet.has(m.pairing_id));
    const officialDone = playerMatches.filter(
      (m) =>
        m.status === 'completed' &&
        (m.match_type === 'draft' || m.match_type === 'final') &&
        m.winner_participant_id != null &&
        String(m.winner_participant_id).length > 0
    );
    const pgOff = officialDone.filter((m) => m.winner_participant_id === pid).length;
    const pjOff = officialDone.length;
    const eg = playerPairings.filter((pr) => pr.official_winner_participant_id === pid).length;
    const ec = playerPairings.filter(
      (pr) => pr.official_winner_participant_id != null || pr.official_draw === true
    ).length;
    return {
      participantId: pid,
      userId,
      name,
      avatarUserId: userId,
      memberBUserId: (p.member_b_user_id as string | null | undefined) ?? null,
      bo3Won: eg,
      bo3Completed: ec,
      bo3WinRate: ec > 0 ? eg / ec : 0,
      matchesWon: pgOff,
      matchesCompleted: pjOff,
      matchWinRate: pjOff > 0 ? pgOff / pjOff : 0,
    };
  });
}

/**
 * Pairings todavía sin resolver. isBlocked ya no distingue "alguien de este pairing se fue": con
 * el walkover (0082) un pairing pendiente contra alguien que se fue se resuelve solo, así que
 * mientras siga pendiente es incertidumbre real (igual que compute_event_champion, 0083).
 */
export function buildPairingRemain(pairings: PodiumPairingRow[]): PairingRemain[] {
  return pairings
    .filter((pr) => pr.official_winner_participant_id == null && pr.official_draw !== true)
    .map((pr) => ({
      participantAId: String(pr.participant_a_id),
      participantBId: String(pr.participant_b_id),
      isBlocked: false,
    }));
}

export type PodiumTiebreakInputs = {
  group: ActiveTiebreakGroupPodiumInput | null;
  matches: TiebreakMatchPodiumInput[];
  bracketMatches: BracketMatchPodiumInput[];
  /** Participantes crudos del grupo (null si la query falló); StandingsScreen los usa para el cuadro suizo. */
  groupParticipants: PodiumGroupParticipant[] | null;
  groupOrigin: string;
};

/** Datos del desempate/bracket más reciente del evento (`tgRow`) para computePodium. */
export async function fetchPodiumTiebreakInputs(
  tgRow: PodiumTiebreakGroupRow,
  pairings: PodiumPairingRow[],
  matches: PodiumMatchRow[]
): Promise<PodiumTiebreakInputs> {
  let group: ActiveTiebreakGroupPodiumInput | null = null;
  const tiebreakMatches: TiebreakMatchPodiumInput[] = [];
  let bracketMatches: BracketMatchPodiumInput[] = [];

  const gpRes = await supabase
    .from('event_tiebreak_group_participants')
    .select('participant_id, user_id, seed')
    .eq('group_id', tgRow.id);
  if (!gpRes.error && gpRes.data && (gpRes.data as { participant_id: string }[]).length > 0) {
    group = {
      id: tgRow.id,
      group_type:
        tgRow.group_type === 'bracket'
          ? 'bracket'
          : tgRow.group_type === 'fourth_place'
            ? 'fourth_place'
            : 'round_robin',
      group_origin: tgRow.group_origin ?? null,
      round_number: tgRow.round_number ?? 1,
      champion_user_id: tgRow.champion_user_id,
      participants: gpRes.data as PodiumGroupParticipant[],
    };
  }
  const prById = new Map(pairings.map((pr) => [String(pr.id), pr]));
  for (const m of matches) {
    if (m.match_type !== 'tiebreak' || m.status !== 'completed') continue;
    if (m.winner_participant_id == null || String(m.winner_participant_id).length === 0) continue;
    const pr = prById.get(String(m.pairing_id));
    if (!pr) continue;
    tiebreakMatches.push({
      pairing_id: String(m.pairing_id),
      participant_a_id: String(pr.participant_a_id),
      participant_b_id: String(pr.participant_b_id),
      winner_participant_id: String(m.winner_participant_id),
      ended_at: m.ended_at != null ? String(m.ended_at) : null,
      tiebreak_round: m.tiebreak_round != null ? Number(m.tiebreak_round) : null,
    });
  }
  if (tgRow.group_type === 'bracket' || tgRow.group_type === 'fourth_place') {
    const bmRes = await supabase
      .from('event_tiebreak_bracket_matches')
      .select('bracket_phase, participant_a_id, participant_b_id, winner_participant_id')
      .eq('group_id', tgRow.id);
    if (!bmRes.error && bmRes.data) {
      bracketMatches = (bmRes.data as {
        bracket_phase: 'semi' | 'final' | 'third_place';
        participant_a_id: string;
        participant_b_id: string;
        winner_participant_id: string | null;
      }[]).map((r) => ({
        bracket_phase: r.bracket_phase,
        participant_a_id: String(r.participant_a_id),
        participant_b_id: String(r.participant_b_id),
        winner_participant_id: r.winner_participant_id != null ? String(r.winner_participant_id) : null,
      }));
    }
  }

  return {
    group,
    matches: tiebreakMatches,
    bracketMatches,
    groupParticipants: !gpRes.error && gpRes.data ? (gpRes.data as PodiumGroupParticipant[]) : null,
    groupOrigin: tgRow.group_origin ?? 'tiebreak',
  };
}

export type EventPodiumResult = {
  podium: PodiumState;
  /** Jugadores role='player' del evento (el mismo player_count que usa el servidor para los puntos). */
  playerCount: number;
};

/** Podio actual de un evento (campeón seguro, peldaños asegurados, etc.). null si falló alguna query. */
export async function fetchEventPodium(eventId: string): Promise<EventPodiumResult | null> {
  const [partsRes, pairingsRes, eventRes, tiebreakGroupRes] = await Promise.all([
    supabase
      .from('event_participants')
      .select(
        `
        id,
        user_id,
        member_b_user_id,
        users!event_participants_user_id_fkey (
          username,
          display_name
        )
      `
      )
      .eq('event_id', eventId)
      .eq('role', 'player'),
    supabase
      .from('pairings')
      .select('id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw')
      .eq('event_id', eventId),
    supabase
      .from('draft_events')
      .select('champion_user_id, champion_decided_by, polemica_winners, recognition_winners, competition_format, top_size')
      .eq('id', eventId)
      .maybeSingle(),
    supabase
      .from('event_tiebreak_groups')
      .select('id, champion_user_id, status, group_type, round_number, created_at, group_origin')
      .eq('event_id', eventId)
      .in('status', ['active', 'resolved', 'failed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (partsRes.error || pairingsRes.error || eventRes.error || !eventRes.data) return null;

  const participants = (partsRes.data ?? []) as PodiumParticipantRow[];
  const pairings = (pairingsRes.data ?? []) as PodiumPairingRow[];
  const pairingIds = pairings.map((p) => p.id);

  const matchesRes =
    pairingIds.length > 0
      ? await supabase
          .from('matches')
          .select('id, pairing_id, winner_participant_id, status, ended_at, match_type, tiebreak_round')
          .in('pairing_id', pairingIds)
      : { data: [], error: null };
  if (matchesRes.error) return null;
  const matches = (matchesRes.data ?? []) as PodiumMatchRow[];

  const ev = eventRes.data as {
    champion_user_id?: string | null;
    champion_decided_by?: string | null;
    polemica_winners?: string[] | null;
    recognition_winners?: string[] | null;
    competition_format?: string | null;
    top_size?: number | null;
  };

  let group: ActiveTiebreakGroupPodiumInput | null = null;
  let tiebreakMatches: TiebreakMatchPodiumInput[] = [];
  let bracketMatches: BracketMatchPodiumInput[] = [];
  if (!tiebreakGroupRes.error && tiebreakGroupRes.data) {
    const tb = await fetchPodiumTiebreakInputs(tiebreakGroupRes.data as PodiumTiebreakGroupRow, pairings, matches);
    group = tb.group;
    tiebreakMatches = tb.matches;
    bracketMatches = tb.bracketMatches;
  }

  const podium = computePodium(
    buildPodiumPlayers(participants, pairings, matches),
    buildPairingRemain(pairings),
    participants.length,
    ev.champion_user_id ?? null,
    group,
    tiebreakMatches,
    ev.champion_decided_by ?? null,
    (ev.polemica_winners ?? []) as string[],
    (ev.recognition_winners ?? []) as string[],
    bracketMatches,
    ev.competition_format ?? null,
    ev.top_size ?? null
  );
  return { podium, playerCount: participants.length };
}

export type SecuredPosition = { event_id: string; user_id: string; position: number };

/** Peldaños con jugadores -> filas del payload de force_close_season (un peldaño compartido = varias filas). */
export function podiumToPositions(eventId: string, podium: PodiumState): SecuredPosition[] {
  const out: SecuredPosition[] = [];
  for (const step of podium.steps) {
    for (const player of step.players) {
      out.push({ event_id: eventId, user_id: player.userId, position: step.rank });
    }
  }
  return out;
}
