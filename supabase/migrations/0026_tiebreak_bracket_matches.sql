-- 0026_tiebreak_bracket_matches.sql
-- Modela los matches específicos del bracket de 4: 2 semis + final + 3°/4°.
-- El cliente consulta esta tabla para saber qué cruces mostrar en lugar de listar
-- todos los pairings entre los 4 participants del grupo.
--
-- Flujo:
--   1. create_bracket_tiebreak_group inserta las 2 semis (seed 1v4 y 2v3) en esta tabla
--      al armar el grupo.
--   2. Al cerrar una match de tipo 'tiebreak' que coincide con una fila pending de esta
--      tabla (mismo group activo y mismos participants), evaluate_tiebreak_group_after_match:
--        - Marca winner_participant_id, pairing_id y resolved_at.
--        - Si era una semi y ambas semis ya tienen ganador, inserta la final
--          (semi_winners) y el partido de 3°/4° (semi_losers).
--        - Si era la final, fija champion_user_id del evento.
--      Cuando todas las filas del bracket tienen winner, el grupo pasa a 'resolved'.

create table if not exists public.event_tiebreak_bracket_matches (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.event_tiebreak_groups(id) on delete cascade,
  bracket_phase text not null check (bracket_phase in ('semi', 'final', 'third_place')),
  participant_a_id uuid not null references public.event_participants(id) on delete cascade,
  participant_b_id uuid not null references public.event_participants(id) on delete cascade,
  pairing_id uuid references public.pairings(id) on delete set null,
  winner_participant_id uuid references public.event_participants(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (participant_a_id <> participant_b_id)
);

create index if not exists idx_etbm_group on public.event_tiebreak_bracket_matches (group_id);
create index if not exists idx_etbm_pairing on public.event_tiebreak_bracket_matches (pairing_id);
create index if not exists idx_etbm_group_phase on public.event_tiebreak_bracket_matches (group_id, bracket_phase);
create index if not exists idx_etbm_group_pending
  on public.event_tiebreak_bracket_matches (group_id)
  where winner_participant_id is null;

alter table public.event_tiebreak_bracket_matches enable row level security;

create policy "select_tiebreak_bracket_matches_for_workspace_members"
  on public.event_tiebreak_bracket_matches
  for select
  using (
    exists (
      select 1
      from public.event_tiebreak_groups etg
      join public.draft_events de on de.id = etg.event_id
      where etg.id = event_tiebreak_bracket_matches.group_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

-- Helper: intenta linkear pairing_id de filas del bracket donde haya un pairing existente
-- entre los mismos participants del evento.
create or replace function public.link_bracket_matches_to_pairings(p_group_id uuid)
returns void
language sql
security definer
as $$
  update public.event_tiebreak_bracket_matches bm
  set pairing_id = p.id
  from public.pairings p,
       public.event_tiebreak_groups etg
  where bm.group_id = p_group_id
    and bm.pairing_id is null
    and etg.id = bm.group_id
    and p.event_id = etg.event_id
    and (
      (p.participant_a_id = bm.participant_a_id and p.participant_b_id = bm.participant_b_id)
      or (p.participant_a_id = bm.participant_b_id and p.participant_b_id = bm.participant_a_id)
    );
$$;

-- create_bracket_tiebreak_group: además de armar el grupo + participants con seed,
-- ahora inserta las 2 semis seed 1v4 y 2v3 y trata de linkear pairing_id si ya existe.
create or replace function public.create_bracket_tiebreak_group(
  p_event_id uuid,
  p_participant_ids uuid[]
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_seed integer;
  v_pid uuid;
  v_seed1 uuid;
  v_seed2 uuid;
  v_seed3 uuid;
  v_seed4 uuid;
begin
  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status)
  values (p_event_id, 1, 'bracket', 'active')
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_participant_ids
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  v_seed1 := p_participant_ids[1];
  v_seed2 := p_participant_ids[2];
  v_seed3 := p_participant_ids[3];
  v_seed4 := p_participant_ids[4];

  if v_seed1 is not null and v_seed4 is not null then
    insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group_id, 'semi', v_seed1, v_seed4);
  end if;

  if v_seed2 is not null and v_seed3 is not null then
    insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group_id, 'semi', v_seed2, v_seed3);
  end if;

  perform public.link_bracket_matches_to_pairings(v_group_id);

  return v_group_id;
end;
$$;

-- Reescribir evaluate_tiebreak_group_after_match: la rama round_robin queda igual (0025);
-- la rama bracket pasa a operar sobre event_tiebreak_bracket_matches.
create or replace function public.evaluate_tiebreak_group_after_match()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_id uuid;
  v_active_group record;
  v_participant_count integer;
  v_played_count integer;
  v_total_pairs_needed integer;
  v_winner_participant_id uuid;
  v_max_wins integer;
  v_leader_user_id uuid;
  v_leader_participant_ids uuid[];
  v_max_match_winrate numeric;
  v_winrate_leaders_count integer;
  v_event_already_completed boolean;
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id, participant_a_id, participant_b_id into v_pairing
  from public.pairings where id = new.pairing_id;
  v_event_id := v_pairing.event_id;

  select id, group_type, round_number into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;
    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    if v_event_already_completed then
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', resolved_at = now() where id = v_active_group.id;
      end if;
      return new;
    end if;

    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc limit 1;

    if v_max_wins = v_participant_count - 1 then
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      else
        update public.event_tiebreak_groups set champion_user_id = v_leader_user_id where id = v_active_group.id;
      end if;
      return new;
    end if;

    if v_played_count < v_total_pairs_needed then return new; end if;

    if v_active_group.round_number = 1 then
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants where group_id = v_active_group.id;
      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    with winrates as (
      select etgp.participant_id, etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
      from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
    )
    select max(wr), count(*) filter (where wr = (select max(wr) from winrates))
    into v_max_match_winrate, v_winrate_leaders_count from winrates;

    if v_winrate_leaders_count = 1 then
      select user_id into v_leader_user_id from (
        select etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
        from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
      ) wr_table where wr = v_max_match_winrate;
      update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    update public.event_tiebreak_groups set status = 'failed', resolved_at = now() where id = v_active_group.id;
    update public.draft_events
    set polemica_winners = (
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) = v_max_match_winrate
    ),
    recognition_winners = coalesce(recognition_winners, '{}') || coalesce((
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) < v_max_match_winrate
    ), '{}'),
    champion_decided_by = 'polemica', status = 'completed', event_ended_at = now(), final_pending = false
    where id = v_event_id and champion_user_id is null;
    return new;
  end if;

  if v_active_group.group_type = 'bracket' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_completed_semis integer;
      v_final_exists boolean;
      v_semi_winners uuid[];
      v_semi_losers uuid[];
      v_bracket_total integer;
      v_bracket_pending integer;
    begin
      -- Buscar la fila del bracket que matchea con los participants del pairing y aún no tiene ganador.
      select id, bracket_phase
      into v_bm_id, v_bm_phase
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = new.winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      if v_bm_phase = 'semi' then
        select count(*) into v_completed_semis
        from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and bracket_phase = 'semi'
          and winner_participant_id is not null;

        if v_completed_semis >= 2 then
          select exists (
            select 1 from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'final'
          ) into v_final_exists;

          if not v_final_exists then
            select
              array_agg(winner_participant_id order by created_at),
              array_agg(
                case when winner_participant_id = participant_a_id
                     then participant_b_id else participant_a_id end
                order by created_at
              )
            into v_semi_winners, v_semi_losers
            from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'semi';

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'final', v_semi_winners[1], v_semi_winners[2]);

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'third_place', v_semi_losers[1], v_semi_losers[2]);

            perform public.link_bracket_matches_to_pairings(v_active_group.id);
          end if;
        end if;

      elsif v_bm_phase = 'final' then
        select user_id into v_leader_user_id
        from public.event_participants where id = new.winner_participant_id;

        update public.draft_events
        set champion_user_id = v_leader_user_id,
            champion_decided_by = 'tiebreak',
            event_ended_at = now(),
            status = 'completed',
            final_pending = false
        where id = v_event_id and champion_user_id is null;

        update public.event_tiebreak_groups
        set champion_user_id = v_leader_user_id
        where id = v_active_group.id and champion_user_id is null;
      end if;

      -- Si ya están todas las filas del bracket con ganador, cerrar el grupo.
      select count(*),
             count(*) filter (where winner_participant_id is null)
      into v_bracket_total, v_bracket_pending
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id;

      if v_bracket_total >= 4 and v_bracket_pending = 0 then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';
      end if;

      return new;
    end;
  end if;

  return new;
