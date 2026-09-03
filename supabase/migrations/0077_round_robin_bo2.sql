-- 0077_round_robin_bo2.sql
-- Sub-paso 2a: agrega 'bo2' como valor válido de match_format (fase regular de round_robin,
-- independiente de top_size) y le enseña a update_pairing_official_result a resolver un pairing
-- BO2: 2-0 => ganador normal, 1-1 => empate (official_draw=true, sin ganador).
--
-- No toca competition_format ni la lógica de swiss_bo2 (maybe_resolve_swiss_bo2_pairing sigue
-- siendo el camino de resolución para competition_format='swiss_bo2'; este branch nuevo es
-- exclusivo de match_format='bo2', que hoy solo puede setear round_robin).

-- ── 1. Ampliar events_match_format_valid ────────────────────────────────────────────────────
alter table public.draft_events
  drop constraint if exists events_match_format_valid;

alter table public.draft_events
  add constraint events_match_format_valid
  check (match_format in ('bo1', 'bo2', 'bo3'));

-- ── 2. update_pairing_official_result — nuevo branch bo2 ────────────────────────────────────
-- Cuerpo idéntico al de 0001, agregando el elsif bo2. Molde: maybe_resolve_swiss_bo2_pairing
-- (0047), pero sin el filtro de swiss_round e integrado en este trigger existente en vez de
-- uno separado.
create or replace function public.update_pairing_official_result()
returns trigger
language plpgsql
security definer
as $$
declare
  v_match_format text;
  v_a_wins integer;
  v_b_wins integer;
  v_completed integer;
  v_winning_participant_id uuid;
  v_pairing public.pairings%rowtype;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  select de.match_format
  into v_match_format
  from public.draft_events de
  where de.id = v_pairing.event_id;

  if v_match_format = 'bo1' then
    select winner_participant_id
    into v_winning_participant_id
    from public.matches
    where pairing_id = new.pairing_id
      and match_type = 'draft'
      and status = 'completed'
    order by match_number
    limit 1;

    if v_winning_participant_id is not null then
      update public.pairings
      set official_winner_participant_id = v_winning_participant_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;

  elsif v_match_format = 'bo2' then
    select
      count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
      count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id),
      count(*)
    into v_a_wins, v_b_wins, v_completed
    from public.matches m
    where m.pairing_id = new.pairing_id
      and m.match_type = 'draft'
      and m.status = 'completed';

    if v_a_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_a_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    elsif v_b_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_b_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    elsif v_completed >= 2 then
      -- 1-1 => empate.
      update public.pairings
      set official_draw = true,
          official_winner_participant_id = null,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null
        and official_draw = false;
    end if;

  elsif v_match_format = 'bo3' then
    select
      count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
      count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id)
    into v_a_wins, v_b_wins
    from public.matches m
    where m.pairing_id = new.pairing_id
      and m.match_type = 'draft'
      and m.status = 'completed';

    if v_a_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_a_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    elsif v_b_wins >= 2 then
      update public.pairings
      set official_winner_participant_id = v_pairing.participant_b_id,
          official_resolved_at = now()
      where id = new.pairing_id
        and official_winner_participant_id is null;
    end if;
  end if;

  return new;
end;
$$;
