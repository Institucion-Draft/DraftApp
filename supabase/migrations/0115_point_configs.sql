-- 0115_point_configs.sql
--
-- Fase A del feature de Temporadas: extraer la configuración de puntos de workspace_ranking_points
-- (hoy hardcodeada en 0109_workspace_points_tiered_rewrite.sql, escalones 5-3-2/7-4-3/9-6-4/12-8-5)
-- a una tabla, para que una Temporada futura pueda tener su propia configuración (inmutable
-- durante la temporada, puede cambiar entre temporadas) sin tocar el Ranking Global.
--
-- Cero cambio de comportamiento en esta fase: el Ranking Global (v_workspace_points y
-- v_workspace_points_breakdown) sigue usando exactamente los mismos valores de siempre, ahora
-- leídos de una config marcada is_default=true ("eterna") en vez de estar en un CASE. Los 6 call
-- sites existentes de workspace_ranking_points (3 en 0109, 3 más en 0112/0113/0114 — todos con la
-- forma de 2 argumentos) NO se tocan: la función de 2 argumentos se conserva (misma firma, así que
-- CREATE OR REPLACE la reemplaza en su lugar sin invalidar las vistas) y pasa a ser un wrapper que
-- delega en una versión nueva de 3 argumentos con la config eterna. La de 3 argumentos NO puede
-- tener DEFAULT: agregar un parámetro crea una sobrecarga distinta (no reemplaza a la de 2), y con
-- default las llamadas de 2 argumentos quedarían ambiguas.
--
-- Diseño:
--   point_configs(id, name, is_default, created_at) — una fila por configuración de puntos.
--     Id fijo y conocido para la config eterna ('00000000-0000-0000-0000-000000000001'), usado
--     como literal en el wrapper de 2 argumentos (evita una subquery por fila en las vistas). Un
--     índice único parcial garantiza que nunca haya más de una fila con is_default=true.
--   point_config_tiers(id, config_id, min_players, points jsonb) — un escalón por umbral de
--     jugadores. Sin max_players: el escalón aplicable es el de mayor min_players que sea
--     <= player_count (order by min_players desc limit 1), así no puede haber huecos ni solapes.
--     points es un array JSON con los puntos por posición ([5,3,2] = 1°:5, 2°:3, 3°:2), lo que
--     permite premiar más o menos posiciones en el futuro sin otra migración de schema. Posición
--     fuera del array (o < 1) = 0 puntos. Player_count por debajo del menor min_players = 0.
--
-- Verificación automática al final (mismo patrón que 0094/0095/0097/0098): recorre las
-- combinaciones de player_count/position que la función vieja cubre hoy, compara contra la función
-- nueva leyendo de la tabla, y aborta TODA la migración si hay una sola discrepancia.

-- ===========================================================================
-- 1. point_configs
-- ===========================================================================
create table public.point_configs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index point_configs_only_one_default
  on public.point_configs (is_default)
  where is_default;

alter table public.point_configs enable row level security;

create policy "point_configs_select_all"
  on public.point_configs
  for select
  using (true);

-- ===========================================================================
-- 2. point_config_tiers
-- ===========================================================================
create table public.point_config_tiers (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.point_configs(id) on delete cascade,
  min_players integer not null check (min_players >= 0),
  points jsonb not null check (jsonb_typeof(points) = 'array'),
  constraint point_config_tiers_config_min_players unique (config_id, min_players)
);

alter table public.point_config_tiers enable row level security;

create policy "point_config_tiers_select_all"
  on public.point_config_tiers
  for select
  using (true);

-- ===========================================================================
-- 3. Seed: config "eterna" con los valores actuales de 0109.
-- ===========================================================================
insert into public.point_configs (id, name, is_default)
values ('00000000-0000-0000-0000-000000000001', 'Eterna (histórica)', true);

