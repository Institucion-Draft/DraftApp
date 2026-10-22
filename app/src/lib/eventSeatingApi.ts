import { supabase } from './supabase';
import type { PackDirection, SeatingParticipantRow } from './eventSeating';

/**
 * Datos del sorteo de lugares (migración 0144). Lecturas directas a event_seating (vigente, lo leen los miembros) y a
 * event_seating_pending (sólo quien gestiona el evento); el azar y las escrituras pasan por las RPC
 * draw_event_seating y publish_event_seating (security definer).
 */

export type SeatEntry = { seat: number; participant_id: string; member: 'a' | 'b'; user_id: string };

export type SeatingRecord = {
  n: number;
  direction: PackDirection;
  seats: SeatEntry[];
  is_current: boolean;
};

export type DrawResult = { n: number; direction: PackDirection; seats: SeatEntry[]; warning: string | null };

function sortSeats(seats: unknown): SeatEntry[] {
  return ((Array.isArray(seats) ? seats : []) as SeatEntry[]).slice().sort((a, b) => a.seat - b.seat);
}

/** Sorteo publicado del evento (vigente u obsoleto); null si nunca se publicó uno. */
export async function fetchSeating(eventId: string): Promise<SeatingRecord | null> {
  const { data, error } = await supabase
    .from('event_seating')
    .select('n, direction, seats, is_current')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { n: number; direction: PackDirection; seats: unknown; is_current: boolean };
  return { n: row.n, direction: row.direction, seats: sortSeats(row.seats), is_current: row.is_current };
}

/** Sólo el estado vigente/obsoleto (liviano, para la pantalla del evento). */
export async function fetchSeatingState(eventId: string): Promise<{ is_current: boolean } | null> {
  const { data, error } = await supabase.from('event_seating').select('is_current').eq('event_id', eventId).maybeSingle();
  if (error) throw error;
  return data ? { is_current: !!(data as { is_current: boolean }).is_current } : null;
}

/** Sorteo pendiente (sin publicar). Sólo lo ve quien gestiona el evento; para el resto siempre es null. */
export async function fetchPendingSeating(eventId: string): Promise<DrawResult | null> {
  const { data, error } = await supabase
    .from('event_seating_pending')
    .select('n, direction, seats, warning')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { n: number; direction: PackDirection; seats: unknown; warning: string | null };
  return { n: row.n, direction: row.direction, seats: sortSeats(row.seats), warning: row.warning };
}

export async function drawSeating(eventId: string): Promise<DrawResult> {
  const { data, error } = await supabase.rpc('draw_event_seating', { p_event_id: eventId });
  if (error) throw error;
  const r = data as { n: number; direction: PackDirection; seats: unknown; warning: string | null };
  return { n: r.n, direction: r.direction, seats: sortSeats(r.seats), warning: r.warning ?? null };
}

export async function publishSeating(eventId: string): Promise<void> {
  const { error } = await supabase.rpc('publish_event_seating', { p_event_id: eventId });
  if (error) throw error;
}

/** Inscriptos del evento (para armar las personas que se sientan y el n de la mesa vacía). */
export async function fetchSeatingParticipants(eventId: string): Promise<SeatingParticipantRow[]> {
  const { data, error } = await supabase
    .from('event_participants')
    .select('id, user_id, role, left_event_at, member_b_user_id')
    .eq('event_id', eventId);
  if (error) throw error;
  return (data ?? []) as SeatingParticipantRow[];
}

export async function fetchDisplayNames(userIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(userIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.from('users').select('id, display_name, username').in('id', unique.slice(i, i + 100));
    if (error) throw error;
    for (const u of (data ?? []) as { id: string; display_name: string | null; username: string | null }[]) {
      names.set(u.id, u.display_name?.trim() || u.username?.trim() || 'Jugador');
    }
  }
  return names;
}
