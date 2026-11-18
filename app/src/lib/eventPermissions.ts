/**
 * Permisos de un evento puntual: lógica pura, sin red ni React. Espejo cliente de can_manage_event (0149) y del botón de
 * tabla/cruces del detalle del evento.
 */

/**
 * ¿Puede organizar ESTE evento? Organizador del workspace, o poseedor de la posta (draft_events.event_organizer_user_id).
 * La posta sólo vale si el usuario existe (uid no vacío): null/undefined nunca coincide con nada.
 */
export function canManageEventGate(input: {
  workspaceRole: string | null | undefined;
  eventOrganizerUserId: string | null | undefined;
  userId: string | null | undefined;
}): boolean {
  if (input.workspaceRole === 'organizer') return true;
  return !!input.userId && !!input.eventOrganizerUserId && input.eventOrganizerUserId === input.userId;
}

/**
 * ¿Puede cambiar la disponibilidad de cubos (public.cubes.is_enabled)? Sólo el organizador del workspace: la policy de UPDATE de
 * cubes es is_workspace_organizer (0150), la posta NO alcanza.
 */
export function canEditCubeAvailability(workspaceRole: string | null | undefined): boolean {
  return workspaceRole === 'organizer';
}

const PLAYING_OR_DONE = new Set(['playing', 'completed', 'concluded']);

/**
 * Botón "Tabla de posiciones" / "Cruces de copa" del detalle del evento.
 * - Copa (knockout, sólo llaves): estado playing/completed/concluded Y (miembro del workspace, participante o quien gestiona el
 *   evento). Sin pasar por la declaración de colores: los cruces son públicos.
 * - Resto de los formatos: condición de siempre (organizador del workspace, colores declarados, o miembro que no juega con el
 *   evento en curso/terminado), y en Grupos + Copa recién con las zonas sorteadas.
 */
export function showStandingsButton(input: {
  isKnockout: boolean;
  isZonesEvent: boolean;
  zonesDrawn: boolean;
  status: string | null | undefined;
  isOrganizer: boolean;
  canManageEvent: boolean;
  isWorkspaceMember: boolean;
  hasParticipantRow: boolean;
  hasDeclaredColors: boolean;
}): boolean {
  const playingOrDone = !!input.status && PLAYING_OR_DONE.has(input.status);
  if (input.isKnockout) {
    return playingOrDone && (input.isWorkspaceMember || input.hasParticipantRow || input.canManageEvent);
  }
  return (
    (!input.isZonesEvent || input.zonesDrawn) &&
    (input.isOrganizer ||
      input.hasDeclaredColors ||
      (playingOrDone && input.isWorkspaceMember && !input.hasParticipantRow))
  );
}

/**
 * Modos de la pantalla de disponibilidad de cubos: 'global' (desde la lista de cubos; sólo el organizador del workspace, escribe
 * public.cubes) y 'event' (desde la ruleta; quien gestiona el evento, escribe public.event_cube_overrides).
 */
export type CubeAvailabilityMode = 'global' | 'event';

export function canEditCubeAvailabilityIn(
  mode: CubeAvailabilityMode,
  input: { workspaceRole: string | null | undefined; eventOrganizerUserId?: string | null; userId?: string | null }
): boolean {
  return mode === 'global' ? canEditCubeAvailability(input.workspaceRole) : canManageEventGate({
    workspaceRole: input.workspaceRole,
    eventOrganizerUserId: input.eventOrganizerUserId,
    userId: input.userId,
  });
}

/**
 * ¿Se ofrece "Eliminar evento" en el detalle? SOLO con el evento CANCELADO (nunca en otro estado).
 * - Organizador del workspace: siempre (como hasta ahora).
 * - Quien solo tiene la posta (gestiona el evento sin ser organizador): si el evento NO es oficial, o si es oficial pero NO tiene ninguna partida.
 *   `hasMatches` null = todavía no se sabe: no se ofrece (el servidor igual lo valida; esto solo evita mostrar un botón que va a fallar).
 * El servidor (0164, draft_events_guard_soft_delete) aplica las mismas reglas: esta función es solo la cara visible.
 */
export function canDeleteCancelledEvent(input: {
  status: string | null | undefined;
  isOrganizer: boolean;
  canManageEvent: boolean;
  isOfficial: boolean | null | undefined;
  hasMatches: boolean | null | undefined;
}): boolean {
  if (input.status !== 'cancelled') return false;
  if (input.isOrganizer) return true;
  if (!input.canManageEvent) return false;
  if (!input.isOfficial) return true;
  return input.hasMatches === false;
}

/** Cuándo hace falta saber si el evento tiene partidas: cancelado, oficial, y quien mira solo tiene la posta. */
export function needsMatchCountForDelete(input: {
  status: string | null | undefined;
  isOrganizer: boolean;
  canManageEvent: boolean;
  isOfficial: boolean | null | undefined;
}): boolean {
  return input.status === 'cancelled' && !input.isOrganizer && input.canManageEvent && !!input.isOfficial;
}

/** RPC de borrado lógico: el organizador del workspace sigue con el de siempre; quien solo tiene la posta usa el nuevo (0164). */
export function deleteEventRpcName(isOrganizer: boolean): 'soft_delete_event' | 'soft_delete_cancelled_event' {
  return isOrganizer ? 'soft_delete_event' : 'soft_delete_cancelled_event';
}
