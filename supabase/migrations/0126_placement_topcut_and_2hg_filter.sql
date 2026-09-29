-- 0126_placement_topcut_and_2hg_filter.sql
--
-- 1. v_participant_event_placement:
--    a) excluye eventos two_headed_giant (en 2HG solo el miembro A tiene fila en event_participants
--       y el placement calculado como round robin no significa nada);
--    b) el bracket real (1°-4°) se toma SOLO del grupo de top cut vigente del evento
--       (group_origin in ('round_robin_topcut','swiss_topcut'), status <> 'superseded'), igual que
--       v_event_final_positions. Ignora por completo grupos como round_robin_fourth_place (disputas
--       de desempate entre otros jugadores, no parte de la posición final);
--    c) el bracket se aplica también a round_robin con top_size (antes solo a swiss): el perdedor
--       del 3er/4to puesto queda 4°, sea por resultado real o por walkover en cascada;
--    d) en round_robin con bracket, quienes no llegaron al bracket quedan desde 5° en adelante
--       (rr_rank entre los no clasificados, desplazado por la cantidad de puestos ya ocupados por
--       el bracket) para no colisionar con 1°-4°. Swiss conserva swiss_rank para el resto.
--    1°/2° salen de la fila 'final' y 3°/4° de 'third_place', de forma independiente: si solo una de
--    las dos está resuelta, se asignan los puestos de esa.
-- 2. v_head_to_head_stats, v_player_streaks, v_player_color_stats: agregan
--    event_type <> 'two_headed_giant' al subselect de draft_events. Se parchea la definición VIVA
--    (pg_get_viewdef), como hizo 0116 con is_official, porque la base tiene drift respecto de las
--    migraciones. v_player_workspace_stats ya tiene el filtro y no se toca.
--
-- Mismas columnas, tipos y orden en las cuatro vistas: los grants y las vistas dependientes siguen
-- funcionando. Todo en una transacción implícita: si una verificación falla, no queda nada aplicado.

-- ── 1. v_participant_event_placement ─────────────────────────────────────────

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
    de.competition_format, ep.swiss_points, ep.swiss_omw, ep.swiss_gw, ep.swiss_ogw,
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
    rank() over (
      partition by event_id
      order by
        case when bo3_completed > 0 then bo3_won::numeric / bo3_completed else 0 end desc,
        case when matches_completed > 0 then matches_won::numeric / matches_completed else 0 end desc
    ) as rr_rank,
    -- Ranking de fase regular solo entre quienes NO están en el bracket (para 5° en adelante)
    rank() over (
      partition by event_id, (bracket_placement is null)
      order by
        case when bo3_completed > 0 then bo3_won::numeric / bo3_completed else 0 end desc,
        case when matches_completed > 0 then matches_won::numeric / matches_completed else 0 end desc
    ) as rr_rank_outside_bracket
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
    when bracket_size > 0                                    then bracket_size + rr_rank_outside_bracket
    -- Round robin sin bracket: por BO3 win rate → match win rate
    else                                                          rr_rank
  end as placement,
  total_players
from with_ranks;

grant select on public.v_participant_event_placement to anon, authenticated;

-- ── 2. Filtro 2HG en las demás vistas de estadísticas (parche sobre la definición viva) ──────

do $$
declare
  v_name text;
  v_expected integer;
  v_def text;
  v_new text;
  v_found integer;
  v_pat constant text := 'WHERE draft_events.is_official = true)';
  v_rep constant text := 'WHERE draft_events.is_official = true AND draft_events.event_type <> ''two_headed_giant'')';
  v_map constant jsonb := '{"v_head_to_head_stats": 4,"v_player_streaks": 3, "v_player_color_stats": 2}';
begin
  for v_name, v_expected in select key, value::integer from jsonb_each_text(v_map) as t(key, value) loop
    v_def := pg_get_viewdef(('public.' || v_name)::regclass, true);
    v_def := regexp_replace(v_def, ';\s*$', '');

    if position('two_headed_giant' in v_def) > 0 then
      raise exception '0126: la vista % ya tiene filtro two_headed_giant; revisar antes de parchear. Nada quedó aplicado.', v_name;
    end if;

    v_found := (length(v_def) - length(replace(v_def, v_pat, ''))) / length(v_pat);
    if v_found <> v_expected then
      raise exception '0126: la vista % tiene % subselect(s) reconocidos de draft_events y se esperaban %. Nada quedó aplicado.', v_name, v_found, v_expected;
    end if;

    v_new := replace(v_def, v_pat, v_rep);
    execute format('create or replace view public.%I as %s', v_name, v_new);

    v_found := (length(pg_get_viewdef(('public.' || v_name)::regclass, true))
                - length(replace(pg_get_viewdef(('public.' || v_name)::regclass, true), 'two_headed_giant', ''))) / length('two_headed_giant');
    if v_found <> v_expected then
      raise exception '0126: la vista % quedó con % filtro(s) two_headed_giant y se esperaban %. Nada quedó aplicado.', v_name, v_found, v_expected;
    end if;
  end loop;

  if position('two_headed_giant' in pg_get_viewdef('public.v_player_workspace_stats'::regclass, true)) = 0 then
    raise warning '0126: v_player_workspace_stats no tiene filtro two_headed_giant (se esperaba que sí); revisar a mano.';
  end if;

  raise notice '0126: filtro two_headed_giant aplicado a v_head_to_head_stats, v_player_streaks y v_player_color_stats.';
end;
$$;
