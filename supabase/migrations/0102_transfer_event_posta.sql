-- 0102_transfer_event_posta.sql
-- Fase 2/8: RPC de transferencia de la "posta" (organizador puntual de un evento, Fase 1 en
-- 0101_event_organizer_posta_schema.sql).
--
-- Único camino permitido para escribir event_organizer_user_id después de la creación del evento
-- (el revoke de columna de la Fase 1 bloquea cualquier UPDATE genérico del cliente sobre esa
-- columna). Corre SECURITY DEFINER: sus propios SELECT/UPDATE internos no están sujetos a ese
-- revoke porque corren con los privilegios del dueño de la función, no del rol `authenticated`
-- que la invoca vía RPC.
--
-- Validaciones, en orden:
--   1. Hay sesión (auth.uid() no nulo).
--   2. El evento existe y no está borrado.
--   3. Quien llama tiene la posta ACTUALMENTE (event_organizer_user_id = auth.uid()) — un
--      organizador real del workspace que no creó ni recibió la posta no puede usarla, porque
--      nunca fue suya (sus facultades vienen de can_manage_event/is_workspace_organizer, no de
--      esta columna).
--   4. El destino no es uno mismo.
--   5. El evento está en una ventana que permite transferir: 'scheduled' o 'playing'. Bloqueada
--      durante 'drafting' (desde que se aprieta "Arrancar draft" hasta que termina, para no
--      soltarle el control a otra persona en medio de una sesión de draft en curso) y en todos
--      los estados terminales ('completed', 'cancelled', 'concluded' — no queda nada que
--      administrar).
--   6. El destino es un participante ROLE='player' inscripto y activo (left_event_at is null) en
--      ESTE evento — nunca a un no-participante ni a un 'ghost'/'exile'. Contempla equipos de
--      two-headed giant: una fila de event_participants puede representar a dos personas
--      (user_id y member_b_user_id), cualquiera de las dos es un destino válido.
--
-- Nota de diseño explícita: "Me voy" y la posta son independientes. Si quien tiene la posta se
-- marca como "ido" (left_event_at en su propia fila de participante), NO la pierde — sigue
-- teniéndola hasta que la delegue explícitamente acá. Por eso esta función nunca chequea el
-- left_event_at del HOLDER, solo el del DESTINO.

create or replace function public.transfer_event_posta(p_event_id uuid, p_to_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_event public.draft_events%rowtype;
begin
  if v_uid is null then
    raise exception 'Tenés que iniciar sesión para transferir la posta.';
  end if;

  if p_to_user_id is null then
    raise exception 'Elegí a quién le cedés las facultades.';
  end if;

  select de.*
  into v_event
  from public.draft_events de
  where de.id = p_event_id
    and de.deleted_at is null
  for update;

  if not found then
    raise exception 'Evento no encontrado.';
  end if;

  if v_event.event_organizer_user_id <> v_uid then
    raise exception 'No tenés la posta de este evento.';
  end if;

  if p_to_user_id = v_uid then
    raise exception 'No podés cederte la posta a vos mismo.';
  end if;

  if v_event.status not in ('scheduled', 'playing') then
    raise exception 'No se puede transferir la posta en este momento del evento.';
  end if;

  if not exists (
    select 1
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
      and (ep.user_id = p_to_user_id or ep.member_b_user_id = p_to_user_id)
  ) then
    raise exception 'El destino debe ser un jugador inscripto y activo en el evento.';
  end if;

  update public.draft_events
  set event_organizer_user_id = p_to_user_id
  where id = p_event_id;
end;
$$;

comment on function public.transfer_event_posta(uuid, uuid) is
  'Transfiere la posta (organizador puntual) de un evento a otro participante role=player activo. Solo puede llamarla quien tiene la posta actualmente.';

revoke all on function public.transfer_event_posta(uuid, uuid) from public;
grant execute on function public.transfer_event_posta(uuid, uuid) to authenticated;
