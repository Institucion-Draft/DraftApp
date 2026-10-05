import type { EventType } from './database.types';
import { getEventTypeLabel } from './labels';

/** Formatos de competición conocidos. Para sumar uno nuevo alcanza con agregar una entrada. */
const COMPETITION_FORMAT_LABELS: Record<string, string> = {
  round_robin: 'Todos contra todos',
  swiss: 'Suizo',
};

/**
 * Modalidad de juego de un evento: "Todos contra todos · BO2", "Todos contra todos · BO1 + Top 4",
 * "Suizo · BO3 + Top 4", "Gigante de Dos Cabezas · Todos contra todos · BO3".
 * Los datos que falten se omiten; vacío si el evento no tiene nada cargado.
 */
export function formatEventMode(
  eventType: string | null,
  competitionFormat: string | null,
  topSize: number | null,
  matchFormat: string | null
): string {
  const parts: string[] = [];
  if (eventType === 'two_headed_giant') {
    parts.push(getEventTypeLabel(eventType as EventType));
  }
  const formatLabel = competitionFormat ? COMPETITION_FORMAT_LABELS[competitionFormat] : undefined;
  if (formatLabel) parts.push(formatLabel);

  let tail = matchFormat ? matchFormat.toUpperCase() : '';
  if (topSize && topSize > 0) tail = tail ? `${tail} + Top ${topSize}` : `Top ${topSize}`;
  if (tail) parts.push(tail);
  return parts.join(' · ');
}
