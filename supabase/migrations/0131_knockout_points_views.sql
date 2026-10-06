-- 0131_knockout_points_views.sql
-- Copa (sólo llaves): que el bracket de Copa puntúe en el Ranking Global y en el de Temporada.
--
-- 0130 no toca ninguna vista de puntos. Las tres vistas que leen los puestos del bracket filtran
-- hoy por
--     g.group_origin = ANY (ARRAY['round_robin_topcut', 'swiss_topcut'])
-- y sin este cambio una Copa oficial completada sumaría 0 puntos (sin ningún error). Esta
-- migración agrega 'knockout_bracket' a ese filtro en:
--   * v_event_final_positions        (CTE bracket_rows)
--   * v_workspace_points             (CTE bracket_top3)
--   * v_workspace_points_breakdown   (CTE bracket_rows)
-- Las v_season_* NO se tocan: v_season_positions lee de v_event_final_positions, y
-- v_season_points / v_season_points_breakdown leen de v_season_positions.
--
-- Qué puntúa (lo resuelven las propias vistas, que ya leen sólo 'final' y 'third_place'):
--   1° ganador de la final, 2° perdedor de la final, 3° ganador del 3er puesto. El perdedor del
--   3er puesto no puntúa (igual que en el top 4 real).
--
-- Método (patrón de 0116 / 0126): se parte de la definición VIVA (pg_get_viewdef), se reemplaza
-- el texto del filtro y se vuelve a crear la vista con create or replace view. Se cuenta la
-- cantidad de ocurrencias ANTES y DESPUÉS y, si no cuadra, se aborta toda la migración. Mismas
-- columnas, tipos y orden (create or replace no los admite distintos); los grants se conservan y
-- además se comparan.
--
-- Verificación automática (patrón de 0128 / 0129): snapshot de v_participant_event_placement,
-- v_event_final_positions, v_workspace_points y v_season_points antes de cambiar nada (más
-- v_workspace_points_breakdown, que también se parcha, y v_season_points_breakdown, que depende
-- de una vista parchada) y comparación al final: cualquier diferencia aborta todo. Sin eventos
-- Copa oficiales en la base el contenido tiene que ser idéntico.
--
-- No se tocan: v_participant_event_placement (perfil), los evaluadores de logros,
-- achievement_event_eligible ni ninguna función. Los eventos Copa de prueba se crean con
-- is_official = false (las tres vistas filtran is_official = true).
--
-- Idempotente: si el filtro ya tiene 'knockout_bracket' en la cantidad esperada, no hace nada.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (nada cambió todavía)
-- ===========================================================================
create temporary table _snap_0131_placement on commit drop as
select * from public.v_participant_event_placement;

create temporary table _snap_0131_final_positions on commit drop as
select * from public.v_event_final_positions;

create temporary table _snap_0131_workspace_points on commit drop as
select * from public.v_workspace_points;

create temporary table _snap_0131_season_points on commit drop as
select * from public.v_season_points;

create temporary table _snap_0131_workspace_points_breakdown on commit drop as
select * from public.v_workspace_points_breakdown;

create temporary table _snap_0131_season_points_breakdown on commit drop as
select * from public.v_season_points_breakdown;

-- Columnas (nombre, orden, tipo) y permisos de las tres vistas que se reescriben.
create temporary table _snap_0131_cols on commit drop as
select c.table_name, c.column_name, c.ordinal_position, c.data_type
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown');

create temporary table _snap_0131_acl on commit drop as
select cl.relname::text as relname, cl.relacl::text as acl
from pg_class cl
join pg_namespace n on n.oid = cl.relnamespace
where n.nspname = 'public'
  and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown');

-- ===========================================================================
-- 1. PARCHE sobre la definición viva
-- ===========================================================================
do $$
declare
  v_name text;
  v_expected integer;
  v_def text;
  v_new text;
  v_old_found integer;
  v_new_found integer;
  v_origin_total integer;
  v_pat constant text := 'ARRAY[''round_robin_topcut''::text, ''swiss_topcut''::text]';
  v_rep constant text := 'ARRAY[''round_robin_topcut''::text, ''swiss_topcut''::text, ''knockout_bracket''::text]';
  v_map constant jsonb := '{"v_event_final_positions": 1, "v_workspace_points": 1, "v_workspace_points_breakdown": 1}';
