/**
 * Estadísticas de un cubo o una sede (pantallas Cubo y Editar sede): lógica pura, sin acceso a datos.
 *
 * Los puntos NO se calculan acá: salen de v_workspace_points_breakdown (el ranking existente, con Copa Consuelo
 * incluida) y las posiciones finales de v_event_final_positions. Este módulo sólo ordena y elige.
 *
 * Reglas:
 *  - Total por jugador: puntos (desc), luego primeros puestos (desc; position === 1 en el desglose), luego nombre (asc).
 *  - Sólo entran jugadores con puntos > 0.
 *  - "Primer evento": el de scheduled_for más antiguo (empate: id) entre los que le pasan, que ya vienen filtrados
 *    (oficiales, no borrados, completed/concluded).
 *  - Podio de un evento: posiciones finales 1, 2 y 3 (las de Copa Consuelo, 1000+, no son del podio del evento);
 *    los empates comparten peldaño y se ordenan por nombre.
 */

export type PointsRow = { user_id: string; event_id: string; position: number; points: number };
export type FinalPositionRow = { user_id: string; position: number };
export type EventRef = { id: string; name?: string | null; scheduled_for: string | null };
export type PlayerNames = Map<string, string>;

export type PlayerTotal = { userId: string; name: string; points: number; firsts: number; events: number };
export type PodiumEntry = { userId: string; name: string; position: 1 | 2 | 3 };

/** Podio del primer evento: además de la posición, el participante de ESE evento (para mostrar su Pokémon de ahí). */
export type FirstPodiumEntry = PodiumEntry & { participantId: string | null };

export type CubeStats = {
  firstEvent: { id: string; name: string | null; scheduled_for: string | null } | null;
  firstPodium: FirstPodiumEntry[];
  topPlayer: PlayerTotal | null;
  /** Eventos oficiales, no borrados, completed/concluded. 0 = la tarjeta no se muestra. */
  eventsCount: number;
};

export type VenueStats = {
  podium: PlayerTotal[];
  eventsCount: number;
};

const FALLBACK_NAME = 'Jugador';

export function displayNameOf(userId: string, names: PlayerNames): string {
  return names.get(userId)?.trim() || FALLBACK_NAME;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'es', { sensitivity: 'base' });
}

/** Totales por jugador ordenados (puntos, primeros puestos, nombre). `eventIds` limita a los eventos válidos. */
export function rankPlayersByPoints(
  rows: PointsRow[],
  names: PlayerNames,
  opts: { eventIds?: Set<string>; limit?: number } = {}
): PlayerTotal[] {
  const acc = new Map<string, { points: number; firsts: number; events: Set<string> }>();
  for (const r of rows) {
    if (opts.eventIds && !opts.eventIds.has(r.event_id)) continue;
    const cur = acc.get(r.user_id) ?? { points: 0, firsts: 0, events: new Set<string>() };
    cur.points += r.points ?? 0;
    if (r.position === 1) cur.firsts += 1;
    cur.events.add(r.event_id);
    acc.set(r.user_id, cur);
  }
  const out: PlayerTotal[] = [];
  for (const [userId, v] of acc) {
    if (v.points <= 0) continue;
    out.push({ userId, name: displayNameOf(userId, names), points: v.points, firsts: v.firsts, events: v.events.size });
  }
  out.sort((a, b) => b.points - a.points || b.firsts - a.firsts || compareNames(a.name, b.name) || (a.userId < b.userId ? -1 : 1));
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

/** Evento más antiguo por scheduled_for (los sin fecha van al final; empate por id para ser estable). */
export function pickFirstEvent<T extends EventRef>(events: T[]): T | null {
  if (events.length === 0) return null;
  const key = (e: T) => (e.scheduled_for ? Date.parse(e.scheduled_for) : Number.POSITIVE_INFINITY);
  return [...events].sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** Podio (1°-3°) de un evento a partir de v_event_final_positions. Un jugador aparece una sola vez, con su mejor puesto. */
export function podiumFromFinalPositions(rows: FinalPositionRow[], names: PlayerNames): PodiumEntry[] {
  const best = new Map<string, 1 | 2 | 3>();
  for (const r of rows) {
    if (r.position !== 1 && r.position !== 2 && r.position !== 3) continue;
    const cur = best.get(r.user_id);
    if (cur == null || r.position < cur) best.set(r.user_id, r.position);
  }
  const out: PodiumEntry[] = [...best].map(([userId, position]) => ({ userId, name: displayNameOf(userId, names), position }));
  out.sort((a, b) => a.position - b.position || compareNames(a.name, b.name) || (a.userId < b.userId ? -1 : 1));
  return out;
}
