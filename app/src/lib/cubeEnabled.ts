/**
 * Cubos habilitados / deshabilitados (public.cubes.is_enabled, migración 0160). Lógica pura, sin red ni React.
 *
 * Un cubo deshabilitado no entra en la ruleta de cubos (ni en las opciones, ni en el N de las probabilidades pesadas, ni en la
 * elección manual de "Jugador elige"), pero NO se borra ni afecta lo ya jugado. Una fila sin el flag (null/undefined: APK o consulta que
 * no lo conoce) cuenta como habilitada, igual que el default de la base.
 */

export type CubeEnabledFlag = { is_enabled?: boolean | null };

export const LAST_ENABLED_CUBE_TITLE = 'No se puede deshabilitar';
export const LAST_ENABLED_CUBE_MESSAGE = 'Tiene que quedar al menos un cubo habilitado: sin cubos habilitados la ruleta no puede girar.';
export const NO_ENABLED_CUBES_NOTICE = 'No hay cubos habilitados. Habilitá al menos uno para poder tirar la ruleta.';

export function isCubeEnabled(cube: CubeEnabledFlag): boolean {
  return cube.is_enabled !== false;
}

/** Los cubos que pueden salir en la ruleta (conserva el orden). */
export function filterEnabledCubes<T extends CubeEnabledFlag>(cubes: readonly T[]): T[] {
  return cubes.filter(isCubeEnabled);
}

export function enabledCubeCount(cubes: readonly CubeEnabledFlag[]): number {
  return cubes.reduce((n, c) => n + (isCubeEnabled(c) ? 1 : 0), 0);
}

/**
 * ¿Se puede deshabilitar este cubo? No si es el ÚLTIMO habilitado (con 0 habilitados la ruleta no puede girar) ni si no está en la
 * lista. Si ya está deshabilitado devuelve true (no hay nada que impedir).
 */
export function canDisableCube(cubes: readonly (CubeEnabledFlag & { id: string })[], cubeId: string): boolean {
  const cube = cubes.find((c) => c.id === cubeId);
  if (!cube) return false;
  if (!isCubeEnabled(cube)) return true;
  return enabledCubeCount(cubes) > 1;
}

// ── Nivel de evento (0163) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Cada evento puede PRENDER o APAGAR cualquier cubo (public.event_cube_overrides.is_enabled), incluso uno apagado en el global, y eso nunca
// modifica el global. Elegibilidad efectiva = el estado propio del evento si existe; si no, el global en vivo (cubes.is_enabled).

export const EVENT_LAST_ELIGIBLE_MESSAGE = 'Tiene que quedar al menos un cubo elegible en este evento: sin cubos elegibles la ruleta no puede girar.';
export const NO_ELIGIBLE_CUBES_NOTICE = 'No hay cubos elegibles en este evento. Prendé alguno en "Habilitar/Deshabilitar cubos".';

export type EventCubeInput = CubeEnabledFlag & { id: string };
/** Estado propio de un cubo en un evento (una fila de event_cube_overrides). */
export type EventCubeOverride = { cube_id: string; is_enabled: boolean };

export type EventCubeRow<T extends EventCubeInput = EventCubeInput> = T & {
  /** Habilitado en el global. */
  globalEnabled: boolean;
  /** Estado propio del evento (true/false) o null si hereda el global. */
  override: boolean | null;
  /** Elegible en la ruleta de este evento: el estado propio si existe, si no el global. */
  eligible: boolean;
};

function overrideMap(overrides: Iterable<EventCubeOverride>): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const o of overrides) m.set(o.cube_id, o.is_enabled);
  return m;
}

/** ¿Es elegible este cubo en el evento? El estado propio manda; sin él, el global. */
export function isEligibleInEvent(cube: CubeEnabledFlag, override: boolean | null | undefined): boolean {
  return override == null ? isCubeEnabled(cube) : override;
}

/** Cada cubo con su estado global, propio y efectivo (conserva el orden). */
export function eventCubeRows<T extends EventCubeInput>(cubes: readonly T[], overrides: Iterable<EventCubeOverride>): EventCubeRow<T>[] {
  const m = overrideMap(overrides);
  return cubes.map((c) => {
    const override = m.has(c.id) ? (m.get(c.id) as boolean) : null;
    return { ...c, globalEnabled: isCubeEnabled(c), override, eligible: isEligibleInEvent(c, override) };
  });
}

/** Los cubos que pueden salir en la ruleta del evento (conserva el orden). Su largo es la N de las probabilidades ponderadas. */
export function effectiveEligibleCubes<T extends EventCubeInput>(cubes: readonly T[], overrides: Iterable<EventCubeOverride>): T[] {
  const m = overrideMap(overrides);
  return cubes.filter((c) => isEligibleInEvent(c, m.has(c.id) ? (m.get(c.id) as boolean) : null));
}

/**
 * ¿Se puede apagar este cubo en el evento? No si es el ÚLTIMO elegible, ni si no está en la lista. Si ya no es elegible devuelve true (no hay
 * nada que impedir). Prender siempre se puede.
 */
export function canTurnOffCubeInEvent(rows: readonly { id: string; eligible: boolean }[], cubeId: string): boolean {
  const row = rows.find((r) => r.id === cubeId);
  if (!row) return false;
  if (!row.eligible) return true;
  return rows.reduce((n, r) => n + (r.eligible ? 1 : 0), 0) > 1;
}
