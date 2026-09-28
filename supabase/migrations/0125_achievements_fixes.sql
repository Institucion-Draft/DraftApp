-- 0125_achievements_fixes.sql
--
-- Dos correcciones de lógica de negocio sobre evaluadores ya definidos en 0122/0123. Ninguna
-- toca schema: solo reemplaza el cuerpo de las funciones (create or replace), los permisos ya
-- otorgados/revocados en 0122/0123 se conservan tal cual.
--
-- 1. Merecido? (0123): sacamos la condición de "debe haber al menos una partida real jugada
--    antes del walkover" — esa restricción es de "Por la ventana" (que ni siquiera la usa) y se
--    había puesto mal acá. El disparador correcto es: ganar cualquier pairing/serie por
--    walkover (que la deja resuelta a favor de quien se queda), sin exigir ninguna partida
--    previa jugada en ese pairing. Se actualiza también el texto de la descripción (0121), que
--    hablaba de un enfrentamiento "en curso" — ya no aplica con el disparador corregido.
--
-- 2. El Plaga / El Super-Plaga (0122): pasan a ser exclusivos de competition_format =
--    'round_robin' (con o sin top4 — top_size no se filtra porque ambos logros solo miran fase
--    regular, no bracket). Antes achv_eval_plaga/achv_eval_super_plaga no filtraban por formato,
--    así que también se otorgaban en eventos Suizo: confirmado, había que corregirlo.

-- ===========================================================================
-- 1. Merecido?
-- ===========================================================================
create or replace function public.achv_eval_merecido(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
  v_series_won boolean;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  for r in
    select distinct
      m.pairing_id, m.match_type, coalesce(m.tiebreak_round, 1) as tb_round,
      m.winner_participant_id as stayer_id, ep.user_id
    from public.matches m
    join public.pairings pr on pr.id = m.pairing_id
    join public.event_participants ep on ep.id = m.winner_participant_id and ep.role = 'player'
    where pr.event_id = p_event_id
      and m.is_walkover
      and m.status = 'completed'
      and m.match_type in ('draft', 'tiebreak')
      and m.winner_participant_id is not null
  loop
    -- ¿el pairing / la serie quedó a favor de quien se quedó?
    if r.match_type = 'draft' then
      select exists (
        select 1 from public.pairings p
        where p.id = r.pairing_id and p.official_winner_participant_id = r.stayer_id
      ) into v_series_won;
    else
      select exists (
        select 1
        from public.event_tiebreak_bracket_matches bm
        join public.event_tiebreak_groups g on g.id = bm.group_id
        where bm.pairing_id = r.pairing_id
          and g.event_id = p_event_id
          and g.round_number = r.tb_round
          and g.status not in ('superseded', 'failed')
          and bm.winner_participant_id = r.stayer_id
      ) into v_series_won;
    end if;

    if v_series_won
       and public.grant_achievement('merecido', r.user_id, p_event_id,
             jsonb_build_object('pairing_id', r.pairing_id, 'match_type', r.match_type)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

update public.achievement_definitions
set description = 'Ganaste un enfrentamiento porque tu rival abandonó el evento.'
where code = 'merecido';

-- ===========================================================================
-- 2. El Plaga / El Super-Plaga: exclusivos de round_robin (con o sin top4)
-- ===========================================================================
create or replace function public.achv_eval_plaga(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_format text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select competition_format into v_format from public.draft_events where id = p_event_id;
  if v_format <> 'round_robin' then return 0; end if;

  for r in select * from public.achv_plaga_candidates(p_event_id) c where not c.is_super loop
    if public.grant_achievement('plaga', r.winner_user_id, p_event_id,
         jsonb_build_object('pairing_id', r.pairing_id, 'victim_user_id', r.victim_user_id)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

create or replace function public.achv_eval_super_plaga(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_format text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select competition_format into v_format from public.draft_events where id = p_event_id;
  if v_format <> 'round_robin' then return 0; end if;

  for r in select * from public.achv_plaga_candidates(p_event_id) c where c.is_super loop
    if public.grant_achievement('super_plaga', r.winner_user_id, p_event_id,
         jsonb_build_object('pairing_id', r.pairing_id, 'victim_user_id', r.victim_user_id)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
