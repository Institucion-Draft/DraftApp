-- 0141_cups_points_achievements_stats.sql
-- Bloque C de la Copa (competition_format 'knockout' y 'zones_knockout'): puntos, logros y estadísticas entre eventos.
-- Los eventos oficiales siguen sin habilitarse en la UI (forcedSandbox no se toca).
--
-- 1. PUNTOS
--    * Copa Consuelo (group_origin 'knockout_second_chance') puntúa fijo: 3 al campeón, 1 al subcampeón y 1 al tercero, sin
--      importar la cantidad de jugadores ni la config de puntos, y suma en el Ranking Global y en el de Temporada. Se
--      modela con la vista nueva v_consuelo_positions, que codifica la posición como 1000 + puesto (1001/1002/1003); la
--      versión de 3 argumentos de workspace_ranking_points devuelve 3/1/1 para esas posiciones. Un jugador sólo está en
--      una copa, así que nunca suma Copa principal y Consuelo en el mismo evento.
--    * Las vistas v_event_final_positions, v_workspace_points y v_workspace_points_breakdown se parchan sobre su definición
--      VIVA (pg_get_viewdef) agregando esas filas; v_season_positions, v_season_points y v_season_points_breakdown no se
--      tocan: leen de v_event_final_positions y calculan con workspace_ranking_points.
--    * La Copa principal sigue con la tabla actual (0131). Un evento concluido antes de cerrar la fase de grupos no tiene
--      llaves y no suma; uno concluido con una copa a medias suma sólo los puestos ya resueltos (las vistas leen
--      únicamente final y 3er puesto con ganador).
-- 2. CONSUELO CON MÁS DE 16 NO CLASIFICADOS (zones_build_cups): pasan los 16 mejores, por posición en el grupo y, dentro de
--    cada posición, por promedio de puntos por enfrentamiento con los desempates de los wildcards (hash estable al final).
--    El resto queda afuera (zones_cups_log -> consuelo_available / consuelo_left_out). Con 4 a 16, igual que antes.
-- 3. LOGROS
--    a) Remontada providencial: también la final de la Copa principal (achv_comeback_rows). Consuelo no.
--    b) achv_regular_pairings ya no incluye pairings de stage 'bracket' ni 'revenge' (Invicto en eventos concluded dejaba
--       de otorgarse por esos pendientes eternos). Los demás formatos no tienen esos stages: sin cambios.
--    c) Tiempo de reflexionar: no se otorga en 'knockout' ni 'zones_knockout' (achv_eval_tiempo_de_reflexionar).
--    d) Plaga, Super-Plaga, Duro de matar, Buen compañero, Por la ventana y De la ventana a la puerta grande: sin cambios.
-- 4. ESTADÍSTICAS ENTRE EVENTOS (se parchan sobre la definición viva):
--    a) v_head_to_head_stats y v_player_streaks: el filtro de walkover de los pairings mira sólo partidas draft y final
--       (una serie de Copa que reutiliza el pairing de grupos y se resuelve por walkover ya no hace desaparecer el
--       resultado limpio de grupos).
--    b) Esas dos vistas no cuentan las series de mata-mata resueltas por walkover (serie = partidas 'tiebreak' de la ronda
--       del grupo), igual que en grupos.
--    c) v_head_to_head_stats, v_player_streaks, v_player_workspace_stats y v_season_player_stats ignoran los grupos de
--       llaves con status failed o superseded.
--    d) Consuelo cuenta como cualquier otra serie (las vistas no distinguen el origen del grupo).
--
-- Funciones y vistas que se reemplazan o parchan. Funciones: md5 del texto entre los $$ del archivo de origen (cuerpo de la última
-- migración que las define), con LF y con CRLF. Vistas: md5 de pg_get_viewdef(oid, true) sobre la cadena 0001..0140 del
-- repo (la base viva puede tener drift: comparar con select md5(pg_get_viewdef('public.<vista>'::regclass, true))).
--   workspace_ranking_points(int,int,uuid) 971660a938bef4ed862f59edec93c1f5  (302 caracteres con LF; con CRLF: f1089e6efafd0105ff3d05c1fd60826a, 314)  [0115]
--   achv_regular_pairings              7a38134fe07bd0978ba13575b2989bfb  (583 caracteres con LF; con CRLF: 3806d34d02d8820e292b5d38247ae1af, 600)  [0122]
--   achv_eval_tiempo_de_reflexionar    021152d11826b830da91f05166446908  (1123 caracteres con LF; con CRLF: b5190fd4938691cd808bc68794387fac, 1156)  [0122]
--   achv_comeback_rows                 bde6a65b98750daaf84684900bb636b3  (3087 caracteres con LF; con CRLF: 75130deedd70c8c2d8feb38d1f6f6756, 3172)  [0123]
--   zones_build_cups                   dc1a0d40c2613e4d1f28e1283cda9f0d  (6252 caracteres con LF; con CRLF: 8e423cd0e2cd3c7548043c24db4c9160, 6396)  [0140]
--   v_event_final_positions            66f7be3c4afdb5b26829c5855dc6dbc4  (4307 caracteres)
--   v_workspace_points                 80da696f62e5933a34affcb881118a6e  (5675 caracteres)
--   v_workspace_points_breakdown       13344a6d238a838413da1ce3eb5b4948  (6489 caracteres)
--   v_head_to_head_stats               bf6142344ef9333eef0c69dc90b492fa  (16932 caracteres)
--   v_player_streaks                   8061dc59ebc1b497231be093f93e57c8  (11142 caracteres)
--   v_player_workspace_stats           51ddfd3be36919e4f4b2b3bf92bde0d6  (8245 caracteres)
--   v_season_player_stats              fd5cfe968f5fc360634f2dbfb2d90cc0  (3859 caracteres)
-- Vistas que NO se tocan (leen de las anteriores) pero se verifican contra su snapshot:
--   v_season_positions                 1fbf49473b388b60ae90eca7b5665fa6  (737 caracteres)
--   v_season_points                    fb54ec05fefa7d3535f2cba84b90e05f  (1548 caracteres)
--   v_season_points_breakdown          49b7d56de72e6082899a486fb113684f  (625 caracteres)
--
-- Idempotente: cada parche de vista se omite si ya está aplicado. Si una vista viva no tiene el texto esperado, la
-- migración aborta y no queda nada aplicado.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (nada cambió todavía)
-- ===========================================================================
create temporary table _snap_0141_final_positions on commit drop as select * from public.v_event_final_positions;
create temporary table _snap_0141_workspace_points on commit drop as select * from public.v_workspace_points;
create temporary table _snap_0141_workspace_points_breakdown on commit drop as select * from public.v_workspace_points_breakdown;
create temporary table _snap_0141_season_positions on commit drop as select * from public.v_season_positions;
create temporary table _snap_0141_season_points on commit drop as select * from public.v_season_points;
create temporary table _snap_0141_season_points_breakdown on commit drop as select * from public.v_season_points_breakdown;

