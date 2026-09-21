-- 0117_season_stats_and_breakdown.sql
--
-- Fase C del feature de Temporadas: vistas por temporada que necesita la pantalla de Temporada
-- (mismas columnas que el Ranking Global) y su detalle de puntos por jugador.
--
-- 1. v_season_player_stats: equivalente de v_player_workspace_stats (0109) agrupado por
--    (season_id, user_id) en vez de (workspace_id, user_id). Un evento cuenta en la temporada a la
--    que pertenece según v_event_season (draft_started_at contra el calendario), en cualquier
--    estado: los eventos inconclusos reflejan sus stats en vivo (EJ/WRE/PJ/WRP/VJ/WRV) aunque
--    todavía no aporten puntos. Mismo criterio que la vista del Global: excluye eliminados, 2HG y
--    sandbox (is_official = false).
--
-- 2. v_season_points_breakdown: equivalente de v_workspace_points_breakdown (0114) para una
--    temporada: una fila por (temporada, jugador, evento) con la posición y los puntos según la
--    config de ESA temporada. Sale de v_season_positions, así que incluye las posiciones
--    congeladas por un cierre forzado (columna frozen).
--
-- Vistas nuevas (no reemplazan ninguna existente), así que no hay riesgo de 42P16 por drift.
-- La verificación del final aborta la migración si el detalle no suma lo mismo que
-- v_season_points, o si el agregado por temporada de las stats supera al del workspace.

