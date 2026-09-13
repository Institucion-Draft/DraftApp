/**
 * Armado del bracket real de top4 de Suizo (competition_format='swiss' + top_size=4, Fase 6.6):
 * calcula el top4 en TypeScript a partir de las columnas swiss_points/omw/gw/ogw ya persistidas
 * (recalculadas por recalc_swiss_tiebreakers en cada pairing resuelto — no hace falta
 * recomputar nada acá), y llama al RPC create_swiss_top4_bracket para crearlo.
 *
 * A diferencia de roundRobinTop4Bracket.ts, no hay (todavía) interacción con walkover suizo del
 * bracket ni con el criterio de "disputa por el 4to puesto" — el desempate del corte en Suizo es
 * íntegramente matemático (puntos→OMW→GW→OGW→hash por user_id, ver 0093/0050), sin un partido
 * real de por medio (decisión explícita, ver diagnóstico de Fase 6). Por eso esta función es
 * mucho más simple: ordenar y llamar al RPC, sin ramas de disputa.
 *
 * Mismo criterio de desempate que usa el seed del bracket server-side hasta 0097
 * (maybe_advance_swiss_round) y la tabla de posiciones (StandingsScreen.tsx): puntos desc, OMW
 * desc, GW desc, OGW desc, user_id asc como desempate final determinístico.
 */
import { supabase } from './supabase';

export type SwissTop4BracketOutcome =
  | { kind: 'not_ready' }
  | { kind: 'bracket_created'; top4ParticipantIds: string[] }
  | { kind: 'error'; message: string };

type SwissParticipantRow = {
  id: string;
  left_event_at: string | null;
  swiss_points: number | null;
  swiss_omw: number | string | null;
  swiss_gw: number | string | null;
  swiss_ogw: number | string | null;
  user_id: string;
};

export async function computeAndCreateSwissTop4Bracket(eventId: string): Promise<SwissTop4BracketOutcome> {
  const partsRes = await supabase
    .from('event_participants')
    .select('id, left_event_at, swiss_points, swiss_omw, swiss_gw, swiss_ogw, user_id')
    .eq('event_id', eventId)
    .eq('role', 'player');
  if (partsRes.error) {
    return { kind: 'error', message: partsRes.error.message ?? 'No se pudieron cargar los participantes.' };
  }

  const active = (partsRes.data as SwissParticipantRow[]).filter((p) => !p.left_event_at);
  if (active.length < 4) {
    return { kind: 'not_ready' };
  }

  const sorted = [...active].sort((a, b) => {
    const ptsA = a.swiss_points ?? 0;
    const ptsB = b.swiss_points ?? 0;
    if (ptsB !== ptsA) return ptsB - ptsA;

    const omwA = a.swiss_omw != null ? Number(a.swiss_omw) : -Infinity;
    const omwB = b.swiss_omw != null ? Number(b.swiss_omw) : -Infinity;
    if (omwB !== omwA) return omwB - omwA;

    const gwA = a.swiss_gw != null ? Number(a.swiss_gw) : -Infinity;
    const gwB = b.swiss_gw != null ? Number(b.swiss_gw) : -Infinity;
    if (gwB !== gwA) return gwB - gwA;

    const ogwA = a.swiss_ogw != null ? Number(a.swiss_ogw) : -Infinity;
    const ogwB = b.swiss_ogw != null ? Number(b.swiss_ogw) : -Infinity;
    if (ogwB !== ogwA) return ogwB - ogwA;

    // Desempate final determinístico — mismo campo y dirección que StandingsScreen.tsx.
    return a.user_id.localeCompare(b.user_id);
  });

  const top4 = sorted.slice(0, 4).map((p) => p.id);

  const rpcRes = await supabase.rpc('create_swiss_top4_bracket', {
    p_event_id: eventId,
    p_top4_ordered: top4,
  });
  if (rpcRes.error) {
    return { kind: 'error', message: rpcRes.error.message ?? 'No se pudo armar el top4.' };
  }
  return { kind: 'bracket_created', top4ParticipantIds: top4 };
}
