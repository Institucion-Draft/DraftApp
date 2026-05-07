-- 0016_event_tiebreak.sql
-- Sistema de desempate para empates en el primer lugar.
-- Se juegan como matches con match_type='tiebreak' DENTRO del pairing existente entre los empatados.
-- BO3 a 2 ganadas, mismo formato que oficial.
-- Las partidas de desempate NO cuentan en stats del evento (PG/PJ/EG/EC),
-- PERO sí cuentan como partidas oficiales en historial global y racha del jugador.

-- 1. Extender CHECK constraint de match_type para aceptar 'tiebreak'
alter table public.matches
  drop constraint if exists matches_match_type_check;

alter table public.matches
  add constraint matches_match_type_check
  check (match_type in ('draft', 'final', 'revenge', 'two_headed_giant', 'tiebreak'));

-- 2. Columnas nuevas en pairings para trackear el resultado del desempate
alter table public.pairings
  add column if not exists tiebreak_winner_participant_id uuid references public.event_participants(id),
  add column if not exists tiebreak_resolved_at timestamptz;

create index if not exists idx_pairings_tiebreak_winner
  on public.pairings (tiebreak_winner_participant_id);

-- 3. Función trigger que asigna ganador del desempate al llegar a 2 partidas ganadas
create or replace function public.update_pairing_tiebreak_result()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_pairing public.pairings%rowtype;
  v_a_wins integer;
  v_b_wins integer;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  if v_pairing.tiebreak_winner_participant_id is not null then
    return new;
  end if;

  select
    count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
    count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id)
  into v_a_wins, v_b_wins
  from public.matches m
  where m.pairing_id = new.pairing_id
    and m.match_type = 'tiebreak'
    and m.status = 'completed';

  if v_a_wins >= 2 then
    update public.pairings
    set tiebreak_winner_participant_id = v_pairing.participant_a_id,
        tiebreak_resolved_at = now()
    where id = new.pairing_id
      and tiebreak_winner_participant_id is null;
  elsif v_b_wins >= 2 then
    update public.pairings
    set tiebreak_winner_participant_id = v_pairing.participant_b_id,
        tiebreak_resolved_at = now()
    where id = new.pairing_id
      and tiebreak_winner_participant_id is null;
  end if;

  return new;
end;
$function$;

drop trigger if exists on_match_completed_tiebreak on public.matches;
create trigger on_match_completed_tiebreak
  after insert or update on public.matches
  for each row
  execute function public.update_pairing_tiebreak_result();

-- 4. Trigger que reevalúa el campeón del evento cuando se asigna un tiebreak winner
create or replace function public.trigger_compute_event_champion_on_tiebreak()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_event_id uuid;
begin
  if new.tiebreak_winner_participant_id is null then
    return new;
  end if;
  if old.tiebreak_winner_participant_id is not null then
    return new;
  end if;

  v_event_id := new.event_id;
  perform public.compute_event_champion(v_event_id);
  return new;
end;
$function$;

drop trigger if exists on_pairing_tiebreak_resolved on public.pairings;
create trigger on_pairing_tiebreak_resolved
  after update on public.pairings
  for each row
  execute function public.trigger_compute_event_champion_on_tiebreak();

-- 5. Reescribir compute_event_champion para considerar tiebreak en empate de 2
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
  v_leader_a_user_id uuid;
  v_leader_b_user_id uuid;
  v_leader_a_participant_id uuid;
  v_leader_b_participant_id uuid;
  v_tiebreak_winner_user_id uuid;
  v_tiebreak_pairing_id uuid;
