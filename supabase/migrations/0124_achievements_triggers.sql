-- 0124_achievements_triggers.sql
-- Sistema de logros de temporada, parte 4/4: enganche con constraint triggers diferidos.
--
-- Flujo: cada cambio relevante en matches / pairings / event_participants /
-- event_diary_entries / draft_events / event_tiebreak_bracket_matches dispara un constraint trigger
-- DEFERRABLE INITIALLY DEFERRED que SOLO encola el event_id en achievement_eval_queue (insert
-- ... on conflict do nothing: barato y sin lógica de negocio). Al commit, con la cadena de
-- triggers de dominio (matches -> pairings -> campeón -> avance de Suizo...) ya resuelta, el
-- trigger diferido de la propia cola drena esa fila y corre evaluate_achievements.
-- Los constraint triggers se ejecutan en el orden en que se encolan, y los eventos que se
-- encolan durante el commit también se ejecutan: por eso todos los "encolar" corren antes que
-- los "drenar" y el evaluador ve el estado final. Ninguna excepción llega a la transacción del
-- partido/pairing: el drenado captura todo (los fallos por logro se registran además dentro de
-- evaluate_achievements).

-- ===========================================================================
-- 1. Encolado (una función por tabla, para resolver el event_id)
-- ===========================================================================
create or replace function public.achievement_enqueue_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event_id is not null then
    insert into public.achievement_eval_queue (event_id) values (p_event_id)
    on conflict (event_id) do nothing;
  end if;
exception when others then
  perform public.achievement_log_error(p_event_id, 'enqueue', sqlstate, sqlerrm);
end;
$$;

create or replace function public.achievement_enqueue_from_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.achievement_enqueue_event(
    (select p.event_id from public.pairings p where p.id = new.pairing_id)
  );
  return null;
end;
$$;

-- pairings, event_participants y event_diary_entries tienen event_id.
create or replace function public.achievement_enqueue_from_event_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.achievement_enqueue_event(new.event_id);
  return null;
end;
$$;

create or replace function public.achievement_enqueue_from_draft_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.achievement_enqueue_event(new.id);
  return null;
end;
$$;

create or replace function public.achievement_enqueue_from_bracket_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.achievement_enqueue_event(
    (select g.event_id from public.event_tiebreak_groups g where g.id = new.group_id)
  );
  return null;
end;
$$;

-- ===========================================================================
-- 2. Drenado (corre al commit sobre la fila encolada)
-- ===========================================================================
create or replace function public.achievement_process_queue_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_msg text;
begin
  delete from public.achievement_eval_queue where event_id = new.event_id;
  begin
    perform public.evaluate_achievements(new.event_id);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    perform public.achievement_log_error(new.event_id, 'evaluate', v_state, v_msg);
  end;
  return null;
end;
$$;

-- ===========================================================================
-- 3. Constraint triggers (todos deferrable initially deferred)
-- ===========================================================================
-- matches: solo partidas que quedan completed (una partida en curso no cambia ningún logro).
create constraint trigger achievements_enq_matches_ins
  after insert on public.matches
  deferrable initially deferred
  for each row
  when (new.status = 'completed')
  execute function public.achievement_enqueue_from_match();

create constraint trigger achievements_enq_matches_upd
  after update of status, winner_participant_id, is_walkover on public.matches
  deferrable initially deferred
  for each row
  when (new.status = 'completed')
  execute function public.achievement_enqueue_from_match();

-- pairings: cuando se resuelve (ganador o empate).
create constraint trigger achievements_enq_pairings_upd
  after update of official_winner_participant_id, official_draw, official_resolved_at on public.pairings
  deferrable initially deferred
  for each row
  when (new.official_winner_participant_id is not null or new.official_draw is true)
  execute function public.achievement_enqueue_from_event_id();

-- event_participants: alta (avatar rotativo asignado), baja del evento, cambio de avatar/rol.
create constraint trigger achievements_enq_participants_ins
  after insert on public.event_participants
  deferrable initially deferred
  for each row
  execute function public.achievement_enqueue_from_event_id();

create constraint trigger achievements_enq_participants_upd
  after update of left_event_at, rotated_avatar_id, role on public.event_participants
  deferrable initially deferred
  for each row
  execute function public.achievement_enqueue_from_event_id();

-- bitácora de evento: alta de entrada.
create constraint trigger achievements_enq_diary_ins
  after insert on public.event_diary_entries
  deferrable initially deferred
  for each row
  execute function public.achievement_enqueue_from_event_id();

-- draft_events: estado, campeón, y lo que cambia elegibilidad / fase regular de Suizo.
create constraint trigger achievements_enq_events_upd
  after update of status, champion_user_id, is_official, deleted_at, draft_started_at, event_type,
                  top_size, current_swiss_round, swiss_rounds_manual, swiss_rounds_total
  on public.draft_events
  deferrable initially deferred
  for each row
  execute function public.achievement_enqueue_from_draft_event();

-- bracket/desempate: se define un ganador o se linkea un pairing.
create constraint trigger achievements_enq_bracket_ins
  after insert on public.event_tiebreak_bracket_matches
  deferrable initially deferred
  for each row
  when (new.winner_participant_id is not null)
  execute function public.achievement_enqueue_from_bracket_match();

create constraint trigger achievements_enq_bracket_upd
  after update of winner_participant_id, pairing_id on public.event_tiebreak_bracket_matches
  deferrable initially deferred
  for each row
  execute function public.achievement_enqueue_from_bracket_match();

-- Cola: drenado al commit.
create constraint trigger achievements_process_queue
  after insert on public.achievement_eval_queue
  deferrable initially deferred
  for each row
  execute function public.achievement_process_queue_row();

-- ===========================================================================
-- 4. Permisos: internas
-- ===========================================================================
revoke execute on function public.achievement_enqueue_event(uuid) from public, anon, authenticated;
revoke execute on function public.achievement_enqueue_from_match() from public, anon, authenticated;
revoke execute on function public.achievement_enqueue_from_event_id() from public, anon, authenticated;
revoke execute on function public.achievement_enqueue_from_draft_event() from public, anon, authenticated;
revoke execute on function public.achievement_enqueue_from_bracket_match() from public, anon, authenticated;
revoke execute on function public.achievement_process_queue_row() from public, anon, authenticated;
