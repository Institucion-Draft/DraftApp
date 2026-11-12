-- 0157_desbloqueo_especial_temporada.sql
-- Desbloqueo especial por la partida N.º 420 de la temporada de un workspace (solo base de datos: el cliente viene después).
--
-- REGLAS
--   * Partida válida: matches de un evento con is_official = true, event_type <> 'two_headed_giant', no borrado (deleted_at nulo),
--     con match_type <> 'revenge', is_walkover = false y status <> 'aborted'. Las rendiciones (ended_by_surrender) cuentan.
--   * Alcance: por workspace y temporada, la del evento según v_event_season (0116: por draft_started_at).
--   * Orden: SIEMPRE por matches.started_at (desempate por id), nunca por ended_at. Las partidas en curso ocupan su lugar en el orden.
--   * La N-ésima partida (special_match_threshold() = 420) se resuelve recién cuando está completada con ganador Y no queda ninguna
--     partida válida in_progress empezada antes. Una in_progress con más de special_match_stale_hours() (24 h) desde su started_at
--     NO bloquea (sigue ocupando su lugar en el orden hasta que se complete o se aborte).
--   * Si una partida anterior se aborta, el orden se corre: la reevaluación corre también cuando una partida pasa a 'aborted'.
--   * Una vez disparada queda congelada: una sola fila por (workspace, temporada) en season_special_unlocks, nunca se revierte
--     (las claves foráneas a match/usuarios/evento son ON DELETE SET NULL para que borrar datos no la deshaga).
--
-- QUÉ HACE
--   1. special_match_threshold() (420) y special_match_stale_hours() (24): constantes IMMUTABLE. Las pruebas redefinen el umbral.
--   2. season_special_unlocks: RLS activada y sin políticas; sin acceso directo para anon/authenticated (REVOKE explícito: los
--      privilegios por defecto de Supabase no los cancela ALTER DEFAULT PRIVILEGES). Única por (workspace_id, season_id).
--   3. special_unlock_evaluate(workspace, season): toma pg_advisory_xact_lock por workspace+temporada, ubica la partida N.º umbral,
--      comprueba que esté completada con ganador y sin válidas en curso antes, y la congela (INSERT ... ON CONFLICT DO NOTHING).
--   4. Disparo desde la base: constraint triggers DIFERIDOS en matches (insert/update con status completed o aborted). Corren al
--      commit, con el estado final de la transacción. Un error de la evaluación se registra en achievement_eval_errors
--      (achievement_log_error, código 'special_unlock') y NO aborta la transacción de la partida.
--   5. assign_rotated_avatar(): igual a 0146 salvo la recompensa (ver abajo).
--   6. RPCs get_my_special_unlock_notice() y ack_special_unlock_notice() (SECURITY DEFINER, auth.uid(), solo authenticated).
--   7. special_unlock_sweep(): barrido para las colgadas que cruzan las 24 h (ver BARRIDO). La programación en pg_cron NO va en el
--      cuerpo de la migración (pg_cron no existe en PGlite): bloque "correr a mano después de aplicar" más abajo.
--   8. event_participants.special_reward text null, check in ('shiny','ditto'): dato legible de qué inscripción cobró la recompensa.
--      Lo setea assign_rotated_avatar ('shiny' ganador, 'ditto' perdedor). anon/authenticated no pueden escribirla: sin GRANT de
--      columna (0151 da INSERT/UPDATE solo por columnas) y un guard BEFORE INSERT/UPDATE que la protege aunque algún día se
--      otorgue un GRANT de tabla. Legible por quien ya lee event_participants (SELECT de tabla).
--   9. Devolución al cancelar o borrar el evento antes del draft (ver DEVOLUCIÓN).
--
-- BARRIDO (special_unlock_sweep)
--   Recorre los (workspace, temporada) SIN fila en season_special_unlocks que tengan alguna partida válida in_progress con más de
--   special_match_stale_hours() desde su started_at, y llama a special_unlock_evaluate() para cada uno. Cada par va en su propio
--   bloque con manejo de error: se registra con achievement_log_error (código 'special_unlock_sweep') y sigue con el resto.
--   Devuelve cuántos desbloqueos se congelaron. Los locks por par se sueltan al terminar la transacción del barrido.
--
-- DEVOLUCIÓN (special_unlock_release_for_event)
--   Si un evento SIN draft iniciado (draft_started_at nulo) se cancela (cancelled_at pasa a no nulo) o se borra (deleted_at pasa a no
--   nulo), toda recompensa consumida en ese evento (winner/loser_consumed_event_id) vuelve a quedar pendiente
--   (consumed_event_id y consumed_at en nulo) y se limpia event_participants.special_reward de ese evento. Desinscribirse NO la
--   devuelve. Con el draft ya iniciado tampoco se devuelve. Un evento que solo cambia a status 'cancelled' sin cancelled_at no
--   dispara la devolución. El borrado FÍSICO de la fila del evento (solo administrador: authenticated no tiene DELETE) no devuelve nada:
--   un BEFORE DELETE que actualice season_special_unlocks choca con el ON DELETE SET NULL de la misma sentencia ("tuple already
--   modified") y uno AFTER llega cuando la clave ya se anuló. Si hiciera falta, a mano: update season_special_unlocks set
--   winner_consumed_at = null where winner_consumed_event_id is null and winner_consumed_at is not null (y lo mismo con loser).
--
-- RECOMPENSAS (en assign_rotated_avatar, al insertar la inscripción)
--   * Solo en eventos is_official = true y no 2HG, del MISMO workspace del desbloqueo (sin tope de temporada). Sandbox y 2HG nunca
--     consumen ni disparan nada. Se consume una recompensa pendiente por inscripción (la más antigua) y se marca
--     winner/loser_consumed_event_id y consumed_at en la misma transacción (fila bloqueada FOR UPDATE: dos inscripciones
--     simultáneas del mismo usuario no consumen la misma).
--   * Ganador: is_shiny := true y avatar al azar entre los activos que le corresponden (mismo pool que hoy: generación, Unown).
--     Perdedor: avatar = Ditto (default_avatars activo con name 'Ditto'; si no existe no se consume) e is_shiny := false.
--     Ditto repetido en el evento está permitido. La recompensa pisa el avatar custom solo en ese evento (a nivel base: se asigna
--     rotated_avatar_id aunque el usuario tenga custom_avatar_path; que el cliente lo muestre por encima del custom es trabajo del
--     cliente).
--   * Reinscripción en el mismo evento: no consume otra (si hay histórico del evento no se reclama nada). El histórico devuelve el
--     mismo avatar y shiny; para un usuario con custom que ya cobró la recompensa en ese evento también se lo devuelve.
--   * La tirada normal (1/4096 y cumpleaños, 0146) no cambia, tampoco en sandbox.
--   DESVÍO RESPECTO DEL PEDIDO: el pedido ubica la recompensa "justo después de la tirada de is_shiny y antes del bloque del
--   histórico", pero en la función vigente (0146) el histórico y el retorno anticipado por avatar custom están ANTES de la tirada.
--   Por eso el reclamo (que decide si hay recompensa) va arriba, antes del retorno por custom, y se aplica justo después de la
--   tirada. El histórico se lee primero (solo lectura) para no consumir cuando ya hay uno.
--
-- LO QUE NO HACE (queda para el cliente / otra fase): cartel, llamada a las RPCs, mostrar la recompensa por encima del avatar
-- custom (el dato legible ahora es event_participants.special_reward) y el espejo del Ditto en pantallas distintas del life tracker.
--
-- LÍMITES CONOCIDOS
--   * Una in_progress que pasa las 24 h deja de bloquear sin generar ningún evento: lo cubre special_unlock_sweep() una vez
--     programado en pg_cron (bloque aparte), o la próxima partida que se complete/aborte en ese workspace y temporada, o a mano:
--       select public.special_unlock_evaluate('<workspace_id>', '<season_id>');      -- como postgres
--       select public.special_unlock_sweep();
--   * No existe ningún cierre automático de partidas colgadas (ni en migraciones, ni en pg_cron, ni en el cliente más allá del
--     aborto con confirmación de ambos jugadores, 0001 finalize_match_abort).
--   * La recompensa se consume al inscribirse: si el jugador se desinscribe, o el evento ya empezó el draft y no se juega, se pierde.
--     Solo se devuelve si el evento se cancela/borra ANTES del draft.
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   assign_rotated_avatar   5c725a71f14827986c6fad913de0bbcb  (3026 caracteres con LF; con CRLF: 71d185c61f4f632934bee1dbbb79bb86, 3119)  [0146]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'assign_rotated_avatar';
--
-- OBJETOS NUEVOS: tabla season_special_unlocks; funciones special_match_threshold, special_match_stale_hours,
-- special_ditto_avatar_id, special_unlock_evaluate, special_unlock_on_match, special_unlock_claim,
-- get_my_special_unlock_notice, ack_special_unlock_notice, special_unlock_sweep, special_unlock_release_for_event,
-- special_unlock_on_event_cancel, event_participants_guard_special_reward; columna event_participants.special_reward; constraint
-- triggers special_unlock_matches_ins / _upd (matches); trigger special_unlock_event_cancel (draft_events) y
-- event_participants_guard_special_reward (event_participants).
--
-- APLICAR EN PRODUCCIÓN (a mano, SQL Editor): idempotente. Depende de 0116 (seasons, v_event_season), 0121 (achievement_event_season,
-- achievement_log_error) y 0146 (assign_rotated_avatar). Verificar después con el bloque de abajo y las consultas de la sección 8.
--
-- CORRER A MANO DESPUÉS DE APLICAR (no está dentro de la migración: pg_cron no existe en PGlite; hora UTC; minuto 17 para no coincidir
-- con las tareas a las en punto ni con analytics_refresh 08:30). Verificar antes que exista la extensión (Database > Extensions):
--     select cron.schedule('special_unlock_sweep', '17 * * * *', $$select public.special_unlock_sweep()$$);
--     select jobid, jobname, schedule, active from cron.job where jobname = 'special_unlock_sweep';
--   Para quitarlo: select cron.unschedule('special_unlock_sweep');
--
-- VERIFICACIÓN POSTERIOR (como postgres):
--     select column_name, data_type from information_schema.columns where table_name = 'event_participants' and column_name = 'special_reward';
--     select has_column_privilege('authenticated', 'public.event_participants', 'special_reward', 'update') as escribe,
--            has_column_privilege('authenticated', 'public.event_participants', 'special_reward', 'select') as lee;   -- false / true
--     select public.special_unlock_sweep();                                                                            -- 0 si no hay nada colgado
--
--   Verificación de concurrencia (solo en la base real, con dos sesiones): en A) begin; completar la partida N-1; (sin commit). En B)
--   begin; completar la partida N; commit. En A) commit. Esperado: UNA fila en season_special_unlocks.
--
-- ROLLBACK (NO CORRER salvo marcha atrás deliberada; borra las filas congeladas, las recompensas consumidas y special_reward):
--   -- 0) select cron.unschedule('special_unlock_sweep');   -- si se programó
--   -- 1) volver a la función de 0146 (ejecutar la sección 4 de 0146_shiny_birthday_chance.sql)
--   -- 2) drop trigger if exists special_unlock_matches_ins on public.matches;
--   --    drop trigger if exists special_unlock_matches_upd on public.matches;
--   --    drop trigger if exists special_unlock_event_cancel on public.draft_events;
--   --    drop trigger if exists event_participants_guard_special_reward on public.event_participants;
--   -- 3) drop function if exists public.ack_special_unlock_notice();
--   --    drop function if exists public.get_my_special_unlock_notice();
--   --    drop function if exists public.special_unlock_claim(uuid, uuid);
--   --    drop function if exists public.special_unlock_on_match();
--   --    drop function if exists public.special_unlock_evaluate(uuid, uuid);
--   --    drop function if exists public.special_unlock_sweep();
--   --    drop function if exists public.special_unlock_on_event_cancel();
--   --    drop function if exists public.special_unlock_release_for_event(uuid);
--   --    drop function if exists public.event_participants_guard_special_reward();
--   --    drop function if exists public.special_ditto_avatar_id();
--   --    drop function if exists public.special_match_stale_hours();
--   --    drop function if exists public.special_match_threshold();
--   -- 4) alter table public.event_participants drop column if exists special_reward;   -- (hacer backup antes)
--   --    drop table if exists public.season_special_unlocks;   -- (hacer backup antes)