begin
  select status, champion_user_id
  into v_event_status, v_event_champion_user_id
  from public.draft_events
  where id = p_event_id and deleted_at is null;

  if v_event_status is null then return; end if;
  if v_event_status <> 'playing' then return; end if;
  if v_event_champion_user_id is not null then return; end if;

  select
    count(*),
    count(*) filter (where official_winner_participant_id is null) as pending_total,
    count(*) filter (
      where official_winner_participant_id is null
        and (
          exists (select 1 from public.event_participants ep where ep.id = p.participant_a_id and ep.left_event_at is not null)
          or exists (select 1 from public.event_participants ep where ep.id = p.participant_b_id and ep.left_event_at is not null)
        )
    ) as pending_blocked
  into v_total_pairings, v_pending_pairings_total, v_pending_pairings_blocked
  from public.pairings p
  where p.event_id = p_event_id;

  if v_total_pairings = 0 then return; end if;
  if v_pending_pairings_total > v_pending_pairings_blocked then return; end if;

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player';

  if v_total_players < 2 then return; end if;

  v_min_bo3_required := ceil(2.0 * (v_total_players - 1) / 3.0)::integer;

  with player_bo3 as (
    select
      ep.user_id, ep.id as participant_id,
      count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
      count(*) filter (where p.official_winner_participant_id = ep.id) as won
    from public.event_participants ep
    left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
    where ep.event_id = p_event_id and ep.role = 'player'
    group by ep.user_id, ep.id
  ),
  eligible as (
    select user_id, participant_id, completed, won, (won::numeric / nullif(completed, 0)) as winrate
    from player_bo3
    where completed >= v_min_bo3_required
  )
  select max(winrate), count(*) filter (where winrate = (select max(winrate) from eligible))
  into v_max_winrate, v_leaders_count
  from eligible;

  if v_max_winrate is null then
    update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
    return;
  end if;

  if v_leaders_count = 1 then
    select user_id into v_leader_user_id
    from (
      select ep.user_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id
    ) leaders
    where (won::numeric / nullif(completed, 0)) = v_max_winrate and completed >= v_min_bo3_required;

    update public.draft_events
    set champion_user_id = v_leader_user_id, champion_decided_by = 'auto', event_ended_at = now(),
        status = 'completed', final_pending = false
    where id = p_event_id and champion_user_id is null;
    return;
  end if;

  -- Empate. Si son exactamente 2, buscar tiebreak entre ellos.
  if v_leaders_count = 2 then
    with player_bo3 as (
      select ep.user_id, ep.id as participant_id,
        count(*) filter (where p.official_winner_participant_id is not null and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)) as completed,
        count(*) filter (where p.official_winner_participant_id = ep.id) as won
      from public.event_participants ep
      left join public.pairings p on (p.participant_a_id = ep.id or p.participant_b_id = ep.id) and p.event_id = p_event_id
      where ep.event_id = p_event_id and ep.role = 'player'
      group by ep.user_id, ep.id
    ),
    leaders_list as (
      select user_id, participant_id, won, completed,
        row_number() over (order by participant_id) as rn
      from player_bo3
      where completed >= v_min_bo3_required
        and (won::numeric / nullif(completed, 0)) = v_max_winrate
    )
    select
      max(case when rn = 1 then user_id end),
      max(case when rn = 2 then user_id end),
      max(case when rn = 1 then participant_id end),
      max(case when rn = 2 then participant_id end)
    into v_leader_a_user_id, v_leader_b_user_id, v_leader_a_participant_id, v_leader_b_participant_id
    from leaders_list;

    -- Buscar pairing entre los dos líderes y si ya tiene tiebreak winner
    select id, tiebreak_winner_participant_id
    into v_tiebreak_pairing_id, v_tiebreak_winner_user_id
    from public.pairings
    where event_id = p_event_id
      and (
        (participant_a_id = v_leader_a_participant_id and participant_b_id = v_leader_b_participant_id)
        or (participant_a_id = v_leader_b_participant_id and participant_b_id = v_leader_a_participant_id)
      );

    if v_tiebreak_winner_user_id is not null then
      -- El tiebreak ya se resolvió. Convertir el participant ganador en user_id.
      select ep.user_id into v_leader_user_id
      from public.event_participants ep
      where ep.id = v_tiebreak_winner_user_id;

      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
          event_ended_at = now(), status = 'completed', final_pending = false
      where id = p_event_id and champion_user_id is null;
      return;
    end if;
  end if;

  -- Empate sin resolver: marcar pendiente
  update public.draft_events set final_pending = true where id = p_event_id and champion_user_id is null;
end;
$function$;

-- Recalcular para eventos en playing
do $$
declare v_event record;
begin
  for v_event in select id from public.draft_events where status = 'playing' and deleted_at is null
  loop
    perform public.compute_event_champion(v_event.id);
  end loop;
end;
$$;
