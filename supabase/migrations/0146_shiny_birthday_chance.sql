-- 0146_shiny_birthday_chance.sql
-- Más chance de shiny al inscribirse cerca del cumpleaños del jugador (users.birthday, 0145).
--
-- REGLAS (todas con días calendario de America/Argentina/Buenos_Aires, no UTC)
--   * El día de la inscripción es su cumpleaños (is_birthday, 0145):               50 %.
--   * Si no, y la fecha del evento (draft_events.scheduled_for) cae a ±3 días
--     de su cumpleaños (el día mismo incluido):                                    30 %.
--   * Si no (o sin birthday cargado): la chance basal de siempre, 1/4096.
--   Los 3 días se cuentan con vuelta de año (cumple el 1/1, evento el 30/12) y con la regla del 29/2 (en años no bisiestos se
--   festeja el 28/2). Sin efecto retroactivo: la chance se evalúa al insertar la inscripción, así que sólo afecta inscripciones
--   nuevas; las existentes conservan su is_shiny. Reinscribirse en el mismo evento NO vuelve a tirar: el histórico
--   (event_participant_avatar_history, 0017/0044) devuelve el mismo avatar y el mismo shiny.
--   Ojo: si el evento cae EL DÍA del cumpleaños pero la inscripción es otro día, la chance es 30 % (el 50 % es sólo por el día
--   de la inscripción).
--
-- QUÉ HACE
--   1. Constantes (funciones IMMUTABLE sin argumentos, arriba de todo): shiny_chance_basal_pct (100/4096),
--      shiny_chance_birthday_pct (50), shiny_chance_near_birthday_pct (30) y shiny_birthday_window_days (3).
--   2. birthday_within_days(p_birthday, p_ref, p_days): true si p_ref está a p_days o menos de algún cumpleaños (el del año
--      anterior, el del año y el del siguiente, para la vuelta de año). IMMUTABLE.
--   3. shiny_chance_for(p_user_id, p_event_date, p_ref_day): devuelve el PORCENTAJE (0-100) según las reglas de arriba.
--      Determinística: sólo depende de los argumentos y de users.birthday (STABLE). p_event_date null => se usa p_ref_day.
--      Lee el birthday del usuario y delega la regla en shiny_chance_for_birthday(p_birthday, ...), la versión pura
--      (IMMUTABLE) que se prueba con casos fijos en la verificación sin tocar datos.
--   4. assign_rotated_avatar: igual a 0142 salvo la tirada de shiny, que pasa de random() < 1/4096 a
--      random() < shiny_chance_for(...) / 100.
--
-- OTRAS RUTAS QUE TIRAN SHINY (no se tocan): randomize_giant_pairs (2HG, 0055) conserva el shiny que B ya traía de su propia
-- inscripción (que sí pasó por assign_rotated_avatar, con el boost); sólo si B no tuviera avatar (caso borde) tira 1/4096 fijo.
-- re_randomize_giant_pairs (0051) reinserta a B: el trigger le devuelve su avatar y shiny del histórico, sin tirar de nuevo.
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   assign_rotated_avatar   f25808420224d37b82f86add211c3f68  (2628 caracteres con LF)  [0142]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'public'::regnamespace and proname = 'assign_rotated_avatar';
--
-- Depende de is_birthday (0145). OBJETOS NUEVOS: shiny_chance_basal_pct, shiny_chance_birthday_pct,
-- shiny_chance_near_birthday_pct, shiny_birthday_window_days, birthday_within_days, shiny_chance_for_birthday,
-- shiny_chance_for.

-- ===========================================================================
-- 1. Constantes
-- ===========================================================================
create or replace function public.shiny_chance_basal_pct()
returns numeric language sql immutable as $$ select 100.0 / 4096.0 $$;

create or replace function public.shiny_chance_birthday_pct()
returns numeric language sql immutable as $$ select 50.0 $$;

create or replace function public.shiny_chance_near_birthday_pct()
returns numeric language sql immutable as $$ select 30.0 $$;

create or replace function public.shiny_birthday_window_days()
returns integer language sql immutable as $$ select 3 $$;

