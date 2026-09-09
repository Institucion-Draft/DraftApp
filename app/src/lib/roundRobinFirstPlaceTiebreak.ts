/**
 * Desempate de 1er puesto de round_robin BO3 clásico (sin top_size), group_origin=
 * 'round_robin_first_place'. Calcula desde el estado ACTUAL de pairings/participantes y arma el
 * grupo (create_round_robin_first_place_tiebreak_group), o corona campeón directo si el cálculo
 * deja a un único participante en disputa.
 *
 * Compartida por dos llamadores:
 * - EventDetailScreen.tsx: creación original, cuando compute_event_champion marca
 *   final_pending=true (grupo de 2+ recién detectado).
 * - PlayerProfileInEventScreen.tsx (Fase 3 del walkover): recálculo tras un abandono, ANTES de
 *   que arranque cualquier pierna del desempate — el caller ya cerró el grupo viejo (status=
 *   'resolved', preserva la evidencia de la disputa — close_active_round_robin_first_place_group,
 *   0086) y vuelve a llamar esto con el roster actual.
 *
 * En ambos casos, quien tiene left_event_at seteado queda excluido de `standings`/la disputa
 * (computeFinalStandingsWithTiebreakSplit ya filtra por leftEventAt) — pero sus resultados
 * reales siguen en `pairingResults` sin tocar, así que el head-to-head/calidad de rivales de
 * los demás participantes NUNCA se recalcula por su salida, solo se libera la plaza que
 * ocupaba (confirmado en el diseño de Fase 3).
 */

import { supabase } from './supabase';
import {
  computeFinalStandingsWithTiebreakSplit,
  computeFourthPlaceTiebreakBracket,
  type RoundRobinStandingInput,
  type RoundRobinPairingResult,
} from './podium';

export type FirstPlaceTiebreakOutcome =
  | { kind: 'no_dispute' }
  | { kind: 'champion_crowned'; championParticipantId: string }
  | { kind: 'group_created'; tiedParticipantIds: string[] }
  | { kind: 'error'; message: string };

export async function computeAndCreateFirstPlaceTiebreakGroup(
  eventId: string,
  isBo2: boolean,
  participants: { id: string; left_event_at: string | null }[]
): Promise<FirstPlaceTiebreakOutcome> {
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

  // BO1/BO3 = 1 punto por pairing ganado; BO2 = 3 por ganado, 1 por empate — mismo criterio que
  // EventDetailScreen.tsx usa en el resto de los bloques de standings.
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

  // cutoffPosition=0: la frontera es el 1er puesto (índice 0-based), no el 4to.
  const { standings, cutoffTieGroup } = computeFinalStandingsWithTiebreakSplit(
    standingInputs,
    pairingResults,
    0
  );

  if (standings.length === 0) {
    // Nadie elegible (por ejemplo, todos los que quedaban activos se fueron también).
    return { kind: 'no_dispute' };
  }

  if (cutoffTieGroup.length <= 1) {
    // Sin empate genuino: standings[0] es el único líder. Cubre tanto "nunca hubo empate" como
    // "el recálculo tras una salida dejó a 1 solo participante en disputa" — en ese segundo
    // caso, ese único participante es directamente el campeón.
    const championParticipantId = standings[0]!;
    const championRes = await supabase
      .from('event_participants')
      .select('user_id')
      .eq('id', championParticipantId)
      .maybeSingle();
    if (championRes.error || !championRes.data) {
      return {
        kind: 'error',
        message: championRes.error?.message ?? 'No se pudo resolver el campeón.',
      };
    }
    await supabase
      .from('draft_events')
      .update({
        champion_user_id: championRes.data.user_id,
        champion_decided_by: 'tiebreak',
        event_ended_at: new Date().toISOString(),
        status: 'completed',
        final_pending: false,
      })
      .eq('id', eventId)
      .is('champion_user_id', null);
    return { kind: 'champion_crowned', championParticipantId };
  }

  const tied = cutoffTieGroup.length > 4 ? cutoffTieGroup.slice(0, 4) : cutoffTieGroup;
  const { matches } = computeFourthPlaceTiebreakBracket(tied, pairingResults);
  if (matches.length === 0) {
    return { kind: 'no_dispute' };
  }

  const rpcRes = await supabase.rpc('create_round_robin_first_place_tiebreak_group', {
    p_event_id: eventId,
    p_matches: matches,
    p_tied_participants_ordered: tied,
  });
  if (rpcRes.error) {
    return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el desempate.' };
  }
  return { kind: 'group_created', tiedParticipantIds: tied };
}