end;
$$;

-- Backfill: para grupos bracket activos que aún no tienen filas en la nueva tabla,
-- generar las 2 semis a partir de los seeds existentes y linkear pairing_id.
-- Si alguna de esas semis ya fue jugada, marcarla como resuelta usando la última
-- match de tiebreak completada entre esos participants.
do $$
declare
  v_group record;
  v_pids uuid[];
  v_pa uuid;
  v_pb uuid;
  v_bm_id uuid;
  v_winner uuid;
  v_pairing_id uuid;
  v_ended timestamptz;
  v_completed_semis integer;
  v_final_exists boolean;
  v_semi_winners uuid[];
  v_semi_losers uuid[];
begin
  for v_group in
    select id from public.event_tiebreak_groups
    where group_type = 'bracket' and status = 'active'
  loop
    if exists (select 1 from public.event_tiebreak_bracket_matches where group_id = v_group.id) then
      continue;
    end if;

    select array_agg(participant_id order by seed) into v_pids
    from public.event_tiebreak_group_participants
    where group_id = v_group.id;

    if v_pids is null or array_length(v_pids, 1) <> 4 then
      continue;
    end if;

    insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group.id, 'semi', v_pids[1], v_pids[4]);

    insert into public.event_tiebreak_bracket_matches (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group.id, 'semi', v_pids[2], v_pids[3]);

    perform public.link_bracket_matches_to_pairings(v_group.id);

    -- Backfill de ganadores de semis a partir de matches ya cerradas.
    for v_bm_id, v_pa, v_pb in
      select id, participant_a_id, participant_b_id
      from public.event_tiebreak_bracket_matches
      where group_id = v_group.id and bracket_phase = 'semi'
    loop
      select m.winner_participant_id, m.pairing_id, m.ended_at
      into v_winner, v_pairing_id, v_ended
      from public.matches m
      join public.pairings p on p.id = m.pairing_id
      where m.match_type = 'tiebreak'
        and m.status = 'completed'
        and m.winner_participant_id is not null
        and (
          (p.participant_a_id = v_pa and p.participant_b_id = v_pb)
          or (p.participant_a_id = v_pb and p.participant_b_id = v_pa)
        )
      order by m.ended_at desc nulls last
      limit 1;

      if v_winner is not null then
        update public.event_tiebreak_bracket_matches
        set winner_participant_id = v_winner,
            pairing_id = coalesce(v_pairing_id, pairing_id),
            resolved_at = coalesce(v_ended, now())
        where id = v_bm_id;
      end if;
    end loop;

    -- Si ambas semis quedaron resueltas con el backfill, generar final + 3°/4°.
    select count(*) into v_completed_semis
    from public.event_tiebreak_bracket_matches
    where group_id = v_group.id and bracket_phase = 'semi' and winner_participant_id is not null;

    if v_completed_semis = 2 then
      select exists (
        select 1 from public.event_tiebreak_bracket_matches
        where group_id = v_group.id and bracket_phase = 'final'
      ) into v_final_exists;

      if not v_final_exists then
        select
          array_agg(winner_participant_id order by created_at),
          array_agg(
            case when winner_participant_id = participant_a_id
                 then participant_b_id else participant_a_id end
            order by created_at
          )
        into v_semi_winners, v_semi_losers
        from public.event_tiebreak_bracket_matches
        where group_id = v_group.id and bracket_phase = 'semi';

        insert into public.event_tiebreak_bracket_matches
          (group_id, bracket_phase, participant_a_id, participant_b_id)
        values (v_group.id, 'final', v_semi_winners[1], v_semi_winners[2]);

        insert into public.event_tiebreak_bracket_matches
          (group_id, bracket_phase, participant_a_id, participant_b_id)
        values (v_group.id, 'third_place', v_semi_losers[1], v_semi_losers[2]);

        perform public.link_bracket_matches_to_pairings(v_group.id);
      end if;
    end if;
  end loop;
end $$;
