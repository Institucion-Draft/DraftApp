/**
 * "Dar por concluido": disponibilidad del botón para las Copas (sólo llaves y grupos + llaves). Es la MISMA regla que
 * tiene hoy el todos contra todos, sin la parte de formato: quien gestiona el evento, evento en juego y al menos
 * 7 días después de la fecha programada.
 */
export const CONCLUDE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function isConcludeAvailable(input: {
  canManageEvent: boolean;
  status: string;
  scheduledFor: string | number | Date;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return (
    input.canManageEvent &&
    input.status === 'playing' &&
    now >= new Date(input.scheduledFor).getTime() + CONCLUDE_AFTER_MS
  );
}
