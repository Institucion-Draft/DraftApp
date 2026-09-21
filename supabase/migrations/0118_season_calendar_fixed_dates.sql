-- 0118_season_calendar_fixed_dates.sql
--
-- Corrige el calendario de temporadas: los cortes son fechas FIJAS y culturales, NO astronómicas.
-- Siempre a las 00:00 de Buenos Aires, todos los años sin excepción:
--     21 de marzo (Otoño), 21 de junio (Invierno), 21 de septiembre (Primavera),
--     21 de diciembre (Verano).
-- Reemplaza los cortes que 0116 cargó con el algoritmo de Meeus (equinoccios/solsticios reales,
-- que caían en 20/21/22/23 según el año). Mismo rango (Primavera 2026 a Verano 2050/51, 98
-- cortes) y mismos nombres. Efecto visible: Primavera 2026 arranca el 2026-09-21 (no el 22).
--
-- Por qué una migración nueva y no editar 0116 ni un UPDATE directo:
--   * 0116 ya está aplicada; editar una migración aplicada deja el historial mintiendo.
--   * seasons.starts_at referencia season_calendar(starts_at) sin ON UPDATE CASCADE, así que no se
--     puede cambiar el valor de una fila del calendario mientras alguna temporada la referencia.
--   * Aunque nadie creó temporadas a propósito, ensure_workspace_seasons corre por trigger cuando
--     arranca cualquier draft y crea la temporada "próxima" (la fila de Primavera 2026 con la fecha
--     vieja), o sea que puede haber filas de seasons apuntando al calendario viejo.
-- Por eso: se insertan los cortes nuevos, se reapuntan las seasons existentes al corte nuevo del
-- MISMO nombre (conservan id, config de puntos y todo lo demás), y recién ahí se borran los cortes
-- viejos. Si alguna temporada ya cerró o tiene eventos congelados por un cierre forzado, la
-- migración aborta en vez de mover fechas bajo datos que ya son resultado oficial.
--
-- Los cortes se generan con make_timestamptz(..., 'America/Argentina/Buenos_Aires'), así que la
-- medianoche local es correcta aunque Buenos Aires vuelva a tener horario de verano.
--
-- La membresía de eventos se calcula siempre desde el calendario (v_event_season), así que un
-- evento cuyo draft arrancó entre un corte viejo y su equivalente nuevo cambia de temporada de
-- forma automática. Si esa temporada todavía no tiene fila en un workspace, la crea el próximo
-- sync_workspace_seasons (o el trigger del próximo cambio de evento).

-- ===========================================================================
-- 0. Calendario nuevo y snapshot de las temporadas existentes
-- ===========================================================================
create temporary table _season_calendar_new on commit drop as
select
  make_timestamptz(y.year, m.month, 21, 0, 0, 0, 'America/Argentina/Buenos_Aires') as starts_at,
  case m.month
    when 3 then 'Otoño ' || y.year
    when 6 then 'Invierno ' || y.year
    when 9 then 'Primavera ' || y.year
    else 'Verano ' || y.year || '/' || right((y.year + 1)::text, 2)
  end as name,
  case m.month
    when 3 then 'autumn'
    when 6 then 'winter'
    when 9 then 'spring'
    else 'summer'
  end as kind
from generate_series(2026, 2050) as y(year)
cross join (values (3), (6), (9), (12)) as m(month)
where make_timestamptz(y.year, m.month, 21, 0, 0, 0, 'America/Argentina/Buenos_Aires')
      >= make_timestamptz(2026, 9, 21, 0, 0, 0, 'America/Argentina/Buenos_Aires');

create temporary table _seasons_before_0118 on commit drop as
select s.id as season_id, s.workspace_id, c.name
from public.seasons s
join public.season_calendar c on c.starts_at = s.starts_at;

-- ===========================================================================
-- 1. Precondiciones: no mover fechas bajo resultados oficiales ni bajo nombres desconocidos
-- ===========================================================================
do $$
declare
  v_closed integer;
  v_frozen integer;
  v_unknown integer;
begin
  select count(*) into v_closed from public.seasons where closed_at is not null;
  select count(*) into v_frozen from public.season_frozen_events;
  select count(*) into v_unknown
  from _seasons_before_0118 b
  where not exists (select 1 from _season_calendar_new n where n.name = b.name);

  if v_closed > 0 or v_frozen > 0 then
    raise exception 'Fase B (Temporadas): hay % temporada(s) cerrada(s) y % evento(s) congelado(s) por cierre forzado. No se mueven las fechas de corte bajo resultados ya oficiales: revisar a mano. Migración abortada, nada quedó aplicado.', v_closed, v_frozen;
  end if;
  if v_unknown > 0 then
    raise exception 'Fase B (Temporadas): % temporada(s) apuntan a un corte del calendario cuyo nombre no existe en el calendario nuevo. Migración abortada, nada quedó aplicado.', v_unknown;
  end if;
end;
$$;

