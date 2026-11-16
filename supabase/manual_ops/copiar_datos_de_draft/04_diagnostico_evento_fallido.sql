-- ============================================================================================================================
-- 04 — DIAGNÓSTICO del evento FALLIDO (SOLO LECTURA; no ejecuta ni cambia nada). Qué cuelga de él hoy y qué lo seguiría contando.
-- Poner el id del FALLIDO. Correr como postgres. Una sola tabla: concepto / valor / qué implica.
-- ============================================================================================================================
with p as (select 'PEGAR-ID-DEL-EVENTO-FALLIDO'::uuid as f),
e as (select d.* from public.draft_events d, p where d.id = p.f),
m as (select m.* from public.matches m join public.pairings pr on pr.id = m.pairing_id, p where pr.event_id = p.f),
s as (select es.season_id, es.season_starts_at from public.v_event_season es, p where es.event_id = p.f)
select * from (
  select 1 as ord, 'evento' as concepto,
         format('%s | tipo=%s | comp=%s | estado=%s | oficial=%s | borrado=%s | cancelado=%s', e.name, e.event_type, e.competition_format, e.status, e.is_official, e.deleted_at is not null, e.cancelled_at is not null) as valor,
         'Si es oficial y no está borrado/cancelado, TODO lo de abajo se sigue contando.' as implica from e
  union all
  select 2, 'temporada (por draft_started_at)', coalesce((select season_id::text || ' (' || season_starts_at::date || ')' from s), 'ninguna'),
         'Cuenta para la temporada de su draft_started_at. Un evento NO terminado (status distinto de completed/concluded/cancelled) impide el cierre automático de esa temporada.' from e
  union all
  select 3, 'participantes (jugadores)', (select count(*) from public.event_participants ep, p where ep.event_id = p.f and ep.role = 'player')::text,
         'Sus avatares/shiny se tiraron al inscribirse: no se revierten.' from e
  union all
  select 4, 'partidas: total / completadas / en curso / abortadas',
         format('%s / %s / %s / %s', (select count(*) from m), (select count(*) from m where status = 'completed'), (select count(*) from m where status = 'in_progress'), (select count(*) from m where status = 'aborted')),
         'Sin partidas, el evento no tiene resultados que limpiar.' from e
  union all
  select 5, 'partidas VÁLIDAS para el desbloqueo de la 420 (oficial, no 2HG, no venganza, no walkover, no abortada)',
         (select count(*) from m, e where e.is_official and e.event_type <> 'two_headed_giant' and e.deleted_at is null and m.match_type <> 'revenge' and m.is_walkover = false and m.status <> 'aborted')::text,
         'Estas ocupan lugar en el orden de la temporada: dejarlas, o borrarlas con el evento, cambia qué partida es la 420.' from e
  union all
  select 6, 'desbloqueo especial ya congelado en su temporada',
         coalesce((select string_agg(format('match=%s ganador=%s perdedor=%s', u.match_id, u.winner_user_id, u.loser_user_id), '; ') from public.season_special_unlocks u join s on s.season_id = u.season_id), 'no'),
         'Si ya está congelado nunca se revierte. Si la partida 420 es de este evento, queda congelada aunque se borre el evento.' from e
  union all
  select 7, 'recompensas del desbloqueo CONSUMIDAS en este evento (winner/loser)',
         (select count(*) from public.season_special_unlocks u, p where u.winner_consumed_event_id = p.f or u.loser_consumed_event_id = p.f)::text,
         'La devolución automática SOLO ocurre si se cancela/borra ANTES de empezar el draft. Con el draft ya empezado se pierden: hay que devolverlas a mano (ver análisis).' from e
  union all
  select 8, 'inscripciones con special_reward (shiny/ditto)', (select count(*) from public.event_participants ep, p where ep.event_id = p.f and ep.special_reward is not null)::text,
         'Son las que consumieron la recompensa acá, no en el evento bueno.' from e
  union all
  select 9, 'inscripciones shiny / has_shiny_participant', (select count(*) from public.event_participants ep, p where ep.event_id = p.f and ep.is_shiny)::text || ' / ' || e.has_shiny_participant::text,
         'Aparecen en "Pokémon recibidos" de los jugadores (eventos oficiales) mientras el evento exista.' from e
  union all
  select 10, 'logros otorgados por este evento (source_event_id)', (select count(*) from public.achievement_unlocks a, p where a.source_event_id = p.f)::text,
         'Borrar o cancelar el evento NO quita logros ya otorgados (son únicos por workspace/temporada/usuario/logro).' from e
  union all
  select 11, 'filas en estadísticas oficiales (enfrentamientos / partidas)',
         (select count(*) from public.v_participant_official_results r, p where r.event_id = p.f)::text || ' / ' || (select count(*) from public.v_participant_official_games g, p where g.event_id = p.f)::text,
         'Salen de las estadísticas solo si el evento se borra (deleted_at) o es sandbox: cancelar NO las saca.' from e
  union all
  select 12, 'filas en puntos de ranking (v_workspace_points_breakdown)', (select count(*) from public.v_workspace_points_breakdown b, p where b.event_id = p.f)::text,
         'Idem: cuenta mientras el evento sea oficial y no esté borrado.' from e
  union all
  select 13, '¿lo ve analytics?', (e.is_official is true and e.deleted_at is null and e.cancelled_at is null and e.event_type <> 'two_headed_giant' and e.status in ('drafting', 'playing', 'completed', 'concluded'))::text,
         'true = aparece como un evento más (y sus partidas/participaciones) en la próxima publicación; cancelado, borrado o sandbox lo saca.' from e
  union all
  select 14, '¿bloquea el cierre de su temporada?', (e.is_official and e.deleted_at is null and e.event_type <> 'two_headed_giant' and e.draft_started_at is not null and e.status not in ('completed', 'concluded', 'cancelled'))::text,
         'true = mientras siga en este estado la temporada no cierra sola (hay que cancelarlo, borrarlo o completarlo).' from e
  union all
  select 15, 'campeón registrado', coalesce(e.champion_user_id::text, 'ninguno'), 'Si hay campeón, suma medallas/puntos en el ranking.' from e
) t
order by ord;