create temporary table _snap_0141_cols on commit drop as
select c.table_name, c.column_name, c.ordinal_position, c.data_type
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                       'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats');

create temporary table _snap_0141_acl on commit drop as
select cl.relname::text as relname, cl.relacl::text as acl
from pg_class cl
join pg_namespace n on n.oid = cl.relnamespace
where n.nspname = 'public'
  and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                     'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats');

-- ===========================================================================
-- 1. v_consuelo_positions: puestos de la Copa Consuelo (posición codificada 1000 + puesto)
-- ===========================================================================
create or replace view public.v_consuelo_positions as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
)
select
  ep.user_id,
  de.workspace_id,
  de.id as event_id,
  epc.player_count,
  (1000 + pts.position)::integer as "position",
  de.name as event_name,
  de.scheduled_for,
  de.competition_format,
  de.top_size,
  v.name as venue_name,
  c.name as cube_name,
  de.draft_started_at,
  de.draft_ended_at
from public.event_tiebreak_bracket_matches bm
join public.event_tiebreak_groups g
  on g.id = bm.group_id
 and g.group_origin = 'knockout_second_chance'
 and g.status <> 'superseded'
join public.draft_events de
  on de.id = g.event_id
 and de.deleted_at is null
 and de.is_official = true
 and de.event_type <> 'two_headed_giant'
 and de.status in ('completed', 'concluded')
