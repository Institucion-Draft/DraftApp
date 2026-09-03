/**
 * Réplica en cliente del criterio de líderes empatados alineado con compute_event_champion en
 * SQL (umbral ceil(2/3 * (n-1)) pairings completados). BO1/BO3: mismo win rate (won/completed).
 * BO2 (0078/0079): mismo puntaje total absoluto (won*3 + draws*1), no proporción — un pairing
 * con official_draw=true cuenta como completado (no como pendiente) y suma 1 punto a cada lado.
 */

export type PairingSummary = {
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  /** BO2: true si el pairing terminó 1-1 (empate ya resuelto, sin ganador). */
  official_draw?: boolean;
};

function sameWinrate(a: { won: number; completed: number }, b: { won: number; completed: number }): boolean {
  return a.won * b.completed === b.won * a.completed;
}

/**
 * Si hay exactamente dos elegibles empatados en el máximo (win rate para BO1/BO3, puntos totales
 * para BO2), devuelve sus participant ids ordenados. `isBo2` debe reflejar el match_format del
 * evento — no se infiere de los pairings.
 */
export function getTwoWayTieFirstPlaceParticipantIds(
  playerParticipantIds: string[],
  pairings: PairingSummary[],
  isBo2: boolean
): readonly [string, string] | null {
  const n = playerParticipantIds.length;
  if (n < 2) return null;
  const minRequired = Math.ceil((2 * (n - 1)) / 3);

  type Stat = { id: string; completed: number; won: number; draws: number };
  const stats: Stat[] = playerParticipantIds.map((pid) => {
    const rel = pairings.filter((p) => p.participant_a_id === pid || p.participant_b_id === pid);
    const completed = rel.filter(
      (p) => p.official_winner_participant_id != null || p.official_draw === true
    ).length;
    const won = rel.filter((p) => p.official_winner_participant_id === pid).length;
    const draws = rel.filter((p) => p.official_draw === true).length;
    return { id: pid, completed, won, draws };
  });

  const eligible = stats.filter((s) => s.completed >= minRequired && s.completed > 0);
  if (eligible.length === 0) return null;

  const points = (s: Stat) => s.won * 3 + s.draws;
  const sameScore = (a: Stat, b: Stat) => (isBo2 ? points(a) === points(b) : sameWinrate(a, b));

  let maxLeader: Stat | null = null;
  for (const s of eligible) {
    const isBetter = isBo2
      ? !maxLeader || points(s) > points(maxLeader)
      : !maxLeader || s.won * maxLeader.completed > maxLeader.won * s.completed;
    if (isBetter) maxLeader = s;
  }
  if (!maxLeader) return null;

  const leaders = eligible.filter((s) => sameScore(s, maxLeader!));
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
