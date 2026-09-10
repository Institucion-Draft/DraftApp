/**
 * Armado del top4 real de round_robin_bo1_top4 (competition_format='round_robin' + top_size=4,
 * ver 0076): calcula desde el estado ACTUAL de pairings/participantes si el corte del 4to
 * puesto está resuelto sin empate (arma el bracket real de una) o en disputa (arma el
 * desempate de 4to puesto, group_origin='round_robin_fourth_place', 0071/0072).
 *
 * Compartida por dos llamadores:
 * - EventDetailScreen.tsx: creación original, cuando la fase regular queda 100% resuelta
 *   (allResolved).
 * - PlayerProfileInEventScreen.tsx (Fase 4 del walkover): recálculo tras un abandono ANTES de
 *   que arranque cualquier semi del bracket real — el caller ya cerró el grupo viejo (status=
 *   'resolved', preserva la evidencia — close_active_round_robin_topcut_bracket_group) y vuelve
 *   a llamar esto con el roster actual.
 *
 * Mismo principio que roundRobinFirstPlaceTiebreak.ts: quien tiene left_event_at seteado queda
 * excluido de `standings` (computeFinalStandingsWithTiebreakSplit ya filtra por leftEventAt) —
 * pero sus resultados reales siguen en `pairingResults` sin tocar, así que el head-to-head/
 * calidad de rivales de los demás NUNCA se recalcula por su salida, solo se libera la seed que
 * ocupaba: el siguiente en la orden de mérito (5°, o el que corresponda en cascada si hay más
 * de una salida) sube a ocuparla — no hace falta ningún corrimiento manual, es consecuencia
 * directa de recomputar standings con el roster actual y volver a tomar el top4.
 *
 * Fase 5 (desempate de 4to puesto) queda fuera de este recálculo: si al recomputar surge un
 * empate genuino en el corte del top4, este helper arma ese desempate (comportamiento normal,
 * ya existente) pero no es todavía walkover-safe en sí mismo — se endurece cuando se implemente
 * la Fase 5.
 */

import { supabase } from './supabase';
import {
  computeFinalStandingsWithTiebreakSplit,
  computeFourthPlaceTiebreakBracket,
  type RoundRobinStandingInput,
  type RoundRobinPairingResult,
} from './podium';

export type Top4BracketOutcome =
  | { kind: 'no_dispute' }
  | { kind: 'bracket_created'; top4ParticipantIds: string[] }
  | { kind: 'fourth_place_group_created'; tiedParticipantIds: string[] }
  | { kind: 'error'; message: string };

export async function computeAndCreateTop4Bracket(
  eventId: string,
  isBo2: boolean,
  participants: { id: string; left_event_at: string | null }[]
): Promise<Top4BracketOutcome> {
  const rrPairingsRes = await supabase
    .from('pairings')
    .select('participant_a_id, participant_b_id, official_winner_participant_id, official_draw')
    .eq('event_id', eventId);
  if (rrPairingsRes.error || !rrPairingsRes.data) {
    return {
      kind: 'error',
      message: rrPairingsRes.error?.message ?? 'No se pudieron cargar los enfrentamientos.',
    };
  }
  const rrPairings = rrPairingsRes.data as {
    participant_a_id: string;
    participant_b_id: string;
    official_winner_participant_id: string | null;
    official_draw: boolean;
  }[];

  const pointsByParticipant: Record<string, number> = {};
  for (const part of participants) pointsByParticipant[part.id] = 0;
  for (const pr of rrPairings) {
    const w = pr.official_winner_participant_id;
    if (w != null) {
      pointsByParticipant[w] = (pointsByParticipant[w] ?? 0) + (isBo2 ? 3 : 1);
    } else if (isBo2 && pr.official_draw) {
      pointsByParticipant[pr.participant_a_id] = (pointsByParticipant[pr.participant_a_id] ?? 0) + 1;
      pointsByParticipant[pr.participant_b_id] = (pointsByParticipant[pr.participant_b_id] ?? 0) + 1;
    }
  }

  const standingInputs: RoundRobinStandingInput[] = participants.map((part) => ({
    participantId: part.id,
    points: pointsByParticipant[part.id] ?? 0,
    leftEventAt: part.left_event_at,
  }));
  const pairingResults: RoundRobinPairingResult[] = rrPairings.map((pr) => {
    const isDraw = pr.official_winner_participant_id == null && pr.official_draw;
    const winnerIsA = pr.official_winner_participant_id === pr.participant_a_id;
    const winnerIsB = pr.official_winner_participant_id === pr.participant_b_id;
    const pointsA = isBo2 ? (winnerIsA ? 3 : isDraw ? 1 : 0) : winnerIsA ? 1 : 0;
    const pointsB = isBo2 ? (winnerIsB ? 3 : isDraw ? 1 : 0) : winnerIsB ? 1 : 0;
    return {
      participantAId: pr.participant_a_id,
      participantBId: pr.participant_b_id,
      winnerParticipantId: pr.official_winner_participant_id,
      isDraw,
      pointsA,
      pointsB,
    };
  });

  // cutoffPosition default (3, 0-based = 4to puesto).
  const { standings, fourthPlaceTieGroup } = computeFinalStandingsWithTiebreakSplit(
    standingInputs,
    pairingResults
  );

  if (fourthPlaceTieGroup.length === 0) {
    // Sin empate en el corte del 4to puesto: top4 directo. Si el recálculo dejó menos de 4
    // elegibles (varias salidas seguidas en un evento chico), no hay top4 posible todavía.
    if (standings.length < 4) {
      return { kind: 'no_dispute' };
    }
    const top4 = standings.slice(0, 4);
    const rpcRes = await supabase.rpc('create_round_robin_top4_bracket', {
      p_event_id: eventId,
      p_top4_ordered: top4,
    });
    if (rpcRes.error) {
      return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el top4.' };
    }
    return { kind: 'bracket_created', top4ParticipantIds: top4 };
  }

  // Empate genuino en el corte: mismos 3 lugares no en disputa + desempate de 4to puesto
  // (Fase 5, comportamiento ya existente, sin endurecer walkover todavía).
  const top3 = standings.filter((pid) => !fourthPlaceTieGroup.includes(pid)).slice(0, 3);
  const { fourthPlaceParticipantId, matches } = computeFourthPlaceTiebreakBracket(
    fourthPlaceTieGroup,
    pairingResults
  );

  if (matches.length === 0 && fourthPlaceParticipantId != null) {
    if (top3.length !== 3) {
      return { kind: 'no_dispute' };
    }
    const top4 = [...top3, fourthPlaceParticipantId];
    const rpcRes = await supabase.rpc('create_round_robin_top4_bracket', {
      p_event_id: eventId,
      p_top4_ordered: top4,
    });
    if (rpcRes.error) {
      return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el top4.' };
    }
    return { kind: 'bracket_created', top4ParticipantIds: top4 };
  }

  if (matches.length > 0 && top3.length === 3) {
    const rpcRes = await supabase.rpc('create_fourth_place_tiebreak_group', {
      p_event_id: eventId,
      p_matches: matches,
      p_top3_ordered: top3,
    });
    if (rpcRes.error) {
      return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el desempate de 4to puesto.' };
    }
    return { kind: 'fourth_place_group_created', tiedParticipantIds: fourthPlaceTieGroup };
  }

  return { kind: 'no_dispute' };
}
