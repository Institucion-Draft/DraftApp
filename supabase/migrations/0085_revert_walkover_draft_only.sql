-- 0085_revert_walkover_draft_only.sql
-- Fix encontrado al implementar la Fase 3: revert_walkover_for_participant (0082) borraba
-- CUALQUIER match con is_walkover=true del participante, sin filtrar por match_type. Eso era
-- inofensivo mientras el único walkover posible fuera de fase regular (match_type='draft'),
-- pero la Fase 3 agrega apply_walkover_for_tiebreak_leg, que también inserta is_walkover=true
-- sobre match_type='tiebreak' — y esas matches viven sobre el MISMO pairing_id que el
-- enfrentamiento de fase regular entre esos dos participantes (round-robin: las piernas de
-- desempate reusan el pairing ya existente). Sin el filtro, "Revertir" después de un walkover
-- de desempate borraba esas matches de tiebreak Y ADEMÁS reseteaba pairings.official_winner_
-- participant_id/official_draw — pisando el resultado REAL de fase regular de ese pairing, que
-- nunca tuvo nada que ver con el desempate.
--
-- Fix: restringir el DELETE a match_type='draft' — el único tipo que esta función revierte
-- desde que existe (Fase 1). Revertir walkover de una pierna de desempate queda fuera de
-- alcance por ahora (no se pidió en Fase 3); si hace falta en el futuro, es una función nueva
-- y separada (revert_walkover_for_tiebreak_leg), no este mismo filtro ampliado.
create or replace function public.revert_walkover_for_participant(p_participant_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  with deleted as (
    delete from public.matches m
    using public.pairings p
    where m.pairing_id = p.id
      and m.is_walkover = true
      and m.match_type = 'draft'
      and m.winner_participant_id <> p_participant_id
      and (p.participant_a_id = p_participant_id or p.participant_b_id = p_participant_id)
    returning m.pairing_id
  ),
  distinct_pairings as (
    select distinct pairing_id from deleted
  )
  update public.pairings
  set official_winner_participant_id = null,
      official_resolved_at = null,
      official_draw = false
  where id in (select pairing_id from distinct_pairings);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
