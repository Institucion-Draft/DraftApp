/**
 * Armado de los datos de entrada de `computePodium` (podium.ts). Extraído de StandingsScreen.load()
 * para que el podio del evento, el podio "asegurado" que se congela en el cierre forzado de una
 * temporada, y el historial de posiciones del perfil de jugador salgan del MISMO código:
 * StandingsScreen usa estas funciones para armar su podio, y fetchEventPodium/fetchEventPodiums
 * las usan para calcular el podio de uno o varios eventos sin abrir esa pantalla.
 *
 * fetchEventPodium(eventId) es un caso particular de fetchEventPodiums([eventId]) — mismo código,
 * para que los dos caminos nunca puedan divergir. fetchEventPodiums hace 7 queries en total sin
 * importar cuántos eventos se pidan (batch por event_id/pairing_id/group_id), en vez de repetir
 * ~6-7 queries por evento: pensado para pantallas que necesitan el podio de varios eventos a la
 * vez (p. ej. el historial de "últimos drafts" de un perfil).
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
  event_id?: string;
  member_b_user_id?: string | null;
  users?: unknown;
};

export type PodiumPairingRow = {
  id: string;
  event_id?: string;
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

type RawBracketMatchQueryRow = {
  bracket_phase: 'semi' | 'final' | 'third_place';
  participant_a_id: string;
  participant_b_id: string;
  winner_participant_id: string | null;
};

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

/**
 * Ensambla PodiumTiebreakInputs a partir de filas YA obtenidas (sin I/O) — compartida por
 * fetchPodiumTiebreakInputs (un evento, hace sus propias queries) y fetchEventPodiums (varios
 * eventos, las trae todas en lote antes de llamar acá).
 */
function buildPodiumTiebreakInputs(
  tgRow: PodiumTiebreakGroupRow,
  groupParticipantsRows: PodiumGroupParticipant[] | null,
  bracketMatchesRows: RawBracketMatchQueryRow[],
  pairings: PodiumPairingRow[],
  matches: PodiumMatchRow[]
): PodiumTiebreakInputs {
  let group: ActiveTiebreakGroupPodiumInput | null = null;
  if (groupParticipantsRows && groupParticipantsRows.length > 0) {
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
      participants: groupParticipantsRows,
    };
  }

  const tiebreakMatches: TiebreakMatchPodiumInput[] = [];
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

  const bracketMatches: BracketMatchPodiumInput[] =
    tgRow.group_type === 'bracket' || tgRow.group_type === 'fourth_place'
      ? bracketMatchesRows.map((r) => ({
          bracket_phase: r.bracket_phase,
          participant_a_id: String(r.participant_a_id),
          participant_b_id: String(r.participant_b_id),
          winner_participant_id: r.winner_participant_id != null ? String(r.winner_participant_id) : null,
        }))
      : [];

  return {
    group,
    matches: tiebreakMatches,
    bracketMatches,
    groupParticipants: groupParticipantsRows,
    groupOrigin: tgRow.group_origin ?? 'tiebreak',
  };
}

/** Datos del desempate/bracket más reciente del evento (`tgRow`) para computePodium. */
export async function fetchPodiumTiebreakInputs(
  tgRow: PodiumTiebreakGroupRow,
  pairings: PodiumPairingRow[],
  matches: PodiumMatchRow[]
): Promise<PodiumTiebreakInputs> {
  const gpRes = await supabase
    .from('event_tiebreak_group_participants')
    .select('participant_id, user_id, seed')
    .eq('group_id', tgRow.id);
  const groupParticipantsRows = !gpRes.error && gpRes.data ? (gpRes.data as PodiumGroupParticipant[]) : null;

  let bracketMatchesRows: RawBracketMatchQueryRow[] = [];
  if (tgRow.group_type === 'bracket' || tgRow.group_type === 'fourth_place') {
    const bmRes = await supabase
      .from('event_tiebreak_bracket_matches')
      .select('bracket_phase, participant_a_id, participant_b_id, winner_participant_id')
      .eq('group_id', tgRow.id);
    if (!bmRes.error && bmRes.data) bracketMatchesRows = bmRes.data as RawBracketMatchQueryRow[];
  }

  return buildPodiumTiebreakInputs(tgRow, groupParticipantsRows, bracketMatchesRows, pairings, matches);
}