join event_player_counts epc on epc.event_id = de.id
left join public.venues v on v.id = de.venue_id
left join public.cubes c on c.id = de.cube_id
cross join lateral (
  values
    (bm.participant_a_id, case
      when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_a_id then 1 else 2 end)
      when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_a_id then 3 else null end)
    end),
    (bm.participant_b_id, case
      when bm.bracket_phase = 'final' then (case when bm.winner_participant_id = bm.participant_b_id then 1 else 2 end)
      when bm.bracket_phase = 'third_place' then (case when bm.winner_participant_id = bm.participant_b_id then 3 else null end)
    end)
) as pts(participant_id, position)
join public.event_participants ep on ep.id = pts.participant_id
where bm.bracket_phase in ('final', 'third_place')
  and bm.winner_participant_id is not null
  and pts.position is not null;

grant select on public.v_consuelo_positions to authenticated;

-- ===========================================================================
-- 2. workspace_ranking_points (3 args): Consuelo fijo
-- ===========================================================================
create or replace function public.workspace_ranking_points(
  p_player_count integer,
  p_position integer,
  p_config_id uuid
)
returns integer
language sql
stable
as $$
  select case
    -- Copa Consuelo (v_consuelo_positions): posiciones codificadas 1001 (campeón), 1002 (subcampeón) y 1003 (3º). Puntos
    -- fijos, independientes de la cantidad de jugadores y de la config de puntos de la temporada.
    when p_position = 1001 then 3
    when p_position in (1002, 1003) then 1
    else coalesce(
      (
        select case when p_position >= 1 then (t.points ->> (p_position - 1))::integer end
        from public.point_config_tiers t
        where t.config_id = p_config_id
          and t.min_players <= p_player_count
        order by t.min_players desc
        limit 1
      ),
      0
    )
  end;
$$;

-- Helpers de parcheo (temporales): cuentan ocurrencias y aplican un reemplazo exigiendo la cantidad esperada.
create or replace function pg_temp.occ(p_text text, p_find text) returns integer language sql immutable as $$
  select (length(p_text) - length(replace(p_text, p_find, ''))) / length(p_find)
$$;

create or replace function pg_temp.rx_occ(p_text text, p_pat text) returns integer language sql immutable as $$
  select count(*)::integer from regexp_matches(p_text, p_pat, 'g')
$$;

create or replace function pg_temp.patch_view(p_view text, p_marker text, p_steps jsonb) returns text language plpgsql as $$
declare
  v_def text;
  v_step jsonb;
  v_n integer;
begin
  v_def := regexp_replace(pg_get_viewdef(('public.' || p_view)::regclass, true), ';\s*$', '');
  if position(p_marker in v_def) > 0 then
    raise notice '0141: % ya está parchada; sin cambios.', p_view;
    return null;
  end if;
  for v_step in select * from jsonb_array_elements(p_steps) loop
    if v_step->>'kind' = 'regex' then
      v_n := pg_temp.rx_occ(v_def, v_step->>'find');
      if v_n <> (v_step->>'expected')::integer then
        raise exception '0141: la vista % tiene % coincidencia(s) de /%/ y se esperaba %. Nada quedó aplicado.', p_view, v_n, v_step->>'find', v_step->>'expected';
      end if;
      v_def := regexp_replace(v_def, v_step->>'find', v_step->>'repl');
    else
      v_n := pg_temp.occ(v_def, v_step->>'find');
      if v_n <> (v_step->>'expected')::integer then
        raise exception '0141: la vista % tiene % ocurrencia(s) de "%" y se esperaba %. Nada quedó aplicado.', p_view, v_n, v_step->>'find', v_step->>'expected';
      end if;
      v_def := replace(v_def, v_step->>'find', v_step->>'repl');
    end if;
  end loop;
  return v_def;
end;
$$;

-- ===========================================================================
-- 3. Puntos: v_event_final_positions, v_workspace_points y v_workspace_points_breakdown (definición VIVA)
-- ===========================================================================
do $$
declare
  v_new text;