-- ===========================================================================
-- 1. v_season_player_stats
-- ===========================================================================
create or replace view public.v_season_player_stats as
with bracket_pairings as (
  -- Enfrentamientos (bo3-level) del bracket real de Top4, ganados y perdidos, por jugador y
  -- temporada. Mismo criterio que bracket_pairings de v_player_workspace_stats (0107/0109).
  select
    ep.user_id,
    es.season_id,
    count(distinct bm.id) filter (where bm.winner_participant_id = ep.id) as won,
    count(distinct bm.id) filter (
      where bm.winner_participant_id is not null and bm.winner_participant_id <> ep.id
    ) as lost
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups etg on etg.id = bm.group_id
  join public.draft_events de
    on de.id = etg.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.is_official = true
  join public.v_event_season es on es.event_id = de.id and es.season_id is not null
  join public.event_participants ep
    on (bm.participant_a_id = ep.id or bm.participant_b_id = ep.id)
   and ep.role = 'player'
  group by ep.user_id, es.season_id
)
select
  es.season_id,
  ep.user_id,
  de.workspace_id,
  count(distinct p.id) filter (where p.official_winner_participant_id = ep.id)
    + coalesce(max(bp.won), 0) as pairings_won,
  count(distinct p.id) filter (
    where p.official_winner_participant_id is not null and p.official_winner_participant_id <> ep.id
  ) + coalesce(max(bp.lost), 0) as pairings_lost,
  count(distinct p.id) filter (where p.official_winner_participant_id is null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as pairings_pending,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type in ('draft', 'tiebreak', 'final')) as draft_matches_won,
  count(m.id) filter (
    where m.winner_participant_id is not null
      and m.winner_participant_id <> ep.id
      and m.match_type in ('draft', 'tiebreak', 'final')
      and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as draft_matches_lost,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.match_type = 'revenge') as revenge_matches_won,
  count(m.id) filter (where m.winner_participant_id is not null and m.winner_participant_id <> ep.id and m.match_type = 'revenge' and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as revenge_matches_lost,
  count(m.id) filter (where m.winner_participant_id = ep.id and m.status = 'completed') as total_matches_won,
  count(m.id) filter (
    where m.winner_participant_id is not null
      and m.winner_participant_id <> ep.id
      and m.status = 'completed'
      and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as total_matches_lost,
  count(distinct p.id) filter (where p.super_cup_winner_participant_id = ep.id) as super_cups_won,
  count(distinct de.id) filter (where de.champion_user_id = ep.user_id) as championships,
  count(distinct de.id) filter (where ep.role = 'player') as events_as_player,
  count(distinct de.id) filter (where ep.role = 'ghost') as events_as_ghost,
  count(distinct de.id) filter (where ep.role = 'player' and de.status in ('completed', 'concluded')) as completed_events_as_player,
  avg(extract(epoch from (m.ended_at - m.started_at)) / 60) filter (
    where m.status = 'completed'
    and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as avg_match_duration_minutes
from public.event_participants ep
join public.draft_events de
  on de.id = ep.event_id
 and de.deleted_at is null
 and de.event_type <> 'two_headed_giant'
 and de.is_official = true
join public.v_event_season es on es.event_id = de.id and es.season_id is not null
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id
left join bracket_pairings bp on bp.user_id = ep.user_id and bp.season_id = es.season_id
group by es.season_id, ep.user_id, de.workspace_id;

-- ===========================================================================
-- 2. v_season_points_breakdown
-- ===========================================================================
create or replace view public.v_season_points_breakdown as
select
  sp.season_id,
  sp.workspace_id,
  sp.user_id,
  sp.event_id,
  de.name as event_name,
  sp.player_count,
  sp.position,
  public.workspace_ranking_points(sp.player_count, sp.position, s.point_config_id) as points,
  de.scheduled_for,
  de.competition_format,
  de.top_size,
  v.name as venue_name,
  c.name as cube_name,
  de.draft_started_at,
  de.draft_ended_at,
  sp.frozen
from public.v_season_positions sp
join public.seasons s on s.id = sp.season_id
join public.draft_events de on de.id = sp.event_id
left join public.venues v on v.id = de.venue_id
left join public.cubes c on c.id = de.cube_id;

grant select on public.v_season_player_stats to authenticated;
grant select on public.v_season_points_breakdown to authenticated;

-- ===========================================================================
-- 3. VERIFICACIÓN AUTOMÁTICA
-- ===========================================================================
do $$
declare
  v_mismatch integer;
  v_over integer;
begin
  -- El detalle debe sumar exactamente lo mismo que v_season_points.
  select count(*) into v_mismatch
  from public.v_season_points p
  full join (
    select season_id, user_id, sum(points)::integer as points
    from public.v_season_points_breakdown
    group by season_id, user_id
  ) b on b.season_id = p.season_id and b.user_id = p.user_id
  where p.points is distinct from b.points;

  if v_mismatch > 0 then
    raise exception 'Fase C (Temporadas): % (temporada, usuario) donde v_season_points_breakdown no suma lo mismo que v_season_points. Migración abortada, nada quedó aplicado.', v_mismatch;
  end if;

  -- Sumando todas las temporadas, las stats aditivas no pueden superar a las del workspace (los
  -- eventos anteriores a la primera temporada solo están en el workspace).
  select count(*) into v_over
  from (
    select
      ss.user_id, ss.workspace_id,
      sum(ss.pairings_won) as pw, sum(ss.pairings_lost) as pl,
      sum(ss.draft_matches_won) as mw, sum(ss.draft_matches_lost) as ml,
      sum(ss.revenge_matches_won) as rw, sum(ss.revenge_matches_lost) as rl,
      sum(ss.completed_events_as_player) as pe
    from public.v_season_player_stats ss
    group by ss.user_id, ss.workspace_id
  ) s
  join public.v_player_workspace_stats w on w.user_id = s.user_id and w.workspace_id = s.workspace_id
  where s.pw > w.pairings_won or s.pl > w.pairings_lost
     or s.mw > w.draft_matches_won or s.ml > w.draft_matches_lost
     or s.rw > w.revenge_matches_won or s.rl > w.revenge_matches_lost
     or s.pe > w.completed_events_as_player;

  if v_over > 0 then
    raise exception 'Fase C (Temporadas): % (usuario, workspace) donde la suma de v_season_player_stats supera a v_player_workspace_stats. Migración abortada, nada quedó aplicado.', v_over;
  end if;

  raise notice 'Fase C (Temporadas): detalle de puntos consistente con v_season_points y stats por temporada consistentes con las del workspace.';
end;
$$;
