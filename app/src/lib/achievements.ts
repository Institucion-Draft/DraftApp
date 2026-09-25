import { supabase } from './supabase';

/**
 * Logros de temporada (backend: migraciones 0121-0124). Todo el acceso a datos de las pantallas de
 * Logros pasa por acá. Los desbloqueos los escribe solo el backend; el cliente solo lee y marca
 * como visto (mark_achievements_seen / mark_event_diary_seen).
 */

export type AchievementDefinition = {
  id: string;
  code: string;
  name: string;
  description: string;
  /** 1-15, único por logro: placeholder numerado hasta que exista el arte final de las medallas. */
  icon_slot: number;
  sort_order: number;
  /** Logro secreto: mientras no esté desbloqueado (para quien mira), su nombre y descripción no se muestran. */
  is_secret: boolean;
};

export type AchievementUnlock = {
  id: string;
  workspace_id: string;
  season_id: string;
  user_id: string;
  achievement_id: string;
  source_event_id: string | null;
  unlocked_at: string;
  seen_at: string | null;
};

export type AchievementStat = {
  /** Miembros ACTUALES del workspace que lo tienen en la temporada. */
  count: number;
  /** count sobre los miembros actuales del workspace, 0-100. */
  percent: number;
};

const DEFINITION_COLUMNS = 'id, code, name, description, icon_slot, sort_order, is_secret';
const UNLOCK_COLUMNS = 'id, workspace_id, season_id, user_id, achievement_id, source_event_id, unlocked_at, seen_at';

export async function fetchAchievementDefinitions(): Promise<AchievementDefinition[]> {
  const { data, error } = await supabase
    .from('achievement_definitions')
    .select(DEFINITION_COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    if (__DEV__) console.error('[achievements] definiciones', error);
    return [];
  }
  return (data ?? []) as AchievementDefinition[];
}

/** Todos los desbloqueos de la temporada (la RLS deja leerlos a los miembros del workspace). */
export async function fetchSeasonUnlocks(seasonId: string): Promise<AchievementUnlock[]> {
  const { data, error } = await supabase
    .from('achievement_unlocks')
    .select(UNLOCK_COLUMNS)
    .eq('season_id', seasonId);
  if (error) {
    if (__DEV__) console.error('[achievements] desbloqueos', error);
    return [];
  }
  return (data ?? []) as AchievementUnlock[];
}

export async function fetchWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
  const { data, error } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId);
  if (error) {
    if (__DEV__) console.error('[achievements] miembros', error);
    return [];
  }
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
}

/**
 * Porcentaje de miembros ACTUALES del workspace que tiene cada logro en la temporada. Quien
 * desbloqueó un logro y después dejó el workspace no cuenta (el denominador tampoco lo incluye).
 */
export function computeAchievementStats(
  definitions: AchievementDefinition[],
  unlocks: AchievementUnlock[],
  memberIds: string[]
): Map<string, AchievementStat> {
  const members = new Set(memberIds);
  const holders = new Map<string, Set<string>>();
  for (const u of unlocks) {
    if (!members.has(u.user_id)) continue;
    const set = holders.get(u.achievement_id) ?? new Set<string>();
    set.add(u.user_id);
    holders.set(u.achievement_id, set);
  }
  const out = new Map<string, AchievementStat>();
  for (const d of definitions) {
    const count = holders.get(d.id)?.size ?? 0;
    out.set(d.id, { count, percent: members.size > 0 ? (count / members.size) * 100 : 0 });
  }
  return out;
}

/** Texto que reemplaza el nombre de un logro secreto todavía bloqueado. */
export const SECRET_ACHIEVEMENT_NAME = '??????';

/**
 * ¿Se pueden mostrar el nombre y la descripción? Los no secretos, siempre; los secretos, solo una
 * vez desbloqueados PARA QUIEN MIRA (el usuario cuyo logro se está viendo). Único punto de decisión:
 * todas las pantallas pasan por estas funciones para no filtrar nunca el texto de un secreto.
 */
export function isAchievementRevealed(def: Pick<AchievementDefinition, 'is_secret'>, unlocked: boolean): boolean {
  return !def.is_secret || unlocked;
}

export function achievementDisplayName(
  def: Pick<AchievementDefinition, 'name' | 'is_secret'>,
  unlocked: boolean
): string {
  return isAchievementRevealed(def, unlocked) ? def.name : SECRET_ACHIEVEMENT_NAME;
}

/** null = no se muestra descripción. */
export function achievementDisplayDescription(
  def: Pick<AchievementDefinition, 'description' | 'is_secret'>,
  unlocked: boolean
): string | null {
  return isAchievementRevealed(def, unlocked) ? def.description : null;
}

