-- 0014_event_participants_left_event.sql
-- Agrega columnas a event_participants para trackear cuando un jugador
-- se marca como "Me estoy yendo" (o el organizer lo kickea con el mismo efecto).
-- Y reescribe compute_event_champion para:
--   1) Aplicar umbral de elegibilidad: solo entran a disputa los jugadores
--      con BO3 completados >= ceil(2/3 * total_BO3_del_jugador).
--   2) Cambiar criterio de líder: pasa de "más BO3 ganados absolutos" a
--      "mayor win rate de BO3 (ganados / completados)" entre los elegibles.
--   3) Considerar el evento como cerrable cuando todos los pairings
--      pendientes están bloqueados por al menos un participante con
--      left_event_at no null.

-- 1. Columnas nuevas
alter table public.event_participants
  add column if not exists left_event_at timestamptz,
  add column if not exists left_event_by uuid references public.users(id);

create index if not exists idx_event_participants_left_event_at
  on public.event_participants (event_id, left_event_at);

-- 2. Reescribir compute_event_champion
create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $function$
declare
  v_event_status text;
  v_event_champion_user_id uuid;
  v_total_pairings integer;
  v_pending_pairings_blocked integer;
  v_pending_pairings_total integer;
  v_total_players integer;
  v_min_bo3_required integer;
  v_max_winrate numeric;
  v_leaders_count integer;
  v_leader_user_id uuid;
begin
  -- Solo evaluar eventos en playing y sin campeón asignado
  select status, champion_user_id
  into v_event_status, v_event_champion_user_id
  from public.draft_events
  where id = p_event_id
    and deleted_at is null;

  if v_event_status is null then
    return;
  end if;

  if v_event_status <> 'playing' then
    return;
  end if;

  if v_event_champion_user_id is not null then
    return;
  end if;

  -- Verificar si todos los pairings están cerrados,
  -- o si los pendientes están todos bloqueados por al menos un jugador "ido".
  select
    count(*),
    count(*) filter (where official_winner_participant_id is null) as pending_total,
    count(*) filter (
      where official_winner_participant_id is null
        and (
          exists (
            select 1 from public.event_participants ep
            where ep.id = p.participant_a_id
              and ep.left_event_at is not null
          )
          or exists (
            select 1 from public.event_participants ep
            where ep.id = p.participant_b_id
              and ep.left_event_at is not null
          )
        )
    ) as pending_blocked
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p
  where p.event_id = p_event_id;

  if v_total_pairings = 0 then
    return;
  end if;

  -- Si hay pairings pendientes que NO están bloqueados, el evento no se puede cerrar
  if v_pending_pairings_total > v_pending_pairings_blocked then
    return;
  end if;

  -- Calcular total de jugadores (con role='player') para definir umbral
  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id
    and role = 'player';

  if v_total_players < 2 then
    return;
  end if;

  -- Cada jugador potencialmente disputa (v_total_players - 1) BO3.
  -- Umbral de elegibilidad: completados >= ceil(2/3 * (total_players - 1))
  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  -- Calcular winrate por jugador elegible (jugó al menos v_min_bo3_required BO3)
  with player_bo3 as (
    select
      ep.user_id,
      ep.id as participant_id,
      count(*) filter (
        where p.official_winner_participant_id is not null
          and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
      ) as completed,
      count(*) filter (
        where p.official_winner_participant_id = ep.id
      ) as won
    from public.event_participants ep
    left join public.pairings p
      on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
      and p.event_id = p_event_id
    where ep.event_id = p_event_id
      and ep.role = 'player'
    group by ep.user_id, ep.id
  ),
  eligible as (
    select
      user_id,
      participant_id,
      completed,
      won,
      (won::numeric / nullif(completed, 0)) as winrate
    from player_bo3
    where completed >= v_min_bo3_required
  )
  select max(winrate), count(*) filter (where winrate = (select max(winrate) from eligible))
  into v_max_winrate, v_leaders_count
  from eligible;

  -- Si nadie es elegible, no asignamos campeón pero marcamos final_pending
  if v_max_winrate is null then
    update public.draft_events
    set final_pending = true
    where id = p_event_id
      and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id
    from (
      select
        ep.user_id,
        count(*) filter (
          where p.official_winner_participant_id is not null
            and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
        ) as completed,
        count(*) filter (
          where p.official_winner_participant_id = ep.id
        ) as won
      from public.event_participants ep
      left join public.pairings p
        on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
        and p.event_id = p_event_id
      where ep.event_id = p_event_id
        and ep.role = 'player'
      group by ep.user_id
    ) leaders
    where (won::numeric / nullif(completed, 0)) = v_max_winrate
      and completed >= v_min_bo3_required;

    update public.draft_events
    set
      champion_user_id = v_leader_user_id,
      champion_decided_by = 'auto',
      event_ended_at = now(),
      status = 'completed',
      final_pending = false
    where id = p_event_id
      and champion_user_id is null;
  else
    -- Empate: marcar pendiente de desempate
    update public.draft_events
    set final_pending = true
    where id = p_event_id
      and champion_user_id is null;
  end if;
end;
$function$;

-- 3. Recalcular retroactivamente para eventos en playing
do $$
declare
  v_event record;
begin
  for v_event in
    select id from public.draft_events
    where status = 'playing' and deleted_at is null
  loop
    perform public.compute_event_champion(v_event.id);
  end loop;
end;
$$;
