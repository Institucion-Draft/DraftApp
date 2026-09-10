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
 * Fase 5 (desempate de 4to puesto): si al recomputar surge un empate genuino en el corte del
 * top4, este helper arma ese desempate (`create_fourth_place_tiebreak_group`, comportamiento
 * normal ya existente). `options.minDisputeSize` (usado por el caller de Fase 5, nunca por la
 * creación original) completa ese grupo empatado hasta ese tamaño tomando el siguiente en
 * mérito general de `standings` — sin esto, un grupo de 4 empatados que pierde a uno por
 * abandono quedaría en 3 en vez de reponerse: `computeFinalStandingsWithTiebreakSplit` filtra el
 * empate por IGUALDAD de puntos, así que alguien con menos puntos (el candidato de reemplazo)
 * nunca entra ahí solo — hace falta este paso explícito para no reducir artificialmente el
 * tamaño de la disputa por una salida (confirmado: se reemplaza, nunca se achica).
 *
 * Bug encontrado en la interacción Fase 4 × Fase 5 (alguien del top3, sin ambigüedad, se va
 * DESPUÉS de que el 4to puesto ya se resolvió por una disputa real y el bracket real de top4
 * todavía no arrancó): recomputar standings desde pairings vuelve a ver a los que empataron por
 * el 4to puesto exactamente tan empatados como siempre (esa disputa nunca tocó `pairings`), así
 * que se volvía a disparar create_fourth_place_tiebreak_group — un desempate NUEVO para algo que
 * ya se jugó y resolvió. Fix confirmado, dos partes:
 *   1. Guard: si para este evento YA existe alguna fila group_type='bracket' (activa o
 *      resuelta/superseded, no importa el status — su sola existencia prueba que el top4 real
 *      ya se determinó una vez), NUNCA se vuelve a evaluar/crear un desempate de 4to puesto,
 *      sin importar qué corrimiento esté ocurriendo.
 *   2. Con el guard activo, el "grupo empatado" en el corte no arma un desempate nuevo — se
 *      completa el top4 directo usando, para cada empatado, el orden REAL de la disputa
 *      round_robin_fourth_place que ya se jugó para ese conjunto (resolveFourthPlaceDisputeOrder
 *      sobre su event_tiebreak_bracket_matches), no el orden arbitrario de standings. Quien no
 *      formó parte de ninguna disputa histórica (empate genuinamente nuevo entre gente que
 *      nunca compitió por el 4to puesto) cae al orden de standings como antes.
 *
 * Segundo bug, encontrado probando el primero en vivo: `fourthPlaceTieGroup` (tanda1, solo
 * `pairingResults` de fase regular) puede quedar CORTO — alguien que perdió la final de una
 * disputa real (partidas tiebreak aparte, `pairingResults` nunca las ve) puede tener un
 * head-to-head de fase regular que lo distinga limpio de sus rivales de esa disputa, cayendo
 * fuera del "empate" detectado y colándose en top3 por descarte. Fix: `combinedGroup` (fetch
 * HistoricalDisputedIds + fourthPlaceTieGroup) reemplaza a fourthPlaceTieGroup en todo lo que
 * sigue — `top3` excluye el grupo combinado, no solo el detectado por tanda1. Como consecuencia,
 * `top3` puede legítimamente tener menos de 3 en la rama de bracket ya existente (el resto lo
 * completa el orden de reemplazo) — se saca el guard `top3.length !== 3` de esa rama, la
 * suficiencia real la sigue verificando `top4.length < 4` después de armar el array completo.
 */

import { supabase } from './supabase';
import {
  computeFinalStandingsWithTiebreakSplit,
  computeFourthPlaceTiebreakBracket,
  resolveFourthPlaceDisputeOrder,
  type BracketMatchPodiumInput,
  type RoundRobinStandingInput,
  type RoundRobinPairingResult,
} from './podium';

/** ¿Existe alguna fila group_type='bracket' (cualquier status) para este evento? Si sí, el top4
 *  real ya se determinó una vez — ningún desempate de 4to puesto debe volver a evaluarse. */