/** "0%", "<1%", "12%": entero, y "<1%" si es mayor que 0 pero no llega a 1. */
export function formatAchievementPercent(percent: number): string {
  if (percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

export async function fetchSeasonWorkspaceId(seasonId: string): Promise<string | null> {
  const { data } = await supabase.from('seasons').select('workspace_id').eq('id', seasonId).maybeSingle();
  return (data as { workspace_id?: string } | null)?.workspace_id ?? null;
}

/**
 * Red de seguridad: reevalúa los eventos elegibles del workspace y otorga los logros que los
 * triggers no hayan podido otorgar en su momento (idempotente). Silenciosa: nunca lanza.
 */
export async function syncWorkspaceAchievements(workspaceId: string): Promise<void> {
  const { error } = await supabase.rpc('sync_workspace_achievements', { p_workspace_id: workspaceId });
  if (error && __DEV__) {
    console.warn('[achievements] sync_workspace_achievements', error.message);
  }
}

/** Marca como vistos los logros del usuario actual en la temporada. Nunca lanza. */
export async function markAchievementsSeen(seasonId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_achievements_seen', { p_season_id: seasonId });
  if (error && __DEV__) console.warn('[achievements] mark_achievements_seen', error.message);
}

/** Marca la bitácora del evento como vista por el usuario actual. Nunca lanza. */
export async function markEventDiarySeen(eventId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_event_diary_seen', { p_event_id: eventId });
  if (error && __DEV__) console.warn('[achievements] mark_event_diary_seen', error.message);
}

/** Indicador personal: ¿el usuario tiene algún logro sin ver en esa temporada? */
export async function hasUnseenAchievements(seasonId: string, userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('achievement_unlocks')
    .select('id', { count: 'exact', head: true })
    .eq('season_id', seasonId)
    .eq('user_id', userId)
    .is('seen_at', null);
  if (error) {
    if (__DEV__) console.warn('[achievements] sin ver', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

/**
 * Indicador de la bitácora de un evento: ¿hay algún logro conseguido en este evento posterior a la
 * última visita del usuario a su bitácora (o nunca la visitó y existe al menos uno)?
 */
export async function hasUnseenEventAchievements(eventId: string, userId: string): Promise<boolean> {
  const seenRes = await supabase
    .from('event_diary_seen')
    .select('last_seen_at')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .maybeSingle();
  const lastSeen = (seenRes.data as { last_seen_at?: string } | null)?.last_seen_at ?? null;

  let query = supabase
    .from('achievement_unlocks')
    .select('id', { count: 'exact', head: true })
    .eq('source_event_id', eventId);
  if (lastSeen) query = query.gt('unlocked_at', lastSeen);
  const { count, error } = await query;
  if (error) {
    if (__DEV__) console.warn('[achievements] logros del evento sin ver', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

export type EventAchievementItem = {
  id: string;
  user_id: string;
  season_id: string;
  achievement_id: string;
  unlocked_at: string;
  userName: string;
  achievementName: string;
  iconSlot: number;
};

type EventAchievementRow = {
  id: string;
  user_id: string;
  season_id: string;
  achievement_id: string;
  unlocked_at: string;
  users: { display_name: string; username: string } | { display_name: string; username: string }[] | null;
  achievement_definitions:
    | { name: string; icon_slot: number }
    | { name: string; icon_slot: number }[]
    | null;
};

function one<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

/** Logros conseguidos en un evento, para sintetizar los mensajes en su bitácora. */
export async function fetchEventAchievementItems(eventId: string): Promise<EventAchievementItem[]> {
  const { data, error } = await supabase
    .from('achievement_unlocks')
    .select(
      `
      id,
      user_id,
      season_id,
      achievement_id,
      unlocked_at,
      users (display_name, username),
      achievement_definitions (name, icon_slot)
    `
    )
    .eq('source_event_id', eventId)
    .order('unlocked_at', { ascending: false });
  if (error) {
    if (__DEV__) console.error('[achievements] logros del evento', error);
    return [];
  }
  return ((data ?? []) as unknown as EventAchievementRow[]).map((row) => {
    const u = one(row.users);
    const d = one(row.achievement_definitions);
    return {
      id: row.id,
      user_id: row.user_id,
      season_id: row.season_id,
      achievement_id: row.achievement_id,
      unlocked_at: row.unlocked_at,
      userName: u?.display_name?.trim() || u?.username || 'Jugador',
      achievementName: d?.name ?? 'un logro',
      iconSlot: d?.icon_slot ?? 1,
    };
  });
}

export async function fetchUserDisplayName(userId: string): Promise<string> {
  const { data } = await supabase.from('users').select('display_name, username').eq('id', userId).maybeSingle();
  const row = data as { display_name?: string; username?: string } | null;
  return row?.display_name?.trim() || row?.username || 'Jugador';
}
