-- 0116_seasons.sql
--
-- Fase B del feature de Temporadas: schema de temporadas, pertenencia de eventos, mecanismo de
-- cierre, vista de puntos por temporada, y fix del bug de sandbox en el Ranking Global.
--
-- ---------------------------------------------------------------------------------------------
-- Reglas acordadas
-- ---------------------------------------------------------------------------------------------
-- * Las temporadas son AUTOMÁTICAS, una por estación del hemisferio sur. Cada corte es a las
--   00:00 (hora de Buenos Aires) del día en que ocurre el equinoccio/solsticio. Solo se guarda el
--   inicio (starts_at); el fin de una temporada es el inicio de la siguiente (sin huecos ni
--   solapes por construcción).
-- * Un evento pertenece a la temporada cuyo corte es el mayor <= draft_started_at. Eventos sin
--   draft_started_at todavía no pertenecen a ninguna. Eventos anteriores a la primera temporada
--   quedan solo en el Ranking Global (no hay "Temporada 0").
-- * Cada temporada tiene su propia config de puntos (clon de la temporada anterior o de la
--   eterna), editable hasta que arranca el primer draft NO sandbox de esa temporada, inmutable
--   desde ahí. La config eterna (is_default) nunca es editable.
-- * Cierre formal (closed_at): la temporada solo cierra cuando ya pasó su fin calendárico Y todos
--   sus eventos (excluyendo 2HG, sandbox, eliminados y cancelados) están completed/concluded.
--     - Sin eventos inconclusos: cierra sola (season_try_close, disparada al abrir el workspace
--       vía sync_workspace_seasons, y por trigger cuando un evento cambia de estado).
--     - Con eventos inconclusos: NO cierra sola. El organizador puede forzar el cierre
--       (force_close_season), pero recién a partir del inicio de la temporada siguiente. El cierre
--       forzado NO descarta los eventos inconclusos: congela sus "podios asegurados al momento"
--       (ver más abajo).
--     - Si nadie fuerza y esos eventos terminan resolviéndose por cualquier vía, el trigger de
--       draft_events cierra la temporada en ESE momento.
--     - Mientras una temporada queda colgada, los eventos nuevos pertenecen a la temporada
--       calendárica actual (la pertenencia sale de draft_started_at, no del cierre).
--   closed_at es el momento en que el sistema REGISTRÓ el cierre (no hay cron: se orquesta desde
--   el cliente y por trigger), no necesariamente el instante exacto del corte.
-- * Podios asegurados en el cierre forzado: cada evento inconcluso aporta a la temporada las
--   posiciones que su propio podio ya tiene aseguradas en ese momento (1°/2° definidos aunque
--   falte el 3°, campeón matemáticamente inevitable en liga sin top aunque falten partidos
--   irrelevantes, etc. — el mismo criterio que usa hoy cada evento para mostrar podio
--   parcial). Ese criterio vive en el cliente (podium.ts, computePodium, ~1100 líneas de
--   desempates y proyecciones), así que NO se reimplementa en SQL: el cliente lo calcula para cada
--   evento inconcluso y se lo pasa a force_close_season(season, positions), el mismo patrón
--   "client-orchestrated" del top4 de Suizo. La base valida el payload (evento inconcluso de esa
--   temporada, usuario que juega ese evento) y calcula player_count por su cuenta.
--   Las posiciones quedan CONGELADAS (season_frozen_events / season_frozen_positions): si el
--   evento se resuelve después, la temporada cerrada no cambia. Un evento inconcluso sin
--   posiciones aseguradas queda congelado sin aportar puntos.
--
-- ---------------------------------------------------------------------------------------------
-- Supuestos a validar
-- ---------------------------------------------------------------------------------------------
-- * Primera temporada: Primavera 2026 (corte 2026-09-22 00:00 BA). Para cambiarla, ajustar las
--   filas de season_calendar antes de aplicar.
-- * season_calendar cubre hasta Verano 2050/51. Los cortes se calcularon con el algoritmo de
--   Meeus (Astronomical Algorithms, cap. 27) y se contrastaron con las fechas publicadas de
--   2025-2030. El de 2043-09-23 cae a ~6 minutos de la medianoche local: es el único cuya fecha
--   depende de ese margen. Hay que extender la tabla antes de fines de 2050.
-- * Buenos Aires es UTC-3 fijo (sin horario de verano desde 2009), por eso los cortes se cargan
--   con offset -03.
--
-- ---------------------------------------------------------------------------------------------
-- Alcance del fix de sandbox
-- ---------------------------------------------------------------------------------------------
-- is_official = false nunca debe aportar a ninguna estadística. 0063 lo aplicó a
-- v_head_to_head_stats y v_player_streaks, pero 0082 (walkover) las recreó sin el filtro, y el
-- resto de las vistas de stats nunca lo tuvo. Esta migración lo agrega a: v_workspace_points,
-- v_workspace_points_breakdown, v_workspace_placements, v_player_workspace_stats,
-- v_head_to_head_stats, v_player_streaks, v_participant_event_placement, v_player_color_stats,
-- v_color_performance, v_player_tg_stats, v_cube_stats, cubes_with_stats, venues_with_stats y
-- v_rr_no_top_regular_rank (fuente del ranking de round robin sin top). Los eventos sandbox siguen
-- existiendo y viéndose como eventos; solo dejan de contar en estadísticas. (Las vistas que no
-- son de stats — v_event_season, v_seasons — no filtran a propósito: quien las consume decide.)
-- Esas 12 vistas se parchean en la propia base a partir de su definición vigente (ver sección
-- 9b), no con copias de las migraciones: la base real tiene drift respecto del historial.
--
-- La verificación automática del final (mismo patrón que 0094/0095/0115) aborta toda la
-- migración ante cualquier discrepancia. Si la base de destino no tiene eventos, es un no-op.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES": puntos por evento de eventos oficiales, con las vistas viejas vigentes.
-- ===========================================================================
create temporary table _points_before_0116 on commit drop as
select b.user_id, b.workspace_id, b.event_id, b.position, b.points
from public.v_workspace_points_breakdown b
join public.draft_events de on de.id = b.event_id
where de.is_official = true;

