/**
 * Ditto en el life tracker: el lado de un Ditto muestra el sprite de su rival en esa partida.
 *
 * Este helper sólo decide A QUIÉN copia cada Ditto; no toca imágenes. Un "slot" es un jugador visible en el
 * life tracker: el participante (miembro A) o, en Gigante de 2 cabezas, el miembro B del mismo participante.
 *
 * Reglas:
 *  - Es Ditto quien tiene Pokémon asignado con name 'ditto' y NO tiene avatar custom (el custom gana sobre el
 *    Pokémon, así que ese jugador ya no se ve como Ditto).
 *  - 1 vs 1: copia al único rival. 2HG: copia a UNO de los dos miembros del equipo rival, elegido con un hash
 *    determinístico de partida + participante Ditto (+ miembro), así es el mismo en todos los dispositivos y en
 *    cada render.
 *  - Sin cadenas: si el rival elegido es Ditto, el rival no tiene Pokémon o tiene avatar custom, el Ditto se
 *    queda como Ditto (no aparece en el resultado).
 */

export type DittoMirrorMember = 'a' | 'b';

export type DittoMirrorSlot = {
  participantId: string;
  member: DittoMirrorMember;
  /** default_avatars.name del Pokémon asignado (rotated_avatar_id / member_b_rotated_avatar_id); null si no tiene. */
  avatarName: string | null;
  /** true si el usuario del slot tiene users.custom_avatar_path. */
  hasCustomAvatar: boolean;
};

export type DittoMirrorTarget = { participantId: string; isMemberB: boolean };

export function dittoMirrorKey(participantId: string, member: DittoMirrorMember): string {
  return `${participantId}|${member}`;
}

function isDitto(slot: DittoMirrorSlot): boolean {
  return !slot.hasCustomAvatar && slot.avatarName != null && slot.avatarName.trim().toLowerCase() === 'ditto';
}

/** FNV-1a de 32 bits: simple, determinístico y sin dependencias. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mirrorsForSide(
  matchId: string,
  own: DittoMirrorSlot[],
  rivals: DittoMirrorSlot[],
  out: Map<string, DittoMirrorTarget>
): void {
  if (rivals.length === 0) return;
  for (const slot of own) {
    if (!isDitto(slot)) continue;
    const rival = rivals[hash32(`${matchId}|${slot.participantId}|${slot.member}`) % rivals.length];
    if (rival.hasCustomAvatar) continue;
    if (rival.avatarName == null || rival.avatarName.trim() === '') continue;
    if (isDitto(rival)) continue;
    out.set(dittoMirrorKey(slot.participantId, slot.member), {
      participantId: rival.participantId,
      isMemberB: rival.member === 'b',
    });
  }
}

/**
 * @param matchId id de la partida (o del pairing) que mira el life tracker.
 * @param sideA slots del lado A (1 en 1 vs 1; 1 o 2 en 2HG), en orden [miembro A, miembro B].
 * @param sideB ídem para el lado B.
 * @returns mapa `participantId|a|b` del Ditto -> participante/miembro al que copia. Si no hay entrada, se ve Ditto.
 */
export function resolveDittoMirrors(
  matchId: string,
  sideA: DittoMirrorSlot[],
  sideB: DittoMirrorSlot[]
): Map<string, DittoMirrorTarget> {
  const out = new Map<string, DittoMirrorTarget>();
  mirrorsForSide(matchId, sideA, sideB, out);
  mirrorsForSide(matchId, sideB, sideA, out);
  return out;
}

/** Pausa entre que se cierra el cartel de "quién empieza" y que el Ditto empieza a transformarse. */
export const DITTO_TRANSFORM_DELAY_MS = 1000;
/** Duración total de la transformación (fundido cruzado + squish + destello). */
export const DITTO_TRANSFORM_DURATION_MS = 700;

export type DittoSpritePhase =
  /** Cartel abierto: todos se ven con su propio sprite (Ditto es Ditto). */
  | 'before'
  /** Cartel resuelto en esta sesión, esperando la pausa: sigue siendo Ditto. */
  | 'waiting'
  /** Pasó la pausa: el Ditto pasa a mostrar el sprite del rival, animado. */
  | 'transform'
  /** No hubo cartel en esta sesión (partida ya empezada o sin turnos): sprite copiado directo, sin animación. */
  | 'direct';

export type DittoSpritePlan = { phase: DittoSpritePhase; showMirror: boolean; animate: boolean };

/**
 * Qué sprite mostrar en cada fase y si corresponde animar.
 *
 * @param starterPending el cartel "¿Quién empieza?" está abierto ahora.
 * @param starterSeenThisSession en esta sesión de la pantalla se llegó a mostrar el cartel (se resuelva acá o en
 *   otro dispositivo): sólo entonces la partida "arranca en este momento" y se anima.
 * @param transformDelayElapsed ya pasó DITTO_TRANSFORM_DELAY_MS desde que se resolvió el cartel.
 */
export function dittoSpritePlan(input: {
  starterPending: boolean;
  starterSeenThisSession: boolean;
  transformDelayElapsed: boolean;
}): DittoSpritePlan {
  if (input.starterPending) return { phase: 'before', showMirror: false, animate: false };
  if (!input.starterSeenThisSession) return { phase: 'direct', showMirror: true, animate: false };
  if (!input.transformDelayElapsed) return { phase: 'waiting', showMirror: false, animate: false };
  return { phase: 'transform', showMirror: true, animate: true };
}
