-- =====================================================================
-- Migration 0006: display_name desde email al registrar; backfill user_*
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  random_avatar_id uuid;
  generated_username text;
  meta_display text;
  email_local text;
  chosen_display text;
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

  insert into public.users (id, username, display_name, default_avatar_id)
  values (
    new.id,
    generated_username,
    chosen_display,
    random_avatar_id
  );

  return new;
end;
$$;

-- Usuarios existentes con display_name autogenerado tipo user_xxxxxxxxxxxx → prefijo del email
update public.users u
set display_name = left(trim(split_part(au.email, '@', 1)), 200)
from auth.users au
where u.id = au.id
  and au.email is not null
  and position('@' in au.email) > 1
  and length(trim(split_part(au.email, '@', 1))) > 0
  and u.display_name ~ '^user_[a-f0-9]{12}$';

-- =====================================================================
-- FIN
-- =====================================================================
