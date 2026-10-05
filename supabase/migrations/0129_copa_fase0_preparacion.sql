-- 0129_copa_fase0_preparacion.sql
-- Fase 0 de Copa (grupos + llaves) y Copa (sólo llaves): preparación del schema SIN cambiar el
-- comportamiento de ningún evento existente y sin agregar funcionalidad de Copa.
--
-- Identificadores (decididos): competition_format 'zones_knockout' (grupos + llaves) y
-- 'knockout' (sólo llaves). group_origin 'knockout_bracket' llega en una fase posterior.
--
-- Alcance:
--   1. draft_events: zones_count, zone_qualifiers, interzonal (+ CHECK condicionados al formato).
--      top_size queda en null para Copa (no se toca su CHECK).
--   2. competition_format: el CHECK vivo (draft_events_competition_format_valid, único CHECK de la
--      base que menciona la columna, confirmado contra prod) pasa a admitir los 4 valores.
--   3. pairings.stage text null ('zone' | 'interzonal' | 'bracket'). null = comportamiento actual.
--      Sin backfill, y nada la setea en esta fase.
--   4. compute_event_champion: corte temprano para los dos formatos Copa. Se parte del cuerpo vivo
--      completo (idéntico a 0083, verificado dentro de esta migración) y se agrega sólo esa rama.
--   5. Verificación automática (patrón de 0128): se guarda el contenido de
--      v_participant_event_placement, v_event_final_positions, v_workspace_points y v_season_points
--      antes de cambiar nada y se compara al final; cualquier diferencia aborta toda la migración.
--      También se verifica que el cuerpo nuevo de compute_event_champion sea el anterior más la
--      rama nueva, y nada más.
--
-- NOTA para fases posteriores (no es parte de esta migración): el cierre manual del cliente
-- ('concluded', EventDetailScreen.tsx) calcula el campeón con reglas de liga y no pasa por
-- compute_event_champion; los eventos Copa van a necesitar su propio cierre.
--
-- No se tocan: evaluate_tiebreak_group_after_match, create_*_top4_bracket, las vistas de ranking,
-- el CHECK de bracket_phase, group_origin ni los evaluadores de logros. Los eventos Copa de prueba
-- se crean siempre con is_official = false hasta la fase de puntos y logros.
--
-- Idempotente: add column if not exists, drop constraint if exists, create or replace.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (nada cambió todavía)
-- ===========================================================================
create temporary table _snap_0129_placement on commit drop as
select * from public.v_participant_event_placement;

create temporary table _snap_0129_final_positions on commit drop as
select * from public.v_event_final_positions;

create temporary table _snap_0129_workspace_points on commit drop as
select * from public.v_workspace_points;

create temporary table _snap_0129_season_points on commit drop as
select * from public.v_season_points;

create temporary table _snap_0129_champion_fn on commit drop as
select pg_get_functiondef('public.compute_event_champion(uuid)'::regprocedure) as def;

-- ===========================================================================
-- 1. draft_events: configuración de Copa
-- ===========================================================================
alter table public.draft_events
  add column if not exists zones_count smallint,
  add column if not exists zone_qualifiers smallint,
  add column if not exists interzonal boolean not null default false;

-- ===========================================================================
-- 2. competition_format: 4 valores
-- ===========================================================================
alter table public.draft_events
  drop constraint if exists draft_events_competition_format_valid;

alter table public.draft_events
  add constraint draft_events_competition_format_valid
    check (competition_format in ('round_robin', 'swiss', 'zones_knockout', 'knockout'));

-- zones_count entre 2 y 4 y zone_qualifiers >= 1 SOLO con 'zones_knockout' (obligatorios ahí);
-- null en los demás formatos. Las comparaciones llevan "is not null" explícito: un CHECK con
-- resultado NULL pasa, y sin eso zones_knockout con las columnas en null quedaría permitido.
alter table public.draft_events
  drop constraint if exists draft_events_zones_config_valid;

alter table public.draft_events
  add constraint draft_events_zones_config_valid
    check (
      (
        competition_format = 'zones_knockout'
        and zones_count is not null and zones_count between 2 and 4
        and zone_qualifiers is not null and zone_qualifiers >= 1
      )
      or (
        competition_format <> 'zones_knockout'
        and zones_count is null
        and zone_qualifiers is null
      )
    );

-- interzonal = true solo con 'zones_knockout'.
alter table public.draft_events
  drop constraint if exists draft_events_interzonal_valid;

alter table public.draft_events
  add constraint draft_events_interzonal_valid
    check (interzonal = false or competition_format = 'zones_knockout');

-- ===========================================================================
-- 3. pairings.stage (null = comportamiento actual; sin backfill)
-- ===========================================================================
alter table public.pairings
  add column if not exists stage text;

alter table public.pairings
  drop constraint if exists pairings_stage_valid;

alter table public.pairings
  add constraint pairings_stage_valid
    check (stage is null or stage in ('zone', 'interzonal', 'bracket'));

