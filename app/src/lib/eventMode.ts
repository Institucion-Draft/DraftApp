import type { EventType } from './database.types';
import { getEventTypeLabel } from './labels';

/**
 * Modalidad resumida de un evento: "Todos contra todos + Top 4 · BO3", "Rondas suizas · BO1",
 * "Gigante de Dos Cabezas · BO3". Vacío si el evento no tiene formato cargado.
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
  } else if (competitionFormat === 'swiss') {
    parts.push(topSize === 4 ? 'Rondas suizas + Top 4' : 'Rondas suizas');
  } else if (competitionFormat === 'round_robin') {
    parts.push(topSize === 4 ? 'Todos contra todos + Top 4' : 'Todos contra todos');
  }
  if (matchFormat) parts.push(matchFormat.toUpperCase());
  return parts.join(' · ');
}
