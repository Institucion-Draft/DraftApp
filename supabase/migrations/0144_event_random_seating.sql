-- 0144_event_random_seating.sql
-- "Sortear lugares en la mesa": opción por evento (default OFF) para sortear, antes de arrancar el draft, qué lugar de la
-- mesa ocupa cada inscripto (1..n) y el sentido en que giran los sobres del primer sobre. Los pairings NO se tocan.
--
-- DISEÑO
--   * draft_events.random_seating_enabled: el toggle. Se puede cambiar hasta que arranca el draft (lo exige un trigger).
--   * Dos tablas con el mismo contenido, separadas por quién puede leerlas:
--       event_seating_pending  → resultado ya calculado por el servidor pero todavía NO publicado. Sólo lo lee quien puede
--                                gestionar el evento (el organizador que está viendo la animación).
--       event_seating          → el sorteo VIGENTE (publicado). Lo leen todos los miembros del workspace. Si cambia el
--                                conjunto de inscriptos antes de arrancar, queda is_current = false (obsoleto) y los demás
--                                ven "los lugares se van a volver a sortear" en vez de la mesa vieja.
--     Se separaron en dos tablas (y no en columnas de draft_events) porque RLS es por fila: así el pendiente no se filtra al
--     resto de los usuarios.
--   * draw_event_seating(event): TODO el azar en el servidor; guarda el resultado como pendiente y lo devuelve.
--   * publish_event_seating(event): mueve el pendiente a vigente (se llama al terminar la animación en el celu del
--     organizador, o al volver a la pantalla si la app se cerró a mitad). Idempotente.
--   * Triggers de invalidación sobre event_participants: mientras el draft NO arrancó, cualquier alta, baja, retiro, cambio
--     de rol o cambio de miembro/equipo (2HG) deja el vigente como obsoleto y descarta el pendiente. Después de arrancar
--     el draft nunca se invalida.
--   * Trigger de bloqueo sobre draft_events: pasar a 'drafting'/'playing' (o poner draft_started_at) con el toggle ON y sin
--     sorteo vigente falla en la base, con mensaje claro. Con el toggle OFF todo funciona como siempre.
--   * Gigante de Dos Cabezas: el sorteo es por PERSONA (n = 2 por equipo) y los dos integrantes de un mismo equipo no
--     quedan en lugares contiguos del círculo (k y k+1, ni n y 1). Muestreo uniforme por rechazo (tope de intentos);
--     si se agota, construcción determinística válida; si es imposible (un solo equipo) sortea igual y avisa en `warning`.
--     Requiere que los equipos ya estén sorteados (giant_randomization_done).
--
-- "Inscripto que cuenta": event_participants.role = 'player' y left_event_at is null. En 2HG cada fila es un equipo
-- (miembro A + member_b_user_id) y aporta dos personas.
--
-- NO REEMPLAZA NINGÚN CUERPO DE FUNCIÓN EXISTENTE (sólo agrega). Depende de can_manage_event (0103) e
-- is_workspace_member (0001), que se invocan tal cual.
--
-- OBJETOS NUEVOS: draft_events.random_seating_enabled; tablas event_seating y event_seating_pending; funciones
-- seating_persons, seating_adjacent_same_team, draw_event_seating, publish_event_seating, seating_invalidate_participants,
-- seating_invalidate_event_started, seating_enforce_before_start; triggers trg_seating_invalidate_participants
-- (event_participants), trg_seating_enforce_before_start (draft_events).

-- ===========================================================================
-- 1. Toggle
-- ===========================================================================
alter table public.draft_events
  add column if not exists random_seating_enabled boolean not null default false;

-- ===========================================================================
-- 2. Tablas
-- ===========================================================================
create table if not exists public.event_seating (
  event_id uuid primary key references public.draft_events(id) on delete cascade,
  n integer not null check (n >= 2),
  -- 'cw' = los sobres pasan del lugar N al N+1 (como el reloj, con la numeración horaria).
  direction text not null check (direction in ('cw', 'ccw')),
  -- [{ "seat": 1, "participant_id": "...", "member": "a"|"b", "user_id": "..." }, ...] ordenado por seat
  seats jsonb not null,
  drawn_by uuid references public.users(id),
  drawn_at timestamptz not null,
  published_at timestamptz not null default now(),
  is_current boolean not null default true,
  invalidated_at timestamptz
);

create table if not exists public.event_seating_pending (
  event_id uuid primary key references public.draft_events(id) on delete cascade,
  n integer not null check (n >= 2),
  direction text not null check (direction in ('cw', 'ccw')),
  seats jsonb not null,
  warning text,
  drawn_by uuid references public.users(id),
  drawn_at timestamptz not null default now()
);

