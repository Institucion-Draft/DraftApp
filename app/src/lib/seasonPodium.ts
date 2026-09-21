import type { RankingRow } from './ranking';

export type SeasonPodiumPlayer = { userId: string; name: string; points: number };

export type SeasonPodiumStep = {
  rank: 1 | 2 | 3;
  /** Puntos que comparten todos los jugadores del peldaño. */
  points: number;
  players: SeasonPodiumPlayer[];
};

/**
 * Podio de cierre de una temporada por Puntos. Empate exacto en puntos = mismo peldaño (sin
 * desempatar por copas/winrates, que no reflejan mérito de esa disputa). Los peldaños son los
 * 3 mayores valores DISTINTOS de puntos (mismo criterio denso que ProDeC y el ranking de round
 * robin sin top), así que con empates puede haber más de un jugador por peldaño. Solo cuentan
 * jugadores con puntos > 0. Devuelve únicamente los peldaños con jugadores.
 */
export function computeSeasonPodium(rows: Pick<RankingRow, 'userId' | 'name' | 'points'>[]): SeasonPodiumStep[] {
  const scored = rows.filter((r) => r.points > 0);
  const topValues = Array.from(new Set(scored.map((r) => r.points)))
    .sort((a, b) => b - a)
    .slice(0, 3);
  return topValues.map((points, idx) => ({
    rank: (idx + 1) as 1 | 2 | 3,
    points,
    players: scored
      .filter((r) => r.points === points)
      .map((r) => ({ userId: r.userId, name: r.name, points: r.points })),
  }));
}
