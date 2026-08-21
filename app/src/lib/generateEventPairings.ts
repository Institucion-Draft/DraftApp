/**
 * Generación de pairings al finalizar el draft. Compartida entre EventDetailScreen
 * (botón "Finalizar draft") y DraftTimerScreen (fin automático por cronómetro).
 * No cambia el status del evento: eso queda a cargo del caller, que también decide
 * cómo manejar el rollback y los alerts según el resultado.
 */
import { supabase } from './supabase';

type PairingInsert = {
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  data_source: 'app';
};

export type GeneratePairingsResult = { ok: true; message: string } | { ok: false; message: string };

function relationOne<T>(x: T | T[] | null | undefined): T | null {
  if (x == null) return null;
  return Array.isArray(x) ? (x[0] ?? null) : x;
}

export async function generateEventPairings(eventId: string): Promise<GeneratePairingsResult> {
  const evRes = await supabase
    .from('draft_events')
    .select('competition_format')
    .eq('id', eventId)
    .maybeSingle();
  if (evRes.error || !evRes.data) {
    if (__DEV__) {
      console.error('[generatePairings] Error cargando evento', evRes.error);
    }
    return { ok: false, message: evRes.error?.message ?? 'No se pudo cargar el evento.' };
  }
  const competitionFormat =
    (evRes.data as { competition_format?: string | null }).competition_format ?? 'round_robin';

  const partsRes = await supabase
    .from('event_participants')
    .select(
      `
      id,
      users!event_participants_user_id_fkey (
        display_name,
        username
      )
    `
    )
    .eq('event_id', eventId)
    .eq('role', 'player');

  if (partsRes.error) {
    if (__DEV__) {
      console.error('[generatePairings] Error cargando participantes', partsRes.error);
    }
    return {
      ok: false,
      message: partsRes.error.message ?? 'No se pudieron generar los enfrentamientos.',
    };
  }

  const players = ((partsRes.data ?? []) as Array<{ id: string; users: any }>).map((p) => {
    const u = relationOne(p.users) as { display_name?: string; username?: string } | null;
    const name = (u?.display_name || u?.username || '').trim();
    return { id: p.id, sortName: name.toLocaleLowerCase('es-AR') };
  });

  if (players.length < 2) {
    if (__DEV__) {
      console.error('[generatePairings] Jugadores insuficientes para generar pairings', {
        eventId,
        playersLength: players.length,
      });
    }
    return { ok: false, message: 'Se necesitan al menos 2 jugadores para generar enfrentamientos.' };
  }

  players.sort((a, b) => a.sortName.localeCompare(b.sortName, 'es', { sensitivity: 'base' }));

  // swiss/swiss_bo2 generan rondas vía RPC; todo otro formato (round_robin,
  // round_robin_bo1_top4, two_headed_giant) usa el loop i<j de todos contra todos.
  const usesSwissRounds = competitionFormat === 'swiss' || competitionFormat === 'swiss_bo2';
  if (usesSwissRounds) {
    const isBo2 = competitionFormat === 'swiss_bo2';
    const roundRpc = isBo2 ? 'generate_swiss_bo2_round' : 'generate_swiss_round';
    const nPlayers = players.length;
    const swiss_rounds_total = Math.max(1, Math.ceil(Math.log2(Math.max(nPlayers, 2))));
    const updSwiss = await supabase
      .from('draft_events')
      .update({ swiss_rounds_total })
      .eq('id', eventId);
    if (updSwiss.error) {
      if (__DEV__) {
        console.error('[generatePairings] Error guardando swiss_rounds_total', updSwiss.error);
      }
      return { ok: false, message: updSwiss.error.message ?? 'No se pudo configurar el formato suizo.' };
    }

    const allPairRes = await supabase.rpc('generate_all_pairings', { p_event_id: eventId });
    if (allPairRes.error) {
      if (__DEV__) {
        console.error('[generatePairings] Error generate_all_pairings', allPairRes.error);
      }
      return {
        ok: false,
        message: allPairRes.error.message ?? 'No se pudieron crear los enfrentamientos.',
      };
    }

    const rpcRes = await supabase.rpc(roundRpc, { p_event_id: eventId, p_round: 1 });
    if (rpcRes.error) {
      if (__DEV__) {
        console.error(`[generatePairings] Error ${roundRpc}`, rpcRes.error);
      }
      return { ok: false, message: rpcRes.error.message ?? 'No se pudo generar la ronda suiza.' };
    }

    return { ok: true, message: 'Se generó la ronda 1 (formato suizo).' };
  }

  const inserts: PairingInsert[] = [];
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const aId = players[i]?.id ?? '';
      const bId = players[j]?.id ?? '';
      if (!aId || !bId || aId === bId) continue;
      const participant_a_id = aId < bId ? aId : bId;
      const participant_b_id = aId < bId ? bId : aId;
      inserts.push({
        event_id: eventId,
        participant_a_id,
        participant_b_id,
        data_source: 'app',
      });
    }
  }

  if (inserts.length === 0) {
    if (__DEV__) {
      console.error('[generatePairings] inserts vacío con jugadores suficientes', {
        eventId,
        playersLength: players.length,
        playerIds: players.map((p) => p.id),
      });
    }
    return { ok: false, message: 'No se pudieron generar enfrentamientos. Probá de nuevo.' };
  }

  const insertRes = await supabase.from('pairings').upsert(inserts, {
    onConflict: 'event_id,participant_a_id,participant_b_id',
    ignoreDuplicates: true,
  });
  if (insertRes.error) {
    if (__DEV__) {
      console.error('[generatePairings] Error insertando/upsert pairings', insertRes.error);
    }
    return {
      ok: false,
      message: insertRes.error.message ?? 'No se pudieron crear los enfrentamientos.',
    };
  }

  const verifyRes = await supabase
    .from('pairings')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  if (verifyRes.error) {
    if (__DEV__) {
      console.error('[generatePairings] Error verificando pairings insertados', verifyRes.error);
    }
    return {
      ok: false,
      message: verifyRes.error.message ?? 'No se pudieron verificar los enfrentamientos generados.',
    };
  }
  const totalInDb = verifyRes.count ?? 0;
  if (totalInDb !== inserts.length) {
    if (__DEV__) {
      console.error('[generatePairings] Verificación inconsistente de pairings', {
        eventId,
        expected: inserts.length,
        actual: totalInDb,
      });
    }
    return { ok: false, message: 'No se pudieron generar enfrentamientos. Probá de nuevo.' };
  }

  return { ok: true, message: `Se generaron ${inserts.length} enfrentamientos` };
}
