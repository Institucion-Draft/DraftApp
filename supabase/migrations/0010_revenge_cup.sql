-- 0010_revenge_cup.sql
-- Agrega columnas a pairings para trackear el ganador de la Copa Venganza
-- (la primera persona que llega a 3 venganzas ganadas en un pairing)
-- y crea el trigger que la asigna automáticamente.
-- La asignación es única: una vez asignada, no se recalcula.
-- Solo cuenta matches con match_type='revenge' y status='completed'.
-- Matches abortados o in_progress se ignoran, igual que para super_cup
-- y official_winner_participant_id.

alter table public.pairings
  add column if not exists revenge_cup_winner_participant_id uuid references public.event_participants(id),
  add column if not exists revenge_cup_resolved_at timestamptz;

create index if not exists idx_pairings_revenge_cup_winner
  on public.pairings (revenge_cup_winner_participant_id);

create or replace function public.update_pairing_revenge_cup()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_pairing public.pairings%rowtype;
  v_a_revenge_wins integer;
  v_b_revenge_wins integer;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  if v_pairing.revenge_cup_winner_participant_id is not null then
    return new;
  end if;

  select
    count(*) filter (where m.winner_participant_id = v_pairing.participant_a_id),
    count(*) filter (where m.winner_participant_id = v_pairing.participant_b_id)
  into v_a_revenge_wins, v_b_revenge_wins
  from public.matches m
  where m.pairing_id = new.pairing_id
    and m.match_type = 'revenge'
    and m.status = 'completed';

  if v_a_revenge_wins >= 3 then
    update public.pairings
    set revenge_cup_winner_participant_id = v_pairing.participant_a_id,
        revenge_cup_resolved_at = now()
    where id = new.pairing_id
      and revenge_cup_winner_participant_id is null;
  elsif v_b_revenge_wins >= 3 then
    update public.pairings
    set revenge_cup_winner_participant_id = v_pairing.participant_b_id,
        revenge_cup_resolved_at = now()
    where id = new.pairing_id
      and revenge_cup_winner_participant_id is null;
  end if;

  return new;
end;
$function$;

drop trigger if exists on_match_completed_revenge_cup on public.matches;
create trigger on_match_completed_revenge_cup
  after insert or update on public.matches
  for each row
  execute function public.update_pairing_revenge_cup();
