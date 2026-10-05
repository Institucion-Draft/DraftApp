-- 0128_placement_bo2_points.sql
--
-- v_participant_event_placement: en round_robin con match_format = 'bo2', rr_rank y
-- rr_rank_outside_bracket pasan a ordenar por PUNTOS de tabla (3 por enfrentamiento ganado —los
-- walkovers a favor cuentan, ya setean official_winner_participant_id—, 1 por empate
-- official_draw, 0 por perdido), igual que v_rr_no_top_regular_rank y la tabla de Standings.
-- Hasta ahora ordenaban por winrate de enfrentamientos (bo3_won / bo3_completed) y después por
-- winrate de partidas; en BO2 bo3_completed ni siquiera cuenta los empates 1-1.
--
-- Reglas (confirmadas):
--   * Solo round_robin + bo2. BO1, BO3 y Suizo conservan exactamente el rank() y el orden de hoy.
--   * dense_rank() en BO2 (el puesto siguiente a un empate es el inmediato).
--   * Sin criterio secundario en BO2: los empates exactos en puntos comparten puesto.
--   * Empate por el 1°: la vista deja a ambos en 1°, como hoy en BO3 (no se agrega
--     champion_user_id); el perfil lo corrige con el podio para 1°-3° (CrossEventStats).
--
-- Se parte de la definición VIVA (pg_get_viewdef), que coincide con la de 0126. Mismas columnas,
-- tipos y orden; solo cambia cómo se calculan rr_rank / rr_rank_outside_bracket dentro de los
-- CTE. Las columnas nuevas (match_format, bo2_points, rr_rank_bo2, rr_rank_outside_bracket_bo2)
-- son internas de los CTE y no salen de la vista.
--
-- Verificación automática: antes de reemplazar la vista se guarda la posición de TODO participante
-- de eventos que NO son round_robin BO2; después se compara. Cualquier diferencia aborta la
-- migración entera (transacción: no queda nada aplicado).

create temporary table _placement_before_0128 on commit drop as
select v.participant_id, v.placement
from public.v_participant_event_placement v
where not exists (
  select 1
  from public.draft_events de
  where de.id = v.event_id
    and de.competition_format = 'round_robin'
    and de.match_format = 'bo2'
);

