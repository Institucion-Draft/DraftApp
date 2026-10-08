/**
 * Rondas de las llaves. 'semi', 'final' y 'third_place' las comparten el top 4 de round_robin y
 * Suizo (sus textos no cambian); 'round_of_16' y 'quarter' sólo existen en la Copa (sólo llaves),
 * group_origin = 'knockout_bracket'.
 */

export type BracketPhase = 'round_of_16' | 'quarter' | 'semi' | 'final' | 'third_place';

/** Origen de los grupos de llaves de la Copa. */
export const KNOCKOUT_BRACKET_ORIGIN = 'knockout_bracket';

/** Origen del grupo de la 2da oportunidad de la Copa (0135). */
export const KNOCKOUT_SECOND_CHANCE_ORIGIN = 'knockout_second_chance';

/** Copa principal o 2da oportunidad: los dos cuadros de eliminación directa de una Copa. */
export function isKnockoutCupOrigin(origin: string | null | undefined): boolean {
  return origin === KNOCKOUT_BRACKET_ORIGIN || origin === KNOCKOUT_SECOND_CHANCE_ORIGIN;
}

/** Prefijo de los títulos de ronda de la 2da oportunidad, para distinguirlos de los de la Copa. */
export const SECOND_CHANCE_PREFIX = '2da oportunidad';

/**
 * Títulos de cada ronda en los listados. Semi, final y 3er puesto son los textos que ya usa
 * Enfrentamientos para el top 4; octavos y cuartos son nuevos.
 */
export function bracketPhaseTitle(phase: BracketPhase): string {
  switch (phase) {
    case 'round_of_16':
      return 'Octavos de final';
    case 'quarter':
      return 'Cuartos de final';
    case 'semi':
      return 'Semifinales';
    case 'final':
      return 'Final';
    case 'third_place':
      return '3er y 4to puesto';
  }
}

/** Nombre de la ronda en singular, para botones y textos de un cruce puntual. */
export function bracketPhaseSingularName(phase: BracketPhase): string {
  switch (phase) {
    case 'round_of_16':
      return 'Octavos de final';
    case 'quarter':
      return 'Cuartos de final';
    case 'semi':
      return 'Semifinal';
    case 'final':
      return 'Final';
    case 'third_place':
      return '3er y 4to puesto';
  }
}

/**
 * Nombre corto de la ronda para el header de la instancia y los botones del detalle de un cruce
 * de la Copa. Única fuente: los botones lo usan en minúscula ("Iniciar 4tos").
 */
export function bracketPhaseShortName(phase: BracketPhase): string {
  switch (phase) {
    case 'round_of_16':
      return '8vos';
    case 'quarter':
      return '4tos';
    case 'semi':
      return 'Semifinales';
    case 'final':
      return 'Final';
    case 'third_place':
      return '3er y 4to puesto';
  }
}

/** Etiqueta en mayúsculas del NewsTicker del Life Tracker. */
export function bracketPhaseTickerName(phase: BracketPhase): string {
  switch (phase) {
    case 'round_of_16':
      return 'OCTAVOS';
    case 'quarter':
      return 'CUARTOS';
    case 'semi':
      return 'SEMIFINAL';
    case 'final':
      return 'FINAL';
    case 'third_place':
      return '3ER PUESTO';
  }
}

/**
 * Orden de las rondas en el listado de la Copa: las instancias más tardías van arriba. Mismo orden
 * relativo que el top 4 (final, 3er puesto, semifinales), con cuartos y octavos por debajo.
 */
const KNOCKOUT_ORDER: Record<BracketPhase, number> = {
  final: 0,
  third_place: 1,
  semi: 2,
  quarter: 3,
  round_of_16: 4,
};

/** Orden histórico del top 4 (final primero): no cambia. */
const TOP4_ORDER: Record<BracketPhase, number> = {
  final: 0,
  third_place: 1,
  semi: 2,
  // No existen en el top 4; sólo para que el Record sea total.
  quarter: 3,
  round_of_16: 4,
};

/** Posición de una ronda en el listado de un grupo de llaves según su origen. */
export function bracketPhaseSortKey(phase: BracketPhase, groupOrigin: string | null | undefined): number {
  return (isKnockoutCupOrigin(groupOrigin) ? KNOCKOUT_ORDER : TOP4_ORDER)[phase];
}

/**
 * Rondas que tiene una Copa (sólo llaves) con n jugadores, en orden cronológico. Espeja el
 * sorteo de draw_knockout_bracket (0133): 4 jugadores arrancan en semifinales; de 5 a 8, en cuartos;
 * de 9 a 16, en octavos. El 3er puesto va siempre al final.
 */
export function knockoutRoundsForPlayers(playerCount: number): BracketPhase[] {
  if (playerCount < 4 || playerCount > 16) return [];
  const first: BracketPhase[] =
    playerCount <= 4 ? [] : playerCount <= 8 ? ['quarter'] : ['round_of_16', 'quarter'];
  return [...first, 'semi', 'final', 'third_place'];
}