-- ===========================================================================
-- 4. compute_event_champion: corte temprano para Copa
--    Cuerpo idéntico al vivo (0083) salvo la rama marcada "0129". Misma firma, language,
--    security definer y atributos: create or replace conserva owner y grants.
-- ===========================================================================
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_competition_format text;
  v_top_size integer;
  v_match_format text;
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_score numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_existing_active_group_id uuid;
  v_proj_leader_user_id uuid;
  v_proj_leader_participant_id uuid;
  v_proj_min_score numeric;
  v_proj_threats integer;
begin
  select competition_format, top_size, match_format, status, champion_user_id
  into v_competition_format, v_top_size, v_match_format, v_event_status, v_event_champion_user_id
  from public.draft_events where id = p_event_id and deleted_at is null;

  -- Copa (competition_format 'zones_knockout' / 'knockout', 0129): su campeón sale de la final del
  -- bracket, nunca de la tabla de liga. Esta función no interviene en ningún punto: ni proyecta un
  -- líder, ni marca final_pending, ni cambia status.
  if v_competition_format in ('zones_knockout', 'knockout') then return; end if;

  -- round_robin + top_size=4 (antes competition_format='round_robin_bo1_top4') tiene su propio
  -- flujo de cierre vía el bracket de top4; esta función no debe intervenir en ningún punto
  -- para este formato.
  if v_competition_format = 'round_robin' and coalesce(v_top_size, 0) = 4 then return; end if;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;

  select id into v_existing_active_group_id
  from public.event_tiebreak_groups where event_id = p_event_id and status = 'active' limit 1;
  if v_existing_active_group_id is not null then return; end if;

  select count(*), count(*) filter (where official_winner_participant_id is null and official_draw = false)
  into v_total_pairings, v_pending_pairings_total
  from public.pairings p where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;

  select count(*) into v_total_players from public.event_participants where event_id = p_event_id and role = 'player';
  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Líder matemáticamente inevitable con pairings aún pendientes (0074). BO1/BO3: winrate
  -- proyectado, sin cambios. BO2: puntos totales absolutos (peor caso del candidato = puntos
  -- actuales sin sumar nada de sus pendientes; mejor caso de cada rival = puntos actuales + 3
  -- por cada pendiente que le queda, asumiendo que los gana todos). Quien tiene left_event_at
  -- seteado no puede ser candidato (no va a jugar más) ni contar como amenaza (no puede alcanzar
  -- a nadie si no va a jugar más). El "is_blocked" de pairing_block (mismo criterio "algún lado
  -- se fue" que antes) sigue vivo acá adentro a propósito — ver comentario arriba: decide qué
  -- pendientes cuentan como "todavía disputables" para el rango de la proyección, no si el
  -- evento puede cerrar (eso ahora lo decide solo v_pending_pairings_total).
  if v_pending_pairings_total > 0 and v_event_champion_user_id is null then
    with pairing_block as (
      select
        p.participant_a_id,
        p.participant_b_id,
        p.official_winner_participant_id,
        p.official_draw,
        (epa.left_event_at is not null or epb.left_event_at is not null) as is_blocked
      from public.pairings p
      join public.event_participants epa on epa.id = p.participant_a_id
      join public.event_participants epb on epb.id = p.participant_b_id
      where p.event_id = p_event_id
    ),
    projection as (
      select
        ep.user_id,
        ep.id as participant_id,
        count(*) filter (
          where (pb.official_winner_participant_id is not null or pb.official_draw = true)
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as completed_now,
        count(*) filter (
          where pb.official_winner_participant_id = ep.id
        ) as won_now,
        count(*) filter (
          where pb.official_draw = true
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as draws_now,
        count(*) filter (
          where pb.official_winner_participant_id is null
            and pb.official_draw = false
            and not pb.is_blocked
            and (pb.participant_a_id = ep.id or pb.participant_b_id = ep.id)
        ) as pending_active
      from public.event_participants ep
      left join pairing_block pb on pb.participant_a_id = ep.id or pb.participant_b_id = ep.id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id, ep.id
    ),
    projected as (
      select
        user_id,
        participant_id,
        (completed_now + pending_active) as final_completed,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now)::numeric
          else (won_now::numeric / nullif(completed_now + pending_active, 0))
        end as min_score,
        case when v_match_format = 'bo2'
          then (won_now * 3 + draws_now + pending_active * 3)::numeric
          else ((won_now + pending_active)::numeric / nullif(completed_now + pending_active, 0))
        end as max_score
      from projection
    ),
    candidate as (
      select user_id, participant_id, min_score
      from projected
      where final_completed >= v_min_bo3_required
      order by min_score desc nulls last
      limit 1
    )
    select c.user_id, c.participant_id, c.min_score,
      (select count(*) from projected q
        where q.participant_id <> c.participant_id and q.max_score >= c.min_score)
    into v_proj_leader_user_id, v_proj_leader_participant_id, v_proj_min_score, v_proj_threats
    from candidate c;

    if v_proj_leader_user_id is not null and v_proj_min_score is not null and v_proj_threats = 0 then
      update public.draft_events
        set champion_user_id = v_proj_leader_user_id, champion_decided_by = 'auto_projected'
      where id = p_event_id and status = 'playing' and champion_user_id is null;
    end if;
  end if;

  if v_pending_pairings_total > 0 then return; end if;

  -- Criterio de liderazgo: BO1/BO3 = winrate (won/completed), sin cambios. BO2 = puntos totales
  -- absolutos (won*3 + draws*1), no proporción — "completed" (para el umbral v_min_bo3_required)
  -- sigue siendo pairings resueltos, ahora incluyendo empates. Quien tiene left_event_at seteado
  -- queda afuera del pool de candidatos a campeón (sigue siendo necesario: puede terminar con el
  -- mejor récord real aunque el walkover ya haya resuelto sus pendientes en su contra).
  with player_bo3 as (
    select ep.user_id, ep.id as participant_id,
      count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won,
      count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, draws,
      case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
           else (won::numeric / nullif(completed, 0))
      end as score
    from player_bo3 where completed >= v_min_bo3_required
  )
  select max(score), count(*) filter (where score = (select max(score) from eligible))
  into v_max_score, v_leaders_count from eligible;

  if v_max_score is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id from (
      select ep.user_id,
        count(*) filter (where (p.official_winner_participant_id is not null or p.official_draw = true) and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won,
        count(*) filter (where p.official_draw = true and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as draws
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      group by ep.user_id
    ) leaders
    where (case when v_match_format = 'bo2' then (won * 3 + draws)::numeric
                else (won::numeric / nullif(completed, 0))
           end) = v_max_score
      and completed >= v_min_bo3_required;
    update public.draft_events set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
      status = 'completed', final_pending = false where id = p_event_id and status = 'playing';
    return;
  end if;

  -- v_leaders_count >= 2: el desempate de 1er puesto lo arma el CLIENTE (EventDetailScreen.tsx),
  -- igual que round_robin + top_size=4 ya hace para el desempate del 4to puesto — reusa la
  -- cascada completa de tanda1/tanda2 de podium.ts. Esta función se limita a marcar
  -- final_pending=true; el cliente detecta esa señal y llama a
  -- create_round_robin_first_place_tiebreak_group con el grupo ya ordenado.
  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$$;

-- ===========================================================================
-- 5. VERIFICACIÓN
-- ===========================================================================
-- Normalización SOLO para comparar: ignora CR, comentarios de línea (--) y espacios al final de
-- línea. La definición viva de prod puede diferir del archivo en eso (CRLF, relleno de espacios,
-- acentos con otra codificación dentro de comentarios); nada de eso cambia lo que ejecuta la
-- función. Todo el código ejecutable se compara tal cual. La función no tiene literales con '--'.
create or replace function pg_temp.norm_0129(p text)
returns text
language sql
immutable
as $f$
  select regexp_replace(
    regexp_replace(replace(p, chr(13), ''), '--[^\n]*', '', 'g'),
    '[ \t]+(\n|$)', '\1', 'g')
$f$;

do $$
declare
  v_before text;
  v_after text;
  v_branch constant text := pg_temp.norm_0129($branch$  -- Copa (competition_format 'zones_knockout' / 'knockout', 0129): su campeón sale de la final del
  -- bracket, nunca de la tabla de liga. Esta función no interviene en ningún punto: ni proyecta un
  -- líder, ni marca final_pending, ni cambia status.
  if v_competition_format in ('zones_knockout', 'knockout') then return; end if;

$branch$);
begin
  select pg_temp.norm_0129(def) into v_before from _snap_0129_champion_fn;
  v_after := pg_temp.norm_0129(pg_get_functiondef('public.compute_event_champion(uuid)'::regprocedure));

  if position(v_branch in v_before) > 0 then
    -- Re-ejecución: la rama ya estaba; el código no debe cambiar.
    if v_after is distinct from v_before then
      raise exception '0129: compute_event_champion cambió en una re-ejecución. Nada quedó aplicado.';
    end if;
  elsif replace(v_after, v_branch, '') is distinct from v_before then
    raise exception '0129: el código nuevo de compute_event_champion difiere del vivo en algo más que la rama de Copa. Nada quedó aplicado.';
  elsif position(v_branch in v_after) = 0 then
    raise exception '0129: la rama de Copa no quedó en compute_event_champion. Nada quedó aplicado.';
  end if;
end;
$$;

do $$
declare
  r record;
  v_diff bigint;
begin
  for r in
    select * from (values
      ('_snap_0129_placement',        'public.v_participant_event_placement'),
      ('_snap_0129_final_positions',  'public.v_event_final_positions'),
      ('_snap_0129_workspace_points', 'public.v_workspace_points'),
      ('_snap_0129_season_points',    'public.v_season_points')
    ) as t(snap, vw)
  loop
    execute format(
      'select count(*) from (
         (select * from %1$s except all select * from %2$s)
         union all
         (select * from %2$s except all select * from %1$s)
       ) d', r.snap, r.vw
    ) into v_diff;

    if v_diff > 0 then
      raise exception '0129: % cambió respecto del snapshot previo (% filas distintas). Nada quedó aplicado.', r.vw, v_diff;
    end if;
  end loop;

  raise notice '0129: vistas de placement, posiciones finales, puntos globales y de temporada sin cambios.';
end;
$$;

drop function if exists pg_temp.norm_0129(text);
