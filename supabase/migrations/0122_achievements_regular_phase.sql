-- 0122_achievements_regular_phase.sql
-- Sistema de logros de temporada, parte 2/4: helpers de lectura y evaluadores de los logros que
-- dependen de la FASE REGULAR / el resultado final de un evento:
--   plaga, super_plaga, duro_de_matar, tiempo_de_reflexionar, invicto, buen_companero.
--
-- Convenciones de todos los evaluadores achv_eval_<code>(event_id) -> integer (desbloqueos nuevos):
--   * entran por achievement_event_eligible (exclusión global: sandbox, 2HG, eliminado,
--     cancelado, fuera de la temporada) y otorgan SOLO vía grant_achievement (que la revalida);
--   * solo miran participantes role='player';
--   * el resultado "regular" de un pairing es pairings.official_winner_participant_id /
--     official_draw, que el trigger update_pairing_official_result deriva únicamente de partidas
--     match_type='draft' -> las venganzas (match_type='revenge') no lo afectan por construcción;
--   * son de solo lectura sobre el dominio: nunca modifican pairings/matches/eventos.

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- Pairings de FASE REGULAR de un evento. Round robin: todos. Suizo: solo los efectivamente
-- programados en una ronda (swiss_round no nulo; las filas sin ronda son cruces potenciales que
-- generate_all_pairings crea de más, ver 0099). has_walkover: el resultado regular se resolvió
-- (total o parcialmente) por walkover (partidas match_type='draft' con is_walkover).
create or replace function public.achv_regular_pairings(p_event_id uuid)
returns table (
  pairing_id uuid,
  participant_a_id uuid,
  participant_b_id uuid,
  winner_id uuid,
  is_draw boolean,
  is_resolved boolean,
  resolved_at timestamptz,
  has_walkover boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.participant_a_id,
    p.participant_b_id,
    p.official_winner_participant_id,
    (p.official_draw is true),
    (p.official_winner_participant_id is not null or p.official_draw is true),
    coalesce(p.official_resolved_at, p.created_at),
    exists (
      select 1 from public.matches m
      where m.pairing_id = p.id and m.match_type = 'draft' and m.is_walkover
    )
  from public.pairings p
  join public.draft_events de on de.id = p.event_id
  where p.event_id = p_event_id
    and (de.competition_format <> 'swiss' or p.swiss_round is not null);
$$;

-- ¿Terminó la fase regular de este participante?
--   Round robin: no le queda ningún pairing regular sin resolver.
--   Suizo: las rondas se generan de a una, así que "sin pendientes" es cierto entre rondas;
--   la fase regular termina recién cuando se llegó a la última ronda
--   (coalesce(swiss_rounds_manual, swiss_rounds_total), igual que maybe_advance_swiss_round) y
--   no queda ningún pairing de ronda sin resolver en TODO el evento. Un bye en la última ronda
--   no genera pairing, por eso el criterio de Suizo es del evento y no del participante.
create or replace function public.achv_regular_phase_complete(p_event_id uuid, p_participant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_format text;
  v_manual integer;
  v_total integer;
  v_current integer;
  v_rounds integer;
begin
  select competition_format, swiss_rounds_manual, swiss_rounds_total, current_swiss_round
  into v_format, v_manual, v_total, v_current
  from public.draft_events where id = p_event_id;

  if v_format = 'swiss' then
    v_rounds := coalesce(v_manual, v_total);
    if v_rounds is null or coalesce(v_current, 0) < v_rounds then
      return false;
    end if;
    return not exists (
      select 1 from public.achv_regular_pairings(p_event_id) r where not r.is_resolved
    );
  end if;

  return not exists (
    select 1 from public.achv_regular_pairings(p_event_id) r
    where not r.is_resolved
      and p_participant_id in (r.participant_a_id, r.participant_b_id)
  );
end;
$$;

-- Resultados de un participante en un evento, uno por "enfrentamiento" (unidad = pairing):
--   kind 'regular': cada pairing de fase regular.
--   kind 'bracket': cada partido de bracket/desempate (event_tiebreak_bracket_matches de grupos
--   no superseded ni failed).
-- outcome: 'W' / 'L' / 'D' (empate BO2). is_pending: todavía sin resolver. is_walkover: se
-- resolvió (total o parcialmente) por walkover.
create or replace function public.achv_participant_outcomes(p_event_id uuid, p_participant_id uuid)
returns table (kind text, outcome text, is_pending boolean, is_walkover boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    'regular'::text,
    case
      when r.winner_id = p_participant_id then 'W'
      when r.is_draw then 'D'
      when r.winner_id is not null then 'L'
      else null
    end,
    not r.is_resolved,
    r.has_walkover
  from public.achv_regular_pairings(p_event_id) r
  where p_participant_id in (r.participant_a_id, r.participant_b_id)
  union all
  select
    'bracket'::text,
    case
      when bm.winner_participant_id = p_participant_id then 'W'
      when bm.winner_participant_id is not null then 'L'
      else null
    end,
    bm.winner_participant_id is null,
    exists (
      select 1 from public.matches m
      where m.pairing_id = bm.pairing_id
        and m.match_type = 'tiebreak'
        and coalesce(m.tiebreak_round, 1) = g.round_number
        and m.is_walkover
    )
  from public.event_tiebreak_bracket_matches bm
  join public.event_tiebreak_groups g on g.id = bm.group_id
  where g.event_id = p_event_id
    and g.status not in ('superseded', 'failed')
    and p_participant_id in (bm.participant_a_id, bm.participant_b_id);
$$;

-- ===========================================================================
-- 2. El Plaga / El Super-Plaga
-- ===========================================================================
-- Por cada participante (VÍCTIMA) que terminó su fase regular con EXACTAMENTE una derrota (el
-- empate BO2 no cuenta como derrota), el ganador de esa derrota se lleva el logro:
--   * Super-Plaga si esa derrota es el ÚLTIMO pairing resuelto de la víctima (official_resolved_at)
--     dentro de su fase regular;
--   * Plaga en cualquier otro caso. Son excluyentes: el ganador de un Super-Plaga NO recibe
--     además Plaga por esa misma víctima.
-- Una derrota resuelta por walkover NUNCA otorga el logro a quien "ganó" ese walkover. Las demás
-- derrotas por walkover de la víctima SÍ cuentan como derrotas (rompen su invicto).
create or replace function public.achv_plaga_candidates(p_event_id uuid)
returns table (winner_user_id uuid, victim_user_id uuid, pairing_id uuid, is_super boolean)
language sql
stable
security definer
set search_path = public
as $$
  with reg as materialized (
    select * from public.achv_regular_pairings(p_event_id)
  ),
  players as (
    select ep.id, ep.user_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player'
  ),
  victims as (
    select pl.id as victim_id, pl.user_id as victim_user_id
    from players pl
    where exists (
            select 1 from reg r
            where pl.id in (r.participant_a_id, r.participant_b_id)
          )
      and public.achv_regular_phase_complete(p_event_id, pl.id)
  ),
  losses as (
    select v.victim_id, v.victim_user_id, r.pairing_id, r.winner_id, r.resolved_at, r.has_walkover
    from victims v
    join reg r on v.victim_id in (r.participant_a_id, r.participant_b_id)
    where r.winner_id is not null and r.winner_id <> v.victim_id
  ),
  single_loss as (
    select l.*
    from losses l
    where (select count(*) from losses l2 where l2.victim_id = l.victim_id) = 1
  )
  select
    w.user_id,
    sl.victim_user_id,
    sl.pairing_id,
    not exists (
      select 1 from reg r2
      where sl.victim_id in (r2.participant_a_id, r2.participant_b_id)
        and r2.pairing_id <> sl.pairing_id
        and r2.resolved_at > sl.resolved_at
    )
  from single_loss sl
  join players w on w.id = sl.winner_id
  where not sl.has_walkover;
$$;

create or replace function public.achv_eval_plaga(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;
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
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;
  for r in select * from public.achv_plaga_candidates(p_event_id) c where c.is_super loop
    if public.grant_achievement('super_plaga', r.winner_user_id, p_event_id,
         jsonb_build_object('pairing_id', r.pairing_id, 'victim_user_id', r.victim_user_id)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 3. Duro de matar
-- ===========================================================================
-- Exclusivo de round_robin + top_size=4 (NO Suizo, NO round robin sin top). Por participante:
-- completó sus n-1 pairings de fase regular (n = jugadores del evento) sin ninguna derrota (el
-- empate BO2 no es derrota; los walkovers a favor no rompen la elegibilidad). Quien tiene
-- left_event_at no es elegible.
create or replace function public.achv_eval_duro_de_matar(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_format text;
  v_top integer;
  v_n_players integer;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select competition_format, top_size into v_format, v_top
  from public.draft_events where id = p_event_id;
  if v_format <> 'round_robin' or v_top is distinct from 4 then return 0; end if;

  select count(*) into v_n_players
  from public.event_participants where event_id = p_event_id and role = 'player';
  if v_n_players < 2 then return 0; end if;

  for r in
    with reg as materialized (select * from public.achv_regular_pairings(p_event_id))
    select ep.id as participant_id, ep.user_id
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
      and (select count(*) from reg x
           where ep.id in (x.participant_a_id, x.participant_b_id) and x.is_resolved) = v_n_players - 1
      and not exists (select 1 from reg x
                      where ep.id in (x.participant_a_id, x.participant_b_id) and not x.is_resolved)
      and not exists (select 1 from reg x
                      where ep.id in (x.participant_a_id, x.participant_b_id)
                        and x.winner_id is not null and x.winner_id <> ep.id)
  loop
    if public.grant_achievement('duro_de_matar', r.user_id, p_event_id, '{}'::jsonb) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 4. Tiempo de reflexionar
-- ===========================================================================
-- Evento en completed/concluded. Por participante (que no se fue del evento) sin ningún
-- enfrentamiento propio pendiente: TODOS sus enfrentamientos resueltos fueron derrotas (unidad =
-- pairing, regular o de bracket/desempate; el empate BO2 no es derrota). Los enfrentamientos
-- resueltos por walkover no cuentan como disputados. Sin mínimo: con 1 o más disputados y todos
-- perdidos, corresponde.
create or replace function public.achv_eval_tiempo_de_reflexionar(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select status into v_status from public.draft_events where id = p_event_id;
  if v_status not in ('completed', 'concluded') then return 0; end if;

  for r in
    select ep.id as participant_id, ep.user_id
    from public.event_participants ep
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
      and not exists (
        select 1 from public.achv_participant_outcomes(p_event_id, ep.id) o where o.is_pending
      )
      and (select count(*) from public.achv_participant_outcomes(p_event_id, ep.id) o
           where not o.is_walkover and o.outcome is not null) >= 1
      and not exists (
        select 1 from public.achv_participant_outcomes(p_event_id, ep.id) o
        where not o.is_walkover and o.outcome is not null and o.outcome <> 'L'
      )
  loop
    if public.grant_achievement('tiempo_de_reflexionar', r.user_id, p_event_id, '{}'::jsonb) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 5. Invicto
-- ===========================================================================
-- Se evalúa cuando el evento está en completed o concluded (después de un evento cerrado ya no
-- queda ningún camino futuro: todo camino de bracket termina en una derrota o en el campeonato,
-- que es lo que pasa el evento a completed). Por participante (role player, sin left_event_at):
--   * al menos una partida real ganada (los walkovers a favor NO cuentan como victoria);
--   * ninguna derrota: cualquier partida completed perdida (incluye derrotas por walkover),
--     excluyendo revenge y abortadas;
--   * en concluded, además: ningún enfrentamiento propio pendiente ni partida en curso.
create or replace function public.achv_eval_invicto(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select status into v_status from public.draft_events where id = p_event_id;
  if v_status not in ('completed', 'concluded') then return 0; end if;

  for r in
    select ep.id as participant_id, ep.user_id, rec.real_wins, rec.losses, rec.in_progress
    from public.event_participants ep
    cross join lateral (
      select
        count(*) filter (where m.status = 'completed' and m.winner_participant_id = ep.id
                           and not m.is_walkover)                              as real_wins,
        count(*) filter (where m.status = 'completed' and m.winner_participant_id <> ep.id) as losses,
        count(*) filter (where m.status = 'in_progress')                       as in_progress
      from public.matches m
      join public.pairings pr on pr.id = m.pairing_id
      where pr.event_id = p_event_id
        and ep.id in (pr.participant_a_id, pr.participant_b_id)
        and m.match_type in ('draft', 'final', 'tiebreak')
    ) rec
    where ep.event_id = p_event_id
      and ep.role = 'player'
      and ep.left_event_at is null
      and rec.real_wins >= 1
      and rec.losses = 0
  loop
    if v_status = 'concluded' then
      if r.in_progress > 0 then continue; end if;
      if exists (
        select 1 from public.achv_participant_outcomes(p_event_id, r.participant_id) o where o.is_pending
      ) then
        continue;
      end if;
    end if;

    if public.grant_achievement('invicto', r.user_id, p_event_id, '{}'::jsonb) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 6. Buen compañero
-- ===========================================================================
-- Round robin SIN top4, evento completed/concluded. Fuente: v_rr_no_top_regular_rank (la misma
-- que v_event_final_positions / Ranking Global; no computePodium del cliente).
-- OJO con el offset: la vista EXCLUYE al campeón, así que pos_rank=1 es el 2do puesto y
-- pos_rank=2 el 3ro (v_event_final_positions usa position = pos_rank + 1). Comparten 2do o 3er
-- puesto quienes tienen el mismo pos_rank en (1, 2) junto a al menos otra persona.
create or replace function public.achv_eval_buen_companero(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_format text;
  v_top integer;
  v_status text;
  r record;
  v_n integer := 0;
begin
  if not public.achievement_event_eligible(p_event_id) then return 0; end if;

  select competition_format, top_size, status into v_format, v_top, v_status
  from public.draft_events where id = p_event_id;
  if v_format <> 'round_robin' or v_top is not null or v_status not in ('completed', 'concluded') then
    return 0;
  end if;

  for r in
    select x.user_id, x.pos_rank
    from (
      select rk.user_id, rk.pos_rank, count(*) over (partition by rk.pos_rank) as same_rank
      from public.v_rr_no_top_regular_rank rk
      where rk.event_id = p_event_id
    ) x
    where x.pos_rank in (1, 2) and x.same_rank > 1
  loop
    if public.grant_achievement('buen_companero', r.user_id, p_event_id,
         jsonb_build_object('podium_position', r.pos_rank + 1)) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ===========================================================================
-- 7. Permisos: todo interno
-- ===========================================================================
revoke execute on function public.achv_regular_pairings(uuid) from public, anon, authenticated;
revoke execute on function public.achv_regular_phase_complete(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.achv_participant_outcomes(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.achv_plaga_candidates(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_plaga(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_super_plaga(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_duro_de_matar(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_tiempo_de_reflexionar(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_invicto(uuid) from public, anon, authenticated;
revoke execute on function public.achv_eval_buen_companero(uuid) from public, anon, authenticated;
