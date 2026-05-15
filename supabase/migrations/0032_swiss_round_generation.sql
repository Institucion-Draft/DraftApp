-- 0032_swiss_round_generation.sql
-- Generación de rondas suizas: emparejamiento por puntos, evita repetidos, asigna bye.

-- Columna para registrar las rondas donde un participant recibió bye.
alter table public.event_participants
  add column if not exists bye_rounds integer[] not null default '{}';

-- Función para calcular puntos suizos de un participant en un evento.
create or replace function public.swiss_points_of(p_event_id uuid, p_participant_id uuid)
returns integer
language plpgsql
stable
as $$
declare
  v_wins integer;
  v_byes integer;
begin
  select count(*) into v_wins
  from public.pairings
  where event_id = p_event_id
    and official_winner_participant_id = p_participant_id
    and swiss_round is not null;

  select coalesce(array_length(bye_rounds, 1), 0) into v_byes
  from public.event_participants
  where id = p_participant_id;

  return v_wins * 3 + v_byes * 3;
end;
$$;

-- Función principal: genera la siguiente ronda suiza.
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
  v_paired_pairs uuid[][];
  v_pair record;
  v_p1 uuid;
  v_p2 uuid;
  v_already_played boolean;
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.draft_events where id = p_event_id;

  -- 1. Contar players activos (no idos).
  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  -- 2. Si hay número impar, asignar bye al peor del fondo que aún no haya recibido bye.
  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and not (p_round = any (ep.bye_rounds))  -- no haya recibido bye antes
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  -- 3. Resto de jugadores ordenados por puntos descendente (con bye excluido).
  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  -- 4. Emparejar de a 2 evitando repetidos.
  declare
    i integer := 1;
    n integer := coalesce(array_length(v_remaining_participants, 1), 0);
  begin
    while i <= n - 1 loop
      v_p1 := v_remaining_participants[i];
      -- Buscar próximo participant disponible que no haya jugado con v_p1.
      declare j integer := i + 1;
      begin
        while j <= n loop
          v_p2 := v_remaining_participants[j];
          select exists (
            select 1 from public.pairings
            where event_id = p_event_id
              and ((participant_a_id = v_p1 and participant_b_id = v_p2)
                or (participant_a_id = v_p2 and participant_b_id = v_p1))
          ) into v_already_played;
          if not v_already_played then exit; end if;
          j := j + 1;
        end loop;

        -- Si todos jugaron entre sí (raro), emparejar igual con el siguiente.
        if j > n then
          v_p2 := v_remaining_participants[i + 1];
          j := i + 1;
        end if;

        -- Insertar pairing.
        insert into public.pairings (event_id, participant_a_id, participant_b_id, swiss_round)
        values (p_event_id, v_p1, v_p2, p_round);

        -- Sacar v_p2 del array reordenando.
        v_remaining_participants := v_remaining_participants[1:j-1] || v_remaining_participants[j+1:n];
        n := n - 1;
      end;
      i := i + 1;
    end loop;
  end;

  -- 5. Actualizar current_swiss_round.
  update public.draft_events set current_swiss_round = p_round where id = p_event_id;
end;
$$;

-- Función para calcular swiss_rounds_total según players.
create or replace function public.swiss_total_rounds_for(p_event_id uuid)
returns integer
language plpgsql
stable
as $$
declare
  v_players integer;
begin
  select count(*) into v_players
  from public.event_participants where event_id = p_event_id and role = 'player';
  return ceil(log(2, greatest(v_players, 2)))::integer;
end;
$$;

-- Trigger: cuando se cierra una match suiza, si todas las matches de la ronda actual están cerradas,
-- generar la próxima ronda automáticamente (o disparar top cut si era la última).
create or replace function public.maybe_advance_swiss_round()
returns trigger
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_current_round integer;
  v_total_rounds integer;
  v_pending_matches integer;
  v_event_format text;
begin
  -- Solo aplica a matches oficiales (no venganzas, no tiebreak).
  if new.match_type not in ('draft', 'final') then return new; end if;
  if new.status <> 'completed' then return new; end if;

  select p.event_id into v_event_id from public.pairings p where p.id = new.pairing_id;
  select competition_format, current_swiss_round, swiss_rounds_total
  into v_event_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_event_format <> 'swiss' then return new; end if;
  if v_current_round is null then return new; end if;

  -- Calcular pendientes en la ronda actual.
  select count(*) into v_pending_matches
  from public.pairings p
  where p.event_id = v_event_id and p.swiss_round = v_current_round
    and p.official_winner_participant_id is null;

  if v_pending_matches > 0 then return new; end if;

  -- Todas cerradas. Si no es la última ronda, generar la siguiente.
  if v_current_round < v_total_rounds then
    perform public.generate_swiss_round(v_event_id, v_current_round + 1);
    return new;
  end if;

  -- Era la última ronda: generar bracket de top 4 (reutilizar create_bracket_tiebreak_group).
  declare v_top4 uuid[];
  begin
    select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
                                       coalesce(ep.swiss_omw, 0) desc)
    into v_top4
    from public.event_participants ep
    where ep.event_id = v_event_id and ep.role = 'player' and ep.left_event_at is null
    limit 4;

    if v_top4 is not null and array_length(v_top4, 1) >= 4 then
      v_top4 := v_top4[1:4];
      perform public.create_bracket_tiebreak_group(v_event_id, v_top4);
    end if;
  end;

  return new;
end;
$$;

drop trigger if exists on_match_completed_advance_swiss on public.matches;
create trigger on_match_completed_advance_swiss
after update on public.matches
for each row
when (new.status = 'completed')
execute function public.maybe_advance_swiss_round();
