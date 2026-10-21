-- 0143_gen3_unlock_notice.sql
-- Aviso de una sola vez cuando el jugador desbloquea la Gen 3 (users.gen3_unlocked_at, 0142).
--
-- QUÉ HACE
--   1. users.gen3_unlock_seen_at: cuándo el jugador vio el aviso. null = todavía no lo vio.
--   2. ack_gen3_unlock(): RPC SECURITY DEFINER sin parámetros que setea gen3_unlock_seen_at = now() para auth.uid() SOLO si
--      gen3_unlocked_at no es null y seen_at es null. No recibe un usuario: no puede marcar a otro. Devuelve true si
--      marcó, false si no hizo nada (sin sesión, sin desbloqueo o ya visto). Ejecutable sólo por authenticated.
--   3. users_guard_gen3_unlocked: ahora protege también gen3_unlock_seen_at. users_update_own deja que cada usuario
--      edite cualquier columna de su fila, así que sin el guard cualquiera podría escribir el "visto" por fuera de
--      la RPC (o borrarlo para volver a ver el aviso). Sólo funciones del sistema (la RPC) lo escriben.
--   4. Sin backfill: quien ya esté desbloqueado al aplicar esta migración tiene seen_at = null y VE el aviso.
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   users_guard_gen3_unlocked   27ec065a7101b2649c845f4cec6954df  (226 caracteres con LF; con CRLF: 732bfcd640941ff0e8472597290b2995, 237)  [0142]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'users_guard_gen3_unlocked';
--
-- OBJETOS NUEVOS: users.gen3_unlock_seen_at; función ack_gen3_unlock().

alter table public.users add column if not exists gen3_unlock_seen_at timestamptz;

create or replace function public.users_guard_gen3_unlocked()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.gen3_unlocked_at := null;
      new.gen3_unlock_seen_at := null;
    else
      new.gen3_unlocked_at := old.gen3_unlocked_at;
      new.gen3_unlock_seen_at := old.gen3_unlock_seen_at;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.ack_gen3_unlock()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_rows integer;
begin
  if v_uid is null then
    return false;
  end if;

  update public.users
  set gen3_unlock_seen_at = now()
  where id = v_uid
    and gen3_unlocked_at is not null
    and gen3_unlock_seen_at is null;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.ack_gen3_unlock() from public, anon;
grant execute on function public.ack_gen3_unlock() to authenticated;

-- Verificación
do $verify$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'gen3_unlock_seen_at'
  ) then
    raise exception '0143: falta users.gen3_unlock_seen_at';
  end if;
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ack_gen3_unlock') then
    raise exception '0143: falta ack_gen3_unlock()';
  end if;
  if exists (select 1 from public.users where gen3_unlock_seen_at is not null and gen3_unlocked_at is null) then
    raise exception '0143: hay usuarios con aviso visto y sin desbloqueo';
  end if;
  raise notice '0143: desbloqueados que verán el aviso=%, ya vistos=%',
    (select count(*) from public.users where gen3_unlocked_at is not null and gen3_unlock_seen_at is null),
    (select count(*) from public.users where gen3_unlock_seen_at is not null);
end;
$verify$;
