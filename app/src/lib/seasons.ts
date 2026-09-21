import { supabase } from './supabase';

export type SeasonPhase = 'upcoming' | 'active' | 'finishing' | 'closed';

export type SeasonRow = {
  season_id: string;
  workspace_id: string;
  name: string;
  starts_at: string;
  ends_at: string | null;
  phase: SeasonPhase;
  point_config_id: string;
  closed_at: string | null;
  closed_forced: boolean;
};

export const SEASON_COLUMNS =
  'season_id, workspace_id, name, starts_at, ends_at, phase, point_config_id, closed_at, closed_forced';

/** dd/mm/aaaa en hora de Buenos Aires (UTC-3 fijo). offsetMs permite pedir, p. ej., el último día (-1). */
export function formatBaDate(iso: string, offsetMs = 0): string {
  const d = new Date(new Date(iso).getTime() + offsetMs - 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/**
 * Crea las temporadas que falten del workspace (la actual y la próxima) y cierra las que ya se
 * puedan cerrar. Idempotente; disparador client-orchestrated al abrir el workspace. Nunca lanza:
 * si falla, la pantalla sigue con lo que ya exista.
 */
export async function syncWorkspaceSeasons(workspaceId: string): Promise<void> {
  const { error } = await supabase.rpc('sync_workspace_seasons', { p_workspace_id: workspaceId });
  if (error && __DEV__) {
    console.warn('[seasons] sync_workspace_seasons', error.message);
  }
}

export async function fetchWorkspaceSeasons(workspaceId: string): Promise<SeasonRow[]> {
  const { data, error } = await supabase
    .from('v_seasons')
    .select(SEASON_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('starts_at', { ascending: true });
  if (error) {
    if (__DEV__) console.warn('[seasons] v_seasons', error.message);
    return [];
  }
  return (data ?? []) as SeasonRow[];
}

export async function fetchIsWorkspaceOrganizer(workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as { role?: string } | null)?.role === 'organizer';
}

export type UnfinishedEvent = { event_id: string; event_name: string; status: string };

/** Eventos que impiden cerrar la temporada (null si la consulta falló). */
export async function fetchUnfinishedEvents(seasonId: string): Promise<UnfinishedEvent[] | null> {
  const { data, error } = await supabase.rpc('season_unfinished_events', { p_season_id: seasonId });
  if (error) {
    if (__DEV__) console.warn('[seasons] season_unfinished_events', error.message);
    return null;
  }
  return (data ?? []) as UnfinishedEvent[];
}

/** Cierra la temporada si ya se puede (idempotente). Devuelve el resultado del RPC o null si falló. */
export async function closeSeasonIfReady(seasonId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('close_season_if_ready', { p_season_id: seasonId });
  if (error) {
    if (__DEV__) console.warn('[seasons] close_season_if_ready', error.message);
    return null;
  }
  return typeof data === 'string' ? data : null;
}

export type ForceCloseErrorCode =
  | 'not_organizer'
  | 'season_not_over'
  | 'event_not_unfinished'
  | 'not_a_player'
  | 'invalid_positions'
  | 'not_found'
  | 'unknown';

export type ForceCloseResult =
  | { ok: true; alreadyClosed: boolean }
  | { ok: false; code: ForceCloseErrorCode; message: string };

export const FORCE_CLOSE_ERROR_TEXT: Record<ForceCloseErrorCode, string> = {
  not_organizer: 'Solo un organizador del grupo puede cerrar la temporada.',
  season_not_over: 'La temporada todavía no terminó: solo se puede cerrar desde el inicio de la siguiente.',
  event_not_unfinished: 'Uno de los eventos cambió de estado mientras revisabas. Volvé a calcular los podios.',
  not_a_player: 'Hay un podio con un jugador que no participa de ese evento. Volvé a calcular los podios.',
  invalid_positions: 'Los podios calculados no son válidos. Volvé a calcular.',
  not_found: 'No se encontró la temporada.',
  unknown: 'No se pudo cerrar la temporada. Probá de nuevo.',
};

/** Llama a force_close_season con los podios asegurados calculados en el cliente. */
export async function forceCloseSeason(
  seasonId: string,
  positions: { event_id: string; user_id: string; position: number }[]
): Promise<ForceCloseResult> {
  const { data, error } = await supabase.rpc('force_close_season', {
    p_season_id: seasonId,
    p_secured_positions: positions,
  });
  if (error) {
    const m = error.message ?? '';
    const code: ForceCloseErrorCode = m.includes('NOT_ORGANIZER')
      ? 'not_organizer'
      : m.includes('SEASON_NOT_OVER')
        ? 'season_not_over'
        : m.includes('EVENT_NOT_UNFINISHED')
          ? 'event_not_unfinished'
          : m.includes('NOT_A_PLAYER')
            ? 'not_a_player'
            : m.includes('INVALID_POSITIONS')
              ? 'invalid_positions'
              : 'unknown';
    return { ok: false, code, message: FORCE_CLOSE_ERROR_TEXT[code] };
  }
  if (data === 'closed') return { ok: true, alreadyClosed: false };
  if (data === 'already_closed') return { ok: true, alreadyClosed: true };
  if (data === 'not_found') return { ok: false, code: 'not_found', message: FORCE_CLOSE_ERROR_TEXT.not_found };
  return { ok: false, code: 'unknown', message: FORCE_CLOSE_ERROR_TEXT.unknown };
}

export function phaseSubtitle(s: SeasonRow): string {
  switch (s.phase) {
    case 'upcoming':
      return `Arranca el ${formatBaDate(s.starts_at)}`;
    case 'active':
      return s.ends_at ? `En curso · hasta el ${formatBaDate(s.ends_at, -1)}` : 'En curso';
    case 'finishing':
      return `Terminó el ${s.ends_at ? formatBaDate(s.ends_at, -1) : '—'} · pendiente de cierre`;
    case 'closed':
      return `Cerrada el ${s.closed_at ? formatBaDate(s.closed_at) : '—'}`;
    default:
      return '';
  }
}
