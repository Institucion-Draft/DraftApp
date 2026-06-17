-- 0051_two_headed_giant.sql
--
-- Soporte para el formato Two-Headed Giant: dos jugadores forman un gigante
-- que compite como una sola unidad en un evento de parejas.
--
-- Modelo:
--   - Cada gigante tiene UNA fila en event_participants ("miembro A").
--   - El miembro B queda absorbido en esa fila (member_b_user_id, avatares, etc.)
--   - La función randomize_giant_pairs() hace el emparejamiento aleatorio
--     y elimina las filas sobrantes de los miembros B.
--   - re_randomize_giant_pairs() revierte y vuelve a sortear (solo antes del draft).
--   - participant_colors agrega la columna member ('a'|'b') para distinguir
--     qué colores declaró cada integrante del gigante.

-- ===========================================================================
-- 1. event_participants: columnas para miembro B y nombre del gigante
-- ===========================================================================
alter table public.event_participants
  add column if not exists member_b_user_id           uuid references public.users(id),
  add column if not exists member_b_rotated_avatar_id uuid references public.default_avatars(id),
  add column if not exists member_b_is_shiny          boolean not null default false,
  add column if not exists giant_name                 text;

-- ===========================================================================
-- 2. draft_events: flag para saber si el sorteo de gigantes ya se hizo
-- ===========================================================================
alter table public.draft_events
  add column if not exists giant_randomization_done boolean not null default false;

-- ===========================================================================
-- 3. participant_colors: columna member + reemplazo del unique
-- ===========================================================================
alter table public.participant_colors
  add column if not exists member text not null default 'a'
    check (member in ('a', 'b'));

-- Eliminar el unique viejo (participant_id, color) y crear uno que incluya member.
-- Las filas existentes quedan con member='a', por lo que no hay conflictos.
alter table public.participant_colors
  drop constraint if exists participant_colors_participant_id_color_key;

alter table public.participant_colors
  add constraint participant_colors_participant_id_color_member_key
    unique (participant_id, color, member);

-- ===========================================================================
-- 4. RPC randomize_giant_pairs(p_event_id uuid)
--
-- Empareja aleatoriamente los participantes del evento de a dos:
--   - el primero del par queda como "miembro A" (fila existente, se actualiza),
--   - el segundo queda como "miembro B" (sus datos pasan a A, su fila se borra).
-- Requisito: count par y >= 4, todos sin member_b_user_id seteado todavía.
-- ===========================================================================
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
  where ep.event_id     = p_event_id
    and ep.role         = 'player'
    and ep.member_b_user_id is null
    and ep.left_event_at    is null;

  v_count := coalesce(array_length(v_part_ids, 1), 0);

  if v_count % 2 <> 0 or v_count < 4 then
    raise exception 'INVALID_COUNT';
  end if;

  i := 1;
  while i <= v_count - 1 loop
    v_a_id := v_part_ids[i];
    v_b_id := v_part_ids[i + 1];

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

    -- Nombre del gigante: primeras 3 letras de cada nombre, en mayúsculas.
    v_giant_name := upper(left(v_a_name, 3)) || '-' || upper(left(v_b_name, 3));

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

-- ===========================================================================
-- 5. RPC re_randomize_giant_pairs(p_event_id uuid)
--
-- Revierte el sorteo anterior y hace uno nuevo.
-- Solo permitido si giant_randomization_done = true y draft_started_at IS NULL.
-- ===========================================================================
create or replace function public.re_randomize_giant_pairs(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_done       boolean;
  v_started_at timestamptz;
  v_rec        record;
begin
  select giant_randomization_done, draft_started_at
  into   v_done, v_started_at
  from   public.draft_events
  where  id = p_event_id;

  if not coalesce(v_done, false) then
    raise exception 'RANDOMIZATION_NOT_DONE';
  end if;

  if v_started_at is not null then
    raise exception 'DRAFT_ALREADY_STARTED';
  end if;

  -- Para cada gigante: re-insertar B como participante independiente y limpiar A.
  -- El trigger assign_rotated_avatar le asignará a B su avatar del histórico
  -- (o uno nuevo si no tiene), de forma transitoria — randomize lo absorberá.
  for v_rec in
    select id, member_b_user_id
    from   public.event_participants
    where  event_id = p_event_id
      and  member_b_user_id is not null
  loop
    insert into public.event_participants (event_id, user_id, role)
    values (p_event_id, v_rec.member_b_user_id, 'player');

    update public.event_participants
    set member_b_user_id           = null,
        member_b_rotated_avatar_id = null,
        member_b_is_shiny          = false,
        giant_name                 = null
    where id = v_rec.id;
  end loop;

  -- Limpiar colores declarados del miembro B (chekin de gigantes previo).
  delete from public.participant_colors
  where  participant_id in (
           select id from public.event_participants where event_id = p_event_id
         )
    and  member = 'b';

  -- Nuevo sorteo aleatorio.
  perform public.randomize_giant_pairs(p_event_id);
end;
$$;
