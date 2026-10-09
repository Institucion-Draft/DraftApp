/**
 * Lista de Enfrentamientos de Grupos + Copa (fase de grupos): lógica pura, sin React ni Supabase.
 *
 * - Etiqueta de grupo de cada pairing: "Grupo A" (stage 'zone', nombre de event_zones) o "Interzonal".
 * - Orden de la lista: las partidas EN VIVO suben arriba de todo agrupadas bajo un header por grupo ("Grupo A",
 *   "Grupo B"... e "Interzonal"); un header aparece SOLO si hay al menos una partida en vivo de ese grupo. Debajo, el
 *   resto de los cruces va en una sola lista, sin headers, en el orden que ya traían (propios primero, por estado).
 */

export const INTERZONAL_LABEL = 'Interzonal';

/** "Grupo A" para un pairing de zona, "Interzonal" para un interzonal, null para cualquier otro stage. */
export function pairingGroupLabel(
  stage: string | null | undefined,
  zoneId: string | null | undefined,
  zoneNameById: ReadonlyMap<string, string>
): string | null {
  if (stage === 'interzonal') return INTERZONAL_LABEL;
  if (stage === 'zone') {
    const name = zoneId ? zoneNameById.get(zoneId) : null;
    return name ? `Grupo ${name}` : null;
  }
  return null;
}

/** Abreviatura para el pie de las filas: "Grupo A" -> "GA", "Interzonal" -> "I" (entra en el mismo renglón). */
export function shortGroupLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  if (label === INTERZONAL_LABEL) return 'I';
  if (label.startsWith('Grupo ')) return `G${label.slice('Grupo '.length).trim()}`;
  return label;
}

/** Orden de los headers en vivo: Grupo A, B, ... (por event_zones) y al final Interzonal. */
export function zonesGroupOrder(zoneNamesInOrder: readonly string[]): string[] {
  return [...zoneNamesInOrder.map((n) => `Grupo ${n}`), INTERZONAL_LABEL];
}

export type ZonesListItem = {
  id: string;
  status: 'in_progress' | 'scheduled' | 'completed';
  groupLabel?: string | null;
};

export type ZonesListRow<T extends ZonesListItem> =
  | { kind: 'header'; id: string; title: string }
  /** gapBefore: primera fila de la lista general cuando hay un bloque en vivo arriba (espacio vertical, sin línea ni header). */
  | { kind: 'pairing'; id: string; item: T; gapBefore?: boolean };

/** `sortedItems` ya viene en el orden de la fase de liga (en vivo primero, propios primero...). */
export function buildZonesOfficialRows<T extends ZonesListItem>(
  sortedItems: readonly T[],
  groupOrder: readonly string[]
): ZonesListRow<T>[] {
  const rows: ZonesListRow<T>[] = [];
  const live = sortedItems.filter((it) => it.status === 'in_progress');
  const rest = sortedItems.filter((it) => it.status !== 'in_progress');
  const known = new Set(groupOrder);
  const labels = [...groupOrder, ...[...new Set(live.map((it) => it.groupLabel ?? ''))].filter((l) => l && !known.has(l))];
  for (const label of labels) {
    const inGroup = live.filter((it) => it.groupLabel === label);
    if (inGroup.length === 0) continue;
    rows.push({ kind: 'header', id: `hdr-live-${label}`, title: label });
    for (const it of inGroup) rows.push({ kind: 'pairing', id: it.id, item: it });
  }
  // partidas en vivo sin etiqueta de grupo (no debería pasar): quedan arriba, sin header
  for (const it of live.filter((x) => !x.groupLabel)) rows.push({ kind: 'pairing', id: it.id, item: it });
  rest.forEach((it, i) => {
    rows.push(i === 0 && live.length > 0 ? { kind: 'pairing', id: it.id, item: it, gapBefore: true } : { kind: 'pairing', id: it.id, item: it });
  });
  return rows;
}

export type CompletenessPairing = {
  stage?: string | null;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  official_draw: boolean | null;
};

/**
 * Completitud de UNA zona (pie de su tabla de posiciones): total = enfrentamientos 'zone' de esa zona + interzonales donde
 * participa al menos un jugador de esa zona (un interzonal cuenta en ambos grupos); completados = los de ese conjunto
 * con resultado oficial cerrado. Mismo criterio de "cerrado" que zones_check_phase_complete (0137): ganador o empate;
 * un par donde los DOS jugadores se fueron cuenta como cerrado. Los demás stages (venganzas, llaves) no cuentan.
 */
export function zonePhaseCompleteness(
  zoneId: string,
  pairings: readonly CompletenessPairing[],
  zoneByParticipant: ReadonlyMap<string, string>,
  leftIds: ReadonlySet<string>
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const p of pairings) {
    const za = zoneByParticipant.get(p.participant_a_id);
    const zb = zoneByParticipant.get(p.participant_b_id);
    const belongs =
      p.stage === 'zone' ? za === zoneId && zb === zoneId : p.stage === 'interzonal' ? za === zoneId || zb === zoneId : false;
    if (!belongs) continue;
    total += 1;
    const closed =
      p.official_winner_participant_id != null ||
      p.official_draw === true ||
      (leftIds.has(p.participant_a_id) && leftIds.has(p.participant_b_id));
    if (closed) done += 1;
  }
  return { done, total };
}
