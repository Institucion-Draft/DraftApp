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