-- ===========================================================================
-- 2. Insertar los cortes nuevos, reapuntar las temporadas y borrar los cortes viejos
-- ===========================================================================
insert into public.season_calendar (starts_at, name, kind)
select starts_at, name, kind from _season_calendar_new
on conflict (starts_at) do update set name = excluded.name, kind = excluded.kind;

update public.seasons s
set starts_at = n.starts_at
from _seasons_before_0118 b
join _season_calendar_new n on n.name = b.name
where s.id = b.season_id
  and s.starts_at <> n.starts_at;

-- Si alguna temporada siguiera apuntando a un corte viejo, la FK hace fallar este delete.
delete from public.season_calendar c
where not exists (select 1 from _season_calendar_new n where n.starts_at = c.starts_at);

-- ===========================================================================
-- 3. VERIFICACIÓN AUTOMÁTICA
-- ===========================================================================
do $$
declare
  v_count integer;
  v_bad integer;
  v_seasons_before integer;
  v_seasons_after integer;
begin
  select count(*) into v_count from public.season_calendar;
  if v_count <> 98 then
    raise exception 'Fase B (Temporadas): season_calendar quedó con % filas (se esperaban 98). Migración abortada, nada quedó aplicado.', v_count;
  end if;

  -- Cada corte: día 21 de marzo/junio/septiembre/diciembre, 00:00 de Buenos Aires, con el
  -- nombre/tipo que corresponde a su mes.
  select count(*) into v_bad
  from public.season_calendar c
  where (c.starts_at at time zone 'America/Argentina/Buenos_Aires')::time <> time '00:00'
     or extract(day from (c.starts_at at time zone 'America/Argentina/Buenos_Aires')) <> 21
     or not (
       (extract(month from (c.starts_at at time zone 'America/Argentina/Buenos_Aires')) = 3 and c.kind = 'autumn' and c.name like 'Otoño %')
       or (extract(month from (c.starts_at at time zone 'America/Argentina/Buenos_Aires')) = 6 and c.kind = 'winter' and c.name like 'Invierno %')
       or (extract(month from (c.starts_at at time zone 'America/Argentina/Buenos_Aires')) = 9 and c.kind = 'spring' and c.name like 'Primavera %')
       or (extract(month from (c.starts_at at time zone 'America/Argentina/Buenos_Aires')) = 12 and c.kind = 'summer' and c.name like 'Verano %')
     );
  if v_bad > 0 then
    raise exception 'Fase B (Temporadas): % corte(s) que no son un 21 de mar/jun/sep/dic a las 00:00 de Buenos Aires con su nombre correcto. Migración abortada, nada quedó aplicado.', v_bad;
  end if;

  -- Ciclo de estaciones y separación razonable entre cortes.
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
      or gap < interval '89 days'
      or gap > interval '93 days'
    );
  if v_bad > 0 then
    raise exception 'Fase B (Temporadas): % transición(es) del calendario fuera de ciclo o con separación anormal. Migración abortada, nada quedó aplicado.', v_bad;
  end if;

  -- Bordes de los helpers: el primer corte es 2026-09-21 00:00 BA.
  if public.season_start_at(timestamptz '2026-09-20 23:59:59-03') is not null
     or public.season_start_at(timestamptz '2026-09-21 00:00:00-03') is distinct from timestamptz '2026-09-21 00:00:00-03'
     or public.season_start_at(timestamptz '2026-12-20 12:00:00-03') is distinct from timestamptz '2026-09-21 00:00:00-03'
     or public.season_start_at(timestamptz '2026-12-21 00:00:00-03') is distinct from timestamptz '2026-12-21 00:00:00-03'
     or public.season_end_at(timestamptz '2026-09-21 00:00:00-03') is distinct from timestamptz '2026-12-21 00:00:00-03'
     or public.season_end_at((select max(starts_at) from public.season_calendar)) is not null then
    raise exception 'Fase B (Temporadas): los helpers season_start_at/season_end_at no dan los resultados esperados con el calendario nuevo. Migración abortada, nada quedó aplicado.';
  end if;

  -- Las temporadas existentes se conservaron (mismo id) y siguen con el mismo nombre.
  select count(*) into v_seasons_before from _seasons_before_0118;
  select count(*) into v_seasons_after from public.seasons;
  if v_seasons_before <> v_seasons_after then
    raise exception 'Fase B (Temporadas): cambió la cantidad de temporadas (% antes, % después). Migración abortada, nada quedó aplicado.', v_seasons_before, v_seasons_after;
  end if;

  select count(*) into v_bad
  from _seasons_before_0118 b
  join public.seasons s on s.id = b.season_id
  join public.season_calendar c on c.starts_at = s.starts_at
  where c.name is distinct from b.name;
  if v_bad > 0 then
    raise exception 'Fase B (Temporadas): % temporada(s) cambiaron de nombre al reapuntar el calendario. Migración abortada, nada quedó aplicado.', v_bad;
  end if;

  raise notice 'Fase B (Temporadas): calendario fijo OK — % cortes, 21/3 21/6 21/9 21/12 a las 00:00 de Buenos Aires; % temporada(s) existente(s) reapuntada(s).', v_count, v_seasons_after;
end;
$$;
