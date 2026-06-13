-- 0047_swiss_bo2_auto_resolve.sql
-- Fixes swiss_bo2:
--   2) Resolución automática del pairing al terminar la 2da partida individual.
--   3) Recálculo de tiebreakers ni bien se resuelve cada pairing (gana A/B o empate).
--   4) Bye = 2 puntos (en vez de 3) en swiss_bo2_points_of.

-- ===========================================================================
-- 4. BYE = 2 PUNTOS EN BO2
-- ===========================================================================
-- Victoria = 3, empate = 1, bye = 2, derrota/pendiente = 0.
create or replace function public.swiss_bo2_points_of(participant_id uuid, event_id uuid)
returns int
language plpgsql
stable
as $$
declare
  v_wins integer;
  v_draws integer;
  v_byes integer;
begin
  -- Pairings ganados.
  select count(*) into v_wins
  from public.pairings
  where pairings.event_id = swiss_bo2_points_of.event_id
    and swiss_round is not null
    and official_winner_participant_id = swiss_bo2_points_of.participant_id;

  -- Pairings empatados en los que el participant estuvo involucrado.
  select count(*) into v_draws
  from public.pairings
  where pairings.event_id = swiss_bo2_points_of.event_id
    and swiss_round is not null
    and official_draw = true
    and (participant_a_id = swiss_bo2_points_of.participant_id
      or participant_b_id = swiss_bo2_points_of.participant_id);

  -- Byes recibidos.
  select coalesce(array_length(bye_rounds, 1), 0) into v_byes
  from public.event_participants
  where id = swiss_bo2_points_of.participant_id;

  return v_wins * 3 + v_draws * 1 + v_byes * 2;
end;
$$;

-- ===========================================================================
-- 2. RESOLUCIÓN AUTOMÁTICA DEL PAIRING AL TERMINAR LA 2DA PARTIDA (BO2)
-- ===========================================================================
-- Al completar una partida individual (match_type='draft') de un evento
-- swiss_bo2, si el pairing ya tiene 2 partidas completadas y aún no fue
-- resuelto, se cierra automáticamente: 2-0 => ganador, 1-1 => empate.
create or replace function public.maybe_resolve_swiss_bo2_pairing()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_format text;
  v_completed integer;
  v_wins_a integer;
  v_wins_b integer;
begin
  if new.status <> 'completed' then return new; end if;
  if new.match_type <> 'draft' then return new; end if;

  select p.id, p.event_id, p.participant_a_id, p.participant_b_id,
         p.official_winner_participant_id, p.official_draw
  into v_pairing
  from public.pairings p
  where p.id = new.pairing_id;
  if v_pairing.id is null then return new; end if;

  -- Ya resuelto: nada que hacer.
  if v_pairing.official_winner_participant_id is not null or v_pairing.official_draw = true then
    return new;
  end if;

  select competition_format into v_event_format
  from public.draft_events where id = v_pairing.event_id;
  if v_event_format <> 'swiss_bo2' then return new; end if;

  -- a) Contar partidas completadas del pairing.
  select count(*) into v_completed
  from public.matches
  where pairing_id = new.pairing_id
    and match_type = 'draft'
    and status = 'completed';

  -- b) Solo resolver cuando hay exactamente 2 partidas completadas.
  if v_completed <> 2 then return new; end if;

  select count(*) filter (where winner_participant_id = v_pairing.participant_a_id),
         count(*) filter (where winner_participant_id = v_pairing.participant_b_id)
  into v_wins_a, v_wins_b
  from public.matches
  where pairing_id = new.pairing_id
    and match_type = 'draft'
    and status = 'completed';

  if v_wins_a >= 2 then
    update public.pairings
    set official_winner_participant_id = v_pairing.participant_a_id,
        official_resolved_at = now()
    where id = new.pairing_id
      and official_winner_participant_id is null
      and official_draw = false;
  elsif v_wins_b >= 2 then
    update public.pairings
    set official_winner_participant_id = v_pairing.participant_b_id,
        official_resolved_at = now()
    where id = new.pairing_id
      and official_winner_participant_id is null
      and official_draw = false;
  else
    -- 1-1 => empate.
    update public.pairings
    set official_draw = true,
        official_winner_participant_id = null,
        official_resolved_at = now()
    where id = new.pairing_id
      and official_winner_participant_id is null
      and official_draw = false;
  end if;

  return new;
end;
$$;

drop trigger if exists on_match_completed_resolve_swiss_bo2 on public.matches;
create trigger on_match_completed_resolve_swiss_bo2
after insert or update on public.matches
for each row
when (new.status = 'completed' and new.match_type = 'draft')
execute function public.maybe_resolve_swiss_bo2_pairing();

-- El UPDATE de pairings que hace la función de arriba dispara
-- on_pairing_resolved_advance_swiss_bo2 (avance de ronda), que detecta tanto
-- el seteo de official_winner_participant_id como el de official_draw=true.

-- ===========================================================================
-- 3. RECÁLCULO DE TIEBREAKERS NI BIEN SE RESUELVE CADA PAIRING (BO2)
-- ===========================================================================
create or replace function public.on_swiss_bo2_pairing_recalc_tiebreakers()
returns trigger
language plpgsql
security definer
as $$
declare
  v_format text;
begin
  if new.swiss_round is null then return new; end if;
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;

  select competition_format into v_format
  from public.draft_events where id = new.event_id;
  if v_format <> 'swiss_bo2' then return new; end if;

  perform public.recalc_swiss_bo2_tiebreakers(new.event_id);
  return new;
end;
$$;

-- Nombre con prefijo "on_aa_" para que corra ANTES que
-- on_pairing_resolved_advance_swiss_bo2 (los triggers disparan por orden alfabético).
drop trigger if exists on_aa_swiss_bo2_pairing_resolved_recalc on public.pairings;
create trigger on_aa_swiss_bo2_pairing_resolved_recalc
after update on public.pairings
for each row
when (
  (new.official_draw = true and old.official_draw = false)
  or (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
)
execute function public.on_swiss_bo2_pairing_recalc_tiebreakers();
