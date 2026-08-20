import type { EventStatus, EventType } from './database.types';

export function getEventStatusLabel(status: EventStatus): string {
  switch (status) {
    case 'scheduled':
      return 'Programado';
    case 'drafting':
      return 'Drafteando';
    case 'playing':
      return 'En juego';
    case 'completed':
      return 'Completado';
    case 'cancelled':
      return 'Cancelado';
    case 'concluded':
      return 'Concluido';
    default:
      return status;
  }
}

export function getEventTypeLabel(eventType: EventType): string {
  switch (eventType) {
    case 'draft':
      return 'Draft común';
    case 'tournament':
      return 'Torneo';
    case 'pepidraft':
      return 'Pepidraft';
    case 'two_headed_giant':
      return 'Gigante de Dos Cabezas';
    default:
      return eventType;
  }
}

export function getPairingsLabel(): string {
  return 'Enfrentamientos';
}

export function getPairingStatusLabel(
  status: 'in_progress' | 'scheduled' | 'completed'
): string {
  switch (status) {
    case 'in_progress':
      return 'En vivo';
    case 'scheduled':
      return 'Por definirse';
    case 'completed':
      return 'Terminado';
    default:
      return status;
  }
}