begin
  v_new := pg_temp.patch_view('v_event_final_positions', 'v_consuelo_positions', $j$[
    {"kind":"regex","find":"FROM placement_rows\\s*$","expected":1,
     "repl":"FROM placement_rows\nUNION ALL\n SELECT c.user_id, c.workspace_id, c.event_id, c.player_count, c.\"position\"\n   FROM v_consuelo_positions c"}
  ]$j$::jsonb);
  if v_new is not null then
    execute 'create or replace view public.v_event_final_positions as ' || v_new;
  end if;

  v_new := pg_temp.patch_view('v_workspace_points', 'v_consuelo_positions', $j$[
    {"kind":"regex","find":"(FROM rr_no_top_placement)(\\s*\\)\\s*SELECT all_points\\.user_id)","expected":1,
     "repl":"\\1 UNION ALL SELECT c.user_id, c.workspace_id, workspace_ranking_points(c.player_count, c.\"position\") AS points FROM v_consuelo_positions c\\2"}
  ]$j$::jsonb);
  if v_new is not null then
    execute 'create or replace view public.v_workspace_points as ' || v_new;
  end if;

  v_new := pg_temp.patch_view('v_workspace_points_breakdown', 'v_consuelo_positions', $j$[
    {"kind":"regex","find":"FROM placement_rows\\s*$","expected":1,
     "repl":"FROM placement_rows\nUNION ALL\n SELECT c.user_id, c.workspace_id, c.event_id, c.event_name, c.player_count, c.\"position\", workspace_ranking_points(c.player_count, c.\"position\") AS points, c.scheduled_for, c.competition_format, c.top_size, c.venue_name, c.cube_name, c.draft_started_at, c.draft_ended_at\n   FROM v_consuelo_positions c"}
  ]$j$::jsonb);
  if v_new is not null then
    execute 'create or replace view public.v_workspace_points_breakdown as ' || v_new;
  end if;
end;
$$;

-- ===========================================================================
-- 4. Estadísticas entre eventos (definición VIVA)
-- ===========================================================================
do $$
declare
  v_new text;
  v_groups_step constant jsonb := $j$
    {"kind":"text","find":"JOIN event_tiebreak_groups etg ON etg.id = bm.group_id","expected":1,
     "repl":"JOIN event_tiebreak_groups etg ON etg.id = bm.group_id AND etg.status <> ALL (ARRAY['failed'::text, 'superseded'::text])"}
  $j$::jsonb;
  v_walk_step constant jsonb := $j$
    {"kind":"text","find":"wm.is_walkover = true","expected":1,
     "repl":"wm.is_walkover = true AND (wm.match_type = ANY (ARRAY['draft'::text, 'final'::text]))"}
  $j$::jsonb;
  v_series_step constant jsonb := $j$
    {"kind":"text","find":"WHERE bm.winner_participant_id IS NOT NULL","expected":1,
     "repl":"WHERE bm.winner_participant_id IS NOT NULL AND NOT (EXISTS ( SELECT 1 FROM matches wmb WHERE wmb.pairing_id = bm.pairing_id AND wmb.match_type = 'tiebreak'::text AND wmb.is_walkover = true AND COALESCE(wmb.tiebreak_round, 1) = etg.round_number))"}
  $j$::jsonb;
begin
  v_new := pg_temp.patch_view('v_head_to_head_stats', 'ARRAY[''failed''::text, ''superseded''::text]',
    jsonb_build_array(v_walk_step, v_series_step, v_groups_step));
  if v_new is not null then execute 'create or replace view public.v_head_to_head_stats as ' || v_new; end if;

  v_new := pg_temp.patch_view('v_player_streaks', 'ARRAY[''failed''::text, ''superseded''::text]',
    jsonb_build_array(v_walk_step, v_series_step, v_groups_step));
  if v_new is not null then execute 'create or replace view public.v_player_streaks as ' || v_new; end if;

  v_new := pg_temp.patch_view('v_player_workspace_stats', 'ARRAY[''failed''::text, ''superseded''::text]',
    jsonb_build_array(v_groups_step));
  if v_new is not null then execute 'create or replace view public.v_player_workspace_stats as ' || v_new; end if;

  v_new := pg_temp.patch_view('v_season_player_stats', 'ARRAY[''failed''::text, ''superseded''::text]',
    jsonb_build_array(v_groups_step));
  if v_new is not null then execute 'create or replace view public.v_season_player_stats as ' || v_new; end if;
end;
$$;

