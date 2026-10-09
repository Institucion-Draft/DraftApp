/**
 * Grupos + Copa: resalte PROVISORIO de clasificados a las copas en la tabla de cada zona, antes de que se armen las llaves.
 * Una zona cuenta sólo cuando todos sus enfrentamientos están cerrados (el mismo conteo del pie de la tabla); en una zona
 * incompleta no se resalta a nadie. Cuando las copas ya están armadas, el resalte sale de los grupos de llaves
 * (event_tiebreak_group_participants) y esta función no se usa.
 */

export type CupHighlight = 'main' | 'second';

export type HighlightZone = {
  /** Todos los enfrentamientos de la zona (zona + interzonales de esa zona) cerrados. */
  complete: boolean;
  /** Posición dentro de la zona (rank_in_zone de zone_standings) de cada jugador. */
  players: { participantId: string; rank: number }[];
};

/**
 * Resalte PROVISORIO de Consuelo: sólo cuando N - T está entre 4 y 16. Con más de 16 no clasificados, quiénes pasan (los 16
 * mejores) recién se sabe al armarse las copas, así que antes del armado no se resalta a nadie en marrón; después manda la
 * membresía del grupo de Consuelo.
 */
export function consueloFits(playerCount: number, totalCupPlaces: number): boolean {
  const rest = playerCount - totalCupPlaces;
  return rest >= 4 && rest <= 16;
}

/**
 * Zona definida: rank <= q -> Copa {sede}; rank = q+1 -> sin resaltar si hay wildcards (dependen de las otras zonas), si no
 * Consuelo; rank > q+1 -> Consuelo. Consuelo sólo si se va a armar (N - T entre 4 y 16); si no, sin resaltar.
 */
export function provisionalCupHighlights(input: {
  zones: HighlightZone[];
  qualifiers: number;
  wildcards: number;
  playerCount: number;
  zonesCount: number;
}): Map<string, CupHighlight> {
  const { zones, qualifiers, wildcards, playerCount, zonesCount } = input;
  const out = new Map<string, CupHighlight>();
  const total = zonesCount * qualifiers + wildcards;
  const consuelo = consueloFits(playerCount, total);
  for (const z of zones) {
    if (!z.complete) continue;
    for (const p of z.players) {
      if (p.rank <= qualifiers) {
        out.set(p.participantId, 'main');
      } else if (p.rank === qualifiers + 1 && wildcards > 0) {
        continue;
      } else if (consuelo) {
        out.set(p.participantId, 'second');
      }
    }
  }
  return out;
}

/** Resalte de un jugador: con copas armadas manda SÓLO la membresía de los grupos de llaves; si no, el provisorio. */
export function cupHighlightOf(
  armed: { main: ReadonlySet<string>; second: ReadonlySet<string> | null } | null,
  provisional: ReadonlyMap<string, CupHighlight>,
  participantId: string
): CupHighlight | null {
  if (armed) return armed.main.has(participantId) ? 'main' : armed.second?.has(participantId) ? 'second' : null;
  return provisional.get(participantId) ?? null;
}