create or replace view public.v_participant_event_placement as
with
topcut_groups as (
  -- Un solo grupo de top cut vigente por evento (el más reciente no superseded)
  select distinct on (etg.event_id) etg.id, etg.event_id
  from public.event_tiebreak_groups etg
  where etg.group_origin in ('round_robin_topcut', 'swiss_topcut')
    and etg.status <> 'superseded'
  order by etg.event_id, etg.created_at desc
),
bracket_per_participant as (
  -- Ganador y perdedor de cada partido decisivo, cada uno con su puesto
  select g.event_id, m.winner_participant_id as participant_id,
         case m.bracket_phase when 'final' then 1 else 3 end as bracket_placement
  from topcut_groups g
  join public.event_tiebreak_bracket_matches m
    on m.group_id = g.id
   and m.bracket_phase in ('final', 'third_place')
   and m.winner_participant_id is not null
  union all
  select g.event_id,
         case when m.winner_participant_id = m.participant_a_id then m.participant_b_id else m.participant_a_id end,
         case m.bracket_phase when 'final' then 2 else 4 end
  from topcut_groups g
  join public.event_tiebreak_bracket_matches m
    on m.group_id = g.id
   and m.bracket_phase in ('final', 'third_place')
   and m.winner_participant_id is not null
),
base as (
  select
    ep.id                   as participant_id,
    ep.event_id,
    ep.user_id,
    de.workspace_id,
    de.name                 as event_name,
    de.event_ended_at,
    de.status               as event_status,
    de.scheduled_for,
    de.competition_format,
    de.match_format,
    ep.swiss_points,
    ep.swiss_omw,
    ep.swiss_gw,
    ep.swiss_ogw,
    bpp.bracket_placement,
    count(distinct p.id) filter (
      where p.official_winner_participant_id = ep.id
    )                       as bo3_won,
    count(distinct p.id) filter (
      where p.official_winner_participant_id is not null
        and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
    )                       as bo3_completed,
    count(m.id) filter (
      where m.winner_participant_id = ep.id
        and m.match_type = 'draft'
        and m.status = 'completed'
    )                       as matches_won,
    count(m.id) filter (
      where m.status = 'completed'
        and m.match_type = 'draft'
    )                       as matches_completed,
    -- Puntos BO2: 3 por enfrentamiento ganado (walkover incluido) + 1 por empate. count(distinct
    -- p.id) por la multiplicación de filas del join con matches.
    3 * count(distinct p.id) filter (
      where p.official_winner_participant_id = ep.id
    ) + count(distinct p.id) filter (
      where p.official_winner_participant_id is null
        and p.official_draw is true
        and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
    )                       as bo2_points,
    count(*) over (partition by ep.event_id) as total_players
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.deleted_at is null
   and de.is_official = true
   and de.event_type <> 'two_headed_giant'
  left join bracket_per_participant bpp
    on bpp.event_id = ep.event_id
   and bpp.participant_id = ep.id
  left join public.pairings p
    on p.event_id = ep.event_id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  left join public.matches m
    on m.pairing_id = p.id
  where ep.role = 'player'
  group by
    ep.id, ep.event_id, ep.user_id,
    de.workspace_id, de.name, de.event_ended_at, de.status, de.scheduled_for,
    de.competition_format, de.match_format, ep.swiss_points, ep.swiss_omw, ep.swiss_gw, ep.swiss_ogw,
    bpp.bracket_placement
),
with_ranks as (
  select
    *,
    count(bracket_placement) over (partition by event_id) as bracket_size,
    rank() over (
      partition by event_id
      order by
        coalesce(swiss_points, 0) desc,
        coalesce(swiss_omw, 0) desc,
        coalesce(swiss_gw, 0) desc,
        coalesce(swiss_ogw, 0) desc
    ) as swiss_rank,
    -- BO1/BO3 (y todo lo que no es round_robin BO2): orden de siempre
    rank() over (
      partition by event_id
      order by
        case when bo3_completed > 0 then bo3_won::numeric / bo3_completed else 0 end desc,
        case when matches_completed > 0 then matches_won::numeric / matches_completed else 0 end desc
    ) as rr_rank,
    -- round_robin BO2: puntos de tabla, dense_rank, sin criterio secundario
    dense_rank() over (
      partition by event_id
      order by bo2_points desc
    ) as rr_rank_bo2,
    -- Ranking de fase regular solo entre quienes NO están en el bracket (para 5° en adelante)
    rank() over (
      partition by event_id, (bracket_placement is null)
      order by
        case when bo3_completed > 0 then bo3_won::numeric / bo3_completed else 0 end desc,
        case when matches_completed > 0 then matches_won::numeric / matches_completed else 0 end desc
    ) as rr_rank_outside_bracket,
    dense_rank() over (
      partition by event_id, (bracket_placement is null)
      order by bo2_points desc
    ) as rr_rank_outside_bracket_bo2
  from base
)
select
  participant_id,
  event_id,
  user_id,
  workspace_id,
  event_name,
  event_ended_at,
  event_status,
  scheduled_for,
  bo3_won,
  bo3_completed,
  matches_won,
  matches_completed,
  case
    -- Bracket real (swiss o round robin con top): puestos 1-4
    when bracket_placement is not null                       then bracket_placement::bigint
    -- Swiss fuera del bracket: por swiss_points (sin cambios)
    when competition_format = 'swiss'                        then swiss_rank
    -- Round robin con bracket: fuera del bracket, desde el puesto siguiente al último ocupado
    when bracket_size > 0 then
      bracket_size + (case when competition_format = 'round_robin' and match_format = 'bo2'
                           then rr_rank_outside_bracket_bo2 else rr_rank_outside_bracket end)
    -- Round robin sin bracket: BO2 por puntos; BO1/BO3 por BO3 win rate → match win rate
    else
      case when competition_format = 'round_robin' and match_format = 'bo2'
           then rr_rank_bo2 else rr_rank end
  end as placement,
  total_players
from with_ranks;

grant select on public.v_participant_event_placement to anon, authenticated;

-- Verificación: ningún evento que no sea round_robin BO2 cambió de posición.
do $$
declare
  v_diff integer;
begin
  select count(*) into v_diff
  from _placement_before_0128 b
  left join public.v_participant_event_placement a on a.participant_id = b.participant_id
  where a.placement is distinct from b.placement;

  if v_diff > 0 then
    raise exception '0128: % participante(s) de eventos NO round_robin BO2 cambiaron de placement. Nada quedó aplicado.', v_diff;
  end if;

  raise notice '0128: placement de eventos no-BO2 sin cambios; round_robin BO2 ahora ordena por puntos 3/1/0.';
end;
$$;
