import { supabase } from './supabase';
import { sortReceived, type ReceivedRow } from './pokemonReceived';

/**
 * Historial de Pokémon asignados por evento de un jugador en un workspace. Tablas: event_participants (user_id /
 * member_b_user_id, role = 'player', rotated_avatar_id / member_b_rotated_avatar_id, is_shiny / member_b_is_shiny),
 * default_avatars (name, storage_path, storage_path_shiny, pokemon_type) y draft_events (name, scheduled_for, created_at).
 * Sólo eventos oficiales, no borrados y no cancelados del workspace. 2HG incluido (miembro A y miembro B). Las filas sin
 * Pokémon rotado (foto propia) se omiten. No usa users.default_avatar_id. No depende de las columnas de la 0142.
 */

type Avatar = { name: string; storage_path: string; storage_path_shiny: string | null; pokemon_type: string | null };
type EventEmbed = { id: string; name: string; scheduled_for: string | null; created_at: string | null };
type RowA = { id: string; is_shiny: boolean | null; default_avatars: Avatar | Avatar[] | null; draft_events: EventEmbed | EventEmbed[] | null };
type RowB = { id: string; member_b_is_shiny: boolean | null; default_avatars: Avatar | Avatar[] | null; draft_events: EventEmbed | EventEmbed[] | null };

function first<T>(x: T | T[] | null | undefined): T | null {
  return Array.isArray(x) ? (x[0] ?? null) : (x ?? null);
}

function toRow(
  id: string,
  shiny: boolean | null,
  av: Avatar | Avatar[] | null,
  ev: EventEmbed | EventEmbed[] | null
): ReceivedRow | null {
  const a = first(av);
  const e = first(ev);
  if (!a || !e) return null;
  return {
    id,
    eventId: e.id,
    eventName: e.name,
    eventDate: e.scheduled_for ?? e.created_at ?? null,
    name: a.name,
    storagePath: a.storage_path,
    storagePathShiny: a.storage_path_shiny,
    pokemonType: a.pokemon_type,
    isShiny: !!shiny,
  };
}

const AVATAR_COLS = 'name, storage_path, storage_path_shiny, pokemon_type';
const EVENT_COLS =
  'draft_events!inner(id, name, scheduled_for, created_at, workspace_id, is_official, deleted_at, status)';

export async function fetchReceivedPokemon(userId: string, workspaceId: string): Promise<ReceivedRow[]> {
  const [aRes, bRes] = await Promise.all([
    supabase
      .from('event_participants')
      .select(`id, is_shiny, default_avatars!event_participants_rotated_avatar_id_fkey(${AVATAR_COLS}), ${EVENT_COLS}`)
      .eq('user_id', userId)
      .eq('role', 'player')
      .not('rotated_avatar_id', 'is', null)
      .eq('draft_events.workspace_id', workspaceId)
      .eq('draft_events.is_official', true)
      .is('draft_events.deleted_at', null)
      .neq('draft_events.status', 'cancelled'),
    supabase
      .from('event_participants')
      .select(
        `id, member_b_is_shiny, default_avatars!event_participants_member_b_rotated_avatar_id_fkey(${AVATAR_COLS}), ${EVENT_COLS}`
      )
      .eq('member_b_user_id', userId)
      .eq('role', 'player')
      .not('member_b_rotated_avatar_id', 'is', null)
      .eq('draft_events.workspace_id', workspaceId)
      .eq('draft_events.is_official', true)
      .is('draft_events.deleted_at', null)
      .neq('draft_events.status', 'cancelled'),
  ]);
  if (aRes.error) throw aRes.error;
  if (bRes.error) throw bRes.error;

  const out: ReceivedRow[] = [];
  for (const r of (aRes.data ?? []) as unknown as RowA[]) {
    const row = toRow(`${r.id}|a`, r.is_shiny, r.default_avatars, r.draft_events);
    if (row) out.push(row);
  }
  for (const r of (bRes.data ?? []) as unknown as RowB[]) {
    const row = toRow(`${r.id}|b`, r.member_b_is_shiny, r.default_avatars, r.draft_events);
    if (row) out.push(row);
  }
  return sortReceived(out);
}