-- ===========================================================================
-- 1. season_calendar: cortes globales (los mismos para todos los workspaces)
-- ===========================================================================
create table public.season_calendar (
  starts_at timestamptz primary key,
  name text not null,
  kind text not null check (kind in ('summer', 'autumn', 'winter', 'spring'))
);

alter table public.season_calendar enable row level security;

create policy "season_calendar_select_all"
  on public.season_calendar
  for select
  using (true);

insert into public.season_calendar (starts_at, name, kind)
values
  ('2026-09-22 00:00:00-03', 'Primavera 2026', 'spring'),
  ('2026-12-21 00:00:00-03', 'Verano 2026/27', 'summer'),
  ('2027-03-20 00:00:00-03', 'Otoño 2027', 'autumn'),
  ('2027-06-21 00:00:00-03', 'Invierno 2027', 'winter'),
  ('2027-09-23 00:00:00-03', 'Primavera 2027', 'spring'),
  ('2027-12-21 00:00:00-03', 'Verano 2027/28', 'summer'),
  ('2028-03-19 00:00:00-03', 'Otoño 2028', 'autumn'),
  ('2028-06-20 00:00:00-03', 'Invierno 2028', 'winter'),
  ('2028-09-22 00:00:00-03', 'Primavera 2028', 'spring'),
  ('2028-12-21 00:00:00-03', 'Verano 2028/29', 'summer'),
  ('2029-03-20 00:00:00-03', 'Otoño 2029', 'autumn'),
  ('2029-06-20 00:00:00-03', 'Invierno 2029', 'winter'),
  ('2029-09-22 00:00:00-03', 'Primavera 2029', 'spring'),
  ('2029-12-21 00:00:00-03', 'Verano 2029/30', 'summer'),
  ('2030-03-20 00:00:00-03', 'Otoño 2030', 'autumn'),
  ('2030-06-21 00:00:00-03', 'Invierno 2030', 'winter'),
  ('2030-09-22 00:00:00-03', 'Primavera 2030', 'spring'),
  ('2030-12-21 00:00:00-03', 'Verano 2030/31', 'summer'),
  ('2031-03-20 00:00:00-03', 'Otoño 2031', 'autumn'),
  ('2031-06-21 00:00:00-03', 'Invierno 2031', 'winter'),
  ('2031-09-23 00:00:00-03', 'Primavera 2031', 'spring'),
  ('2031-12-21 00:00:00-03', 'Verano 2031/32', 'summer'),
  ('2032-03-19 00:00:00-03', 'Otoño 2032', 'autumn'),
  ('2032-06-20 00:00:00-03', 'Invierno 2032', 'winter'),
  ('2032-09-22 00:00:00-03', 'Primavera 2032', 'spring'),
  ('2032-12-21 00:00:00-03', 'Verano 2032/33', 'summer'),
  ('2033-03-20 00:00:00-03', 'Otoño 2033', 'autumn'),
  ('2033-06-20 00:00:00-03', 'Invierno 2033', 'winter'),
  ('2033-09-22 00:00:00-03', 'Primavera 2033', 'spring'),
  ('2033-12-21 00:00:00-03', 'Verano 2033/34', 'summer'),
  ('2034-03-20 00:00:00-03', 'Otoño 2034', 'autumn'),
  ('2034-06-21 00:00:00-03', 'Invierno 2034', 'winter'),
  ('2034-09-22 00:00:00-03', 'Primavera 2034', 'spring'),
  ('2034-12-21 00:00:00-03', 'Verano 2034/35', 'summer'),
  ('2035-03-20 00:00:00-03', 'Otoño 2035', 'autumn'),
  ('2035-06-21 00:00:00-03', 'Invierno 2035', 'winter'),
  ('2035-09-23 00:00:00-03', 'Primavera 2035', 'spring'),
  ('2035-12-21 00:00:00-03', 'Verano 2035/36', 'summer'),
  ('2036-03-19 00:00:00-03', 'Otoño 2036', 'autumn'),
  ('2036-06-20 00:00:00-03', 'Invierno 2036', 'winter'),
  ('2036-09-22 00:00:00-03', 'Primavera 2036', 'spring'),
  ('2036-12-21 00:00:00-03', 'Verano 2036/37', 'summer'),
  ('2037-03-20 00:00:00-03', 'Otoño 2037', 'autumn'),
  ('2037-06-20 00:00:00-03', 'Invierno 2037', 'winter'),
  ('2037-09-22 00:00:00-03', 'Primavera 2037', 'spring'),
  ('2037-12-21 00:00:00-03', 'Verano 2037/38', 'summer'),
  ('2038-03-20 00:00:00-03', 'Otoño 2038', 'autumn'),
  ('2038-06-21 00:00:00-03', 'Invierno 2038', 'winter'),
  ('2038-09-22 00:00:00-03', 'Primavera 2038', 'spring'),
  ('2038-12-21 00:00:00-03', 'Verano 2038/39', 'summer'),
  ('2039-03-20 00:00:00-03', 'Otoño 2039', 'autumn'),
  ('2039-06-21 00:00:00-03', 'Invierno 2039', 'winter'),
  ('2039-09-23 00:00:00-03', 'Primavera 2039', 'spring'),
  ('2039-12-21 00:00:00-03', 'Verano 2039/40', 'summer'),
  ('2040-03-19 00:00:00-03', 'Otoño 2040', 'autumn'),
  ('2040-06-20 00:00:00-03', 'Invierno 2040', 'winter'),
  ('2040-09-22 00:00:00-03', 'Primavera 2040', 'spring'),
  ('2040-12-21 00:00:00-03', 'Verano 2040/41', 'summer'),
  ('2041-03-20 00:00:00-03', 'Otoño 2041', 'autumn'),
  ('2041-06-20 00:00:00-03', 'Invierno 2041', 'winter'),
  ('2041-09-22 00:00:00-03', 'Primavera 2041', 'spring'),
  ('2041-12-21 00:00:00-03', 'Verano 2041/42', 'summer'),
  ('2042-03-20 00:00:00-03', 'Otoño 2042', 'autumn'),
  ('2042-06-21 00:00:00-03', 'Invierno 2042', 'winter'),
  ('2042-09-22 00:00:00-03', 'Primavera 2042', 'spring'),
  ('2042-12-21 00:00:00-03', 'Verano 2042/43', 'summer'),
  ('2043-03-20 00:00:00-03', 'Otoño 2043', 'autumn'),
  ('2043-06-21 00:00:00-03', 'Invierno 2043', 'winter'),
  ('2043-09-23 00:00:00-03', 'Primavera 2043', 'spring'),
  ('2043-12-21 00:00:00-03', 'Verano 2043/44', 'summer'),
  ('2044-03-19 00:00:00-03', 'Otoño 2044', 'autumn'),
  ('2044-06-20 00:00:00-03', 'Invierno 2044', 'winter'),
  ('2044-09-22 00:00:00-03', 'Primavera 2044', 'spring'),
  ('2044-12-21 00:00:00-03', 'Verano 2044/45', 'summer'),
  ('2045-03-20 00:00:00-03', 'Otoño 2045', 'autumn'),
  ('2045-06-20 00:00:00-03', 'Invierno 2045', 'winter'),
  ('2045-09-22 00:00:00-03', 'Primavera 2045', 'spring'),
  ('2045-12-21 00:00:00-03', 'Verano 2045/46', 'summer'),
  ('2046-03-20 00:00:00-03', 'Otoño 2046', 'autumn'),
  ('2046-06-21 00:00:00-03', 'Invierno 2046', 'winter'),
  ('2046-09-22 00:00:00-03', 'Primavera 2046', 'spring'),
  ('2046-12-21 00:00:00-03', 'Verano 2046/47', 'summer'),
  ('2047-03-20 00:00:00-03', 'Otoño 2047', 'autumn'),
  ('2047-06-21 00:00:00-03', 'Invierno 2047', 'winter'),
  ('2047-09-22 00:00:00-03', 'Primavera 2047', 'spring'),
  ('2047-12-21 00:00:00-03', 'Verano 2047/48', 'summer'),
  ('2048-03-19 00:00:00-03', 'Otoño 2048', 'autumn'),
  ('2048-06-20 00:00:00-03', 'Invierno 2048', 'winter'),
  ('2048-09-22 00:00:00-03', 'Primavera 2048', 'spring'),
  ('2048-12-21 00:00:00-03', 'Verano 2048/49', 'summer'),
  ('2049-03-20 00:00:00-03', 'Otoño 2049', 'autumn'),
  ('2049-06-20 00:00:00-03', 'Invierno 2049', 'winter'),
  ('2049-09-22 00:00:00-03', 'Primavera 2049', 'spring'),
  ('2049-12-21 00:00:00-03', 'Verano 2049/50', 'summer'),
  ('2050-03-20 00:00:00-03', 'Otoño 2050', 'autumn'),
  ('2050-06-21 00:00:00-03', 'Invierno 2050', 'winter'),
  ('2050-09-22 00:00:00-03', 'Primavera 2050', 'spring'),
  ('2050-12-21 00:00:00-03', 'Verano 2050/51', 'summer');