export type EventPodiumResult = {
  podium: PodiumState;
  /** Jugadores role='player' del evento (el mismo player_count que usa el servidor para los puntos). */
  playerCount: number;
};

type RawEventRow = {
  id: string;
  champion_user_id?: string | null;
  champion_decided_by?: string | null;
  polemica_winners?: string[] | null;
  recognition_winners?: string[] | null;
  competition_format?: string | null;
  top_size?: number | null;
};

/**
 * Podio actual de varios eventos a la vez (campeón seguro, peldaños asegurados, etc.), con 7
 * queries en total sin importar cuántos eventos se pidan. Devuelve un Map con solo los eventos
 * que se pudieron calcular (un id ausente equivale al `null` de fetchEventPodium para ese evento).
 */
export async function fetchEventPodiums(eventIds: string[]): Promise<Map<string, EventPodiumResult>> {
  const out = new Map<string, EventPodiumResult>();
  const ids = Array.from(new Set(eventIds));
  if (ids.length === 0) return out;

  const [partsRes, pairingsRes, eventsRes, groupsRes] = await Promise.all([
    supabase
      .from('event_participants')
      .select(
        `
        id,
        event_id,
        user_id,
        member_b_user_id,
        users!event_participants_user_id_fkey (
          username,
          display_name
        )
      `
      )
      .in('event_id', ids)
      .eq('role', 'player'),
    supabase
      .from('pairings')
      .select('id, event_id, participant_a_id, participant_b_id, official_winner_participant_id, official_draw')
      .in('event_id', ids),
    supabase
      .from('draft_events')
      .select('id, champion_user_id, champion_decided_by, polemica_winners, recognition_winners, competition_format, top_size')
      .in('id', ids),
    supabase
      .from('event_tiebreak_groups')
      .select('id, event_id, champion_user_id, status, group_type, round_number, created_at, group_origin')
      .in('event_id', ids)
      .in('status', ['active', 'resolved', 'failed']),
  ]);
  if (partsRes.error || pairingsRes.error || eventsRes.error || groupsRes.error) return out;

  const participants = (partsRes.data ?? []) as (PodiumParticipantRow & { event_id: string })[];
  const pairings = (pairingsRes.data ?? []) as (PodiumPairingRow & { event_id: string })[];
  const events = (eventsRes.data ?? []) as RawEventRow[];
  const groupRows = (groupsRes.data ?? []) as (PodiumTiebreakGroupRow & { event_id: string; created_at: string })[];

  const pairingIds = pairings.map((p) => p.id);
  const matchesRes =
    pairingIds.length > 0
      ? await supabase
          .from('matches')
          .select('id, pairing_id, winner_participant_id, status, ended_at, match_type, tiebreak_round')
          .in('pairing_id', pairingIds)
      : { data: [], error: null };
  if (matchesRes.error) return out;
  const matches = (matchesRes.data ?? []) as PodiumMatchRow[];

  // El grupo de desempate MÁS RECIENTE por evento — mismo criterio (order by created_at desc,
  // limit 1) que el path de un solo evento, aplicado en el cliente sobre el lote ya traído.
  const latestGroupByEvent = new Map<string, PodiumTiebreakGroupRow & { event_id: string; created_at: string }>();
  for (const g of groupRows) {
    const cur = latestGroupByEvent.get(g.event_id);
    if (!cur || new Date(g.created_at).getTime() > new Date(cur.created_at).getTime()) {
      latestGroupByEvent.set(g.event_id, g);
    }
  }
  const relevantGroups = Array.from(latestGroupByEvent.values());
  const groupIds = relevantGroups.map((g) => g.id);
  const bracketGroupIds = relevantGroups
    .filter((g) => g.group_type === 'bracket' || g.group_type === 'fourth_place')
    .map((g) => g.id);

  const [gpRes, bmRes] = await Promise.all([
    groupIds.length > 0
      ? supabase
          .from('event_tiebreak_group_participants')
          .select('group_id, participant_id, user_id, seed')
          .in('group_id', groupIds)
      : Promise.resolve({ data: [] as (PodiumGroupParticipant & { group_id: string })[], error: null }),
    bracketGroupIds.length > 0
      ? supabase
          .from('event_tiebreak_bracket_matches')
          .select('group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id')
          .in('group_id', bracketGroupIds)
      : Promise.resolve({ data: [] as (RawBracketMatchQueryRow & { group_id: string })[], error: null }),
  ]);

  const groupParticipantsByGroup = new Map<string, PodiumGroupParticipant[]>();
  if (!gpRes.error) {
    for (const row of (gpRes.data ?? []) as (PodiumGroupParticipant & { group_id: string })[]) {
      if (!groupParticipantsByGroup.has(row.group_id)) groupParticipantsByGroup.set(row.group_id, []);
      groupParticipantsByGroup.get(row.group_id)!.push(row);
    }
  }
  const bracketMatchesByGroup = new Map<string, RawBracketMatchQueryRow[]>();
  if (!bmRes.error) {
    for (const row of (bmRes.data ?? []) as (RawBracketMatchQueryRow & { group_id: string })[]) {
      if (!bracketMatchesByGroup.has(row.group_id)) bracketMatchesByGroup.set(row.group_id, []);
      bracketMatchesByGroup.get(row.group_id)!.push(row);
    }
  }

  const participantsByEvent = new Map<string, PodiumParticipantRow[]>();
  for (const p of participants) {
    if (!participantsByEvent.has(p.event_id)) participantsByEvent.set(p.event_id, []);
    participantsByEvent.get(p.event_id)!.push(p);
  }
  const pairingsByEvent = new Map<string, PodiumPairingRow[]>();
  const pairingToEvent = new Map<string, string>();
  for (const pr of pairings) {
    if (!pairingsByEvent.has(pr.event_id)) pairingsByEvent.set(pr.event_id, []);
    pairingsByEvent.get(pr.event_id)!.push(pr);
    pairingToEvent.set(pr.id, pr.event_id);
  }
  const matchesByEvent = new Map<string, PodiumMatchRow[]>();
  for (const m of matches) {
    const evId = pairingToEvent.get(m.pairing_id);
    if (!evId) continue;
    if (!matchesByEvent.has(evId)) matchesByEvent.set(evId, []);
    matchesByEvent.get(evId)!.push(m);
  }

  for (const ev of events) {
    const eventParticipants = participantsByEvent.get(ev.id) ?? [];
    const eventPairings = pairingsByEvent.get(ev.id) ?? [];
    const eventMatches = matchesByEvent.get(ev.id) ?? [];

    let group: ActiveTiebreakGroupPodiumInput | null = null;
    let tiebreakMatches: TiebreakMatchPodiumInput[] = [];
    let bracketMatches: BracketMatchPodiumInput[] = [];
    const tgRow = latestGroupByEvent.get(ev.id);
    if (tgRow) {
      const groupParticipantsRows = gpRes.error ? null : (groupParticipantsByGroup.get(tgRow.id) ?? []);
      const bracketMatchesRows = bracketMatchesByGroup.get(tgRow.id) ?? [];
      const tb = buildPodiumTiebreakInputs(tgRow, groupParticipantsRows, bracketMatchesRows, eventPairings, eventMatches);
      group = tb.group;
      tiebreakMatches = tb.matches;
      bracketMatches = tb.bracketMatches;
    }

    const podium = computePodium(
      buildPodiumPlayers(eventParticipants, eventPairings, eventMatches),
      buildPairingRemain(eventPairings),
      eventParticipants.length,
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
    out.set(ev.id, { podium, playerCount: eventParticipants.length });
  }

  return out;
}

/** Podio actual de UN evento. Caso particular de fetchEventPodiums — mismo código, sin duplicar. */
export async function fetchEventPodium(eventId: string): Promise<EventPodiumResult | null> {
  const map = await fetchEventPodiums([eventId]);
  return map.get(eventId) ?? null;
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
