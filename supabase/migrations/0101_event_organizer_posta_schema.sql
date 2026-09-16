-- 0101_event_organizer_posta_schema.sql
-- Fase 1/8: "posta" transferible del organizador puntual de un evento.
--
-- Diseño acordado: cada draft_events tiene un "poseedor" de las facultades de organizador
-- SOLO para ese evento (event_organizer_user_id), separado de is_workspace_organizer (que sigue
-- intacta para organizadores reales del workspace). Nace en manos de created_by y se puede
-- transferir en el tiempo (Fase 2, RPC transfer_event_posta) a cualquier OTRO participante
-- role='player' inscripto en el evento — nunca a un no-participante.
--
-- created_by NO se toca: queda como registro histórico inmutable de quién creó el evento.
-- event_organizer_user_id es la única fuente de verdad de "quién tiene la posta ahora", y puede
-- terminar siendo una persona distinta de created_by una vez que se transfiere.
--
-- Esta fase es SOLO schema: columna + backfill + trigger de inicialización + el candado de
-- escritura (revoke a nivel de columna) para que ningún UPDATE/INSERT genérico del cliente pueda
-- pisarla — solo un trigger o una función security definer (dueños de la tabla) pueden hacerlo.
-- Todavía no existe el RPC de transferencia (Fase 2) ni se tocó ninguna policy de RLS (Fase 3+).

-- 1. Columna nueva (nullable primero para poder backfillear sin violar not null)
alter table public.draft_events
  add column if not exists event_organizer_user_id uuid references public.users(id);

-- 2. Backfill: todo evento existente arranca con la posta en manos de quien lo creó
update public.draft_events
set event_organizer_user_id = created_by
where event_organizer_user_id is null;

-- 3. A partir de acá, todo evento tiene sí o sí un poseedor de la posta
alter table public.draft_events
  alter column event_organizer_user_id set not null;

-- 4. Trigger: al crear un evento, la posta nace en manos de created_by.
--    (coalesce defensivo: si algo interno ya la seteó explícitamente, se respeta esa
--    inicialización en vez de pisarla; el cliente normal no puede llegar a ese caso porque no
--    tiene privilegio de columna para setearla — ver punto 5.)
create or replace function public.handle_new_draft_event_posta()
returns trigger
language plpgsql
security definer
as $$
begin
  new.event_organizer_user_id := coalesce(new.event_organizer_user_id, new.created_by);
  return new;
end;
$$;

create trigger on_draft_event_created_set_posta
  before insert on public.draft_events
  for each row execute function public.handle_new_draft_event_posta();

-- 5. Candado de escritura: ni INSERT ni UPDATE genéricos (los que hace el cliente normal via
--    supabase-js con su rol `authenticated`) pueden tocar esta columna directamente. El único
--    camino para cambiarla es el trigger de arriba (creación) o, desde la Fase 2, el RPC
--    transfer_event_posta (security definer, corre con los privilegios del dueño de la tabla,
--    no del rol `authenticated`, así que este revoke no lo afecta).
revoke insert (event_organizer_user_id), update (event_organizer_user_id)
  on public.draft_events
  from authenticated, anon;