-- Corte de la temporada a la que pertenece un instante (null si es anterior a la primera).
create or replace function public.season_start_at(p_ts timestamptz)
returns timestamptz
language sql
stable
as $$
  select max(starts_at) from public.season_calendar where starts_at <= p_ts;
$$;

-- Fin (exclusivo) de la temporada que arranca en p_starts_at = inicio de la siguiente (null si
-- es la última cargada, o sea abierta).
create or replace function public.season_end_at(p_starts_at timestamptz)
returns timestamptz
language sql
stable
as $$
  select min(starts_at) from public.season_calendar where starts_at > p_starts_at;
$$;

-- ===========================================================================
-- 2. seasons: una fila por (workspace, corte). Se crean solas (ensure_workspace_seasons).
-- ===========================================================================
create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  starts_at timestamptz not null references public.season_calendar(starts_at),
  point_config_id uuid not null references public.point_configs(id),
  closed_at timestamptz,
  closed_forced boolean not null default false,
  created_at timestamptz not null default now(),
  constraint seasons_workspace_starts_unique unique (workspace_id, starts_at),
  constraint seasons_forced_requires_closed check (not closed_forced or closed_at is not null)
);

alter table public.seasons enable row level security;

create policy "seasons_select_workspace_members"
  on public.seasons
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- Sin policies de escritura: los clientes no escriben seasons directamente, solo los RPC
-- security definer de más abajo.

-- Congelado del cierre forzado: qué eventos estaban inconclusos al forzar el cierre (aunque no
-- tuvieran ninguna posición asegurada) y qué posiciones tenían aseguradas. player_count lo calcula
-- el servidor al congelar. Un evento presente en season_frozen_events aporta SOLO sus posiciones
-- congeladas a esa temporada, aunque después se complete.
create table public.season_frozen_events (
  season_id uuid not null references public.seasons(id) on delete cascade,
  event_id uuid not null references public.draft_events(id) on delete cascade,
  player_count integer not null,
  frozen_at timestamptz not null default now(),
  primary key (season_id, event_id)
);

create table public.season_frozen_positions (
  season_id uuid not null,
  event_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  position integer not null check (position >= 1),
  primary key (season_id, event_id, user_id),
  foreign key (season_id, event_id)
    references public.season_frozen_events(season_id, event_id) on delete cascade
);

alter table public.season_frozen_events enable row level security;
alter table public.season_frozen_positions enable row level security;

create policy "season_frozen_events_select_workspace_members"
  on public.season_frozen_events
  for select
  to authenticated
  using (exists (
    select 1 from public.seasons s
    where s.id = season_frozen_events.season_id and public.is_workspace_member(s.workspace_id)
  ));

create policy "season_frozen_positions_select_workspace_members"
  on public.season_frozen_positions
  for select
  to authenticated
  using (exists (
    select 1 from public.seasons s
    where s.id = season_frozen_positions.season_id and public.is_workspace_member(s.workspace_id)
  ));