alter table public.event_seating enable row level security;
alter table public.event_seating_pending enable row level security;

drop policy if exists "event_seating_select_members" on public.event_seating;
create policy "event_seating_select_members"
  on public.event_seating for select to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_seating.event_id and public.is_workspace_member(de.workspace_id)
  ));

drop policy if exists "event_seating_pending_select_managers" on public.event_seating_pending;
create policy "event_seating_pending_select_managers"
  on public.event_seating_pending for select to authenticated
  using (exists (
    select 1 from public.draft_events de
    where de.id = event_seating_pending.event_id and public.can_manage_event(de.workspace_id, de.id)
  ));

-- Sin policies de escritura: sólo escriben las funciones security definer de abajo.
grant select on public.event_seating to authenticated;
grant select on public.event_seating_pending to authenticated;

-- ===========================================================================
-- 3. Funciones
-- ===========================================================================
-- Personas que se sientan: una por jugador activo; en 2HG el equipo (fila A) aporta además a su miembro B.
create or replace function public.seating_persons(p_event_id uuid)
returns table (participant_id uuid, member text, user_id uuid, team integer)
language sql
stable
security definer
set search_path = public
as $$
  with players as (
    select ep.id, ep.user_id, ep.member_b_user_id,
           dense_rank() over (order by ep.id)::integer as team
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
  )
  select id, 'a'::text, user_id, team from players
  union all
  select id, 'b'::text, member_b_user_id, team from players where member_b_user_id is not null
  order by 4, 2
$$;

revoke execute on function public.seating_persons(uuid) from public, anon, authenticated;

-- Cantidad de pares de lugares contiguos del círculo (k y k+1, y n y 1) con el mismo equipo. Con n = 2 (dos lugares
-- que son vecinos por los dos lados) cuenta el par una vez.
create or replace function public.seating_adjacent_same_team(p_seat_team integer[])
returns integer
language plpgsql
immutable
as $$
declare
  n integer := coalesce(array_length(p_seat_team, 1), 0);
  k integer;
  bad integer := 0;
begin
  if n < 2 then
    return 0;
  end if;
  for k in 1 .. n - 1 loop
    if p_seat_team[k] = p_seat_team[k + 1] then
      bad := bad + 1;
    end if;
  end loop;
  if n > 2 and p_seat_team[n] = p_seat_team[1] then
    bad := bad + 1;
  end if;
  return bad;
end;
$$;

-- p_max_attempts: tope de intentos del muestreo por rechazo (2HG); sólo se baja en pruebas, para ejercitar la construcción
-- determinística de respaldo.
create or replace function public.draw_event_seating(p_event_id uuid, p_max_attempts integer default 2000)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev record;
  v_uid uuid := auth.uid();
  v_pid uuid[];
  v_mem text[];
  v_user uuid[];
  v_team integer[];
  v_n integer;
  v_teams integer;
  v_giant boolean;
  v_perm integer[];        -- v_perm[i] = lugar de la persona i
  v_seat_team integer[];
  v_try integer;
  v_ok boolean := false;
  v_warning text := null;
  v_dir text;
  v_seats jsonb;
  v_i integer;
  v_order integer[];
