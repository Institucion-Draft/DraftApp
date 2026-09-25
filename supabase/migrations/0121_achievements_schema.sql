-- 0121_achievements_schema.sql
-- Sistema de logros de temporada, parte 1/4: esquema, RLS, definiciones y funciones base.
--
-- Diseño (ver conversación de diseño): un único evaluador idempotente por evento
-- (evaluate_achievements, en 0123) que revisa el ESTADO actual del evento; se engancha con
-- constraint triggers diferidos que solo encolan el event_id (0124). Cada logro se otorga una
-- sola vez por (workspace, temporada, usuario) — unique + ON CONFLICT DO NOTHING — así que
-- reevaluar de más es inofensivo.
--
-- Alcance temporal: solo eventos con draft_started_at dentro de la temporada 21-sep-2026 a
-- 20-dic-2026 (hora de Buenos Aires). Nada retroactivo. achievement_window() es el ÚNICO lugar
-- donde vive ese rango; para habilitar otra temporada se redefine esa función.
--
-- Seguridad: las tablas nuevas solo se leen desde el cliente. Toda escritura pasa por funciones
-- security definer; las funciones internas (grant/evaluate/achv_*) NO son ejecutables por
-- anon/authenticated (si no, cualquiera podría otorgarse un logro vía RPC).

-- ===========================================================================
-- 1. Tablas
-- ===========================================================================
create table public.achievement_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null,
  icon_slot smallint not null check (icon_slot between 1 and 10),
  sort_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.achievement_unlocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  achievement_id uuid not null references public.achievement_definitions(id),
  -- Evento que disparó el desbloqueo. on delete set null: si el evento se borra de verdad, el
  -- logro se conserva (los eventos normalmente se borran con soft-delete, deleted_at).
  source_event_id uuid references public.draft_events(id) on delete set null,
  source_ref jsonb not null default '{}'::jsonb,
  unlocked_at timestamptz not null default now(),
  seen_at timestamptz,
  constraint achievement_unlocks_unique unique (workspace_id, season_id, user_id, achievement_id)
);

create index idx_achievement_unlocks_user_season on public.achievement_unlocks (user_id, season_id);
create index idx_achievement_unlocks_unseen on public.achievement_unlocks (user_id, season_id) where seen_at is null;
create index idx_achievement_unlocks_event on public.achievement_unlocks (source_event_id);