-- ===========================================================================
-- 5. Logros
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.achv_regular_pairings(p_event_id uuid)
 RETURNS TABLE(pairing_id uuid, participant_a_id uuid, participant_b_id uuid, winner_id uuid, is_draw boolean, is_resolved boolean, resolved_at timestamp with time zone, has_walkover boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.id,
    p.participant_a_id,
    p.participant_b_id,
    p.official_winner_participant_id,
    (p.official_draw is true),
    (p.official_winner_participant_id is not null or p.official_draw is true),
    coalesce(p.official_resolved_at, p.created_at),
    exists (
      select 1 from public.matches m
      where m.pairing_id = p.id and m.match_type = 'draft' and m.is_walkover
    )
  from public.pairings p
  join public.draft_events de on de.id = p.event_id
  where p.event_id = p_event_id
    and (de.competition_format <> 'swiss' or p.swiss_round is not null)
    -- 0141: los pairings de llaves ('bracket') y de venganza ('revenge') no son fase regular: nunca tienen resultado
    -- oficial y quedaban como pendientes para siempre (Copa sola y Grupos + Copa).
    and p.stage is distinct from 'bracket'
    and p.stage is distinct from 'revenge';
$function$
;

CREATE OR REPLACE FUNCTION public.achv_eval_tiempo_de_reflexionar(p_event_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  -- 0141: no aplica a Copa sola ni a Grupos + Copa.
  if exists (
    select 1 from public.draft_events de
    where de.id = p_event_id and de.competition_format in ('knockout', 'zones_knockout')
  ) then
    return 0;
  end if;

  select status into v_status from public.draft_events where id = p_event_id;
  if v_status not in ('completed', 'concluded') then return 0; end if;

  for r in
    select ep.id as participant_id, ep.user_id
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
      and not exists (
        select 1 from public.achv_participant_outcomes(p_event_id, ep.id) o where o.is_pending
      )
      and (select count(*) from public.achv_participant_outcomes(p_event_id, ep.id) o
           where not o.is_walkover and o.outcome is not null) >= 1
      and not exists (
        select 1 from public.achv_participant_outcomes(p_event_id, ep.id) o
        where not o.is_walkover and o.outcome is not null and o.outcome <> 'L'
      )
  loop
    if public.grant_achievement('tiempo_de_reflexionar', r.user_id, p_event_id, '{}'::jsonb) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.achv_comeback_rows(p_event_id uuid, p_only_first_place boolean)
 RETURNS TABLE(winner_user_id uuid, source_kind text, ref jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_winners uuid[];
  v_has_walkover boolean;
  v_user uuid;
begin
  -- Serie regular BO3
  if not p_only_first_place then
    for r in
      select p.id as pairing_id, p.official_winner_participant_id as series_winner
      from public.pairings p
      join public.draft_events de on de.id = p.event_id
      where p.event_id = p_event_id
        and de.match_format = 'bo3'
        and p.official_winner_participant_id is not null
        and (de.competition_format <> 'swiss' or p.swiss_round is not null)
    loop
      select bool_or(m.is_walkover)
      into v_has_walkover
      from public.matches m
      where m.pairing_id = r.pairing_id and m.match_type = 'draft';

      select array_agg(m.winner_participant_id order by m.match_number)
      into v_winners
      from public.matches m
      where m.pairing_id = r.pairing_id and m.match_type = 'draft' and m.status = 'completed';

      if not coalesce(v_has_walkover, false) and public.achv_is_bo3_comeback(v_winners, r.series_winner) then
        select ep.user_id into v_user
        from public.event_participants ep
        where ep.id = r.series_winner and ep.role = 'player';
        if v_user is not null then
          winner_user_id := v_user;
          source_kind := 'regular';
          ref := jsonb_build_object('pairing_id', r.pairing_id);
          return next;
        end if;
      end if;
    end loop;
  end if;

  -- Serie de bracket / desempate BO3
  for r in
    select bm.id as bm_id, bm.pairing_id, bm.winner_participant_id as series_winner,
           bm.bracket_phase, g.round_number, g.group_origin
    from public.event_tiebreak_bracket_matches bm
    join public.event_tiebreak_groups g on g.id = bm.group_id
    where g.event_id = p_event_id
      and g.status not in ('superseded', 'failed')
      and bm.winner_participant_id is not null
      and bm.pairing_id is not null
      and (
        not p_only_first_place
        or (bm.bracket_phase = 'final'
            and g.group_origin in ('round_robin_topcut', 'swiss_topcut', 'round_robin_first_place', 'knockout_bracket'))
      )
  loop
    select bool_or(m.is_walkover)
    into v_has_walkover
    from public.matches m
    where m.pairing_id = r.pairing_id and m.match_type = 'tiebreak'
      and coalesce(m.tiebreak_round, 1) = r.round_number;

    select array_agg(m.winner_participant_id order by m.match_number)
    into v_winners
    from public.matches m
    where m.pairing_id = r.pairing_id and m.match_type = 'tiebreak'
      and coalesce(m.tiebreak_round, 1) = r.round_number and m.status = 'completed';

    if not coalesce(v_has_walkover, false) and public.achv_is_bo3_comeback(v_winners, r.series_winner) then
      select ep.user_id into v_user
      from public.event_participants ep
      where ep.id = r.series_winner and ep.role = 'player';
      if v_user is not null then
        winner_user_id := v_user;
        source_kind := 'bracket';
        ref := jsonb_build_object('bracket_match_id', r.bm_id, 'bracket_phase', r.bracket_phase);
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$function$
;

-- ===========================================================================
-- 6. zones_build_cups: Consuelo con los 16 mejores
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.zones_build_cups(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event record;
  v_zone record;
  v_order uuid[];
  v_set uuid[];
  v_cand uuid[];
  v_ord record;
  v_seeds uuid[] := '{}';
  v_wild uuid[] := '{}';
  v_hash uuid[] := '{}';
  v_rest uuid[];
  v_main uuid;
  v_cons uuid;
  v_same integer;
  v_pos integer;
  v_cut_tied uuid[] := '{}';
  v_by_hash boolean := false;
  v_wild_log jsonb := null;
  v_cons_size integer;
  v_cons_built boolean := false;
  v_left record;
  v_walkovers integer := 0;
  v_rest_all uuid[];
  v_cons_total integer := 0;
  v_pick uuid[] := '{}';
begin
  select de.id, de.competition_format, de.zones_drawn_at, de.zones_count, de.zone_qualifiers, de.zone_wildcards
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null or v_event.competition_format <> 'zones_knockout' or v_event.zones_drawn_at is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('zonescups:' || p_event_id::text));

  -- Idempotente: si la Copa principal ya está armada, no se vuelve a armar nada.
  if exists (
    select 1 from public.event_tiebreak_groups g
    where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  ) then
    return null;
  end if;

  if v_event.zones_count is null or v_event.zone_qualifiers is null then
    raise exception 'zones_build_cups: el evento no tiene la configuración de zonas.';
  end if;

  perform public.zones_prepare_rank_tables(p_event_id);

  -- Posición de cada jugador dentro de su zona (zone_standings).
  drop table if exists _zc_rank;
  create temporary table _zc_rank (pid uuid primary key, zone_id uuid not null, pos integer not null) on commit drop;
  for v_zone in select z.id from public.event_zones z where z.event_id = p_event_id order by z.zone_index loop
    v_order := public.zones_rank_members((
      select array_agg(m.id) from public.event_participants m
      where m.event_id = p_event_id and m.zone_id = v_zone.id and m.role = 'player'
    ));
    insert into _zc_rank (pid, zone_id, pos)
    select t.pid, v_zone.id, t.ord::integer from unnest(v_order) with ordinality as t(pid, ord);
  end loop;

  -- Siembra: los 1ros, los 2dos, ... (cada posición ordenada entre zonas) y los wildcards al final.
  for v_pos in 1..v_event.zone_qualifiers loop
    select array_agg(r.pid) into v_set from _zc_rank r where r.pos = v_pos;
    select * into v_ord from public.zones_order_by_avg(v_set);
    v_seeds := v_seeds || v_ord.p_order;
  end loop;

  if v_event.zone_wildcards > 0 then
    select array_agg(r.pid) into v_cand from _zc_rank r where r.pos = v_event.zone_qualifiers + 1;
    if coalesce(cardinality(v_cand), 0) < v_event.zone_wildcards then
      raise exception 'zones_build_cups: no hay suficientes candidatos a wildcard (% para %).', coalesce(cardinality(v_cand), 0), v_event.zone_wildcards;
    end if;
    select * into v_ord from public.zones_order_by_avg(v_cand);
    v_hash := v_ord.p_hash;
    v_wild := v_ord.p_order[1:v_event.zone_wildcards];
    v_seeds := v_seeds || v_wild;
    if cardinality(v_cand) > v_event.zone_wildcards then
      -- corte: último que pasa vs primero que no pasa. El hash decidió el corte sólo si el último que pasa fue ELEGIDO por hash
      -- (zones_cmp_tie lo pone por delante de todo el resto de su grupo de empatados, y el primero que no pasa es el que
      -- sigue). Que el primero que no pasa esté en v_hash no alcanza: entonces fue elegido sobre los que vienen DESPUÉS de él
      -- (dos eliminados empatados entre sí), no sobre el último que pasa.
      v_by_hash := (v_ord.p_order[v_event.zone_wildcards] = any (v_hash));
      select array_agg(x) into v_cut_tied
      from unnest(v_ord.p_order) as x
      where public.zones_pts_avg(x) = public.zones_pts_avg(v_ord.p_order[v_event.zone_wildcards]);
    end if;
    v_wild_log := jsonb_build_object(
      'candidates', to_jsonb(v_ord.p_order),
      'advanced', to_jsonb(v_wild),
      'eliminated', to_jsonb(v_ord.p_order[v_event.zone_wildcards + 1:]),
      'cut_tied', to_jsonb(coalesce(v_cut_tied, '{}'::uuid[])),
      'by_hash', v_by_hash
    );
  end if;

  if cardinality(v_seeds) <> v_event.zone_qualifiers * v_event.zones_count + v_event.zone_wildcards then
    raise exception 'zones_build_cups: la cantidad de clasificados (%) no coincide con la configuración (% x % + %).',
      cardinality(v_seeds), v_event.zones_count, v_event.zone_qualifiers, v_event.zone_wildcards;
  end if;

  -- Copa principal
  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (p_event_id, 1, 'bracket', 'active', 'knockout_bracket')
  returning id into v_main;
  v_same := public.zones_build_seeded_bracket(v_main, v_seeds);

  -- Copa Consuelo: los no clasificados (4 a 16), orden aleatorio y byes balanceados (armado existente).
  select array_agg(r.pid) into v_rest_all
  from _zc_rank r
  where r.pid <> all (v_seeds);
  v_cons_total := coalesce(cardinality(v_rest_all), 0);
  if v_cons_total > 16 then
    -- 0141: el cuadro admite hasta 16. Pasan los 16 mejores de los no clasificados: primero por posición en su grupo y,
    -- dentro de cada posición, por promedio de puntos por enfrentamiento con los mismos desempates que los wildcards
    -- (zones_order_by_avg: cruce directo, calidad de rivales, hash estable al final). El resto queda afuera.
    for v_pos in
      select distinct r.pos from _zc_rank r where r.pid = any (v_rest_all) order by 1
    loop
      select array_agg(r.pid) into v_set from _zc_rank r where r.pid = any (v_rest_all) and r.pos = v_pos;
      select * into v_ord from public.zones_order_by_avg(v_set);
      v_pick := v_pick || v_ord.p_order;
      exit when cardinality(v_pick) >= 16;
    end loop;
    v_pick := v_pick[1:16];
    select array_agg(x order by random()) into v_rest from unnest(v_pick) as x;
  else
    select array_agg(x order by random()) into v_rest from unnest(v_rest_all) as x;
  end if;
  v_cons_size := coalesce(cardinality(v_rest), 0);
  if v_cons_size >= 4 and v_cons_size <= 16 then
    insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
    values (p_event_id, 1, 'bracket', 'active', 'knockout_second_chance')
    returning id into v_cons;
    perform public.knockout_build_bracket(v_cons, v_rest);
    v_cons_built := true;
  end if;

  -- Los que ya se fueron (left_event_at) y quedaron en algún cuadro: su rival avanza por walkover. Si los dos de un cruce
  -- se fueron, el cruce queda pendiente (apply_knockout_walkover no hace nada cuando no hay a quién darle la victoria).
  for v_left in
    select distinct ep.id
    from public.event_tiebreak_group_participants gp
    join public.event_participants ep on ep.id = gp.participant_id
    where gp.group_id in (v_main, v_cons) and ep.left_event_at is not null
  loop
    v_walkovers := v_walkovers + public.apply_knockout_walkover(v_left.id);
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'built_at', now(),
    'main_group_id', v_main,
    'consuelo_group_id', v_cons,
    'copa_size', cardinality(v_seeds),
    'consuelo_size', v_cons_size,
    'consuelo_available', v_cons_total,
    'consuelo_left_out', case when v_cons_total > v_cons_size then to_jsonb(array(select y from unnest(v_rest_all) as y where y <> all (v_rest))) else null end,
    'consuelo_built', v_cons_built,
    'seeds', to_jsonb(v_seeds),
    'same_zone_first_round', v_same,
    'walkovers_applied', v_walkovers,
    'wildcards', v_wild_log
  ));
end;
$function$
;

-- ===========================================================================
-- 7. VERIFICACIÓN
-- ===========================================================================
do $$
declare
  v_diff bigint;
  v_consuelo bigint;
begin
  -- mismas columnas y permisos en las vistas parchadas
  select count(*) into v_diff from (
    (select * from _snap_0141_cols
     except all
     select c.table_name, c.column_name, c.ordinal_position, c.data_type
     from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                            'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats'))
    union all
    (select c.table_name, c.column_name, c.ordinal_position, c.data_type
     from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                            'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats')
     except all
     select * from _snap_0141_cols)
  ) d;
  if v_diff > 0 then
    raise exception '0141: cambiaron las columnas de las vistas parchadas (% diferencias). Nada quedó aplicado.', v_diff;
  end if;

  select count(*) into v_diff from (
    (select * from _snap_0141_acl
     except all
     select cl.relname::text, cl.relacl::text
     from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                          'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats'))
    union all
    (select cl.relname::text, cl.relacl::text
     from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown',
                          'v_head_to_head_stats', 'v_player_streaks', 'v_player_workspace_stats', 'v_season_player_stats')
     except all
     select * from _snap_0141_acl)
  ) d;
  if v_diff > 0 then
    raise exception '0141: cambiaron los permisos de las vistas parchadas (% diferencias). Nada quedó aplicado.', v_diff;
  end if;

  -- Sin eventos oficiales con Copa Consuelo, los puntos y posiciones tienen que quedar idénticos.
  select count(*) into v_consuelo from public.v_consuelo_positions;
  if v_consuelo = 0 then
    select count(*) into v_diff from (
      (select * from _snap_0141_final_positions except all select * from public.v_event_final_positions)
      union all
      (select * from public.v_event_final_positions except all select * from _snap_0141_final_positions)
    ) d;
    if v_diff > 0 then raise exception '0141: v_event_final_positions cambió (% filas). Nada quedó aplicado.', v_diff; end if;

    select count(*) into v_diff from (
      (select * from _snap_0141_workspace_points except all select * from public.v_workspace_points)
      union all
      (select * from public.v_workspace_points except all select * from _snap_0141_workspace_points)
    ) d;
    if v_diff > 0 then raise exception '0141: v_workspace_points cambió (% filas). Nada quedó aplicado.', v_diff; end if;

    select count(*) into v_diff from (
      (select * from _snap_0141_workspace_points_breakdown except all select * from public.v_workspace_points_breakdown)
      union all
      (select * from public.v_workspace_points_breakdown except all select * from _snap_0141_workspace_points_breakdown)
    ) d;
    if v_diff > 0 then raise exception '0141: v_workspace_points_breakdown cambió (% filas). Nada quedó aplicado.', v_diff; end if;

    select count(*) into v_diff from (
      (select * from _snap_0141_season_positions except all select * from public.v_season_positions)
      union all
      (select * from public.v_season_positions except all select * from _snap_0141_season_positions)
    ) d;
    if v_diff > 0 then raise exception '0141: v_season_positions cambió (% filas). Nada quedó aplicado.', v_diff; end if;

    select count(*) into v_diff from (
      (select * from _snap_0141_season_points except all select * from public.v_season_points)
      union all
      (select * from public.v_season_points except all select * from _snap_0141_season_points)
    ) d;
    if v_diff > 0 then raise exception '0141: v_season_points cambió (% filas). Nada quedó aplicado.', v_diff; end if;

    select count(*) into v_diff from (
      (select * from _snap_0141_season_points_breakdown except all select * from public.v_season_points_breakdown)
      union all
      (select * from public.v_season_points_breakdown except all select * from _snap_0141_season_points_breakdown)
    ) d;
    if v_diff > 0 then raise exception '0141: v_season_points_breakdown cambió (% filas). Nada quedó aplicado.', v_diff; end if;
  else
    raise notice '0141: hay % fila(s) de Copa Consuelo oficial; se omite la comparación de puntos con el snapshot.', v_consuelo;
  end if;

  raise notice '0141: aplicada (puntos de Consuelo, logros, estadísticas y Consuelo de hasta 16).';
end;
$$;
