-- 0015_user_gender_and_birth_date.sql
-- Agrega columnas gender y birth_date a public.users.
-- Extiende handle_new_user para que tome estos campos del raw_user_meta_data
-- enviado durante el signup.
-- Hace backfill de los usuarios existentes:
--   - Karen → 'female'
--   - Resto → 'male'
-- Cuentas de test sin asignación específica quedan con default 'prefer_not_to_say'
-- para usuarios futuros sin metadata.

-- 1. Columnas nuevas
alter table public.users
  add column if not exists gender text not null default 'prefer_not_to_say'
    check (gender in ('male', 'female', 'other', 'prefer_not_to_say')),
  add column if not exists birth_date date;

-- 2. Backfill: Karen femenino, el resto masculino
update public.users
set gender = 'female'
where lower(display_name) = 'karen';

update public.users
set gender = 'male'
where gender = 'prefer_not_to_say'
  and lower(display_name) <> 'karen';

-- 3. Reescribir handle_new_user para que lea gender y birth_date del metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $function$
declare
  random_avatar_id uuid;
  generated_username text;
  meta_display text;
  email_local text;
  chosen_display text;
  meta_gender text;
  chosen_gender text;
  meta_birth_date date;
begin
  select id into random_avatar_id
  from public.default_avatars
  where is_active = true
  order by random()
  limit 1;

  generated_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);

  meta_display := nullif(
    trim(
      coalesce(
        new.raw_user_meta_data->>'display_name',
        new.raw_user_meta_data->>'full_name',
        ''
      )
    ),
    ''
  );
  if meta_display is not null then
    chosen_display := meta_display;
  elsif new.email is not null and position('@' in new.email) > 1 then
    email_local := trim(split_part(new.email, '@', 1));
    if length(email_local) > 0 then
      chosen_display := email_local;
    else
      chosen_display := generated_username;
    end if;
  else
    chosen_display := generated_username;
  end if;

  -- Resolver gender desde metadata, validar que sea uno de los valores permitidos
  meta_gender := nullif(trim(coalesce(new.raw_user_meta_data->>'gender', '')), '');
  if meta_gender in ('male', 'female', 'other', 'prefer_not_to_say') then
    chosen_gender := meta_gender;
  else
    chosen_gender := 'prefer_not_to_say';
  end if;

  -- Resolver birth_date desde metadata
  begin
    meta_birth_date := (new.raw_user_meta_data->>'birth_date')::date;
  exception when others then
    meta_birth_date := null;
  end;

  insert into public.users (id, username, display_name, default_avatar_id, gender, birth_date)
  values (
    new.id,
    generated_username,
    chosen_display,
    random_avatar_id,
    chosen_gender,
    meta_birth_date
  );

  return new;
end;
$function$;
