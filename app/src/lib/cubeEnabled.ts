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
