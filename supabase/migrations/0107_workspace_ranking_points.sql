-- 0107_workspace_ranking_points.sql
--
-- "Ranking Global" del workspace: tabla de posiciones de TODOS los que alguna vez jugaron en el
-- workspace (sin filtrar por membresía vigente), con columnas Puntos/Copas/EJ/WRE/PJ/WRP/VJ/WRV.
-- Mismo patrón arquitectónico que el resto de las stats cross-evento del repo (v_player_
-- workspace_stats, v_head_to_head_stats, v_player_streaks, v_player_color_stats,
-- v_participant_event_placement): vistas SQL, calculadas on-the-fly, sin tabla persistida ni
-- trigger — la pantalla hace 2 selects (esta vista + v_workspace_points) y los combina del lado
-- del cliente, mismo patrón que ya usa CrossEventStats.tsx para nombres de rivales.
--
-- Dos partes:
--
-- 1. Fix de v_player_workspace_stats (Copas/EJ/WRE/PJ/WRP), dos bugs reales encontrados al
--    investigar de dónde salía cada columna:
--
--    a) Nunca se excluyó Gigante de Dos Cabezas. 0058/0063 agregaron
--       `de.event_type <> 'two_headed_giant'` a v_head_to_head_stats y v_player_streaks
--       (en eventos 2HG cada gigante comparte una fila de event_participants — solo el
--       user_id del miembro A queda registrado, así que sumar esos resultados contamina la
--       historia INDIVIDUAL de ese jugador), pero jamás se tocó v_player_workspace_stats
--       (confirmado: solo aparece en 0001 y 0043, ambas anteriores a que 2HG existiera como
--       feature en 0051). Hoy `championships`/`pairings_won`/etc. de esa vista están
--       contaminados por victorias en equipo de 2HG. Se agrega la misma exclusión.
--
--    b) pairings_won/pairings_lost (EJ/WRE) solo contaban fase regular
--       (`pairings.official_winner_participant_id`, que el trigger update_pairing_official_
--       result únicamente setea para match_type='draft') — el bracket real de Top4 (semis,
--       final, 3°/4°) vive en event_tiebreak_bracket_matches.winner_participant_id, una
--       columna totalmente aparte, así que quedaba afuera. v_head_to_head_stats YA resuelve
--       esto para el historial vs. rivales (CTE bracket_bo3, 0043/0058) — acá se aplica el
--       mismo criterio, agregado como CTE adicional. draft_matches_won/lost (PJ/WRP) tenía el
--       mismo problema pero más simple de arreglar: `m` ya llega vía join con `pairings`
--       (que ya incluye las filas de pairings linkeadas al bracket, ver
--       link_bracket_matches_to_pairings), así que las partidas individuales del bracket
--       (match_type='tiebreak') ya estaban en el join — solo hacía falta ensanchar el FILTER
--       de 'draft' a ('draft','tiebreak','final'), el mismo trío que ya usan v_head_to_head_
--       stats/v_player_streaks/0082 como definición de "partida oficial" (VJ/revenge sigue
--       totalmente aparte, sin tocar).
--
-- 2. v_workspace_points (nueva): el sistema de "Puntos" en sí, solo eventos
--    status in ('completed','concluded'). Tres ramas, UNION ALL, agregadas por (user_id,
--    workspace_id):
--
--    a) liga_first_bonus: +4 al seed=1 del grupo group_origin='round_robin_topcut' de cada
--       evento round_robin+top4 (ese seed es "quien fue 1° de la fase liga" — se fija una
--       sola vez al crear el bracket real, a partir del orden de standings, y sobrevive a
--       recálculos por walkover porque el grupo viejo queda 'superseded' y el nuevo hereda el
--       seed correcto). Se filtra status<>'superseded' para no contar dos veces si el evento
--       tuvo más de un bracket real por una salida antes de semis.
--
--    b) bracket_placement: 10/6/4/2 para 1°/2°/3°/4° del bracket real, tanto
--       round_robin_topcut como swiss_topcut (Suizo nunca tiene el bonus de la rama a). Sale
--       de event_tiebreak_bracket_matches por separado para bracket_phase='final' (1°=ganador,
--       2°=perdedor) y 'third_place' (3°=ganador, 4°=perdedor) — CADA fila con su propio
--       winner_participant_id is not null, no el status del evento. Esto importa de verdad:
--       evaluate_tiebreak_group_after_match fija draft_events.status='completed' apenas se
--       resuelve la fila 'final' (0026), SIN esperar a que 'third_place' se juegue — un evento
--       puede quedar 'completed' con el 3er/4to puesto todavía pendiente, y en ese estado el
--       1°/2° ya deben tener sus puntos pero el 3°/4° todavía no.
--
--    c) rr_no_top: round_robin SIN top4. champion_user_id del evento = 1° siempre único (+10).
--       2°/3°/4° (6/4/2): dense_rank() por puntaje de fase regular (1pt/pairing ganado en
--       BO1/BO3, 3/1/0 en BO2) de todos los participantes activos (left_event_at is null)
--       excluyendo al campeón — empate exacto en puntaje = mismo dense_rank = misma cantidad
--       de puntos de esa posición, sin usar el criterio de desempate fino (calidad de
--       rivales/hash) que existe para otros fines. Esto es DISTINTO de "quién es 1°": el 1°
--       siempre sale de champion_user_id, que ya es único por el desempate real de 1er puesto
--       ya implementado (group_origin='round_robin_first_place').

