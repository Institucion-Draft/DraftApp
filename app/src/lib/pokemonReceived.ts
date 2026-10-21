/**
 * Pokémon asignados por evento (sección "Pokemones" del perfil): lógica pura, sin acceso a datos.
 *
 * Una fila = una inscripción del jugador con Pokémon asignado (rotated_avatar_id, o member_b_rotated_avatar_id si fue
 * el miembro B de un equipo 2HG). Nunca interviene el users.default_avatar_id global.
 */

export type ReceivedRow = {
  /** Único por fila (id de participante + miembro). */
  id: string;
  eventId: string;
  eventName: string;
  /** scheduled_for del evento, o su created_at si no tiene fecha. */
  eventDate: string | null;
  /** default_avatars.name tal cual (ej. 'Mr-Mime', 'Unown-K', 'Ditto'). */
  name: string;
  storagePath: string;
  storagePathShiny: string | null;
  /** default_avatars.pokemon_type (en español, ej. 'Agua'). */
  pokemonType: string | null;
  isShiny: boolean;
};

export const UNOWN_TYPE = 'Psíquico';

/** Forma de Unown a partir del storage_path ('unown.png' = A, 'unown-k.png' = K, 'unown-exclamation.png' = !). */
export function unownFormFromPath(storagePath: string): string | null {
  const m = /(?:^|\/)unown(?:-([a-z]|exclamation|question))?\.png$/i.exec(storagePath);
  if (!m) return null;
  return (m[1] ?? 'a').toLowerCase();
}

function formLabel(form: string): string {
  if (form === 'exclamation') return '!';
  if (form === 'question') return '?';
  return form.toUpperCase();
}

/** Nombre a mostrar: Unown lleva su forma ('Unown (K)'); el resto, el nombre guardado (Ditto es Ditto). */
export function pokemonDisplayName(row: Pick<ReceivedRow, 'name' | 'storagePath'>): string {
  const form = unownFormFromPath(row.storagePath);
  return form ? `Unown (${formLabel(form)})` : row.name;
}

/** Sprite a mostrar: el shiny si corresponde y existe. */
export function pokemonSpritePath(row: Pick<ReceivedRow, 'storagePath' | 'storagePathShiny' | 'isShiny'>): string {
  return row.isShiny && row.storagePathShiny ? row.storagePathShiny : row.storagePath;
}

/** Tipo efectivo: las formas de Unown cuentan como psíquico. */
export function effectiveType(row: Pick<ReceivedRow, 'pokemonType' | 'storagePath'>): string | null {
  if (unownFormFromPath(row.storagePath)) return UNOWN_TYPE;
  const t = row.pokemonType?.trim();
  return t ? t : null;
}

/** Más reciente primero (por fecha del evento; sin fecha al final; empate por id para ser estable). */
export function sortReceived<T extends Pick<ReceivedRow, 'eventDate' | 'id'>>(rows: T[]): T[] {
  const key = (r: T) => (r.eventDate ? Date.parse(r.eventDate) : Number.NEGATIVE_INFINITY);
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return kb > ka ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function lastReceived<T extends Pick<ReceivedRow, 'eventDate' | 'id'>>(rows: T[], n = 5): T[] {
  return sortReceived(rows).slice(0, n);
}

export type TypeShare = { types: string[]; count: number; total: number; percent: number };

/**
 * Tipo más asignado y su porcentaje sobre los Pokémon con tipo conocido. Con empate devuelve todos los empatados
 * (orden alfabético). null si no hay ninguno.
 */
export function topTypeShare(rows: Pick<ReceivedRow, 'pokemonType' | 'storagePath'>[]): TypeShare | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const t = effectiveType(r);
    if (!t) continue;
    total += 1;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (total === 0) return null;
  const max = Math.max(...counts.values());
  const types = [...counts].filter(([, c]) => c === max).map(([t]) => t).sort((a, b) => a.localeCompare(b, 'es'));
  return { types, count: max, total, percent: Math.round((max / total) * 100) };
}

/** "Agua · 24 %" por cada tipo empatado. */
export function formatTypeShare(share: TypeShare): string[] {
  return share.types.map((t) => `${t} · ${share.percent} %`);
}

/** Fecha corta del evento para la lista ('' si no hay). */
export function formatEventDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Argentina es UTC-3 todo el año (sin horario de verano desde 2009): el día local se obtiene restando 3 h al instante. */
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Fecha dd/mm/aa en hora local de Argentina (el día no se corre por UTC). '' si no hay fecha o es inválida. */
export function formatShortDateAR(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms - AR_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${dd}/${mm}/${yy}`;
}

export const LAST_POKEMON_COUNT = 5;
const MAX_SPRITE_PX = 56;
const CELL_PADDING_PX = 6;

/**
 * Fila de los últimos 5: ancho de cada celda (partes iguales del ancho disponible, también con menos de 5, para que
 * midan lo mismo) y tamaño del sprite, que se achica si la celda es angosta.
 */
export function lastRowLayout(availableWidth: number): { cell: number; sprite: number } {
  const cell = Math.max(1, Math.floor(availableWidth / LAST_POKEMON_COUNT));
  const sprite = Math.max(24, Math.min(MAX_SPRITE_PX, cell - CELL_PADDING_PX));
  return { cell, sprite };
}