async function hasEverHadRealBracket(eventId: string): Promise<boolean> {
  const res = await supabase
    .from('event_tiebreak_groups')
    .select('id')
    .eq('event_id', eventId)
    .eq('group_type', 'bracket')
    .eq('group_origin', 'round_robin_topcut')
    .limit(1);
  return !res.error && (res.data?.length ?? 0) > 0;
}

/**
 * Todos los participantIds que en algún momento fueron parte de una disputa round_robin_
 * fourth_place de este evento (cualquier status — la activa/resuelta que se jugó de verdad, o
 * cualquier `superseded` de un recálculo anterior), leídos de `pending_bracket_matches` — la
 * única fuente que tiene a TODOS los concretos de la disputa (bye incluido), no
 * `event_tiebreak_group_participants` (esa guarda el top3 ajeno a la disputa).
 *
 * Necesario porque `computeFinalStandingsWithTiebreakSplit` solo mira `pairingResults` de la
 * fase regular: alguien que perdió la FINAL de una disputa real (partidas tiebreak aparte) puede
 * tener un head-to-head de fase regular que lo distinga limpio de sus rivales de esa disputa,
 * cayendo fuera de `fourthPlaceTieGroup` y colándose en top3 — aunque en la realidad ya jugada
 * su lugar es dentro del grupo que se resolvió por desempate (bug Fase 4 × Fase 5, confirmado en
 * vivo).
 */
async function fetchHistoricalDisputedIds(eventId: string): Promise<Set<string>> {
  const res = await supabase
    .from('event_tiebreak_groups')
    .select('pending_bracket_matches')
    .eq('event_id', eventId)
    .eq('group_origin', 'round_robin_fourth_place');
  const ids = new Set<string>();
  if (res.error || !res.data) return ids;
  for (const g of res.data as { pending_bracket_matches: unknown }[]) {
    const pending = g.pending_bracket_matches as
      | { a?: { participantId?: string }; b?: { participantId?: string } }[]
      | null;
    for (const m of pending ?? []) {
      if (m.a?.participantId) ids.add(m.a.participantId);
      if (m.b?.participantId) ids.add(m.b.participantId);
    }
  }
  return ids;
}

/**
 * Orden de reemplazo para un `tieGroup` (ya en orden de standings, hash-tie-break incluido):
 * busca, entre TODAS las disputas round_robin_fourth_place históricas de este evento (cualquier
 * status, más reciente primero), la más reciente que haya jugado de verdad a alguno de sus
 * integrantes, y usa ESE orden real para quienes se solapan con `tieGroup` — el resto (nadie
 * disputó nunca por ellos) queda con el orden de standings, al final.
 */
async function findReplacementOrder(
  eventId: string,
  tieGroup: string[],
  pairingResults: RoundRobinPairingResult[]
): Promise<string[]> {
  const groupsRes = await supabase
    .from('event_tiebreak_groups')
    .select('id, pending_bracket_matches')
    .eq('event_id', eventId)
    .eq('group_origin', 'round_robin_fourth_place')
    .order('created_at', { ascending: false });
  if (groupsRes.error || !groupsRes.data) return tieGroup;

  for (const g of groupsRes.data as { id: string; pending_bracket_matches: unknown }[]) {
    const pending = g.pending_bracket_matches as
      | { a?: { participantId?: string }; b?: { participantId?: string } }[]
      | null;
    const disputedIds = new Set<string>();
    for (const m of pending ?? []) {
      if (m.a?.participantId) disputedIds.add(m.a.participantId);
      if (m.b?.participantId) disputedIds.add(m.b.participantId);
    }
    if (!tieGroup.some((pid) => disputedIds.has(pid))) continue;

    const bmRes = await supabase
      .from('event_tiebreak_bracket_matches')
      .select('bracket_phase, participant_a_id, participant_b_id, winner_participant_id')
      .eq('group_id', g.id);
    if (bmRes.error || !bmRes.data) continue;

    const realOrder = resolveFourthPlaceDisputeOrder(
      bmRes.data as BracketMatchPodiumInput[],
      pairingResults
    );
    if (!realOrder) continue;

    const known = realOrder.filter((pid) => tieGroup.includes(pid));
    const rest = tieGroup.filter((pid) => !known.includes(pid));
    return [...known, ...rest];
  }

  return tieGroup;
}