-- ===========================================================================
-- 3. Helpers de consulta: eventos inconclusos y candado de config
-- ===========================================================================
-- Eventos que impiden cerrar la temporada: oficiales, no eliminados, no 2HG, que arrancaron
-- dentro de la temporada y todavía no están completed/concluded/cancelled.
create or replace function public.season_unfinished_events(p_season_id uuid)
returns table (event_id uuid, event_name text, status text)
language sql
stable
as $$
  select de.id, de.name, de.status
  from public.seasons s
  join public.draft_events de
    on de.workspace_id = s.workspace_id
   and de.draft_started_at is not null
   and de.draft_started_at >= s.starts_at
   and de.draft_started_at < coalesce(public.season_end_at(s.starts_at), 'infinity'::timestamptz)
  where s.id = p_season_id
    and de.deleted_at is null
    and de.is_official = true
    and de.event_type <> 'two_headed_giant'
    and de.status not in ('completed', 'concluded', 'cancelled')
  order by de.draft_started_at;
$$;

-- true si alguna temporada que usa esta config ya tuvo un draft oficial (no sandbox) iniciado.
-- No filtra eliminados a propósito: un draft que arrancó bloquea la config aunque se borre.
create or replace function public.season_config_locked(p_config_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.seasons s
    join public.draft_events de
      on de.workspace_id = s.workspace_id
     and de.is_official = true
     and de.draft_started_at is not null
     and de.draft_started_at >= s.starts_at
     and de.draft_started_at < coalesce(public.season_end_at(s.starts_at), 'infinity'::timestamptz)
    where s.point_config_id = p_config_id
  );
$$;

-- ===========================================================================
-- 4. Inmutabilidad de la config de puntos
-- ===========================================================================
create or replace function public.guard_point_config_immutable(p_config_id uuid)
returns void
language plpgsql
as $$
begin
  if exists (select 1 from public.point_configs where id = p_config_id and is_default) then
    raise exception 'CONFIG_ETERNA_INMUTABLE: la configuración eterna del Ranking Global no se puede modificar.';
  end if;
  if public.season_config_locked(p_config_id) then
    raise exception 'CONFIG_TEMPORADA_BLOQUEADA: la temporada ya tiene un draft oficial iniciado, sus puntajes ya no se pueden modificar.';
  end if;
end;
$$;

