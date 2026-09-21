import { supabase } from './supabase';

export type PointTier = {
  minPlayers: number;
  /** Puntos por posición: points[0] = 1°, points[1] = 2°, etc. */
  points: number[];
};

export async function fetchDefaultPointConfigId(): Promise<string | null> {
  const { data } = await supabase.from('point_configs').select('id').eq('is_default', true).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Escalones de una config, ordenados por min_players ascendente. Vacío si falla o no existe. */
export async function fetchPointTiers(configId: string | null): Promise<PointTier[]> {
  if (!configId) return [];
  const { data } = await supabase
    .from('point_config_tiers')
    .select('min_players, points')
    .eq('config_id', configId)
    .order('min_players', { ascending: true });
  return ((data ?? []) as { min_players: number; points: unknown }[]).map((r) => ({
    minPlayers: r.min_players,
    points: Array.isArray(r.points) ? r.points.map((n) => Number(n)) : [],
  }));
}

/** Índice del escalón aplicable: el de mayor minPlayers <= playerCount (igual que workspace_ranking_points en SQL). */
export function tierIndexForPlayerCount(tiers: PointTier[], playerCount: number): number | null {
  let idx: number | null = null;
  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i].minPlayers <= playerCount) idx = i;
  }
  return idx;
}

/** Puntos de una posición para un evento de `playerCount` jugadores (igual que workspace_ranking_points en SQL). */
export function pointsForPosition(tiers: PointTier[], playerCount: number, position: number): number {
  if (position < 1) return 0;
  const idx = tierIndexForPlayerCount(tiers, playerCount);
  if (idx == null) return 0;
  return tiers[idx].points[position - 1] ?? 0;
}

function lastPlayerOfTier(tiers: PointTier[], idx: number): number | null {
  return idx + 1 < tiers.length ? tiers[idx + 1].minPlayers - 1 : null;
}

/** "4-6", "7", "13+" */
export function tierRangeLabel(tiers: PointTier[], idx: number): string {
  const min = tiers[idx].minPlayers;
  const max = lastPlayerOfTier(tiers, idx);
  if (max == null) return `${min}+`;
  return max === min ? `${min}` : `${min}-${max}`;
}

/** "4 a 6 jug.: 5/3/2 · 7 a 9 jug.: 7/4/3 · 13+ jug.: 12/8/5" */
export function tiersLegendText(tiers: PointTier[]): string {
  return tiers
    .map((t, idx) => {
      const max = lastPlayerOfTier(tiers, idx);
      const range = max == null ? `${t.minPlayers}+` : max === t.minPlayers ? `${t.minPlayers}` : `${t.minPlayers} a ${max}`;
      return `${range} jug.: ${t.points.join('/')}`;
    })
    .join(' · ');
}
