/**
 * Partidas ganadas de verdad por un jugador dentro de una serie de llaves (desempate o cruce de
 * mata-mata). Única fuente para las píldoras de PairingDetailScreen y de PairingsListScreen y para
 * la marca de progreso de la Copa: el walkover cuenta para el resultado oficial pero no infla el
 * marcador visual.
 */
export type SeriesMatch = {
  /** Si viene informado, sólo cuenta 'tiebreak': las venganzas de un pairing que luego pasó a 'bracket' no suman. */
  match_type?: string | null;
  status: string | null;
  winner_participant_id: string | null;
  is_walkover?: boolean | null;
};

export function countSeriesWins(matches: readonly SeriesMatch[], participantId: string): number {
  return matches.filter(
    (m) =>
      (m.match_type == null || m.match_type === 'tiebreak') &&
      m.status === 'completed' &&
      m.winner_participant_id === participantId &&
      !m.is_walkover
  ).length;
}

/**
 * Venganzas ganadas por un jugador entre los dos del pairing (un único pairing por par y evento:
 * unique (event_id, participant_a_id, participant_b_id)). Criterio de los triggers de las copas de
 * venganza (0010/0011): match_type='revenge', completada y con ganador. Por eso NO filtra walkover:
 * el marcador tiene que coincidir con lo que la base usó para otorgar las copas.
 */
export function countRevengeWins(matches: readonly SeriesMatch[], participantId: string): number {
  return matches.filter(
    (m) => m.match_type === 'revenge' && m.status === 'completed' && m.winner_participant_id === participantId
  ).length;
}
