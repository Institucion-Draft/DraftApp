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
    default:
      return eventType;
  }
}

export function getPairingsLabel(): string {
  return 'Enfrentamientos';
}