begin
  for v_name, v_expected in
    select key, value::integer from jsonb_each_text(v_map) as t(key, value)
  loop
    v_def := pg_get_viewdef(('public.' || v_name)::regclass, true);
    v_def := regexp_replace(v_def, ';\s*$', '');

    -- Ocurrencias de cada texto (v_pat no es subcadena de v_rep: el ']' final lo distingue).
    v_old_found := (length(v_def) - length(replace(v_def, v_pat, ''))) / length(v_pat);
    v_new_found := (length(v_def) - length(replace(v_def, v_rep, ''))) / length(v_rep);

    if v_new_found = v_expected and v_old_found = 0 then
      raise notice '0131: % ya tiene knockout_bracket (% ocurrencia/s); sin cambios.', v_name, v_new_found;
      continue;
    end if;

    if v_old_found <> v_expected or v_new_found <> 0 then
      raise exception '0131: la vista % tiene % filtro(s) de group_origin reconocidos (y % ya parchados) y se esperaban % (y 0). Nada quedó aplicado.',
        v_name, v_old_found, v_new_found, v_expected;
    end if;

    v_new := replace(v_def, v_pat, v_rep);
    execute format('create or replace view public.%I as %s', v_name, v_new);

    -- Verificación posterior sobre la definición que quedó viva.
    v_def := regexp_replace(pg_get_viewdef(('public.' || v_name)::regclass, true), ';\s*$', '');
    v_old_found := (length(v_def) - length(replace(v_def, v_pat, ''))) / length(v_pat);
    v_new_found := (length(v_def) - length(replace(v_def, v_rep, ''))) / length(v_rep);
    v_origin_total := (length(v_def) - length(replace(v_def, '''knockout_bracket''', ''))) / length('''knockout_bracket''');

    if v_old_found <> 0 or v_new_found <> v_expected or v_origin_total <> v_expected then
      raise exception '0131: la vista % quedó con % filtro(s) viejo(s), % parchado(s) y % mención(es) de knockout_bracket; se esperaban 0, % y %. Nada quedó aplicado.',
        v_name, v_old_found, v_new_found, v_origin_total, v_expected, v_expected;
    end if;
  end loop;

  raise notice '0131: knockout_bracket agregado al filtro de group_origin de v_event_final_positions, v_workspace_points y v_workspace_points_breakdown.';
end;
$$;

-- ===========================================================================
-- 2. VERIFICACIÓN: mismas columnas y permisos, mismo contenido
-- ===========================================================================
do $$
declare
  v_diff bigint;
begin
  select count(*) into v_diff from (
    (select * from _snap_0131_cols
     except all
     select c.table_name, c.column_name, c.ordinal_position, c.data_type
     from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown'))
    union all
    (select c.table_name, c.column_name, c.ordinal_position, c.data_type
     from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown')
     except all
     select * from _snap_0131_cols)
  ) d;
  if v_diff > 0 then
    raise exception '0131: cambiaron las columnas de las vistas parchadas (% diferencias). Nada quedó aplicado.', v_diff;
  end if;

  select count(*) into v_diff from (
    (select * from _snap_0131_acl
     except all
     select cl.relname::text, cl.relacl::text
     from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown'))
    union all
    (select cl.relname::text, cl.relacl::text
     from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public'
       and cl.relname in ('v_event_final_positions', 'v_workspace_points', 'v_workspace_points_breakdown')
     except all
     select * from _snap_0131_acl)
  ) d;
  if v_diff > 0 then
    raise exception '0131: cambiaron los permisos de las vistas parchadas (% diferencias). Nada quedó aplicado.', v_diff;
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
      ('_snap_0131_placement',                'public.v_participant_event_placement'),
      ('_snap_0131_final_positions',          'public.v_event_final_positions'),
      ('_snap_0131_workspace_points',         'public.v_workspace_points'),
      ('_snap_0131_season_points',            'public.v_season_points'),
      ('_snap_0131_workspace_points_breakdown', 'public.v_workspace_points_breakdown'),
      ('_snap_0131_season_points_breakdown',  'public.v_season_points_breakdown')
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
      raise exception '0131: % cambió respecto del snapshot previo (% filas distintas). Nada quedó aplicado.', r.vw, v_diff;
    end if;
  end loop;

  raise notice '0131: placement, posiciones finales, puntos globales y de temporada (y sus desgloses) sin cambios.';
end;
$$;