insert into public.point_config_tiers (config_id, min_players, points)
values
  ('00000000-0000-0000-0000-000000000001', 4, '[5,3,2]'::jsonb),
  ('00000000-0000-0000-0000-000000000001', 7, '[7,4,3]'::jsonb),
  ('00000000-0000-0000-0000-000000000001', 10, '[9,6,4]'::jsonb),
  ('00000000-0000-0000-0000-000000000001', 13, '[12,8,5]'::jsonb);

-- ===========================================================================
-- 4. workspace_ranking_points: versión de 3 argumentos (config explícita) que lee de la tabla, y
--    la de 2 argumentos existente convertida en wrapper de la config eterna. Ninguna es IMMUTABLE
--    (dependen de una tabla) — pasan a STABLE.
--    Ojo: jsonb ->> con índice negativo cuenta desde el final del array, por eso la guarda
--    explícita p_position >= 1 (posición 0 o negativa debe dar 0, como en el CASE original).
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
  select coalesce(
    (
      select case when p_position >= 1 then (t.points ->> (p_position - 1))::integer end
      from public.point_config_tiers t
      where t.config_id = p_config_id
        and t.min_players <= p_player_count
      order by t.min_players desc
      limit 1
    ),
    0
  );
$$;

-- Misma firma que la de 0109: reemplaza en su lugar, las vistas existentes siguen funcionando.
create or replace function public.workspace_ranking_points(p_player_count integer, p_position integer)
returns integer
language sql
stable
as $$
  select public.workspace_ranking_points(
    p_player_count,
    p_position,
    '00000000-0000-0000-0000-000000000001'::uuid
  );
$$;

-- ===========================================================================
-- 5. VERIFICACIÓN AUTOMÁTICA: la función nueva debe devolver EXACTAMENTE lo mismo que la vieja
--    hardcodeada de 0109 para todo player_count/position cubierto. Aborta toda la migración si
--    hay una sola discrepancia.
-- ===========================================================================
do $$
declare
  v_player_count integer;
  v_position integer;
  v_expected integer;
  v_actual integer;
  v_mismatch_count integer := 0;
  v_total integer := 0;
  v_details text := '';
begin
  foreach v_player_count in array array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,20,30,50] loop
    foreach v_position in array array[-1,0,1,2,3,4,5] loop
      v_total := v_total + 1;

      -- Réplica exacta del CASE hardcodeado que esta migración reemplaza (0109).
      v_expected := case
        when v_player_count < 4 then 0
        when v_player_count <= 6 then (case v_position when 1 then 5 when 2 then 3 when 3 then 2 else 0 end)
        when v_player_count <= 9 then (case v_position when 1 then 7 when 2 then 4 when 3 then 3 else 0 end)
        when v_player_count <= 12 then (case v_position when 1 then 9 when 2 then 6 when 3 then 4 else 0 end)
        else (case v_position when 1 then 12 when 2 then 8 when 3 then 5 else 0 end)
      end;

      -- Llamada con 2 argumentos, igual que los 6 call sites existentes — ejercita el wrapper.
      v_actual := public.workspace_ranking_points(v_player_count, v_position);

      if v_actual is distinct from v_expected then
        v_mismatch_count := v_mismatch_count + 1;
        v_details := v_details || format(
          E'\n  player_count=%s position=%s: esperado=%s, obtenido=%s',
          v_player_count, v_position, v_expected, v_actual
        );
      end if;
    end loop;
  end loop;

  if v_mismatch_count > 0 then
    raise exception 'Fase A (Temporadas): % discrepancia(s) de % combinación(es) verificada(s) entre workspace_ranking_points vieja (hardcodeada) y nueva (leyendo point_config_tiers). Migración abortada, nada quedó aplicado. Detalle:%', v_mismatch_count, v_total, v_details;
  end if;

  raise notice 'Fase A (Temporadas): verificación OK — % combinación(es) de player_count/position verificada(s), output idéntico antes/después de extraer la configuración a tabla.', v_total;
end;
$$;