-- Indicador de "no visto" de la bitácora de evento (visible para todos los inscriptos, no solo
-- para quien ganó el logro): cuándo abrió cada usuario la bitácora de cada evento.
create table public.event_diary_seen (
  user_id uuid not null references public.users(id) on delete cascade,
  event_id uuid not null references public.draft_events(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

-- Cola de eventos a evaluar (la llenan los constraint triggers de 0124; la drena el trigger
-- diferido de la propia cola). Sin acceso desde el cliente.
create table public.achievement_eval_queue (
  event_id uuid primary key,
  enqueued_at timestamptz not null default now()
);

-- Fallos de evaluación (un logro que falla no aborta la transacción del partido/pairing que lo
-- disparó: se registra acá). Sin acceso desde el cliente.
create table public.achievement_eval_errors (
  id bigint generated always as identity primary key,
  event_id uuid,
  code text,
  sqlstate text,
  message text,
  created_at timestamptz not null default now()
);

-- ===========================================================================
-- 2. RLS
-- ===========================================================================
alter table public.achievement_definitions enable row level security;
alter table public.achievement_unlocks enable row level security;
alter table public.event_diary_seen enable row level security;
alter table public.achievement_eval_queue enable row level security;
alter table public.achievement_eval_errors enable row level security;

create policy "achievement_definitions_select"
  on public.achievement_definitions for select to authenticated
  using (true);

create policy "achievement_unlocks_select_workspace_members"
  on public.achievement_unlocks for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "event_diary_seen_select_workspace_members"
  on public.event_diary_seen for select to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_diary_seen.event_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

-- Sin policies de escritura en ninguna: solo funciones security definer escriben.
-- achievement_eval_queue / achievement_eval_errors: RLS activo sin policies = sin acceso.

grant select on public.achievement_definitions to authenticated;
grant select on public.achievement_unlocks to authenticated;
grant select on public.event_diary_seen to authenticated;

-- ===========================================================================
-- 3. Definiciones de los 15 logros (metadata de visualización; la lógica está en achv_eval_<code>)
-- ===========================================================================
insert into public.achievement_definitions (code, name, description, icon_slot, sort_order) values
  ('plaga', 'El Plaga',
   'Le cortaste el invicto a alguien en la fase regular: su única derrota fue contra vos.', 1, 1),
  ('super_plaga', 'El Super-Plaga',
   'Le cortaste el invicto a alguien en su último enfrentamiento de la fase regular: era su única derrota.', 2, 2),
  ('dalo_vuelta', 'Dalo vuelta!',
   'Ganaste un BO3 después de perder la primera partida.', 3, 3),
  ('remontada_providencial', 'Remontada providencial!',
   'Diste vuelta un BO3 que definía el 1er puesto del evento.', 4, 4),
  ('por_la_ventana', 'Por la ventana',
   'Ganaste el desempate por el 4to puesto y te colaste en el top 4.', 5, 5),
  ('ventana_puerta_grande', 'De la ventana a la puerta grande',
   'Ganaste el desempate por el 4to puesto y terminaste campeón del mismo evento.', 6, 6),
  ('duro_de_matar', 'Duro de matar',
   'Completaste toda la fase regular de un round-robin con top 4 sin perder ningún enfrentamiento.', 7, 7),
  ('merecido', 'Merecido?',
   'Ganaste un enfrentamiento en curso porque tu rival abandonó el evento.', 8, 8),
  ('largar_el_blanco', 'Largá el blanco',
   'Ganaste una partida por 50 o más puntos de vida de diferencia.', 9, 9),
  ('bancame_un_toque', 'Bancame un toque?',
   'Jugaste una partida de más de 60 minutos.', 10, 10),
  ('sospechoso', 'Sospechoso',
   'Te tocó 5 veces el mismo tipo de Pokémon como avatar de evento en la temporada.', 1, 11),
  ('tiempo_de_reflexionar', 'Tiempo de reflexionar',
   'Perdiste todos los enfrentamientos que disputaste en un evento.', 2, 12),
  ('buen_companero', 'Buen compañero',
   'Compartiste el 2do o 3er puesto de un round-robin sin top 4.', 3, 13),
  ('fanatico_del_registro', 'Fanático del registro',
   'Escribiste 10 entradas de bitácora de evento en la temporada.', 4, 14),
  ('invicto', 'Invicto',
   'Ganaste todas las partidas que jugaste en un evento.', 5, 15);

-- ===========================================================================
-- 4. Funciones base
-- ===========================================================================

-- Rango de draft_started_at que evalúa el sistema: [21-sep-2026 00:00, 21-dic-2026 00:00) hora de
-- Buenos Aires (o sea, hasta el 20-dic-2026 inclusive). ÚNICO lugar donde vive el rango.
create or replace function public.achievement_window()
returns tstzrange
language sql
stable
as $$
  select tstzrange(
    timestamp '2026-09-21 00:00:00' at time zone 'America/Argentina/Buenos_Aires',
    timestamp '2026-12-21 00:00:00' at time zone 'America/Argentina/Buenos_Aires',
    '[)'
  );
$$;

-- Exclusión global, centralizada: ningún logro se evalúa ni se otorga para un evento que no la
-- cumpla (sandbox, 2HG, eliminado, cancelado, o fuera de la temporada).
create or replace function public.achievement_event_eligible(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.draft_events de
    where de.id = p_event_id
      and de.is_official = true
      and de.event_type <> 'two_headed_giant'
      and de.deleted_at is null
      and de.status <> 'cancelled'
      and de.draft_started_at is not null
      and public.achievement_window() @> de.draft_started_at
  );
$$;

-- Temporada del evento según v_event_season (por draft_started_at), no la fecha del desbloqueo.
-- Si la fila de temporada todavía no existe la crea (ensure_workspace_seasons es idempotente).
create or replace function public.achievement_event_season(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season uuid;
  v_ws uuid;
begin
  select season_id, workspace_id into v_season, v_ws
  from public.v_event_season where event_id = p_event_id;

  if v_season is null and v_ws is not null then
    perform public.ensure_workspace_seasons(v_ws);
    select season_id into v_season from public.v_event_season where event_id = p_event_id;
  end if;

  return v_season;
end;
$$;

-- Otorga un logro. Revalida la exclusión global (defensa en profundidad: los evaluadores ya
-- entran por achievement_event_eligible, pero este es el único camino de escritura). Devuelve
-- true solo si el desbloqueo es nuevo.
create or replace function public.grant_achievement(
  p_code text,
  p_user_id uuid,
  p_event_id uuid,
  p_ref jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_season uuid;
  v_ach uuid;
  v_rows integer;
begin
  if p_user_id is null or p_event_id is null then
    return false;
  end if;

  if not public.achievement_event_eligible(p_event_id) then
    return false;
  end if;

  -- Solo puede ganar un logro quien participó del evento.
  if not exists (
    select 1 from public.event_participants ep
    where ep.event_id = p_event_id and ep.user_id = p_user_id
  ) then
    return false;
  end if;

  select workspace_id into v_ws from public.draft_events where id = p_event_id;
  v_season := public.achievement_event_season(p_event_id);
  if v_season is null then
    return false;
  end if;

  select id into v_ach from public.achievement_definitions where code = p_code and is_active;
  if v_ach is null then
    return false;
  end if;

  insert into public.achievement_unlocks
    (workspace_id, season_id, user_id, achievement_id, source_event_id, source_ref)
  values
    (v_ws, v_season, p_user_id, v_ach, p_event_id, coalesce(p_ref, '{}'::jsonb))
  on conflict (workspace_id, season_id, user_id, achievement_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Marca como vistos los logros del usuario en una temporada (lo llama el cliente al abrir la
-- pantalla de Logros).
create or replace function public.mark_achievements_seen(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  update public.achievement_unlocks
  set seen_at = now()
  where user_id = auth.uid()
    and season_id = p_season_id
    and seen_at is null;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Marca la bitácora de un evento como vista por el usuario (lo llama el cliente al abrirla).
-- Solo si el usuario es miembro del workspace del evento.
create or replace function public.mark_event_diary_seen(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  select workspace_id into v_ws from public.draft_events where id = p_event_id;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'Sin permiso';
  end if;

  insert into public.event_diary_seen (user_id, event_id, last_seen_at)
  values (auth.uid(), p_event_id, now())
  on conflict (user_id, event_id) do update set last_seen_at = excluded.last_seen_at;
end;
$$;

-- ===========================================================================
-- 5. Permisos de ejecución
-- ===========================================================================
-- Internas: nadie del cliente las ejecuta. (Las llaman otras funciones security definer y los
-- triggers, que corren con los privilegios del dueño.)
revoke execute on function public.achievement_window() from public, anon, authenticated;
revoke execute on function public.achievement_event_eligible(uuid) from public, anon, authenticated;
revoke execute on function public.achievement_event_season(uuid) from public, anon, authenticated;
revoke execute on function public.grant_achievement(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- Públicas (del cliente): validan auth.uid() internamente.
revoke execute on function public.mark_achievements_seen(uuid) from public, anon;
revoke execute on function public.mark_event_diary_seen(uuid) from public, anon;
grant execute on function public.mark_achievements_seen(uuid) to authenticated;
grant execute on function public.mark_event_diary_seen(uuid) to authenticated;
