-- 0033_swiss_pairings_unified.sql
-- Generación de TODOS los pairings al iniciar el evento (n(n-1)/2 cruces).
-- generate_swiss_round actualizado: hace UPDATE sobre pairings existentes seteando swiss_round.

create or replace function public.generate_all_pairings(p_event_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_p1 uuid;
  v_p2 uuid;
  v_p_a uuid;
  v_p_b uuid;
  players uuid[];
  i integer;
  j integer;
  n integer;
begin
  select array_agg(id order by id) into players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  n := coalesce(array_length(players, 1), 0);
  if n < 2 then return; end if;

  i := 1;
  while i < n loop
    j := i + 1;
    while j <= n loop
      v_p1 := players[i];
      v_p2 := players[j];
      if v_p1 < v_p2 then v_p_a := v_p1; v_p_b := v_p2;
      else v_p_a := v_p2; v_p_b := v_p1;
      end if;

      insert into public.pairings (event_id, participant_a_id, participant_b_id)
      values (p_event_id, v_p_a, v_p_b)
      on conflict (event_id, participant_a_id, participant_b_id) do nothing;

      j := j + 1;
    end loop;
    i := i + 1;
  end loop;
end;
$$;

create or replace function public.generate_swiss_round(p_event_id uuid, p_round integer)
returns void
language plpgsql
security definer
as $$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_p1 uuid;
  v_p2 uuid;
  v_p_a uuid;
  v_p_b uuid;
  v_already_played boolean;
begin
  -- Asegurar que todos los pairings existan.
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and not (p_round = any (ep.bye_rounds))
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  declare
    i integer := 1;
    n integer := coalesce(array_length(v_remaining_participants, 1), 0);
  begin
    while i <= n - 1 loop
      v_p1 := v_remaining_participants[i];
      declare j integer := i + 1;
      begin
        while j <= n loop
          v_p2 := v_remaining_participants[j];
          -- Chequear si ya jugaron oficialmente (swiss_round no null) en una ronda previa.
          select exists (
            select 1 from public.pairings
            where event_id = p_event_id
              and swiss_round is not null
              and ((participant_a_id = v_p1 and participant_b_id = v_p2)
                or (participant_a_id = v_p2 and participant_b_id = v_p1))
          ) into v_already_played;
          if not v_already_played then exit; end if;
          j := j + 1;
        end loop;

        if j > n then
          v_p2 := v_remaining_participants[i + 1];
          j := i + 1;
        end if;

        if v_p1 < v_p2 then v_p_a := v_p1; v_p_b := v_p2;
        else v_p_a := v_p2; v_p_b := v_p1;
        end if;

        -- UPDATE en lugar de INSERT.
        update public.pairings
        set swiss_round = p_round
        where event_id = p_event_id
          and participant_a_id = v_p_a
          and participant_b_id = v_p_b;

        v_remaining_participants := v_remaining_participants[1:j-1] || v_remaining_participants[j+1:n];
        n := n - 1;
      end;
      i := i + 1;
    end loop;
  end;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;
end;
$$;