-- ===========================================================================
-- 2. birthday_within_days
-- ===========================================================================
create or replace function public.birthday_within_days(p_birthday date, p_ref date, p_days integer)
returns boolean
language sql
immutable
as $$
  select coalesce(
    (
      select bool_or(abs(c.celebration - p_ref) <= p_days)
      from (
        -- El cumpleaños del año anterior, del año de p_ref y del siguiente (cubre la vuelta de año).
        -- 29/2 en año no bisiesto se festeja el 28/2.
        select make_date(
                 y.y,
                 b.m,
                 case when b.m = 2 and b.d = 29
                           and not (y.y % 4 = 0 and (y.y % 100 <> 0 or y.y % 400 = 0))
                      then 28 else b.d end
               ) as celebration
        from generate_series(extract(year from p_ref)::integer - 1, extract(year from p_ref)::integer + 1) as y(y),
             (select extract(month from p_birthday)::integer as m, extract(day from p_birthday)::integer as d) as b
      ) c
    ),
    false
  )
$$;

-- ===========================================================================
-- 3. shiny_chance_for_birthday / shiny_chance_for
-- ===========================================================================
create or replace function public.shiny_chance_for_birthday(p_birthday date, p_event_date date, p_ref_day date)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_birthday is not null then
    if public.is_birthday(p_birthday, p_ref_day) then
      return public.shiny_chance_birthday_pct();
    end if;
    if public.birthday_within_days(p_birthday, coalesce(p_event_date, p_ref_day), public.shiny_birthday_window_days()) then
      return public.shiny_chance_near_birthday_pct();
    end if;
  end if;

  return public.shiny_chance_basal_pct();
end;
$$;

create or replace function public.shiny_chance_for(p_user_id uuid, p_event_date date, p_ref_day date)
returns numeric
language sql
stable
as $$
  select public.shiny_chance_for_birthday(
    (select u.birthday from public.users u where u.id = p_user_id),
    p_event_date,
    p_ref_day
  )
$$;

-- ===========================================================================
-- 4. assign_rotated_avatar (cuerpo de 0142; sólo cambia la tirada de shiny)
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
begin
  select (u.custom_avatar_path is not null),
         (u.gen3_unlocked_at is not null),
         u.display_name,
         u.username
  into user_has_custom, gen3_ok, v_display, v_username
  from public.users u
  where u.id = new.user_id;

  if user_has_custom then
    return new;
  end if;

  select rotated_avatar_id, is_shiny
  into historical_avatar_id, historical_is_shiny
  from public.event_participant_avatar_history
  where user_id = new.user_id
    and event_id = new.event_id;

  if historical_avatar_id is not null then
    new.rotated_avatar_id := historical_avatar_id;
    new.is_shiny := coalesce(historical_is_shiny, false);
    return new;
  end if;

  -- Shiny antes de elegir qué Pokémon: chance basal, o más si es el cumpleaños del jugador o el evento cae cerca de él.
  v_today := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  select (de.scheduled_for at time zone 'America/Argentina/Buenos_Aires')::date
  into v_event_date
  from public.draft_events de
  where de.id = new.event_id;
  new.is_shiny := (random() < public.shiny_chance_for(new.user_id, v_event_date, v_today) / 100.0);

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
-- 5. Verificación
-- ===========================================================================
do $verify$
declare
  v_basal numeric := public.shiny_chance_basal_pct();
  v_user uuid;