-- ===========================================================================
-- 1. v_player_workspace_stats: excluir 2HG + incluir bracket real en EJ/WRE y PJ/WRP
-- ===========================================================================
drop view if exists public.v_player_workspace_stats;

create view public.v_player_workspace_stats as
with bracket_pairings as (
  -- Enfrentamientos (bo3-level) del bracket real de Top4 (semis, final, 3°/4°), ganados y
  -- perdidos, por user_id/workspace_id. Mismo criterio que bracket_bo3 en v_head_to_head_stats
  -- (0043/0058), pero agregado sin la dimensión de rival (acá no importa contra quién).
  select
    ep.user_id,
    de.workspace_id,
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
  join public.event_participants ep
    on (bm.participant_a_id = ep.id or bm.participant_b_id = ep.id)
   and ep.role = 'player'
  group by ep.user_id, de.workspace_id
)
select
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
  avg(extract(epoch from (m.ended_at - m.started_at)) / 60) filter (
    where m.status = 'completed'
    and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  ) as avg_match_duration_minutes
from public.event_participants ep
join public.draft_events de
  on de.id = ep.event_id
 and de.deleted_at is null
 and de.event_type <> 'two_headed_giant'
left join public.pairings p on p.event_id = de.id and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
left join public.matches m on m.pairing_id = p.id
left join bracket_pairings bp on bp.user_id = ep.user_id and bp.workspace_id = de.workspace_id
group by ep.user_id, de.workspace_id;

grant select on public.v_player_workspace_stats to anon, authenticated;

-- ===========================================================================
-- 2. v_workspace_points: sistema de "Puntos" nuevo — solo eventos completed/concluded
-- ===========================================================================
create or replace view public.v_workspace_points as
with liga_first_bonus as (
  -- Round Robin CON top4: +4 al seed=1 del bracket real (1° de la fase liga), siempre,
  -- independientemente del resultado del mata-mata posterior.
  select gp.user_id, de.workspace_id, 4 as points
  from public.event_tiebreak_group_participants gp
  join public.event_tiebreak_groups g on g.id = gp.group_id
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  where g.group_type = 'bracket'
    and g.group_origin = 'round_robin_topcut'
    and g.status <> 'superseded'
    and gp.seed = 1
),
bracket_placement as (
  -- Round Robin CON top4 y Suizo (siempre con top4): 10/6/4/2 para 1°/2°/3°/4° del bracket
  -- real. 'final' y 'third_place' se leen por separado — cada una otorga sus puntos en cuanto
  -- ESA fila tiene winner_participant_id, sin esperar a la otra ni al status del evento.
  select ep.user_id, de.workspace_id, pts.points
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g
    on g.id = bm.group_id
   and g.group_origin in ('round_robin_topcut', 'swiss_topcut')
   and g.status <> 'superseded'
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  cross join lateral (
    values
      (bm.participant_a_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_a_id then 10 else 6 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_a_id then 4 else 2 end)
      end),
      (bm.participant_b_id, case
        when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_b_id then 10 else 6 end)
        when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_b_id then 4 else 2 end)
      end)
  ) as pts(participant_id, points)
  join public.event_participants ep on ep.id = pts.participant_id
  where bm.bracket_phase in ('final', 'third_place')
    and bm.winner_participant_id is not null
),
rr_no_top_champion as (
  -- Round Robin SIN top4: 1° = champion_user_id del evento, siempre único (desempate real de
  -- 1er puesto ya implementado). +10.
  select ep.user_id, de.workspace_id, 10 as points
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id
   and ep.user_id = de.champion_user_id
   and ep.role = 'player'
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
rr_no_top_points as (
  -- Puntaje de fase regular de cada participante activo, excluyendo al campeón (ya cubierto
  -- arriba) — base para el dense_rank de 2°/3°/4°. BO1/BO3: 1pt/pairing ganado. BO2: 3/1/0.
  select
    ep.id as participant_id,
    ep.user_id,
    de.id as event_id,
    de.workspace_id,
    coalesce(sum(
      case
        when p.official_winner_participant_id = ep.id
          then (case when de.match_format = 'bo2' then 3 else 1 end)
        when p.official_winner_participant_id is null
          and p.official_draw = true
          and de.match_format = 'bo2'
          and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
          then 1
        else 0
      end
    ), 0) as points
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.competition_format = 'round_robin'
   and de.top_size is null
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
   and de.champion_user_id is not null
  left join public.pairings p
    on p.event_id = de.id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  where ep.role = 'player'
    and ep.left_event_at is null
    and ep.user_id <> de.champion_user_id
  group by ep.id, ep.user_id, de.id, de.workspace_id
),
rr_no_top_ranked as (
  select
    user_id,
    workspace_id,
    dense_rank() over (partition by event_id order by points desc) as pos_rank
  from rr_no_top_points
),
rr_no_top_placement as (
  select user_id, workspace_id,
    case pos_rank when 1 then 6 when 2 then 4 when 3 then 2 else 0 end as points
  from rr_no_top_ranked
  where pos_rank <= 3
),
all_points as (
  select user_id, workspace_id, points from liga_first_bonus
  union all
  select user_id, workspace_id, points from bracket_placement
  union all
  select user_id, workspace_id, points from rr_no_top_champion
  union all
  select user_id, workspace_id, points from rr_no_top_placement
)
select user_id, workspace_id, sum(points)::integer as points
from all_points
group by user_id, workspace_id;

grant select on public.v_workspace_points to anon, authenticated;
