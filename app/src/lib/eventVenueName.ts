import { supabase } from './supabase';

/** Nombre de la sede del evento (draft_events.venue_id -> venues.name), o null si no tiene. */
export async function fetchEventVenueName(eventId: string): Promise<string | null> {
  const evRes = await supabase.from('draft_events').select('venue_id').eq('id', eventId).maybeSingle();
  const venueId = (evRes.data as { venue_id: string | null } | null)?.venue_id ?? null;
  if (evRes.error || !venueId) return null;
  const vRes = await supabase.from('venues').select('name').eq('id', venueId).maybeSingle();
  return (vRes.data as { name: string | null } | null)?.name?.trim() || null;
}
