import { supabase } from './supabase';

export const PLAYGROUND_PRESENCE_COOLDOWN_HOURS = 4;

type PresenceCooldownFields = {
  user_id: string;
  last_match_ended_at: string | null;
  joined_at: string;
};

/** Presencia dentro del cooldown de actividad (mismo criterio en toda la sala). */
export function isPresenceWithinCooldown(
  row: PresenceCooldownFields,
  now: number = Date.now()
): boolean {
  const ref = row.last_match_ended_at ?? row.joined_at;
  return now - new Date(ref).getTime() < PLAYGROUND_PRESENCE_COOLDOWN_HOURS * 60 * 60 * 1000;
}

/** Separa filas `is_active=true` en las que siguen dentro del cooldown y las que ya lo superaron. */
export function splitPresenceByCooldown<T extends PresenceCooldownFields>(
  rows: T[]
): { active: T[]; stale: T[] } {
  const now = Date.now();
  const active: T[] = [];
  const stale: T[] = [];
  for (const row of rows) {
    (isPresenceWithinCooldown(row, now) ? active : stale).push(row);
  }
  return { active, stale };
}

/**
 * No hay cron que expire presencia vencida, así que cada pantalla que lee
 * playground_presence hace esta limpieza proactiva al cargar, para que la fila
 * no quede is_active=true para siempre.
 */
export async function expireStalePresence(
  workspaceId: string,
  staleUserIds: string[]
): Promise<void> {
  if (staleUserIds.length === 0) return;
  await supabase
    .from('playground_presence')
    .update({ is_active: false, left_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .in('user_id', staleUserIds);
}