create or replace function public.point_config_tiers_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.guard_point_config_immutable(old.config_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.guard_point_config_immutable(new.config_id);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger point_config_tiers_guard_trg
  before insert or update or delete on public.point_config_tiers
  for each row execute function public.point_config_tiers_guard();

create or replace function public.point_configs_guard()
returns trigger
language plpgsql
as $$
begin
  perform public.guard_point_config_immutable(old.id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger point_configs_guard_trg
  before update or delete on public.point_configs
  for each row execute function public.point_configs_guard();

create or replace function public.seasons_config_guard()
returns trigger
language plpgsql
as $$
begin
  if new.point_config_id is distinct from old.point_config_id then
    perform public.guard_point_config_immutable(old.point_config_id);
  end if;
  return new;
end;
$$;

create trigger seasons_config_guard_trg
  before update of point_config_id on public.seasons
  for each row execute function public.seasons_config_guard();

-- ===========================================================================
-- 5. Vistas de temporada y pertenencia de eventos
-- ===========================================================================
-- Pertenencia calculada desde el calendario global (no desde las filas de seasons), así un
-- evento nunca cae en la temporada equivocada aunque la fila del workspace todavía no exista.
-- Incluye eventos en cualquier estado (los inconclusos también, para sus stats en vivo);
-- quien consuma filtra is_official / 2HG / status según lo que necesite.
create or replace view public.v_event_season as
select
  de.id as event_id,
  de.workspace_id,
  cal.starts_at as season_starts_at,
  s.id as season_id
from public.draft_events de
cross join lateral (select public.season_start_at(de.draft_started_at) as starts_at) cal
left join public.seasons s
  on s.workspace_id = de.workspace_id
 and s.starts_at = cal.starts_at
where de.draft_started_at is not null
  and de.deleted_at is null
  and cal.starts_at is not null;

-- phase: upcoming (todavía no arrancó) / active (en curso) / finishing (pasó su fin calendárico
-- pero no cerró formalmente) / closed.
create or replace view public.v_seasons as
select
  s.id as season_id,
  s.workspace_id,
  s.starts_at,
  e.ends_at,
  c.name,
  c.kind,
  s.point_config_id,
  s.closed_at,
  s.closed_forced,
  case
    when s.closed_at is not null then 'closed'
    when now() < s.starts_at then 'upcoming'
    when e.ends_at is null or now() < e.ends_at then 'active'
    else 'finishing'
  end as phase,
  public.season_config_locked(s.point_config_id) as config_locked
from public.seasons s
join public.season_calendar c on c.starts_at = s.starts_at
cross join lateral (select public.season_end_at(s.starts_at) as ends_at) e;

-- ===========================================================================
-- 6. Creación automática de temporadas del workspace (clona la config de puntos)
-- ===========================================================================
-- Crea la temporada en curso, la próxima (para poder editar su config de antemano) y las
-- pasadas que tengan al menos un evento. Cada una con una config propia clonada de la temporada
-- anterior del workspace (o de la eterna si no hay).
create or replace function public.ensure_workspace_seasons(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cal record;
  v_next_start timestamptz;
  v_source_config uuid;
  v_new_config uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ensure_workspace_seasons:' || p_workspace_id::text));

  select min(starts_at) into v_next_start from public.season_calendar where starts_at > now();

  for v_cal in
    select c.starts_at, c.name
    from public.season_calendar c
    where not exists (
      select 1 from public.seasons s
      where s.workspace_id = p_workspace_id and s.starts_at = c.starts_at
    )
      and (
        c.starts_at = public.season_start_at(now())
        or c.starts_at = v_next_start
        or exists (
          select 1 from public.draft_events de
          where de.workspace_id = p_workspace_id
            and de.draft_started_at is not null
            and de.draft_started_at >= c.starts_at
            and de.draft_started_at < coalesce(public.season_end_at(c.starts_at), 'infinity'::timestamptz)
        )
      )
    order by c.starts_at
  loop
    select s.point_config_id into v_source_config
    from public.seasons s
    where s.workspace_id = p_workspace_id and s.starts_at < v_cal.starts_at
    order by s.starts_at desc
    limit 1;

    if v_source_config is null then
      select id into v_source_config from public.point_configs where is_default;
    end if;

    insert into public.point_configs (name)
    values ('Temporada ' || v_cal.name)
    returning id into v_new_config;

    insert into public.point_config_tiers (config_id, min_players, points)
    select v_new_config, t.min_players, t.points
    from public.point_config_tiers t
    where t.config_id = v_source_config;

    insert into public.seasons (workspace_id, starts_at, point_config_id)
    values (p_workspace_id, v_cal.starts_at, v_new_config);
  end loop;
end;
$$;

-- ===========================================================================
-- 7. Cierre de temporadas
-- ===========================================================================
-- Devuelve: 'not_found' | 'already_closed' | 'not_over' | 'blocked' | 'closed'.
create or replace function public.season_try_close(p_season_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons%rowtype;
  v_ends timestamptz;
begin
  select * into v_season from public.seasons where id = p_season_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_season.closed_at is not null then
    return 'already_closed';
  end if;

  v_ends := public.season_end_at(v_season.starts_at);
  if v_ends is null or now() < v_ends then
    return 'not_over';
  end if;

  if exists (select 1 from public.season_unfinished_events(p_season_id)) then
    return 'blocked';
  end if;

  update public.seasons set closed_at = now() where id = p_season_id;
  return 'closed';
end;
$$;

create or replace function public.close_ready_seasons(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select s.id
    from public.seasons s
    where s.workspace_id = p_workspace_id
      and s.closed_at is null
      and coalesce(public.season_end_at(s.starts_at), 'infinity'::timestamptz) <= now()
    order by s.starts_at
  loop
    perform public.season_try_close(v_id);
  end loop;
end;
$$;

-- RPC (client-orchestrated): al abrir el workspace. Crea las temporadas que falten y cierra
-- las que ya se puedan cerrar. Idempotente.
create or replace function public.sync_workspace_seasons(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'NOT_A_MEMBER';
  end if;
  perform public.ensure_workspace_seasons(p_workspace_id);
  perform public.close_ready_seasons(p_workspace_id);
end;
$$;

create or replace function public.close_season_if_ready(p_season_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.seasons where id = p_season_id;
  if v_workspace_id is null then
    return 'not_found';
  end if;
  if not public.is_workspace_member(v_workspace_id) then
    raise exception 'NOT_A_MEMBER';
  end if;
  return public.season_try_close(p_season_id);
end;
$$;

-- Cierre forzado: solo organizador, solo desde el inicio de la temporada siguiente.
-- p_secured_positions: array JSON [{event_id, user_id, position}, ...] con los podios asegurados
-- al momento de cada evento inconcluso de la temporada (los calcula el cliente con computePodium;
-- un peldaño compartido va como varias filas con la misma position). Puede ir vacío.
-- Congela TODOS los eventos inconclusos (con o sin posiciones) y las posiciones recibidas.
create or replace function public.force_close_season(p_season_id uuid, p_secured_positions jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons%rowtype;
  v_ends timestamptz;
  v_has_unfinished boolean;
begin
  select * into v_season from public.seasons where id = p_season_id for update;
  if not found then
    return 'not_found';
  end if;
  if not public.is_workspace_organizer(v_season.workspace_id) then
    raise exception 'NOT_ORGANIZER';
  end if;
  if v_season.closed_at is not null then
    return 'already_closed';
  end if;

  v_ends := public.season_end_at(v_season.starts_at);
  if v_ends is null or now() < v_ends then
    raise exception 'SEASON_NOT_OVER';
  end if;

  if p_secured_positions is null or jsonb_typeof(p_secured_positions) <> 'array' then
    raise exception 'INVALID_POSITIONS: se esperaba un array JSON.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_secured_positions) as x(event_id uuid, user_id uuid, position integer)
    where x.event_id is null or x.user_id is null or x.position is null or x.position < 1
  ) then
    raise exception 'INVALID_POSITIONS: cada elemento necesita event_id, user_id y position >= 1.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_secured_positions) as x(event_id uuid, user_id uuid, position integer)
    where x.event_id not in (select u.event_id from public.season_unfinished_events(p_season_id) u)
  ) then
    raise exception 'EVENT_NOT_UNFINISHED: hay posiciones de un evento que no está inconcluso en esta temporada.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_secured_positions) as x(event_id uuid, user_id uuid, position integer)
    where not exists (
      select 1 from public.event_participants ep
      where ep.event_id = x.event_id and ep.user_id = x.user_id and ep.role = 'player'
    )
  ) then
    raise exception 'NOT_A_PLAYER: hay posiciones de un usuario que no juega ese evento.';
  end if;

  v_has_unfinished := exists (select 1 from public.season_unfinished_events(p_season_id));

  insert into public.season_frozen_events (season_id, event_id, player_count)
  select
    p_season_id,
    u.event_id,
    (select count(*)::integer from public.event_participants ep
     where ep.event_id = u.event_id and ep.role = 'player')
  from public.season_unfinished_events(p_season_id) u;

  insert into public.season_frozen_positions (season_id, event_id, user_id, position)
  select p_season_id, x.event_id, x.user_id, x.position
  from jsonb_to_recordset(p_secured_positions) as x(event_id uuid, user_id uuid, position integer);

  update public.seasons
  set closed_at = now(), closed_forced = v_has_unfinished
  where id = p_season_id;
  return 'closed';
end;
$$;

-- Trigger: crea la temporada del evento cuando arranca su draft (esto además activa el candado
-- de la config), y cierra las temporadas anteriores que ya puedan cerrarse cuando un evento
-- cambia de estado (completado, concluido, cancelado, eliminado, sandbox, etc.).
create or replace function public.draft_events_seasons_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.draft_started_at is not null
     and (tg_op = 'INSERT' or old.draft_started_at is distinct from new.draft_started_at) then
    perform public.ensure_workspace_seasons(new.workspace_id);
  end if;

  if tg_op = 'UPDATE' and (
       old.status is distinct from new.status
    or old.deleted_at is distinct from new.deleted_at
    or old.is_official is distinct from new.is_official
    or old.event_type is distinct from new.event_type
    or old.draft_started_at is distinct from new.draft_started_at
  ) then
    perform public.close_ready_seasons(new.workspace_id);
  end if;

  return null;
end;
$$;

create trigger draft_events_seasons_sync_trg
  after insert or update of draft_started_at, status, deleted_at, is_official, event_type
  on public.draft_events
  for each row execute function public.draft_events_seasons_sync();

-- Permisos: las funciones internas no son invocables por clientes; los RPC solo por usuarios
-- autenticados (cada uno valida membresía/rol adentro).
revoke all on function public.ensure_workspace_seasons(uuid) from public, anon, authenticated;
revoke all on function public.season_try_close(uuid) from public, anon, authenticated;
revoke all on function public.close_ready_seasons(uuid) from public, anon, authenticated;

revoke all on function public.sync_workspace_seasons(uuid) from public, anon;
revoke all on function public.close_season_if_ready(uuid) from public, anon;
revoke all on function public.force_close_season(uuid, jsonb) from public, anon;
grant execute on function public.sync_workspace_seasons(uuid) to authenticated;
grant execute on function public.close_season_if_ready(uuid) to authenticated;
grant execute on function public.force_close_season(uuid, jsonb) to authenticated;
grant select on public.season_frozen_events to authenticated;
grant select on public.season_frozen_positions to authenticated;
grant execute on function public.season_unfinished_events(uuid) to authenticated;

grant select on public.v_event_season to authenticated;
grant select on public.v_seasons to authenticated;

-- ===========================================================================
-- 8. Fix de sandbox: v_workspace_points y v_workspace_points_breakdown excluyen
--    is_official = false. Mismo cuerpo que 0109/0114 salvo por los filtros marcados.
-- ===========================================================================
create or replace view public.v_workspace_points as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
),
bracket_top3 as (
  select
    ep.user_id,
    de.workspace_id,
    public.workspace_ranking_points(epc.player_count, pts.position) as points
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g
    on g.id = bm.group_id
   and g.group_origin in ('round_robin_topcut', 'swiss_topcut')
   and g.status <> 'superseded'
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.is_official = true -- fix sandbox
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  join event_player_counts epc on epc.event_id = de.id
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
    and pts.position is not null
),
rr_no_top_champion as (
  select
    ep.user_id,
    de.workspace_id,
    public.workspace_ranking_points(epc.player_count, 1) as points
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id
   and ep.user_id = de.champion_user_id
   and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.is_official = true -- fix sandbox
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
rr_no_top_placement as (
  select
    r.user_id,
    r.workspace_id,
    public.workspace_ranking_points(epc.player_count, (r.pos_rank + 1)::integer) as points
  from public.v_rr_no_top_regular_rank r
  join public.draft_events de on de.id = r.event_id and de.is_official = true -- fix sandbox
  join event_player_counts epc on epc.event_id = r.event_id
  where r.pos_rank <= 2
),
all_points as (
  select user_id, workspace_id, points from bracket_top3
  union all
  select user_id, workspace_id, points from rr_no_top_champion
  union all
  select user_id, workspace_id, points from rr_no_top_placement
)
select user_id, workspace_id, sum(points)::integer as points
from all_points
group by user_id, workspace_id;

create or replace view public.v_workspace_points_breakdown as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
),
bracket_rows as (
  select
    ep.user_id, de.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, pts.position,
    public.workspace_ranking_points(epc.player_count, pts.position) as points,
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g
    on g.id = bm.group_id
   and g.group_origin in ('round_robin_topcut', 'swiss_topcut')
   and g.status <> 'superseded'
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.is_official = true -- fix sandbox
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
    and pts.position is not null
),
champion_rows as (
  select
    ep.user_id, de.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, 1 as position,
    public.workspace_ranking_points(epc.player_count, 1) as points,
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id and ep.user_id = de.champion_user_id and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  left join public.venues v on v.id = de.venue_id
  left join public.cubes c on c.id = de.cube_id
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.is_official = true -- fix sandbox
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
placement_rows as (
  select
    r.user_id, r.workspace_id, de.id as event_id, de.name as event_name,
    epc.player_count, (r.pos_rank + 1)::integer as position,
    public.workspace_ranking_points(epc.player_count, (r.pos_rank + 1)::integer) as points,
    de.scheduled_for, de.competition_format, de.top_size,
    v.name as venue_name, c.name as cube_name, de.draft_started_at, de.draft_ended_at
  from public.v_rr_no_top_regular_rank r
  join public.draft_events de on de.id = r.event_id and de.is_official = true -- fix sandbox
  join event_player_counts epc on epc.event_id = r.event_id
  left join public.venues v on v.id = de.venue_id
  left join public.cubes c on c.id = de.cube_id
  where r.pos_rank <= 2
)
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from bracket_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from champion_rows
union all
select user_id, workspace_id, event_id, event_name, player_count, position, points,
       scheduled_for, competition_format, top_size, venue_name, cube_name, draft_started_at, draft_ended_at
from placement_rows;

-- ===========================================================================
-- 9. Posiciones finales por evento (sin puntos) y puntos por temporada
-- ===========================================================================
-- Misma lógica de posiciones que v_workspace_points (top3 del bracket real, campeón de round
-- robin sin top, dense_rank de round robin sin top), pero expuesta como (evento, jugador,
-- posición) para poder aplicarle la config de puntos de cada temporada. Solo eventos oficiales,
-- no eliminados, no 2HG, completed/concluded.
create or replace view public.v_event_final_positions as
with event_player_counts as (
  select event_id, count(*)::integer as player_count
  from public.event_participants
  where role = 'player'
  group by event_id
),
bracket_rows as (
  select ep.user_id, de.workspace_id, de.id as event_id, epc.player_count, pts.position
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g
    on g.id = bm.group_id
   and g.group_origin in ('round_robin_topcut', 'swiss_topcut')
   and g.status <> 'superseded'
  join public.draft_events de
    on de.id = g.event_id
   and de.deleted_at is null
   and de.is_official = true
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
  join event_player_counts epc on epc.event_id = de.id
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
    and pts.position is not null
),
champion_rows as (
  select ep.user_id, de.workspace_id, de.id as event_id, epc.player_count, 1 as position
  from public.draft_events de
  join public.event_participants ep
    on ep.event_id = de.id and ep.user_id = de.champion_user_id and ep.role = 'player'
  join event_player_counts epc on epc.event_id = de.id
  where de.competition_format = 'round_robin'
    and de.top_size is null
    and de.deleted_at is null
    and de.is_official = true
    and de.event_type <> 'two_headed_giant'
    and de.status in ('completed', 'concluded')
    and de.champion_user_id is not null
),
placement_rows as (
  select r.user_id, r.workspace_id, de.id as event_id, epc.player_count, (r.pos_rank + 1)::integer as position
  from public.v_rr_no_top_regular_rank r
  join public.draft_events de on de.id = r.event_id and de.is_official = true
  join event_player_counts epc on epc.event_id = r.event_id
  where r.pos_rank <= 2
)
select user_id, workspace_id, event_id, player_count, position from bracket_rows
union all
select user_id, workspace_id, event_id, player_count, position from champion_rows
union all
select user_id, workspace_id, event_id, player_count, position from placement_rows;

-- Posiciones que cuentan para cada temporada: las de los eventos completados (en vivo) MÁS las
-- congeladas de los eventos que estaban inconclusos cuando se forzó el cierre. Un evento
-- congelado en una temporada aporta solo sus posiciones congeladas, aunque después se complete.
create or replace view public.v_season_positions as
select
  es.season_id,
  fp.workspace_id,
  fp.user_id,
  fp.event_id,
  fp.player_count,
  fp.position,
  false as frozen
from public.v_event_final_positions fp
join public.v_event_season es on es.event_id = fp.event_id and es.season_id is not null
where not exists (
  select 1 from public.season_frozen_events fe
  where fe.season_id = es.season_id and fe.event_id = fp.event_id
)
union all
select
  fpos.season_id,
  s.workspace_id,
  fpos.user_id,
  fpos.event_id,
  fe.player_count,
  fpos.position,
  true as frozen
from public.season_frozen_positions fpos
join public.season_frozen_events fe
  on fe.season_id = fpos.season_id and fe.event_id = fpos.event_id
join public.seasons s on s.id = fpos.season_id;

-- Puntos por temporada: cada evento aporta según la config de SU temporada. Los eventos
-- inconclusos no aportan puntos hasta resolverse, salvo los congelados por un cierre forzado.
create or replace view public.v_season_points as
select
  sp.season_id,
  sp.workspace_id,
  sp.user_id,
  sum(public.workspace_ranking_points(sp.player_count, sp.position, s.point_config_id))::integer as points
from public.v_season_positions sp
join public.seasons s on s.id = sp.season_id
group by sp.season_id, sp.workspace_id, sp.user_id;

grant select on public.v_event_final_positions to authenticated;
grant select on public.v_season_positions to authenticated;
grant select on public.v_season_points to authenticated;

-- ===========================================================================
-- 9b. Sandbox en el resto de las estadísticas (is_official = false nunca cuenta).
--     Estas vistas NO se reescriben con una copia del SQL de sus migraciones: la base real tiene
--     drift respecto de las migraciones (v_participant_event_placement conserva la definición de
--     0041 y nunca tomó la de 0042; una copia de 0042 rompe con 42P16 al cambiar sus columnas).
--     En cambio se lee la definición VIGENTE de cada vista con pg_get_viewdef y se reemplaza cada
--     referencia a draft_events por una subconsulta que solo devuelve eventos oficiales:
--         join draft_events de   ->   join (select * from public.draft_events
--                                           where is_official = true) de
--     Es equivalente a agregar la condición al ON (también en los LEFT JOIN de cubes_with_stats y
--     venues_with_stats: el cubo/sede sigue apareciendo, solo dejan de contarse sus eventos
--     sandbox). Como la lista de columnas, su orden y sus tipos no cambian, create or replace view
--     no puede fallar por 42P16 y conserva los grants. Si alguna vista tiene una referencia a
--     draft_events con una forma que el reemplazo no reconoce, la migración aborta en vez de
--     dejarla a medio filtrar.
-- ===========================================================================
do $$
declare
  v_name text;
  v_def text;
  v_new text;
  v_refs integer;
  v_replaced integer;
begin
  foreach v_name in array array[
    'v_rr_no_top_regular_rank', 'v_workspace_placements', 'v_player_workspace_stats',
    'v_head_to_head_stats', 'v_player_streaks', 'v_participant_event_placement',
    'v_player_color_stats', 'v_color_performance', 'v_player_tg_stats', 'v_cube_stats',
    'cubes_with_stats', 'venues_with_stats'
  ] loop
    v_def := pg_get_viewdef(('public.' || v_name)::regclass, true);
    v_def := regexp_replace(v_def, ';\s*$', '');

    select count(*) into v_refs from regexp_matches(v_def, '\mdraft_events\M', 'g');
    select count(*) into v_replaced
    from regexp_matches(v_def, '(?:\mjoin|\mfrom)\s+(?:public\.)?draft_events\s+\w+', 'gi');

    if v_refs = 0 or v_refs <> v_replaced then
      raise exception 'Fase B (Temporadas): la vista % tiene % referencia(s) a draft_events pero solo % con la forma reconocida. Migración abortada, nada quedó aplicado.', v_name, v_refs, v_replaced;
    end if;

    v_new := regexp_replace(
      v_def,
      '(\mjoin|\mfrom)\s+(?:public\.)?draft_events\s+(\w+)',
      '\1 (select * from public.draft_events where is_official = true) \2',
      'gi'
    );

    execute format('create or replace view public.%I as %s', v_name, v_new);

    if pg_get_viewdef(('public.' || v_name)::regclass) !~ 'is_official' then
      raise exception 'Fase B (Temporadas): la vista % quedó sin el filtro is_official. Migración abortada, nada quedó aplicado.', v_name;
    end if;
  end loop;

  raise notice 'Fase B (Temporadas): filtro is_official aplicado a las 12 vistas de estadísticas leyendo su definición vigente.';
end;
$$;

-- ===========================================================================
-- 10. VERIFICACIÓN AUTOMÁTICA
-- ===========================================================================
-- 10a. Calendario: cortes a medianoche de Buenos Aires, ciclo de estaciones correcto,
--      separación entre cortes razonable, y helpers de pertenencia con casos de borde.
do $$
declare
  v_bad integer;
  v_total integer;
begin
  select count(*) into v_total from public.season_calendar;
  if v_total = 0 then
    raise exception 'Fase B (Temporadas): season_calendar quedó vacío. Migración abortada, nada quedó aplicado.';
  end if;

  select count(*) into v_bad
  from public.season_calendar
  where (starts_at at time zone 'America/Argentina/Buenos_Aires')::time <> time '00:00';
  if v_bad > 0 then
    raise exception 'Fase B (Temporadas): % corte(s) de season_calendar no caen a las 00:00 de Buenos Aires. Migración abortada, nada quedó aplicado.', v_bad;
  end if;

  select count(*) into v_bad
  from (
    select
      kind,
      lag(kind) over (order by starts_at) as prev_kind,
      starts_at - lag(starts_at) over (order by starts_at) as gap
    from public.season_calendar
  ) x
  where prev_kind is not null
    and (
      (prev_kind, kind) not in (('spring', 'summer'), ('summer', 'autumn'), ('autumn', 'winter'), ('winter', 'spring'))
      or gap < interval '85 days'
      or gap > interval '97 days'
    );
  if v_bad > 0 then
    raise exception 'Fase B (Temporadas): % transición(es) de season_calendar fuera de ciclo o con separación anormal. Migración abortada, nada quedó aplicado.', v_bad;
  end if;

  if public.season_start_at(timestamptz '2026-09-21 23:59:59-03') is not null
     or public.season_start_at(timestamptz '2026-09-22 00:00:00-03') is distinct from timestamptz '2026-09-22 00:00:00-03'
     or public.season_start_at(timestamptz '2026-12-20 12:00:00-03') is distinct from timestamptz '2026-09-22 00:00:00-03'
     or public.season_start_at(timestamptz '2026-12-21 00:00:00-03') is distinct from timestamptz '2026-12-21 00:00:00-03'
     or public.season_end_at(timestamptz '2026-09-22 00:00:00-03') is distinct from timestamptz '2026-12-21 00:00:00-03'
     or public.season_end_at((select max(starts_at) from public.season_calendar)) is not null then
    raise exception 'Fase B (Temporadas): los helpers season_start_at/season_end_at no dan los resultados esperados en los casos de borde. Migración abortada, nada quedó aplicado.';
  end if;

  raise notice 'Fase B (Temporadas): calendario OK — % cortes, medianoche de Buenos Aires, ciclo de estaciones consistente, helpers de borde correctos.', v_total;
end;
$$;

-- 10b. Fix de sandbox: el breakdown nuevo debe ser idéntico al viejo restringido a eventos
--      oficiales (nada más cambió), y v_workspace_points debe seguir sumando lo mismo que el
--      breakdown por (usuario, workspace).
do $$
declare
  v_missing integer;
  v_extra integer;
  v_mismatch integer;
  v_total integer;
begin
  select count(*) into v_total from _points_before_0116;

  select count(*) into v_missing
  from (
    select user_id, workspace_id, event_id, position, points from _points_before_0116
    except all
    select user_id, workspace_id, event_id, position, points from public.v_workspace_points_breakdown
  ) x;

  select count(*) into v_extra
  from (
    select user_id, workspace_id, event_id, position, points from public.v_workspace_points_breakdown
    except all
    select user_id, workspace_id, event_id, position, points from _points_before_0116
  ) x;

  if v_missing > 0 or v_extra > 0 then
    raise exception 'Fase B (Temporadas): fix de sandbox — v_workspace_points_breakdown difiere del anterior restringido a eventos oficiales (% fila(s) faltantes, % sobrantes, sobre % filas de referencia). Migración abortada, nada quedó aplicado.', v_missing, v_extra, v_total;
  end if;

  select count(*) into v_mismatch
  from public.v_workspace_points p
  full join (
    select user_id, workspace_id, sum(points)::integer as points
    from public.v_workspace_points_breakdown
    group by user_id, workspace_id
  ) b on b.user_id = p.user_id and b.workspace_id = p.workspace_id
  where p.points is distinct from b.points;

  if v_mismatch > 0 then
    raise exception 'Fase B (Temporadas): fix de sandbox — % (usuario, workspace) donde v_workspace_points no coincide con la suma de v_workspace_points_breakdown. Migración abortada, nada quedó aplicado.', v_mismatch;
  end if;

  raise notice 'Fase B (Temporadas): fix de sandbox OK — % fila(s) de referencia de eventos oficiales idénticas antes/después; total y detalle consistentes.', v_total;
end;
$$;

-- 10c. La lógica de posiciones nueva (v_event_final_positions, base de v_season_points) debe dar,
--      con la config eterna, exactamente los mismos puntos que v_workspace_points.
do $$
declare
  v_mismatch integer;
begin
  select count(*) into v_mismatch
  from public.v_workspace_points p
  full join (
    select user_id, workspace_id,
      sum(public.workspace_ranking_points(player_count, position))::integer as points
    from public.v_event_final_positions
    group by user_id, workspace_id
  ) f on f.user_id = p.user_id and f.workspace_id = p.workspace_id
  where p.points is distinct from f.points;

  if v_mismatch > 0 then
    raise exception 'Fase B (Temporadas): % (usuario, workspace) donde v_event_final_positions (con config eterna) no coincide con v_workspace_points. Migración abortada, nada quedó aplicado.', v_mismatch;
  end if;

  raise notice 'Fase B (Temporadas): v_event_final_positions consistente con v_workspace_points (config eterna).';
end;
$$;
