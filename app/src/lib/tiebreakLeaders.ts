/**
 * Réplica en cliente del criterio de líderes empatados (2 jugadores, mismo win rate BO3)
 * alineado con compute_event_champion en SQL (umbral ceil(2/3 * (n-1)) BO3 completados).
 */

export type PairingSummary = {
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
};

function sameWinrate(a: { won: number; completed: number }, b: { won: number; completed: number }): boolean {
  return a.won * b.completed === b.won * a.completed;
}

/** Si hay exactamente dos elegibles empatados en el máximo win rate, devuelve sus participant ids ordenados. */
export function getTwoWayTieFirstPlaceParticipantIds(
  playerParticipantIds: string[],
  pairings: PairingSummary[]
): readonly [string, string] | null {
  const n = playerParticipantIds.length;
  if (n < 2) return null;
  const minRequired = Math.ceil((2 * (n - 1)) / 3);

  type Stat = { id: string; completed: number; won: number };
  const stats: Stat[] = playerParticipantIds.map((pid) => {
    const rel = pairings.filter((p) => p.participant_a_id === pid || p.participant_b_id === pid);
    const completed = rel.filter((p) => p.official_winner_participant_id != null).length;
    const won = rel.filter((p) => p.official_winner_participant_id === pid).length;
    return { id: pid, completed, won };
  });

  const eligible = stats.filter((s) => s.completed >= minRequired && s.completed > 0);
  if (eligible.length === 0) return null;

  let maxLeader: { won: number; completed: number } | null = null;
  for (const s of eligible) {
    if (!maxLeader || s.won * maxLeader.completed > maxLeader.won * s.completed) {
      maxLeader = { won: s.won, completed: s.completed };
    }
  }
  if (!maxLeader) return null;

  const leaders = eligible.filter((s) => sameWinrate(s, maxLeader));
  if (leaders.length !== 2) return null;

  const [a, b] = [leaders[0]!.id, leaders[1]!.id].sort((x, y) => x.localeCompare(y));
  return [a, b] as const;
}

export function pairingIsBetweenParticipants(
  pairing: { participant_a_id: string; participant_b_id: string },
  idA: string,
  idB: string
): boolean {
  return (
    (pairing.participant_a_id === idA && pairing.participant_b_id === idB) ||
    (pairing.participant_a_id === idB && pairing.participant_b_id === idA)
  );
}
