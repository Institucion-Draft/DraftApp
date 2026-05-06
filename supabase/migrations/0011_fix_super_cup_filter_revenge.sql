-- 0011_fix_super_cup_filter_revenge.sql
-- Fix: el trigger update_pairing_super_cup no filtraba por match_type='revenge',
-- lo que causaba que ganar 2 partidas oficiales seguidas (en BO3 con barrida 2-0)
-- asignara espureamente la Súper Copa, que es exclusiva del mundo de venganzas.
--
-- Esta migración:
-- 1. Reescribe la función con el filtro correcto.
-- 2. Limpia todos los super_cup_winner_participant_id existentes (data espurea).
-- 3. Re-evalúa la Súper Copa correctamente para todos los pairings con venganzas,
--    asignándola al primer participante que ganó 2 venganzas consecutivas.

-- 1. Reescribir función con filtro de match_type
create or replace function public.update_pairing_super_cup()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_pairing public.pairings%rowtype;
  v_recent_winners uuid[];
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;
  if v_pairing.super_cup_winner_participant_id is not null then
    return new;
  end if;
  select array_agg(winner_participant_id order by match_number desc)
  into v_recent_winners
  from (
    select winner_participant_id, match_number
    from public.matches
    where pairing_id = new.pairing_id
      and match_type = 'revenge'
      and status = 'completed'
      and winner_participant_id is not null
    order by match_number desc
    limit 2
  ) recent;
  if array_length(v_recent_winners, 1) = 2
     and v_recent_winners[1] = v_recent_winners[2] then
    update public.pairings
    set super_cup_winner_participant_id = v_recent_winners[1],
        super_cup_resolved_at = now()
    where id = new.pairing_id
      and super_cup_winner_participant_id is null;
  end if;
  return new;
end;
$function$;

-- 2. Limpiar Súper Copas existentes (todas son espureas o serán recalculadas)
update public.pairings
set super_cup_winner_participant_id = null,
    super_cup_resolved_at = null
where super_cup_winner_participant_id is not null;

-- 3. Re-evaluar Súper Copa para todos los pairings con venganzas usando lógica correcta.
-- Para cada pairing, busca la primera secuencia de 2 venganzas consecutivas ganadas
-- por el mismo participante (ordenadas por match_number ascendente) y le asigna la
-- Súper Copa con el ended_at de la 2da venganza como resolved_at.
with revenge_seq as (
  select
    m.pairing_id,
    m.match_number,
    m.winner_participant_id,
    m.ended_at,
    lag(m.winner_participant_id) over (partition by m.pairing_id order by m.match_number) as prev_winner
  from public.matches m
  where m.match_type = 'revenge'
    and m.status = 'completed'
    and m.winner_participant_id is not null
),
super_cup_resolutions as (
  select distinct on (pairing_id)
    pairing_id,
    winner_participant_id,
    ended_at as resolved_at
  from revenge_seq
  where winner_participant_id = prev_winner
  order by pairing_id, match_number
)
update public.pairings p
set super_cup_winner_participant_id = scr.winner_participant_id,
    super_cup_resolved_at = scr.resolved_at
from super_cup_resolutions scr
where p.id = scr.pairing_id;
