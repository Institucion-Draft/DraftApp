-- 0095_swiss_unify_pairing_resolution_trigger.sql
-- Fase 6.3: retira el trigger paralelo y redundante de resolución de pairings de
-- swiss_bo2 (maybe_resolve_swiss_bo2_pairing), y hace que update_pairing_official_result
-- (el trigger genérico sobre matches que ya resuelve BO1/BO2/BO3 de round_robin desde
-- 0077) también resuelva swiss/swiss_bo2 correctamente, incluido el empate 1-1 de bo2.
--
-- Mapeo preciso del estado previo (confirmado leyendo el código, no folklore):
--   - update_pairing_official_result ya disparaba sin condición sobre TODO match
--     completado, para todo evento — pero decidía bo1/bo2/bo3 leyendo
--     draft_events.match_format, columna que NUNCA se setea para eventos suizos
--     (queda en el default 'bo3'). Para swiss BO3 esto da la casualidad de ser
--     correcto (el default coincide con el formato real). Para swiss_bo2 es
--     incorrecto: la rama 'bo3' SÍ detecta un barrido 2-0 (a_wins>=2 también es
--     cierto ahí) pero NUNCA detecta un empate 1-1 (la rama bo3 no tiene concepto
--     de empate) — por eso hacía falta maybe_resolve_swiss_bo2_pairing en paralelo,
--     que es lo único que hoy resuelve el 1-1 en swiss_bo2. En el caso 2-0 ambos
--     triggers corrían en paralelo sobre la misma partida (redundante pero
--     inofensivo: el segundo UPDATE queda bloqueado por el guard
--     "where official_winner_participant_id is null").
--   - El avance de ronda (maybe_advance_swiss_round / maybe_advance_swiss_bo2_round)
--     YA escucha la señal genérica de pairings.official_winner_participant_id /
--     official_draw desde 0034 — no hace falta tocarlo en esta fase.
--
-- Fix: update_pairing_official_result deriva el match_format efectivo con el mismo
-- shim temporal de Fase 6.2 (swiss_effective_match_format) cuando el evento es
-- swiss/swiss_bo2, en vez de confiar en la columna match_format (que Fase 6.4
-- corrige de raíz). Esto enruta swiss_bo2 a la rama 'bo2' ya existente (la misma
-- que usa round_robin BO2), que ya sabe resolver el empate — sin código nuevo.
-- Una vez hecho esto, maybe_resolve_swiss_bo2_pairing queda 100% redundante y se
-- retira junto con su trigger.
--
-- VERIFICACIÓN AUTOMÁTICA incluida al final: para todo pairing de swiss/swiss_bo2
-- YA resuelto (ganador o empate) en la base de destino, recalcula a mano —con la
-- MISMA lógica que la función nueva— el resultado a partir de sus matches, y lo
-- compara contra lo que está persistido (escrito por el sistema viejo de dos
-- triggers). Si un solo pairing difiere, aborta la migración entera (transacción
-- implícita del archivo) sin aplicar nada. No cubre timing/orden de disparo en
-- vivo (eso se prueba con un evento real después de aplicar, empate 1-1 incluido).

-- ===========================================================================
-- 1. update_pairing_official_result — deriva match_format efectivo para swiss
-- ===========================================================================
create or replace function public.update_pairing_official_result()
returns trigger
language plpgsql
security definer
as $$
declare
  v_competition_format text;
  v_match_format text;
  v_a_wins integer;
  v_b_wins integer;
  v_completed integer;
  v_winning_participant_id uuid;
  v_pairing public.pairings%rowtype;
begin
  select * into v_pairing from public.pairings where id = new.pairing_id;

  select de.competition_format, de.match_format
  into v_competition_format, v_match_format
  from public.draft_events de
  where de.id = v_pairing.event_id;

  -- Shim temporal (igual que swiss_points_of/swiss_opponents/swiss_match_winrate
  -- desde Fase 6.2): match_format no se setea para eventos suizos, se deriva de
  -- competition_format. Fase 6.4 retira este shim y usa match_format directamente.
  if v_competition_format in ('swiss', 'swiss_bo2') then
    v_match_format := public.swiss_effective_match_format(v_pairing.event_id);
  end if;

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

-- ===========================================================================
-- 2. Retirar el trigger paralelo y redundante de swiss_bo2
-- ===========================================================================
drop trigger if exists on_match_completed_resolve_swiss_bo2 on public.matches;
drop function if exists public.maybe_resolve_swiss_bo2_pairing();

-- ===========================================================================
-- 3. VERIFICACIÓN AUTOMÁTICA: recalcular a mano la resolución de todo pairing
--    swiss/swiss_bo2 YA resuelto y compararla contra lo persistido.
-- ===========================================================================
create temporary table _swiss_resolution_check on commit drop as
select
  p.id as pairing_id,
  p.event_id,
  p.participant_a_id,
  p.participant_b_id,
  p.official_winner_participant_id as persisted_winner,
  p.official_draw as persisted_draw,
  count(*) filter (where m.winner_participant_id = p.participant_a_id) as a_wins,
  count(*) filter (where m.winner_participant_id = p.participant_b_id) as b_wins,
  count(*) as completed,
  public.swiss_effective_match_format(p.event_id) as effective_format
from public.pairings p
join public.draft_events de on de.id = p.event_id
join public.matches m
  on m.pairing_id = p.id and m.match_type = 'draft' and m.status = 'completed'
where de.competition_format in ('swiss', 'swiss_bo2')
  and (p.official_winner_participant_id is not null or p.official_draw = true)
group by p.id, p.event_id, p.participant_a_id, p.participant_b_id,
         p.official_winner_participant_id, p.official_draw;

do $$
declare
  v_mismatch_count integer;
  v_details text;
  v_total integer;
begin
  select count(*) into v_total from _swiss_resolution_check;

  select count(*), string_agg(
    format(
      'pairing %s (event %s, formato efectivo %s): persistido ganador=%s empate=%s | recalculado ganador=%s empate=%s (a_wins=%s b_wins=%s completed=%s)',
      pairing_id, event_id, effective_format,
      persisted_winner, persisted_draw,
      expected_winner, expected_draw,
      a_wins, b_wins, completed
    ), E'\n'
  )
  into v_mismatch_count, v_details
  from (
    select *,
      case
        when a_wins >= 2 then participant_a_id
        when b_wins >= 2 then participant_b_id
        else null
      end as expected_winner,
      case
        when a_wins >= 2 or b_wins >= 2 then false
        when effective_format = 'bo2' and completed >= 2 then true
        else false
      end as expected_draw
    from _swiss_resolution_check
  ) x
  where persisted_winner is distinct from expected_winner
     or persisted_draw is distinct from expected_draw;

  if v_mismatch_count > 0 then
    raise exception 'Fase 6.3: % discrepancia(s) de % pairing(s) verificado(s) entre la resolución vieja (dos triggers paralelos) y la nueva (update_pairing_official_result unificada). Migración abortada, nada quedó aplicado. Detalle:
%', v_mismatch_count, v_total, v_details;
  end if;

  raise notice 'Fase 6.3: verificación OK — % pairing(s) de evento(s) swiss/swiss_bo2 real(es) ya resuelto(s), la resolución nueva coincide exactamente con la persistida. Falta la prueba en vivo (2-0 y 1-1) con un evento real post-deploy.', v_total;
end;
$$;
