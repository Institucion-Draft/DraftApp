/**
 * Combinaciones de colores de los mazos de un jugador (perfil dentro del workspace). Helper puro, sin red ni React.
 *
 * Los datos salen de la vista v_player_color_combo_stats (una fila por usuario, workspace y combinación): `combo` es el
 * conjunto exacto de colores del mazo en orden W U B R G C (p. ej. "WUB"), `decks_count` los mazos con esa combinación, y
 * `games_played` / `games_won` las PARTIDAS individuales oficiales (ronda, final y desempate) jugadas y ganadas con ella; la
 * vista ya excluye venganzas, Gigantes de Dos Cabezas y eventos de prueba. (pairings_played / pairings_won siguen en la
 * vista pero ya no se usan para el winrate.) Acá sólo se ordena y se eligen las mejores.
 */
import type { MtgColor } from './database.types';

/** Mínimo de partidas jugadas con una combinación para que entre en "más winrate" (el Win Rate por color no tiene mínimo). */
export const COMBO_MIN_GAMES = 3;

const COLOR_ORDER: MtgColor[] = ['W', 'U', 'B', 'R', 'G', 'C'];

export type ColorCombo = {
  /** Colores en orden fijo W U B R G C, p. ej. 'WUB'. */
  key: string;
  colors: MtgColor[];
  /** Mazos (participaciones) con esta combinación. */
  decks: number;
  /** Partidas jugadas y ganadas con esta combinación. */
  played: number;
  won: number;
  /** % entero de partidas ganadas; null si no jugó ninguna. */
  winrate: number | null;
};

/** Fila de v_player_color_combo_stats (los bigint pueden llegar como string). */
export type ComboViewRow = {
  combo: string;
  decks_count: number | string;
  games_played: number | string;
  games_won: number | string;
};

export function comboKey(colors: readonly string[]): string {
  return COLOR_ORDER.filter((c) => colors.includes(c)).join('');
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function pickColorCombos(
  rows: readonly ComboViewRow[],
  limit = 3
): { mostUsed: ColorCombo[]; bestWinrate: ColorCombo[] } {
  const byKey = new Map<string, ColorCombo>();
  for (const r of rows) {
    const key = comboKey((r.combo ?? '').split(''));
    if (!key) continue;
    const cur =
      byKey.get(key) ?? ({ key, colors: key.split('') as MtgColor[], decks: 0, played: 0, won: 0, winrate: null } as ColorCombo);
    cur.decks += num(r.decks_count);
    cur.played += num(r.games_played);
    cur.won += num(r.games_won);
    byKey.set(key, cur);
  }
  const all = [...byKey.values()].map((c) => ({
    ...c,
    winrate: c.played > 0 ? Math.round((c.won / c.played) * 100) : null,
  }));

  const stable = (a: ColorCombo, b: ColorCombo) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const mostUsed = [...all].sort((a, b) => b.decks - a.decks || b.played - a.played || stable(a, b)).slice(0, limit);
  const bestWinrate = all
    .filter((c) => c.played >= COMBO_MIN_GAMES && c.winrate != null)
    .sort((a, b) => b.won / b.played - a.won / a.played || b.played - a.played || stable(a, b))
    .slice(0, limit);
  return { mostUsed, bestWinrate };
}