-- ===========================================================================
-- 1. Constantes
-- ===========================================================================
create or replace function public.special_match_threshold()
returns integer language sql immutable as $$ select 420 $$;

create or replace function public.special_match_stale_hours()
returns integer language sql immutable as $$ select 24 $$;

-- ===========================================================================
-- 2. Tabla
-- ===========================================================================
create table if not exists public.season_special_unlocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  winner_user_id uuid references public.users(id) on delete set null,
  loser_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  winner_seen_at timestamptz,
  loser_seen_at timestamptz,
  winner_consumed_event_id uuid references public.draft_events(id) on delete set null,
  loser_consumed_event_id uuid references public.draft_events(id) on delete set null,
  winner_consumed_at timestamptz,
  loser_consumed_at timestamptz,
  constraint season_special_unlocks_unique unique (workspace_id, season_id)
);

alter table public.season_special_unlocks enable row level security;
-- Sin políticas: nadie del cliente lee ni escribe; solo funciones SECURITY DEFINER.
revoke all on table public.season_special_unlocks from public, anon, authenticated;

comment on table public.season_special_unlocks is
  'Desbloqueo especial de la partida N.º 420 por workspace y temporada (0157). Una fila por (workspace, temporada), congelada. Sin acceso directo desde el cliente.';

-- special_reward: dato legible de qué inscripción cobró la recompensa ('shiny' = ganador, 'ditto' = perdedor).
alter table public.event_participants add column if not exists special_reward text;
alter table public.event_participants drop constraint if exists event_participants_special_reward_check;
alter table public.event_participants
  add constraint event_participants_special_reward_check check (special_reward is null or special_reward in ('shiny', 'ditto'));