begin
  -- birthday_within_days (±3, inclusive, vuelta de año y 29/2)
  if not public.birthday_within_days(date '1990-05-17', date '2024-05-17', 3)
     or not public.birthday_within_days(date '1990-05-17', date '2024-05-14', 3)
     or not public.birthday_within_days(date '1990-05-17', date '2024-05-20', 3)
     or public.birthday_within_days(date '1990-05-17', date '2024-05-13', 3)
     or public.birthday_within_days(date '1990-05-17', date '2024-05-21', 3) then
    raise exception '0146: birthday_within_days falla con una fecha común';
  end if;
  if not public.birthday_within_days(date '1990-01-01', date '2024-12-30', 3)
     or not public.birthday_within_days(date '1990-12-31', date '2025-01-02', 3)
     or public.birthday_within_days(date '1990-01-01', date '2024-12-28', 3) then
    raise exception '0146: birthday_within_days falla con la vuelta de año';
  end if;
  if not public.birthday_within_days(date '2000-02-29', date '2023-03-03', 3)
     or public.birthday_within_days(date '2000-02-29', date '2023-03-04', 3)
     or not public.birthday_within_days(date '2000-02-29', date '2024-03-03', 3)
     or public.birthday_within_days(date '2000-02-29', date '2024-03-04', 3) then
    raise exception '0146: birthday_within_days falla con el 29 de febrero';
  end if;
  if public.birthday_within_days(null, date '2024-05-17', 3) or public.birthday_within_days(date '1990-05-17', null, 3) then
    raise exception '0146: birthday_within_days con null debería ser false';
  end if;

  -- shiny_chance_for_birthday (la regla de shiny_chance_for): args = (birthday, fecha del evento, día de la inscripción)
  -- el día del cumpleaños (aunque el evento sea otro día)
  if public.shiny_chance_for_birthday(date '1990-05-17', date '2024-06-30', date '2024-05-17') <> 50
     or public.shiny_chance_for_birthday(date '1990-05-17', date '2024-06-30', date '2025-05-17') <> 50 then
    raise exception '0146: falla el día del cumpleaños';
  end if;
  -- 3 días antes y 3 días después (por fecha del evento), y el día mismo del evento si se inscribió otro día
  if public.shiny_chance_for_birthday(date '1990-05-17', date '2024-05-14', date '2024-04-01') <> 30
     or public.shiny_chance_for_birthday(date '1990-05-17', date '2024-05-20', date '2024-04-01') <> 30
     or public.shiny_chance_for_birthday(date '1990-05-17', date '2024-05-17', date '2024-04-01') <> 30 then
    raise exception '0146: falla a ±3 días';
  end if;
  -- 4 días antes y 4 días después: basal
  if public.shiny_chance_for_birthday(date '1990-05-17', date '2024-05-13', date '2024-04-01') <> v_basal
     or public.shiny_chance_for_birthday(date '1990-05-17', date '2024-05-21', date '2024-04-01') <> v_basal then
    raise exception '0146: falla a 4 días';
  end if;
  -- sin fecha de evento: se usa el día de la inscripción
  if public.shiny_chance_for_birthday(date '1990-05-17', null, date '2024-05-15') <> 30 then
    raise exception '0146: sin fecha de evento debería usar el día de la inscripción';
  end if;
  -- cumpleaños a fin de año con evento a principios del siguiente, y al revés
  if public.shiny_chance_for_birthday(date '1990-12-31', date '2025-01-02', date '2024-10-01') <> 30
     or public.shiny_chance_for_birthday(date '1990-01-01', date '2024-12-30', date '2024-10-01') <> 30
     or public.shiny_chance_for_birthday(date '1990-12-31', date '2025-01-04', date '2024-10-01') <> v_basal then
    raise exception '0146: falla con la vuelta de año';
  end if;
  -- 29/2: se festeja el 28/2 en años no bisiestos (50 %), y el 29/2 en bisiestos
  if public.shiny_chance_for_birthday(date '2000-02-29', date '2024-06-30', date '2023-02-28') <> 50
     or public.shiny_chance_for_birthday(date '2000-02-29', date '2023-03-01', date '2023-03-01') <> 30
     or public.shiny_chance_for_birthday(date '2000-02-29', date '2024-06-30', date '2024-02-29') <> 50
     or public.shiny_chance_for_birthday(date '2000-02-29', date '2024-02-28', date '2024-02-28') <> 30
     or public.shiny_chance_for_birthday(date '2000-02-29', date '2023-03-03', date '2023-01-10') <> 30
     or public.shiny_chance_for_birthday(date '2000-02-29', date '2023-03-04', date '2023-01-10') <> v_basal then
    raise exception '0146: falla con el 29 de febrero';
  end if;
  -- sin birthday
  if public.shiny_chance_for_birthday(null, date '2024-05-17', date '2024-05-17') <> v_basal then
    raise exception '0146: sin birthday debería dar la chance basal';
  end if;

  -- shiny_chance_for (con lectura de users): usuario inexistente y, si hay, uno sin birthday cargado
  if public.shiny_chance_for(gen_random_uuid(), date '2024-05-17', date '2024-05-17') <> v_basal then
    raise exception '0146: shiny_chance_for con un usuario inexistente debería dar la chance basal';
  end if;
  select u.id into v_user from public.users u where u.birthday is null limit 1;
  if v_user is not null and public.shiny_chance_for(v_user, date '2024-05-17', date '2024-05-17') <> v_basal then
    raise exception '0146: shiny_chance_for con un usuario sin birthday debería dar la chance basal';
  end if;

  if v_basal <> 100.0 / 4096.0 then
    raise exception '0146: la chance basal cambió';
  end if;
  raise notice '0146: chance de shiny por cumpleaños lista (basal=% %%, cumpleaños=% %%, ±% días=% %%)',
    v_basal, public.shiny_chance_birthday_pct(), public.shiny_birthday_window_days(), public.shiny_chance_near_birthday_pct();
end;
$verify$;