export type Top4BracketOutcome =
  | { kind: 'no_dispute' }
  | { kind: 'bracket_created'; top4ParticipantIds: string[] }
  | { kind: 'fourth_place_group_created'; tiedParticipantIds: string[] }
  | { kind: 'error'; message: string };

export async function computeAndCreateTop4Bracket(
  eventId: string,
  isBo2: boolean,
  participants: { id: string; left_event_at: string | null }[],
  options?: { minDisputeSize?: number }
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
  const { standings, fourthPlaceTieGroup: rawTieGroup } = computeFinalStandingsWithTiebreakSplit(
    standingInputs,
    pairingResults
  );

  // Fase 5: completar el grupo empatado hasta minDisputeSize (si vino con menos, por una salida
  // reciente) tomando el siguiente en mérito general — standings ya trae al grupo empatado como
  // bloque contiguo (mismos puntos, agrupados por tanda1), así que el resto del grupo original
  // son las entradas siguientes que todavía no están en el grupo.
  let fourthPlaceTieGroup = rawTieGroup;
  const minDisputeSize = options?.minDisputeSize;
  if (minDisputeSize && rawTieGroup.length > 0 && rawTieGroup.length < minDisputeSize) {
    const tieSet = new Set(rawTieGroup);
    const lastTieIdx = Math.max(...rawTieGroup.map((pid) => standings.indexOf(pid)));
    const padCandidates = standings.slice(lastTieIdx + 1).filter((pid) => !tieSet.has(pid));
    const need = Math.min(minDisputeSize, 4) - rawTieGroup.length;
    fourthPlaceTieGroup = [...rawTieGroup, ...padCandidates.slice(0, need)];
  }

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

  // Empate genuino en el corte. "Grupo completo a reemplazar": el empate actual (tanda1) más
  // cualquiera que alguna vez haya sido parte de una disputa round_robin_fourth_place de este
  // evento y siga elegible — no solo fourthPlaceTieGroup, que puede quedar corto si tanda1
  // (fase regular) alcanza a distinguir a alguien que en la disputa real (tiebreak aparte)
  // terminó del otro lado del resultado.
  const historicalDisputedIds = await fetchHistoricalDisputedIds(eventId);
  const eligibleSet = new Set(standings);
  const combinedSet = new Set<string>(fourthPlaceTieGroup);
  for (const pid of historicalDisputedIds) {
    if (eligibleSet.has(pid)) combinedSet.add(pid);
  }
  const combinedGroup = standings.filter((pid) => combinedSet.has(pid));

  // Antes de tratar esto como una disputa nueva: ¿el top4 real ya se determinó alguna vez para
  // este evento? Si sí, ningún desempate de 4to puesto vuelve a evaluarse — se arma el top4
  // directo, usando el orden REAL de cualquier disputa histórica que haya cubierto a estos
  // mismos empatados (bug Fase 4 × Fase 5, confirmado).
  const top3 = standings.filter((pid) => !combinedSet.has(pid)).slice(0, 3);
  if (await hasEverHadRealBracket(eventId)) {
    const replacementOrder = await findReplacementOrder(eventId, combinedGroup, pairingResults);
    const top4 = [...top3, ...replacementOrder].slice(0, 4);
    if (top4.length < 4) {
      return { kind: 'no_dispute' };
    }
    const rpcRes = await supabase.rpc('create_round_robin_top4_bracket', {
      p_event_id: eventId,
      p_top4_ordered: top4,
    });
    if (rpcRes.error) {
      return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el top4.' };
    }
    return { kind: 'bracket_created', top4ParticipantIds: top4 };
  }

  const { fourthPlaceParticipantId, matches } = computeFourthPlaceTiebreakBracket(
    combinedGroup,
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
    return { kind: 'fourth_place_group_created', tiedParticipantIds: combinedGroup };
  }

  return { kind: 'no_dispute' };
}
