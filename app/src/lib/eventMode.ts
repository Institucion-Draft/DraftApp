import type { EventType } from './database.types';
import { getEventTypeLabel } from './labels';

/** Valores válidos de draft_events.competition_format. */
export const COMPETITION_FORMATS = ['round_robin', 'swiss', 'zones_knockout', 'knockout'] as const;
export type CompetitionFormat = (typeof COMPETITION_FORMATS)[number];

export function isCompetitionFormat(value: unknown): value is CompetitionFormat {
  return typeof value === 'string' && (COMPETITION_FORMATS as readonly string[]).includes(value);
}

/**
 * Normaliza el competition_format crudo de la base. Un valor desconocido se trata como
 * 'round_robin' (comportamiento histórico) pero avisa en desarrollo. null/undefined (query que
 * no trajo la columna) se tratan como 'round_robin' sin avisar.
 */
export function normalizeCompetitionFormat(raw: string | null | undefined): CompetitionFormat {
  if (isCompetitionFormat(raw)) return raw;
  if (raw != null && __DEV__) {
    console.error(`[competition_format] valor desconocido "${raw}", se trata como 'round_robin'.`);
  }
  return 'round_robin';
}

/** Etiqueta base de cada formato. El Record obliga a sumar una entrada al agregar un formato. */
const COMPETITION_FORMAT_LABELS: Record<CompetitionFormat, string> = {
  round_robin: 'Todos contra todos',
  swiss: 'Suizo',
  zones_knockout: 'Grupos + Copa',
  knockout: 'Copa (sólo llaves)',
};

export function getCompetitionFormatBaseLabel(format: CompetitionFormat): string {
  return COMPETITION_FORMAT_LABELS[format];
}

/**
 * Modalidad de juego de un evento: "Todos contra todos · BO2", "Todos contra todos · BO1 + Top 4",
 * "Suizo · BO3 + Top 4", "Gigante de Dos Cabezas · Todos contra todos · BO3".
 * Los datos que falten se omiten; vacío si el evento no tiene nada cargado. Copa (sólo llaves)
 * suma el formato de las llaves: "Copa (sólo llaves) · BO1". Copa (grupos + llaves) muestra sólo la
 * etiqueta base (su detalle se define cuando exista su pantalla de creación).
 */
export function formatEventMode(
  eventType: string | null,
  competitionFormat: string | null,
  topSize: number | null,
  matchFormat: string | null,
  topcutFormat?: string | null
): string {
  const parts: string[] = [];
  if (eventType === 'two_headed_giant') {
    parts.push(getEventTypeLabel(eventType as EventType));
  }
  const known = isCompetitionFormat(competitionFormat) ? competitionFormat : null;
  if (known) parts.push(COMPETITION_FORMAT_LABELS[known]);
  if (known === 'knockout') {
    // Copa (sólo llaves): el formato de las llaves (topcut_format) va en la etiqueta.
    if (topcutFormat === 'bo1' || topcutFormat === 'bo3') parts.push(topcutFormat.toUpperCase());
    return parts.join(' · ');
  }
  if (known === 'zones_knockout') {
    // Grupos + Copa: dos formatos independientes, el de la fase de grupos (match_format) y el de las llaves (topcut_format).
    if (matchFormat) parts.push(`Grupos ${matchFormat.toUpperCase()}`);
    if (topcutFormat === 'bo1' || topcutFormat === 'bo3') parts.push(`Llaves ${topcutFormat.toUpperCase()}`);
    return parts.join(' · ');
  }

  let tail = matchFormat ? matchFormat.toUpperCase() : '';
  if (topSize && topSize > 0) tail = tail ? `${tail} + Top ${topSize}` : `Top ${topSize}`;
  if (tail) parts.push(tail);
  return parts.join(' · ');
}

/** Copa (sólo llaves): cantidad de jugadores inscriptos admitida (el servidor valida lo mismo). */
export const KNOCKOUT_MIN_PLAYERS = 4;
export const KNOCKOUT_MAX_PLAYERS = 16;

/** null si la cantidad sirve para una Copa (sólo llaves); si no, el motivo para mostrar. */
export function knockoutPlayerCountProblem(playerCount: number): string | null {
  if (playerCount >= KNOCKOUT_MIN_PLAYERS && playerCount <= KNOCKOUT_MAX_PLAYERS) return null;
  return `que haya entre ${KNOCKOUT_MIN_PLAYERS} y ${KNOCKOUT_MAX_PLAYERS} jugadores inscriptos (hay ${playerCount})`;
}