-- Sin escritura de cliente: sin GRANT de columna (el INSERT/UPDATE de authenticated en 0151 es por lista de columnas) y, por si algún día
-- se otorga un GRANT de tabla, un guard. Corre antes que on_participant_created (los triggers BEFORE salen por orden alfabético).
revoke insert (special_reward), update (special_reward) on public.event_participants from public, anon, authenticated;

create or replace function public.event_participants_guard_special_reward()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.special_reward := null;
    else
      new.special_reward := old.special_reward;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists event_participants_guard_special_reward on public.event_participants;
create trigger event_participants_guard_special_reward
  before insert or update on public.event_participants
  for each row execute function public.event_participants_guard_special_reward();

-- ===========================================================================
-- 3. Evaluación (congelado, orden por started_at, espera por pendientes)
-- ===========================================================================
create or replace function public.special_ditto_avatar_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select da.id
  from public.default_avatars da
  where da.is_active = true
    and lower(btrim(da.name)) = 'ditto'
  order by da.id
  limit 1
$$;

create or replace function public.special_unlock_evaluate(p_workspace_id uuid, p_season_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer := public.special_match_threshold();
  v_target record;
  v_winner_user uuid;
  v_loser_pid uuid;
  v_loser_user uuid;
  v_rows integer;
begin
  if p_workspace_id is null or p_season_id is null then
    return false;
  end if;

  -- Un solo evaluador por workspace+temporada a la vez; el lock vive hasta el fin de la transacción. Quien llega segundo espera y
  -- después lee el estado ya confirmado por el primero (cada sentencia de plpgsql toma un snapshot nuevo en READ COMMITTED).
  perform pg_advisory_xact_lock(hashtext('special_unlock'), hashtext(p_workspace_id::text || ':' || p_season_id::text));

  if exists (
    select 1 from public.season_special_unlocks u
    where u.workspace_id = p_workspace_id and u.season_id = p_season_id
  ) then
    return false;
  end if;

  with v as (
    select m.id, m.started_at, m.status, m.winner_participant_id,
           p.participant_a_id, p.participant_b_id,
           row_number() over (order by m.started_at, m.id) as rn
    from public.matches m
    join public.pairings p on p.id = m.pairing_id
    join public.draft_events de on de.id = p.event_id
    join public.v_event_season es on es.event_id = de.id
    where es.workspace_id = p_workspace_id
      and es.season_id = p_season_id
      and de.is_official = true
      and de.event_type <> 'two_headed_giant'
      and de.deleted_at is null
      and m.match_type <> 'revenge'
      and m.is_walkover = false
      and m.status <> 'aborted'
  )
  select t.id, t.status, t.winner_participant_id, t.participant_a_id, t.participant_b_id,
         exists (
           select 1 from v b
           where b.rn < t.rn
             and b.status = 'in_progress'
             and b.started_at > now() - make_interval(hours => public.special_match_stale_hours())
         ) as blocked
  into v_target
  from v t
  where t.rn = v_n;

  if not found then
    return false;
  end if;
  if v_target.status <> 'completed' or v_target.winner_participant_id is null or v_target.blocked then
    return false;
  end if;

  v_loser_pid := case
    when v_target.winner_participant_id = v_target.participant_a_id then v_target.participant_b_id
    when v_target.winner_participant_id = v_target.participant_b_id then v_target.participant_a_id
    else null
  end;
  if v_loser_pid is null then
    return false;
  end if;

  select ep.user_id into v_winner_user from public.event_participants ep where ep.id = v_target.winner_participant_id;
  select ep.user_id into v_loser_user from public.event_participants ep where ep.id = v_loser_pid;
  if v_winner_user is null or v_loser_user is null then
    return false;
  end if;

  insert into public.season_special_unlocks (workspace_id, season_id, match_id, winner_user_id, loser_user_id)
  values (p_workspace_id, p_season_id, v_target.id, v_winner_user, v_loser_user)
  on conflict (workspace_id, season_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.special_unlock_on_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_workspace_id uuid;
  v_season_id uuid;
begin
  begin
    select p.event_id into v_event_id from public.pairings p where p.id = new.pairing_id;

    -- Salida barata: eventos sandbox, 2HG, borrados o sin draft iniciado nunca disparan nada.
    select de.workspace_id into v_workspace_id
    from public.draft_events de
    where de.id = v_event_id
      and de.is_official = true
      and de.event_type <> 'two_headed_giant'
      and de.deleted_at is null
      and de.draft_started_at is not null;
    if v_workspace_id is null then
      return null;
    end if;

    v_season_id := public.achievement_event_season(v_event_id);  -- crea las temporadas del workspace si faltan
    perform public.special_unlock_evaluate(v_workspace_id, v_season_id);
  exception when others then
    perform public.achievement_log_error(v_event_id, 'special_unlock', sqlstate, sqlerrm);
  end;
  return null;
end;
$$;

drop trigger if exists special_unlock_matches_ins on public.matches;
create constraint trigger special_unlock_matches_ins
  after insert on public.matches
  deferrable initially deferred
  for each row
  when (new.status in ('completed', 'aborted'))
  execute function public.special_unlock_on_match();

drop trigger if exists special_unlock_matches_upd on public.matches;
create constraint trigger special_unlock_matches_upd
  after update of status, winner_participant_id, is_walkover, match_type on public.matches
  deferrable initially deferred
  for each row
  when (new.status in ('completed', 'aborted'))
  execute function public.special_unlock_on_match();

-- Barrido: reevalúa los pares sin fila congelada que tienen alguna in_progress de más de special_match_stale_hours() horas (candidata a
-- haber dejado de bloquear sin que ningún evento lo avise). Devuelve cuántos desbloqueos se congelaron.
create or replace function public.special_unlock_sweep()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair record;
  v_total integer := 0;
begin
  for v_pair in
    select distinct es.workspace_id, es.season_id
    from public.matches m
    join public.pairings p on p.id = m.pairing_id
    join public.draft_events de on de.id = p.event_id
    join public.v_event_season es on es.event_id = de.id
    where es.season_id is not null
      and de.is_official = true
      and de.event_type <> 'two_headed_giant'
      and de.deleted_at is null
      and m.match_type <> 'revenge'
      and m.is_walkover = false
      and m.status = 'in_progress'
      and m.started_at <= now() - make_interval(hours => public.special_match_stale_hours())
      and not exists (
        select 1 from public.season_special_unlocks u
        where u.workspace_id = es.workspace_id and u.season_id = es.season_id
      )
  loop
    begin
      if public.special_unlock_evaluate(v_pair.workspace_id, v_pair.season_id) then
        v_total := v_total + 1;
      end if;
    exception when others then
      perform public.achievement_log_error(null, 'special_unlock_sweep', sqlstate, sqlerrm);
    end;
  end loop;
  return v_total;
end;
$$;

-- Devuelve las recompensas consumidas en un evento (cancelado/borrado antes del draft) y limpia special_reward de sus inscripciones.
create or replace function public.special_unlock_release_for_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.season_special_unlocks
  set winner_consumed_event_id = null, winner_consumed_at = null
  where winner_consumed_event_id = p_event_id;

  update public.season_special_unlocks
  set loser_consumed_event_id = null, loser_consumed_at = null
  where loser_consumed_event_id = p_event_id;

  update public.event_participants
  set special_reward = null
  where event_id = p_event_id and special_reward is not null;
end;
$$;

create or replace function public.special_unlock_on_event_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.draft_started_at is null
       and ((old.cancelled_at is null and new.cancelled_at is not null)
         or (old.deleted_at is null and new.deleted_at is not null)) then
      perform public.special_unlock_release_for_event(new.id);
    end if;
  exception when others then
    perform public.achievement_log_error(new.id, 'special_unlock_release', sqlstate, sqlerrm);
  end;
  return new;
end;
$$;

drop trigger if exists special_unlock_event_cancel on public.draft_events;
create trigger special_unlock_event_cancel
  after update of cancelled_at, deleted_at on public.draft_events
  for each row execute function public.special_unlock_on_event_cancel();

-- ===========================================================================
-- 4. Reclamo de la recompensa (lo llama assign_rotated_avatar)
-- ===========================================================================
-- Devuelve 'winner', 'loser' o null. Solo eventos oficiales y no 2HG del mismo workspace del desbloqueo. Consume UNA recompensa
-- (la más antigua) y la marca en la misma transacción. Las filas candidatas se bloquean FOR UPDATE.
create or replace function public.special_unlock_claim(p_user_id uuid, p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ev record;
  v_row record;
  v_ditto uuid;
begin
  select de.workspace_id, de.is_official, de.event_type
  into v_ev
  from public.draft_events de
  where de.id = p_event_id;
  if not found or v_ev.is_official is distinct from true or v_ev.event_type = 'two_headed_giant' then
    return null;
  end if;

  v_ditto := public.special_ditto_avatar_id();

  for v_row in
    select u.id,
           (u.winner_user_id = p_user_id and u.winner_consumed_at is null) as is_winner
    from public.season_special_unlocks u
    where u.workspace_id = v_ev.workspace_id
      and (
        (u.winner_user_id = p_user_id and u.winner_consumed_at is null)
        or (u.loser_user_id = p_user_id and u.loser_consumed_at is null and v_ditto is not null)
      )
    order by u.created_at, u.id
    for update
  loop
    if v_row.is_winner then
      update public.season_special_unlocks
      set winner_consumed_event_id = p_event_id, winner_consumed_at = now()
      where id = v_row.id;
      return 'winner';
    else
      update public.season_special_unlocks
      set loser_consumed_event_id = p_event_id, loser_consumed_at = now()
      where id = v_row.id;
      return 'loser';
    end if;
  end loop;

  return null;
end;
$$;

-- ===========================================================================
-- 5. assign_rotated_avatar (cuerpo de 0146 + recompensa)
-- ===========================================================================
create or replace function public.assign_rotated_avatar()
returns trigger
language plpgsql
security definer
as $$

declare
  user_has_custom boolean;
  gen3_ok boolean;
  v_display text;
  v_username text;
  random_avatar_id uuid;
  picked_unown_form text;
  historical_avatar_id uuid;
  historical_is_shiny boolean;
  v_event_date date;
  v_today date;
  v_reward text;
  v_prev text;
begin
  select (u.custom_avatar_path is not null),
         (u.gen3_unlocked_at is not null),
         u.display_name,
         u.username
  into user_has_custom, gen3_ok, v_display, v_username
  from public.users u
  where u.id = new.user_id;

  select rotated_avatar_id, is_shiny
  into historical_avatar_id, historical_is_shiny
  from public.event_participant_avatar_history
  where user_id = new.user_id
    and event_id = new.event_id;

  -- ¿Ya cobró una recompensa en ESTE evento? ('shiny' ganador / 'ditto' perdedor). Sirve para la reinscripción.
  select case when u.winner_user_id = new.user_id and u.winner_consumed_event_id = new.event_id then 'shiny' else 'ditto' end
  into v_prev
  from public.season_special_unlocks u
  where (u.winner_user_id = new.user_id and u.winner_consumed_event_id = new.event_id)
     or (u.loser_user_id = new.user_id and u.loser_consumed_event_id = new.event_id)
  limit 1;

  -- Recompensa del desbloqueo especial: solo si no hay histórico en este evento (reinscripción = mismo resultado, sin consumir).
  -- special_unlock_claim ya descarta eventos sandbox y 2HG.
  if historical_avatar_id is null then
    v_reward := public.special_unlock_claim(new.user_id, new.event_id);
  end if;

  if user_has_custom and v_reward is null then
    -- Con custom no se asigna avatar rotado, salvo que ya haya cobrado la recompensa en este evento (reinscripción).
    if historical_avatar_id is not null and v_prev is not null then
      new.rotated_avatar_id := historical_avatar_id;
      new.is_shiny := coalesce(historical_is_shiny, false);
      new.special_reward := v_prev;
    end if;
    return new;
  end if;

  if historical_avatar_id is not null then
    new.rotated_avatar_id := historical_avatar_id;
    new.is_shiny := coalesce(historical_is_shiny, false);
    new.special_reward := v_prev;
    return new;
  end if;

  -- Shiny antes de elegir qué Pokémon: chance basal, o más si es el cumpleaños del jugador o el evento cae cerca de él.
  v_today := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  select (de.scheduled_for at time zone 'America/Argentina/Buenos_Aires')::date
  into v_event_date
  from public.draft_events de
  where de.id = new.event_id;
  new.is_shiny := (random() < public.shiny_chance_for(new.user_id, v_event_date, v_today) / 100.0);

  -- Recompensa: el ganador sale shiny; el perdedor, Ditto sin shiny.
  if v_reward = 'winner' then
    new.is_shiny := true;
    new.special_reward := 'shiny';
  elsif v_reward = 'loser' then
    new.is_shiny := false;
    new.special_reward := 'ditto';
  end if;

  if v_reward = 'loser' then
    random_avatar_id := public.special_ditto_avatar_id();
    picked_unown_form := null;
  else
    -- Pool del jugador: activos, no asignados en el evento, Gen 1-2 (o también Gen 3 si lo desbloqueó) y Unown como
    -- UNA sola especie: sólo entra su fila representante (forma 'a') y sólo si ninguna forma de Unown está asignada
    -- en el evento. Probabilidad uniforme entre los elegibles.
    select da.id, da.unown_form
    into random_avatar_id, picked_unown_form
    from public.default_avatars da
    where da.is_active = true
      and (coalesce(da.generation, 1) <= 2 or coalesce(gen3_ok, false))
      and (da.unown_form is null or da.unown_form = 'a')
      and da.id not in (
        select rotated_avatar_id
        from public.event_participants
        where event_id = new.event_id
          and rotated_avatar_id is not null
      )
      and (
        da.unown_form is null
        or not exists (
          select 1
          from public.event_participants ep
          join public.default_avatars d2 on d2.id = ep.rotated_avatar_id
          where ep.event_id = new.event_id
            and d2.unown_form is not null
        )
      )
    order by random()
    limit 1;
  end if;

  -- Salió Unown: la forma depende de la inicial del nombre del jugador (sin la forma, queda la 'a').
  if picked_unown_form is not null then
    select da.id
    into random_avatar_id
    from public.default_avatars da
    where da.unown_form = public.unown_form_for_name(v_display, v_username)
      and da.is_active = true
    limit 1;
    if random_avatar_id is null then
      select da.id into random_avatar_id
      from public.default_avatars da
      where da.unown_form = 'a' and da.is_active = true
      limit 1;
    end if;
  end if;

  new.rotated_avatar_id := random_avatar_id;
  return new;
end;
$$;

-- ===========================================================================
-- 6. RPCs del aviso (patrón de ack_gen3_unlock, 0143)
-- ===========================================================================
-- Devuelve a lo sumo UNA fila: el aviso sin ver más antiguo del usuario actual. Solo datos propios.
create or replace function public.get_my_special_unlock_notice()
returns table (role text, season_id uuid, workspace_id uuid, match_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  return query
  select x.r, x.s, x.w, x.m
  from (
    select 'winner'::text as r, u.season_id as s, u.workspace_id as w, u.match_id as m, u.created_at as c, u.id as i
    from public.season_special_unlocks u
    where u.winner_user_id = v_uid and u.winner_seen_at is null
    union all
    select 'loser'::text, u.season_id, u.workspace_id, u.match_id, u.created_at, u.id
    from public.season_special_unlocks u
    where u.loser_user_id = v_uid and u.loser_seen_at is null
  ) x
  order by x.c, x.i
  limit 1;
end;
$$;

-- Marca como visto el aviso que devolvería get_my_special_unlock_notice() (el más antiguo sin ver). No recibe usuario ni partida.
-- Devuelve true si marcó, false si no hizo nada (sin sesión o sin aviso pendiente).
create or replace function public.ack_special_unlock_notice()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_role text;
  v_rows integer;
begin
  if v_uid is null then
    return false;
  end if;

  select x.i, x.r into v_id, v_role
  from (
    select 'winner'::text as r, u.created_at as c, u.id as i
    from public.season_special_unlocks u
    where u.winner_user_id = v_uid and u.winner_seen_at is null
    union all
    select 'loser'::text, u.created_at, u.id
    from public.season_special_unlocks u
    where u.loser_user_id = v_uid and u.loser_seen_at is null
  ) x
  order by x.c, x.i
  limit 1;

  if v_id is null then
    return false;
  end if;

  if v_role = 'winner' then
    update public.season_special_unlocks
    set winner_seen_at = now()
    where id = v_id and winner_user_id = v_uid and winner_seen_at is null;
  else
    update public.season_special_unlocks
    set loser_seen_at = now()
    where id = v_id and loser_user_id = v_uid and loser_seen_at is null;
  end if;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ===========================================================================
-- 7. Permisos (estilo 0151: explícitos, sin depender de los privilegios por defecto)
-- ===========================================================================
revoke all on function public.special_match_threshold() from public, anon, authenticated;
revoke all on function public.special_match_stale_hours() from public, anon, authenticated;
revoke all on function public.special_ditto_avatar_id() from public, anon, authenticated;
revoke all on function public.special_unlock_evaluate(uuid, uuid) from public, anon, authenticated;
revoke all on function public.special_unlock_on_match() from public, anon, authenticated;
revoke all on function public.special_unlock_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.special_unlock_sweep() from public, anon, authenticated;
revoke all on function public.special_unlock_release_for_event(uuid) from public, anon, authenticated;
revoke all on function public.special_unlock_on_event_cancel() from public, anon, authenticated;
revoke all on function public.event_participants_guard_special_reward() from public, anon, authenticated;

revoke all on function public.get_my_special_unlock_notice() from public, anon;
revoke all on function public.ack_special_unlock_notice() from public, anon;
grant execute on function public.get_my_special_unlock_notice() to authenticated;
grant execute on function public.ack_special_unlock_notice() to authenticated;

-- ===========================================================================
-- 8. Verificación
-- ===========================================================================
do $verify$
begin
  if public.special_match_threshold() <> 420 then
    raise exception '0157: el umbral no es 420';
  end if;
  if not exists (select 1 from pg_class c where c.oid = 'public.season_special_unlocks'::regclass and c.relrowsecurity) then
    raise exception '0157: season_special_unlocks sin RLS';
  end if;
  if has_table_privilege('anon', 'public.season_special_unlocks', 'select')
     or has_table_privilege('authenticated', 'public.season_special_unlocks', 'select') then
    raise exception '0157: season_special_unlocks legible por anon/authenticated';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.matches'::regclass and tgname in ('special_unlock_matches_ins', 'special_unlock_matches_upd')) <> 2 then
    raise exception '0157: faltan los constraint triggers de matches';
  end if;
  if not has_function_privilege('authenticated', 'public.get_my_special_unlock_notice()', 'execute')
     or has_function_privilege('anon', 'public.get_my_special_unlock_notice()', 'execute')
     or has_function_privilege('authenticated', 'public.special_unlock_evaluate(uuid, uuid)', 'execute') then
    raise exception '0157: permisos de funciones incorrectos';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_participants' and column_name = 'special_reward') then
    raise exception '0157: falta event_participants.special_reward';
  end if;
  if has_column_privilege('authenticated', 'public.event_participants', 'special_reward', 'update')
     or has_column_privilege('authenticated', 'public.event_participants', 'special_reward', 'insert')
     or has_column_privilege('anon', 'public.event_participants', 'special_reward', 'update')
     or has_column_privilege('anon', 'public.event_participants', 'special_reward', 'insert') then
    raise exception '0157: special_reward escribible por anon/authenticated';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgname in ('special_unlock_event_cancel', 'event_participants_guard_special_reward')) <> 2 then
    raise exception '0157: faltan los triggers de cancelación o el guard de special_reward';
  end if;
  if has_function_privilege('authenticated', 'public.special_unlock_sweep()', 'execute')
     or has_function_privilege('anon', 'public.special_unlock_sweep()', 'execute') then
    raise exception '0157: special_unlock_sweep ejecutable por anon/authenticated';
  end if;
  raise notice '0157: desbloqueo especial listo (umbral=%, congelados=%, Ditto disponible=%)',
    public.special_match_threshold(),
    (select count(*) from public.season_special_unlocks),
    public.special_ditto_avatar_id() is not null;
end;
$verify$;