begin
  select * into v_ev from public.draft_events where id = p_event_id and deleted_at is null;
  if not found then
    raise exception 'Evento no encontrado.' using errcode = 'P0002';
  end if;
  if v_uid is null or not public.can_manage_event(v_ev.workspace_id, v_ev.id) then
    raise exception 'Solo quien gestiona el evento puede sortear los lugares.' using errcode = '42501';
  end if;
  if not v_ev.random_seating_enabled then
    raise exception 'El sorteo de lugares no está activado en este evento.' using errcode = '23514';
  end if;
  if v_ev.draft_started_at is not null or v_ev.status <> 'scheduled' then
    raise exception 'El draft ya arrancó: los lugares no se pueden volver a sortear.' using errcode = '23514';
  end if;

  select array_agg(sp.participant_id order by sp.team, sp.member),
         array_agg(sp.member order by sp.team, sp.member),
         array_agg(sp.user_id order by sp.team, sp.member),
         array_agg(sp.team order by sp.team, sp.member)
  into v_pid, v_mem, v_user, v_team
  from public.seating_persons(p_event_id) sp;

  v_n := coalesce(array_length(v_pid, 1), 0);
  if v_n < 2 then
    raise exception 'Se necesitan al menos 2 inscriptos para sortear los lugares (hay %).', v_n using errcode = '23514';
  end if;

  v_giant := v_ev.event_type = 'two_headed_giant';
  if v_giant and not coalesce(v_ev.giant_randomization_done, false) then
    raise exception 'Sorteá primero los equipos de Gigante de Dos Cabezas.' using errcode = '23514';
  end if;

  v_teams := (select count(distinct t) from unnest(v_team) t);

  if not v_giant then
    -- Permutación uniforme de 1..n.
    select array_agg(r.seat order by r.ord) into v_perm
    from (select row_number() over (order by random())::integer as seat, g as ord
          from generate_series(1, v_n) g) r;
  else
    -- Rechazo: permutaciones uniformes hasta que ningún par de un mismo equipo quede contiguo.
    if v_teams >= 2 then
      for v_try in 1 .. greatest(coalesce(p_max_attempts, 2000), 0) loop
        select array_agg(r.seat order by r.ord) into v_perm
        from (select row_number() over (order by random())::integer as seat, g as ord
              from generate_series(1, v_n) g) r;
        v_seat_team := array_fill(0, array[v_n]);
        for v_i in 1 .. v_n loop
          v_seat_team[v_perm[v_i]] := v_team[v_i];
        end loop;
        if public.seating_adjacent_same_team(v_seat_team) = 0 then
          v_ok := true;
          exit;
        end if;
      end loop;

      if not v_ok then
        -- Construcción determinística válida: personas agrupadas por equipo; la primera mitad en los lugares impares
        -- y la segunda en los pares (con n >= 4 ningún par de un mismo equipo queda contiguo).
        v_perm := array_fill(0, array[v_n]);
        for v_i in 1 .. v_n loop
          if v_i <= v_n / 2 then
            v_perm[v_i] := 2 * (v_i - 1) + 1;
          else
            v_perm[v_i] := 2 * (v_i - v_n / 2 - 1) + 2;
          end if;
        end loop;
        v_seat_team := array_fill(0, array[v_n]);
        for v_i in 1 .. v_n loop
          v_seat_team[v_perm[v_i]] := v_team[v_i];
        end loop;
        v_ok := public.seating_adjacent_same_team(v_seat_team) = 0;
      end if;
    end if;

    if not v_ok then
      -- Imposible (un solo equipo) o la construcción no alcanzó: se sortea igual y se avisa.
      select array_agg(r.seat order by r.ord) into v_perm
      from (select row_number() over (order by random())::integer as seat, g as ord
            from generate_series(1, v_n) g) r;
      v_warning := 'No se pudo evitar que integrantes de un mismo equipo queden en lugares contiguos (con un solo equipo es imposible).';
    end if;
  end if;

  v_dir := case when random() < 0.5 then 'cw' else 'ccw' end;

  select jsonb_agg(jsonb_build_object(
           'seat', v_perm[i], 'participant_id', v_pid[i], 'member', v_mem[i], 'user_id', v_user[i]
         ) order by v_perm[i])
  into v_seats
  from generate_series(1, v_n) i;

  insert into public.event_seating_pending (event_id, n, direction, seats, warning, drawn_by, drawn_at)
  values (p_event_id, v_n, v_dir, v_seats, v_warning, v_uid, now())
  on conflict (event_id) do update
    set n = excluded.n, direction = excluded.direction, seats = excluded.seats,
        warning = excluded.warning, drawn_by = excluded.drawn_by, drawn_at = excluded.drawn_at;

  return jsonb_build_object('n', v_n, 'direction', v_dir, 'seats', v_seats, 'warning', v_warning);
end;
$$;

