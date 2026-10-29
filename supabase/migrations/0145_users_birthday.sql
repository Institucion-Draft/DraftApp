-- 0145_users_birthday.sql
-- Cumpleaños de cada jugador (users.birthday), cargado por el equipo y NO editable por el usuario, más el helper is_birthday().
-- Pensado para dinámicas que dependen del cumpleaños (por ejemplo, más chance de shiny jugando cerca del propio): esas reglas
-- se aplican en otra migración; ésta sólo deja el dato, su protección y el chequeo "¿es su cumpleaños?".
--
-- QUÉ HACE
--   1. users.birthday date (nullable). La columna YA EXISTE desde 0001 (nunca se usó: el campo vivo del alta es birth_date,
--      0015, que el propio usuario manda en el signup). Se declara con add column if not exists por si en algún entorno
--      faltara, y se le pone comment on column. NO se toca birth_date ni se copia nada de una a otra: birth_date lo escribe
--      el usuario, así que no sirve como fuente confiable para reglas de juego.
--   2. users_guard_birthday + trigger BEFORE INSERT OR UPDATE: users_update_own (0001) deja que cada usuario edite
--      cualquier columna de su fila, así que sin guard cualquiera podría ponerse el cumpleaños desde la app. Con
--      auth.role() = 'authenticated' o 'anon' (el rol del JWT de la request):
--        * UPDATE: new.birthday := old.birthday, en silencio (sin raise, para no romper updates de perfil que mandan la fila
--          completa).
--        * INSERT: new.birthday := null.
--      Con auth.role() null (SQL Editor, conexiones directas) o 'service_role' (scripts del equipo) el cambio pasa.
--      Ojo: auth.role() mira el JWT de la request, no el dueño de la función. Una RPC SECURITY DEFINER llamada por un usuario
--      sigue contando como 'authenticated' y NO puede cambiar la columna (a diferencia de users_guard_gen3_unlocked, 0142,
--      que usa current_user).
--   3. is_birthday(p_birthday, p_ref default current_date): true si coinciden día y mes. p_birthday null => false. Un 29 de
--      febrero cuenta como cumpleaños el 28 de febrero en los años no bisiestos (en los bisiestos, sólo el 29).
--      IMMUTABLE: el resultado depende sólo de los argumentos (current_date es el default, se evalúa en quien llama).
--
-- LECTURA: users_select_authenticated (0001) deja leer toda la tabla a cualquier authenticated, así que los demás miembros
-- ya pueden leer birthday con un select explícito (select('id, birthday')). No hace falta cambiar ninguna policy.
--
-- CÓMO CARGARLO (equipo): desde el SQL Editor, p. ej.  update public.users set birthday = '1990-05-17' where username = '...';
--
-- NO REEMPLAZA NINGÚN CUERPO DE FUNCIÓN EXISTENTE (sólo agrega).
--
-- OBJETOS NUEVOS: comment on users.birthday; funciones users_guard_birthday() e is_birthday(date, date); trigger
-- trg_users_guard_birthday (users).

-- ===========================================================================
-- 1. Columna
-- ===========================================================================
alter table public.users add column if not exists birthday date;

comment on column public.users.birthday is
  'Cumpleaños del jugador. Lo carga el equipo (hoy, a mano desde la base) o el alta (a futuro); el usuario NO puede editarlo: users_guard_birthday lo preserva en updates de la app y lo anula en inserts de la app.';

-- ===========================================================================
-- 2. Protección: sólo el equipo (SQL Editor / service_role) escribe la columna
-- ===========================================================================
create or replace function public.users_guard_birthday()
returns trigger
language plpgsql
as $$
begin
  if auth.role() in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.birthday := null;
    else
      new.birthday := old.birthday;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.users_guard_birthday() from public, anon, authenticated;

drop trigger if exists trg_users_guard_birthday on public.users;
create trigger trg_users_guard_birthday
  before insert or update on public.users
  for each row execute function public.users_guard_birthday();

-- ===========================================================================
-- 3. is_birthday
-- ===========================================================================
create or replace function public.is_birthday(p_birthday date, p_ref date default current_date)
returns boolean
language sql
immutable
as $$
  select case
    when p_birthday is null or p_ref is null then false
    -- 29 de febrero: en años no bisiestos se festeja el 28 de febrero.
    when extract(month from p_birthday) = 2 and extract(day from p_birthday) = 29
         and not (extract(year from p_ref)::integer % 4 = 0
                  and (extract(year from p_ref)::integer % 100 <> 0 or extract(year from p_ref)::integer % 400 = 0))
      then extract(month from p_ref) = 2 and extract(day from p_ref) = 28
    else extract(month from p_birthday) = extract(month from p_ref)
         and extract(day from p_birthday) = extract(day from p_ref)
  end
$$;

-- ===========================================================================
-- 4. Verificación
-- ===========================================================================
do $verify$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'users' and column_name = 'birthday'
                   and data_type = 'date' and is_nullable = 'YES') then
    raise exception '0145: falta users.birthday (date, nullable)';
  end if;
  if col_description('public.users'::regclass,
       (select attnum from pg_attribute where attrelid = 'public.users'::regclass and attname = 'birthday')) is null then
    raise exception '0145: falta el comment de users.birthday';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_users_guard_birthday' and tgrelid = 'public.users'::regclass and not tgisinternal) then
    raise exception '0145: falta el trigger trg_users_guard_birthday';
  end if;
  if public.is_birthday(null) or public.is_birthday(null, date '2024-05-01') then
    raise exception '0145: is_birthday(null) debería ser false';
  end if;
  if not public.is_birthday(date '1990-05-01', date '2024-05-01') or public.is_birthday(date '1990-05-01', date '2024-05-02') then
    raise exception '0145: is_birthday falla con una fecha común';
  end if;
  if not public.is_birthday(date '2000-02-29', date '2023-02-28')
     or public.is_birthday(date '2000-02-29', date '2023-03-01')
     or not public.is_birthday(date '2000-02-29', date '2024-02-29')
     or public.is_birthday(date '2000-02-29', date '2024-02-28') then
    raise exception '0145: is_birthday falla con el 29 de febrero';
  end if;
  if not public.is_birthday(date '2001-02-28', date '2023-02-28') then
    raise exception '0145: is_birthday falla con el 28 de febrero';
  end if;
  raise notice '0145: cumpleaños listo (usuarios con birthday cargado=%)', (select count(*) from public.users where birthday is not null);
end;
$verify$;
