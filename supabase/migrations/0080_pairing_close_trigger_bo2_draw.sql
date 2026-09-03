-- 0080_pairing_close_trigger_bo2_draw.sql
-- Fix: update_event_champion_on_pairing_close (0012) solo disparaba compute_event_champion
-- cuando official_winner_participant_id pasaba de null a no-null. Un pairing round_robin BO2
-- resuelto como empate (official_draw: false -> true) nunca cumple esa transición —
-- official_winner_participant_id se queda en null para siempre — así que compute_event_champion
-- nunca llegaba a correr con la fase regular ya 100% resuelta. Resultado real observado: evento
-- con 10/10 pairings resueltos (9 con ganador + 1 empate BO2 decisivo) que se quedó con
-- final_pending=false para siempre, porque la última resolución (el empate) nunca disparó el
-- recálculo.
--
-- Mismo patrón que ya usa on_pairing_resolved_advance_swiss_bo2 (0045/0048): la condición de
-- disparo se traslada al WHEN del trigger (en vez de vivir solo como guard interno de la
-- función), y el guard interno se simplifica para reflejar la misma condición — necesario
-- porque el guard viejo (que solo miraba new.official_winner_participant_id) seguiría
-- descartando la invocación por empate aunque el WHEN ya la deje pasar.

create or replace function public.update_event_champion_on_pairing_close()
returns trigger
language plpgsql
security definer
as $function$
begin
  -- El WHEN del trigger ya filtra a las dos transiciones que nos interesan (ganador seteado, o
  -- empate BO2 resuelto); este guard es redundante a propósito, por si la función se llamara
  -- alguna vez fuera del trigger.
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;

  perform public.compute_event_champion(new.event_id);

  return new;
end;
$function$;

drop trigger if exists on_pairing_official_close_update_champion on public.pairings;
create trigger on_pairing_official_close_update_champion
  after update on public.pairings
  for each row
  when (
    (new.official_draw = true and old.official_draw = false)
    or (new.official_winner_participant_id is not null and old.official_winner_participant_id is null)
  )
  execute function public.update_event_champion_on_pairing_close();

-- Recalcular retroactivamente los eventos en 'playing' que puedan haber quedado con
-- final_pending desactualizado por este bug (mismo patrón que el backfill original de 0012).
do $$
declare
  v_event record;
begin
  for v_event in
    select id from public.draft_events
    where status = 'playing' and deleted_at is null
  loop
    perform public.compute_event_champion(v_event.id);
  end loop;
end;
$$;
