import { supabase } from './supabase';
import { tiersLegendText, type PointTier } from './pointConfig';

export type RankingStatsRow = {
  user_id: string;
  completed_events_as_player: number;
  pairings_won: number;
  pairings_lost: number;
  draft_matches_won: number;
  draft_matches_lost: number;
  revenge_matches_won: number;
  revenge_matches_lost: number;
};

export type Medals = { first: number; second: number; third: number };

/** Puntos y medallas de ProDeC (acertar el 1°/2°/3° color más elegido del evento). */
export type ProDeCTotals = { points: number; first: number; second: number; third: number };

/** Columnas de ProDeC que agregan v_workspace_points y v_season_points (0119). */
export const PRODEC_POINTS_COLUMNS = 'prodec_points, prodec_first, prodec_second, prodec_third';

export type PointsWithProDeCRow = {
  user_id: string;
  points: number;
  prodec_points: number;
  prodec_first: number;
  prodec_second: number;
  prodec_third: number;
};

export function prodecByUserFromRows(rows: PointsWithProDeCRow[]): Map<string, ProDeCTotals> {
  const map = new Map<string, ProDeCTotals>();
  for (const r of rows) {
    map.set(r.user_id, {
      points: r.prodec_points,
      first: r.prodec_first,
      second: r.prodec_second,
      third: r.prodec_third,
    });
  }
  return map;
}

export type RankingRow = {
  userId: string;
  name: string;
  points: number;
  completedEvents: number;
  championships: number;
  secondPlaces: number;
  thirdPlaces: number;
  ej: number;
  wre: number | null;
  pj: number;
  wrp: number | null;
  vj: number;
  wrv: number | null;
  prodecPoints: number;
  prodecFirst: number;
  prodecSecond: number;
  prodecThird: number;
};

export const RANKING_STATS_COLUMNS =
  'user_id, completed_events_as_player, pairings_won, pairings_lost, draft_matches_won, draft_matches_lost, revenge_matches_won, revenge_matches_lost';

function winrate(won: number, lost: number): number | null {
  const total = won + lost;
  return total > 0 ? Math.round((won / total) * 100) : null;
}

/**
 * Puntos por evento jugado (puntos / #PE), con 1 decimal y coma decimal. "-" si todavía no
 * participó de ningún evento (el mismo denominador se usa para el torneo y para ProDeC).
 */
export function formatPointsPerEvent(points: number, events: number): string {
  if (events <= 0) return '-';
  return (points / events).toFixed(1).replace('.', ',');
}

function sortKey(v: number | null): number {
  return v ?? -1;
}

export async function fetchUserNames(userIds: string[]): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  if (userIds.length === 0) return names;
  const res = await supabase.from('users').select('id, display_name, username').in('id', userIds);
  for (const u of (res.data ?? []) as { id: string; display_name: string | null; username: string | null }[]) {
    names[u.id] = u.display_name || u.username || 'Jugador';
  }
  return names;
}

/** Una fila por jugador de `stats`, ordenadas: puntos, copas, WRE, WRP, WRV, nombre. */
export function buildRankingRows(
  stats: RankingStatsRow[],
  pointsByUser: Map<string, number>,
  medalsByUser: Map<string, Medals>,
  namesByUser: Record<string, string>,
  prodecByUser: Map<string, ProDeCTotals>
): RankingRow[] {
  const rows: RankingRow[] = stats.map((s) => {
    const medals = medalsByUser.get(s.user_id);
    const prodec = prodecByUser.get(s.user_id);
    return {
      userId: s.user_id,
      name: namesByUser[s.user_id] ?? 'Jugador',
      points: pointsByUser.get(s.user_id) ?? 0,
      completedEvents: s.completed_events_as_player,
      championships: medals?.first ?? 0,
      secondPlaces: medals?.second ?? 0,
      thirdPlaces: medals?.third ?? 0,
      ej: s.pairings_won + s.pairings_lost,
      wre: winrate(s.pairings_won, s.pairings_lost),
      pj: s.draft_matches_won + s.draft_matches_lost,
      wrp: winrate(s.draft_matches_won, s.draft_matches_lost),
      vj: s.revenge_matches_won + s.revenge_matches_lost,
      wrv: winrate(s.revenge_matches_won, s.revenge_matches_lost),
      prodecPoints: prodec?.points ?? 0,
      prodecFirst: prodec?.first ?? 0,
      prodecSecond: prodec?.second ?? 0,
      prodecThird: prodec?.third ?? 0,
    };
  });

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.championships !== a.championships) return b.championships - a.championships;
    const wreA = sortKey(a.wre);
    const wreB = sortKey(b.wre);
    if (wreB !== wreA) return wreB - wreA;
    const wrpA = sortKey(a.wrp);
    const wrpB = sortKey(b.wrp);
    if (wrpB !== wrpA) return wrpB - wrpA;
    const wrvA = sortKey(a.wrv);
    const wrvB = sortKey(b.wrv);
    if (wrvB !== wrvA) return wrvB - wrvA;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Texto de la leyenda de la tabla; los escalones de puntos salen de la config, no están hardcodeados. */
export function buildRankingLegend(tiers: PointTier[]): string {
  const pointsPart =
    tiers.length > 0
      ? `Pts: Puntos por posición final (1°/2°/3°), según cantidad de jugadores del evento — ${tiersLegendText(tiers)}`
      : 'Pts: Puntos por posición final (1°/2°/3°), según cantidad de jugadores del evento';
  return `${pointsPart} · #PE: Participaciones en Eventos · 🥇: Copas (veces 1°) · 🥈: veces 2° · 🥉: veces 3° · EJ: Enfrentamientos Jugados · WRE: Winrate de Enfrentamientos · PJ: Partidas Jugadas · WRP: Winrate de Partidas · VJ: Venganzas Jugadas · WRV: Winrate de Venganzas · Pts/PE: puntos por evento jugado (Pts ÷ #PE, en el torneo y en ProDeC) · ProDeC (Pts, 🥇, 🥈, 🥉): puntos y veces que acertó el 1°/2°/3° color más elegido del evento — mismos puntos por escalón que el torneo, sin sumar a Pts`;
}
