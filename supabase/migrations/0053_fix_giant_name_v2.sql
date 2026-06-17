-- 0053_fix_giant_name_v2.sql
--
-- Recrea randomize_giant_pairs con formato de nombre Title Case:
--   primera letra mayúscula + resto minúsculas por miembro.
--   Ej: "Tox-Tes", no "TOX-TES". "Md" para un nombre corto "MD".
--
-- La fórmula es: upper(left(name,1)) || lower(substring(name,2,2))
-- que funciona sin relleno para nombres de 1 a n caracteres (left/substring
-- en PostgreSQL nunca agregan espacios ni underscores).
--
-- Re-incluye el coin flip de la migración 0052, para un solo punto de verdad.
-- re_randomize_giant_pairs llama a randomize_giant_pairs internamente, así que
-- hereda el fix sin cambios adicionales.

create or replace function public.randomize_giant_pairs(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_part_ids   uuid[];
  v_count      integer;
  v_a_id       uuid;
  v_b_id       uuid;
  v_a_user_id  uuid;
  v_b_user_id  uuid;
  v_a_name     text;
  v_b_name     text;
  v_is_shiny   boolean;
  v_avatar_id  uuid;
  v_giant_name text;
  i            integer;
begin
  -- Participantes elegibles: jugadores activos sin par asignado, en orden aleatorio.
  select array_agg(ep.id order by random())
  into v_part_ids
  from public.event_participants ep
  where ep.event_id        = p_event_id
    and ep.role            = 'player'
    and ep.member_b_user_id is null
    and ep.left_event_at   is null;

  v_count := coalesce(array_length(v_part_ids, 1), 0);

  if v_count % 2 <> 0 or v_count < 4 then
    raise exception 'INVALID_COUNT';
  end if;

  i := 1;
  while i <= v_count - 1 loop
    -- Coin flip: quien queda como A y quien como B es aleatorio dentro del par.
    if random() > 0.5 then
      v_a_id := v_part_ids[i];
      v_b_id := v_part_ids[i + 1];
    else
      v_a_id := v_part_ids[i + 1];
      v_b_id := v_part_ids[i];
    end if;

    -- Datos de miembro A.
    select ep.user_id,
           coalesce(u.display_name, u.username, 'UNK')
    into   v_a_user_id, v_a_name
    from   public.event_participants ep
    join   public.users u on u.id = ep.user_id
    where  ep.id = v_a_id;

    -- Datos de miembro B.
    select ep.user_id,
           coalesce(u.display_name, u.username, 'UNK')
    into   v_b_user_id, v_b_name
    from   public.event_participants ep
    join   public.users u on u.id = ep.user_id
    where  ep.id = v_b_id;

    -- Tirada de shiny para B (1/4096).
    v_is_shiny := (random() < (1.0 / 4096.0));

    -- Avatar aleatorio para B: excluir avatares ya usados como miembro A
    -- y como miembro B en iteraciones anteriores de este mismo sorteo.
    select id into v_avatar_id
    from   public.default_avatars
    where  is_active = true
      and  id not in (
             select rotated_avatar_id
             from   public.event_participants
             where  event_id = p_event_id
               and  rotated_avatar_id is not null
             union all
             select member_b_rotated_avatar_id
             from   public.event_participants
             where  event_id = p_event_id
               and  member_b_rotated_avatar_id is not null
           )
    order by random()
    limit 1;

    -- Nombre del gigante: primera letra mayúscula + resto minúsculas (máx 3 chars).
    -- upper(left(name,1)) || lower(substring(name,2,2)) nunca rellena con espacios
    -- ni underscores, incluso para nombres cortos como "MD" → "Md".
    v_giant_name := upper(left(v_a_name, 1)) || lower(substring(v_a_name, 2, 2))
                 || '-'
                 || upper(left(v_b_name, 1)) || lower(substring(v_b_name, 2, 2));

    -- Absorber B en la fila de A.
    update public.event_participants
    set member_b_user_id           = v_b_user_id,
        member_b_rotated_avatar_id = v_avatar_id,
        member_b_is_shiny          = v_is_shiny,
        giant_name                 = v_giant_name
    where id = v_a_id;

    -- Eliminar la fila de B (on delete cascade limpia participant_colors de B).
    delete from public.event_participants where id = v_b_id;

    i := i + 2;
  end loop;

  update public.draft_events
  set giant_randomization_done = true
  where id = p_event_id;
end;
$$;
