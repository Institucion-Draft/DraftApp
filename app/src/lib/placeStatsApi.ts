import { supabase } from './supabase';
import {
  pickFirstEvent,
  podiumFromFinalPositions,
  rankPlayersByPoints,
  type CubeStats,
  type EventRef,
  type FinalPositionRow,
  type PlayerNames,
  type PointsRow,
  type VenueStats,
} from './placeStats';

export type { CubeStats, VenueStats } from './placeStats';

/**
 * Datos de las estadísticas de cubo y sede. No hay vistas ni migración nuevas: se leen las que ya usa el ranking
 * (v_workspace_points_breakdown y v_event_final_positions) y se limitan a los eventos oficiales, no borrados,
 * completed/concluded y no 2HG del workspace — el mismo filtro que aplican esas vistas — leídos de draft_events.
 * El desglose sólo trae nombres de cubo y sede (no ids), así que se filtra por nombre y por el conjunto de ids de
 * evento de este cubo/sede: dos cubos con el mismo nombre (uno borrado) no se mezclan.
 */

type EventRow = EventRef & { id: string; name: string | null };

const PAGE = 1000;

async function fetchEligibleEvents(
  workspaceId: string,
  column: 'cube_id' | 'venue_id',
  id: string
): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from('draft_events')
    .select('id, name, scheduled_for')
    .eq('workspace_id', workspaceId)
    .eq(column, id)
    .eq('is_official', true)
    .is('deleted_at', null)
    .neq('event_type', 'two_headed_giant')
    .in('status', ['completed', 'concluded'])
    .order('scheduled_for', { ascending: true });
  if (error) throw error;
  return (data ?? []) as EventRow[];
}

/** Filas del desglose de puntos del workspace para un cubo o sede (por nombre), paginadas por el tope de 1000 filas. */
async function fetchBreakdown(
  workspaceId: string,
  column: 'cube_name' | 'venue_name',
  name: string
): Promise<PointsRow[]> {
  const out: PointsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('v_workspace_points_breakdown')
      .select('user_id, event_id, position, points')
      .eq('workspace_id', workspaceId)
      .eq(column, name)
      .order('event_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as PointsRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchNames(userIds: string[]): Promise<PlayerNames> {
  const names: PlayerNames = new Map();
  const unique = [...new Set(userIds)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase
      .from('users')
      .select('id, display_name, username')
      .in('id', unique.slice(i, i + 100));
    if (error) throw error;
    for (const u of (data ?? []) as { id: string; display_name: string | null; username: string | null }[]) {
      names.set(u.id, u.display_name?.trim() || u.username?.trim() || '');
    }
  }
  return names;
}

export async function fetchCubeStats(workspaceId: string, cubeId: string, cubeName: string): Promise<CubeStats> {
  const events = await fetchEligibleEvents(workspaceId, 'cube_id', cubeId);
  if (events.length === 0) return { firstEvent: null, firstPodium: [], topPlayer: null, eventsCount: 0 };

  const eventIds = new Set(events.map((e) => e.id));
  const first = pickFirstEvent(events);
  const [breakdown, positionsRes] = await Promise.all([
    fetchBreakdown(workspaceId, 'cube_name', cubeName),
    first
      ? supabase.from('v_event_final_positions').select('user_id, position').eq('event_id', first.id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (positionsRes.error) throw positionsRes.error;
  const positions = (positionsRes.data ?? []) as FinalPositionRow[];

  const ids = [...positions.map((p) => p.user_id), ...breakdown.filter((r) => eventIds.has(r.event_id)).map((r) => r.user_id)];
  const names = await fetchNames(ids);
  const top = rankPlayersByPoints(breakdown, names, { eventIds, limit: 1 });
  const podium = podiumFromFinalPositions(positions, names);

  // Participante de cada integrante del podio en ESE evento: con él se ve el Pokémon que tuvo ahí.
  const participantByUser = new Map<string, string>();
  if (first && podium.length > 0) {
    const { data: parts } = await supabase
      .from('event_participants')
      .select('id, user_id')
      .eq('event_id', first.id)
      .eq('role', 'player')
      .in('user_id', podium.map((p) => p.userId));
    for (const p of (parts ?? []) as { id: string; user_id: string }[]) participantByUser.set(p.user_id, p.id);
  }
  return {
    firstEvent: first ? { id: first.id, name: first.name, scheduled_for: first.scheduled_for } : null,
    firstPodium: podium.map((p) => ({ ...p, participantId: participantByUser.get(p.userId) ?? null })),
    topPlayer: top[0] ?? null,
    eventsCount: events.length,
  };
}

export async function fetchVenueStats(workspaceId: string, venueId: string, venueName: string): Promise<VenueStats> {
  const events = await fetchEligibleEvents(workspaceId, 'venue_id', venueId);
  if (events.length === 0) return { podium: [], eventsCount: 0 };
  const eventIds = new Set(events.map((e) => e.id));
  const breakdown = await fetchBreakdown(workspaceId, 'venue_name', venueName);
  const names = await fetchNames(breakdown.filter((r) => eventIds.has(r.event_id)).map((r) => r.user_id));
  return { podium: rankPlayersByPoints(breakdown, names, { eventIds, limit: 3 }), eventsCount: events.length };
}
