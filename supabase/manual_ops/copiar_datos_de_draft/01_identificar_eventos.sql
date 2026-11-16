-- ============================================================================================================================
-- 01 — IDENTIFICAR los dos eventos (SOLO LECTURA). Muestra los 6 eventos más recientes (por draft/fecha) de cada workspace, sin borrados.
-- Marcá cuál es el FALLIDO (tipo de competición equivocado, con los datos reales del draft) y cuál el BUENO (tipo correcto), y copiá sus ids
-- en el bloque PARÁMETROS de 02_copiar_fallido_a_bueno.sql. Correr como postgres.
-- ============================================================================================================================
with ult as (
  select de.*,
         row_number() over (partition by de.workspace_id
                            order by coalesce(de.draft_started_at, de.scheduled_for) desc, de.created_at desc) as rn
  from public.draft_events de
  where de.deleted_at is null
)
select w.name                                  as workspace,
       u.id                                    as evento_id,
       u.name                                  as nombre,
       u.event_type                            as tipo_evento,
       u.competition_format                    as competicion,
       u.match_format                          as formato_partidas,
       u.status                                as estado,
       u.is_official                           as oficial,
       u.scheduled_for                         as programado,
       u.draft_started_at                      as draft_inicio,
       u.draft_ended_at                        as draft_fin,
       round(extract(epoch from (u.draft_ended_at - u.draft_started_at)) / 60)::integer as draft_min,
       u.event_ended_at                        as fin_evento,
       u.created_at                            as creado,
       (select count(*) from public.event_participants ep
         where ep.event_id = u.id and ep.role = 'player' and ep.left_event_at is null) as jugadores,
       (select count(*) from public.matches m join public.pairings p on p.id = m.pairing_id
         where p.event_id = u.id)                                                      as partidas,
       u.is_timed_draft                        as con_cronometro,
       (select count(*) from public.draft_timer_logs l where l.event_id = u.id)        as logs_cronometro,
       u.random_seating_enabled                as sorteo_lugares,
       (select s.is_current from public.event_seating s where s.event_id = u.id)       as sorteo_vigente
from ult u
join public.workspaces w on w.id = u.workspace_id
where u.rn <= 6
order by w.name, u.rn;
