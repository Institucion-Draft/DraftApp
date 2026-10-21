/**
 * Aviso de "desbloqueaste la Gen 3": cuándo corresponde mostrarlo. Lógica pura (sin acceso a datos).
 *
 * Se muestra si la Gen 3 está desbloqueada (users.gen3_unlocked_at), el jugador todavía no lo vio
 * (users.gen3_unlock_seen_at) y en esta sesión de la app no se mostró ya para ese usuario. El último chequeo
 * evita que aparezca dos veces seguidas (doble foco, re-render, carga lenta) y que entre en bucle si falla la
 * escritura del "visto": una vez mostrado en la sesión no se vuelve a mostrar aunque la base siga sin el dato.
 */

export const GEN3_NOTICE_TEXT = 'Felicidades, desbloqueaste los pokemones de tercera generación';

export function shouldShowGen3Notice(input: {
  unlockedAt: string | null | undefined;
  seenAt: string | null | undefined;
  /** Ya se mostró (o se está mostrando) para este usuario en esta sesión de la app. */
  shownThisSession: boolean;
}): boolean {
  if (input.shownThisSession) return false;
  if (!input.unlockedAt) return false;
  if (input.seenAt) return false;
  return true;
}
