/**
 * Winrate de partidas individuales de un evento round_robin, para el desempate de ciclos
 * (`gameWinrateMap` de podium.ts, paso 3 de `resolveTieGroup`). Excluye las matches walkover.
 * Compartido por los armados de desempate/top4 que consultan la base por su cuenta.
 */
import { supabase } from './supabase';
import { buildGameWinrateMap, type GameWinrateMatchInput } from './podium';

/**
 * `undefined` en BO2 (sus puntos 3/1/0 no usan este criterio) y si alguna consulta falla — en ese
 * caso el desempate cae al comportamiento anterior (calidad de rivales → hash).
 */
export async function fetchRoundRobinGameWinrateMap(
  eventId: string,
  participantIds: string[],
  isBo2: boolean
): Promise<Map<string, number> | undefined> {
  if (isBo2) return undefined;
  const pairingsRes = await supabase
    .from('pairings')
    .select('id, participant_a_id, participant_b_id')
    .eq('event_id', eventId);
  if (pairingsRes.error || !pairingsRes.data) return undefined;
  const pairings = pairingsRes.data as { id: string; participant_a_id: string; participant_b_id: string }[];
  if (pairings.length === 0) return buildGameWinrateMap(participantIds, pairings, []);
  const matchesRes = await supabase
    .from('matches')
    .select('pairing_id, winner_participant_id, status, match_type, is_walkover')
    .in(
      'pairing_id',
      pairings.map((p) => p.id)
    );
  if (matchesRes.error || !matchesRes.data) return undefined;
  return buildGameWinrateMap(participantIds, pairings, matchesRes.data as GameWinrateMatchInput[]);
}
