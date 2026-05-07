-- 0012_event_champion_auto.sql
-- Auto-cierre del evento cuando todos los BO3 oficiales están finalizados.
-- Setea champion_user_id si hay un líder único en BO3 ganados.
-- Si hay empate en el primer lugar, setea final_pending=true y no asigna campeón
-- (la lógica de desempate se implementa en una migración posterior).
-- Solo aplica para el caso "todos contra todos BO3" del tipo de competencia actual.
-- Cuando se agreguen otros tipos de competencia (suizas, grupos+playoffs), esta
-- función deberá extenderse o adaptarse al match_format del evento.
--
-- Diseño:
-- - compute_event_champion(event_id) es una función pura que evalúa el estado
--   actual de un evento y aplica los cambios correspondientes. Idempotente.
-- - El trigger on_pairing_official_close_update_champion la llama cuando un
--   pairing se cierra (transición de official_winner_participant_id null → no null).
-- - Al final de la migración, se ejecuta la función sobre todos los eventos en
--   estado 'playing' para recalcular retroactivamente el campeón si corresponde.

create or replace function public.compute_event_champion(p_event_id uuid)
returns void
language plpgsql
security definer
as $function$
declare
  v_total_pairings integer;
  v_closed_pairings integer;
  v_max_bo3_wins integer;
  v_leaders_count integer;
  v_leader_user_id uuid;
  v_event_status text;
  v_event_champion_user_id uuid;
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

  -- Verificar si todos los pairings del evento están cerrados
  select count(*), count(*) filter (where official_winner_participant_id is not null)
  into v_total_pairings, v_closed_pairings
  from public.pairings
  where event_id = p_event_id;

  if v_total_pairings = 0 then
    return;
  end if;

  if v_closed_pairings < v_total_pairings then
    return;
  end if;

  -- Todos cerrados: calcular líder por BO3 ganados
  with bo3_wins as (
    select
      ep.user_id,
      count(*) filter (where p.official_winner_participant_id = ep.id) as wins
    from public.event_participants ep
    left join public.pairings p
      on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
      and p.event_id = p_event_id
    where ep.event_id = p_event_id
      and ep.role = 'player'
    group by ep.user_id
  )
  select max(wins), count(*) filter (where wins = (select max(wins) from bo3_wins))
  into v_max_bo3_wins, v_leaders_count
  from bo3_wins;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id
    from (
      select
        ep.user_id,
        count(*) filter (where p.official_winner_participant_id = ep.id) as wins
      from public.event_participants ep
      left join public.pairings p
        on (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
        and p.event_id = p_event_id
      where ep.event_id = p_event_id
        and ep.role = 'player'
      group by ep.user_id
    ) leaders
    where wins = v_max_bo3_wins;

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
    update public.draft_events
    set final_pending = true
    where id = p_event_id
      and champion_user_id is null;
  end if;
end;
$function$;

create or replace function public.update_event_champion_on_pairing_close()
returns trigger
language plpgsql
security definer
as $function$
begin
  -- Solo procesar cuando official_winner_participant_id pasa de null a no null
  if new.official_winner_participant_id is null then
    return new;
  end if;
  if old.official_winner_participant_id is not null then
    return new;
  end if;

  perform public.compute_event_champion(new.event_id);

  return new;
end;
$function$;

drop trigger if exists on_pairing_official_close_update_champion on public.pairings;
create trigger on_pairing_official_close_update_champion
  after update on public.pairings
  for each row
  execute function public.update_event_champion_on_pairing_close();

-- Recalcular retroactivamente para todos los eventos en playing
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