create or replace function public.publish_event_seating(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev record;
  v_uid uuid := auth.uid();
  v_p public.event_seating_pending;
  v_cur public.event_seating;
begin
  select * into v_ev from public.draft_events where id = p_event_id and deleted_at is null;
  if not found then
    raise exception 'Evento no encontrado.' using errcode = 'P0002';
  end if;
  if v_uid is null or not public.can_manage_event(v_ev.workspace_id, v_ev.id) then
    raise exception 'Solo quien gestiona el evento puede publicar el sorteo de lugares.' using errcode = '42501';
  end if;

  select * into v_p from public.event_seating_pending where event_id = p_event_id;
  if found then
    if v_ev.draft_started_at is not null or v_ev.status <> 'scheduled' then
      raise exception 'El draft ya arrancó: no se puede publicar un sorteo nuevo.' using errcode = '23514';
    end if;
    insert into public.event_seating (event_id, n, direction, seats, drawn_by, drawn_at, published_at, is_current, invalidated_at)
    values (p_event_id, v_p.n, v_p.direction, v_p.seats, v_p.drawn_by, v_p.drawn_at, now(), true, null)
    on conflict (event_id) do update
      set n = excluded.n, direction = excluded.direction, seats = excluded.seats, drawn_by = excluded.drawn_by,
          drawn_at = excluded.drawn_at, published_at = excluded.published_at, is_current = true, invalidated_at = null;
    delete from public.event_seating_pending where event_id = p_event_id;
  end if;

  -- Idempotente: sin pendiente, si ya hay uno vigente se devuelve tal cual.
  select * into v_cur from public.event_seating where event_id = p_event_id and is_current;
  if not found then
    raise exception 'No hay un sorteo de lugares para publicar.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('n', v_cur.n, 'direction', v_cur.direction, 'seats', v_cur.seats);
end;
$$;

revoke execute on function public.draw_event_seating(uuid, integer) from public, anon;
revoke execute on function public.publish_event_seating(uuid) from public, anon;
grant execute on function public.draw_event_seating(uuid, integer) to authenticated;
grant execute on function public.publish_event_seating(uuid) to authenticated;

-- ===========================================================================
-- 4. Invalidación: cambios en los inscriptos mientras el draft no arrancó
-- ===========================================================================
create or replace function public.seating_invalidate_participants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
begin
  if exists (
    select 1 from public.draft_events de
    where de.id = v_event and de.draft_started_at is null and de.status = 'scheduled'
  ) then
    update public.event_seating
    set is_current = false, invalidated_at = now()
    where event_id = v_event and is_current;
    delete from public.event_seating_pending where event_id = v_event;
  end if;
  return coalesce(new, old);
end;
$$;

revoke execute on function public.seating_invalidate_participants() from public, anon, authenticated;

drop trigger if exists trg_seating_invalidate_participants on public.event_participants;
create trigger trg_seating_invalidate_participants
  after insert or delete or update of user_id, role, member_b_user_id, left_event_at
  on public.event_participants
  for each row execute function public.seating_invalidate_participants();

-- ===========================================================================
-- 5. Bloqueo de arranque y candado del toggle (draft_events)
-- ===========================================================================
create or replace function public.seating_enforce_before_start()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- El toggle no cambia una vez arrancado el draft.
  if new.random_seating_enabled is distinct from old.random_seating_enabled and old.draft_started_at is not null then
    raise exception 'No se puede cambiar el sorteo de lugares una vez arrancado el draft.' using errcode = '23514';
  end if;

  -- Arrancar (scheduled -> drafting/playing, o fijar draft_started_at) con el toggle ON exige un sorteo vigente.
  if new.random_seating_enabled
     and ((old.status = 'scheduled' and new.status in ('drafting', 'playing'))
          or (old.draft_started_at is null and new.draft_started_at is not null))
     and not exists (select 1 from public.event_seating s where s.event_id = new.id and s.is_current)
  then
    raise exception 'Falta sortear los lugares en la mesa: no se puede arrancar el draft sin un sorteo vigente.'
      using errcode = '23514';
  end if;

  -- Si el draft se revierte a "no arrancó", el sorteo anterior ya no es de fiar: vuelve a sortearse.
  if old.draft_started_at is not null and new.draft_started_at is null then
    update public.event_seating set is_current = false, invalidated_at = now() where event_id = new.id and is_current;
    delete from public.event_seating_pending where event_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.seating_enforce_before_start() from public, anon, authenticated;

drop trigger if exists trg_seating_enforce_before_start on public.draft_events;
create trigger trg_seating_enforce_before_start
  before update of status, draft_started_at, random_seating_enabled
  on public.draft_events
  for each row execute function public.seating_enforce_before_start();

-- ===========================================================================
-- 6. Verificación
-- ===========================================================================
do $verify$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'draft_events' and column_name = 'random_seating_enabled'
                   and is_nullable = 'NO' and column_default = 'false') then
    raise exception '0144: falta draft_events.random_seating_enabled (not null default false)';
  end if;
  if to_regclass('public.event_seating') is null or to_regclass('public.event_seating_pending') is null then
    raise exception '0144: faltan las tablas de sorteo';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('draw_event_seating', 'publish_event_seating', 'seating_persons', 'seating_adjacent_same_team',
                        'seating_invalidate_participants', 'seating_enforce_before_start')) <> 6 then
    raise exception '0144: faltan funciones';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_seating_invalidate_participants' and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'trg_seating_enforce_before_start' and not tgisinternal) then
    raise exception '0144: faltan triggers';
  end if;
  if exists (select 1 from public.draft_events where random_seating_enabled) then
    raise notice '0144: hay eventos con el toggle ON (se esperaban 0 al aplicar por primera vez)';
  end if;
  raise notice '0144: sorteo de lugares listo (eventos con toggle ON=%)',
    (select count(*) from public.draft_events where random_seating_enabled);
end;
$verify$;
