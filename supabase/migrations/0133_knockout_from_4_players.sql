-- 0133_knockout_from_4_players.sql
-- Copa (sólo llaves): acepta de 4 a 16 jugadores inscriptos (antes 8 a 16).
--
-- Estructura por cantidad de jugadores N:
--   N = 4        cuadro de 4:  primera ronda = semifinales (2 cruces, sin byes), después final y 3er y 4to
--   N = 5 a 8    cuadro de 8:  primera ronda = cuartos (4 posiciones), con 8 - N byes
--   N = 9 a 16   cuadro de 16: primera ronda = octavos (8 posiciones), con 16 - N byes (como hasta ahora)
--
-- Alcance:
--   1. knockout_pick_bye_positions generalizada a primera ronda de 4 y de 8 posiciones, con la misma
--      regla de balanceo de la 0132: la cantidad de cruces reales difiere como máximo en 1 entre la
--      mitad izquierda y la derecha (si es impar, la mitad con el extra se elige al azar) y, dentro de
--      cada mitad, se reparte parejo entre sus grupos de 2 posiciones (extra al azar). Con 4 posiciones
--      cada mitad tiene un único grupo. Con N = 4 (2 posiciones, sin byes) devuelve vacío.
--   2. draw_knockout_bracket: cuerpo de 0132 idéntico salvo (a) el tamaño del cuadro v_p = 4 / 8 / 16,
--      (b) la primera ronda 'semi' / 'quarter' / 'round_of_16', (c) los slots de las rondas sólo desde
--      la primera ronda que exista, y (d) la validación 4 a 16. El bloque de byes (llama al helper), el
--      avance de los que pasan directo y knockout_materialize quedan igual.
--   3. knockout_enforce_player_count (trigger BEFORE UPDATE de draft_events): 4 a 16 en lugar de 8 a 16.
--
-- Revisión de CHECK / constraints que podrían asumir 8 a 16 o que 'semi' nunca es la primera ronda
-- (resultado: NINGUNO bloquea, no hace falta tocarlos):
--   * event_tiebreak_bracket_matches_bracket_phase_check (0130): admite 'semi', 'quarter' y 'round_of_16'.
--   * knockout_slots_round_key_check (0130): admite las cinco rondas, incluida 'semi' como primera.
--   * knockout_slots_feeds_consistent / feeds_as_check (0130): no dependen de la ronda.
--   * knockout_slots_group_round_position_key (unique group, ronda, posición): sin supuesto de cantidad.
--   * draft_events: topcut_format ('bo1'/'bo3') y top_size null para 'knockout' (0130) no dependen de N.
--   * zones_count / zone_qualifiers / interzonal (0129): sólo aplican a 'zones_knockout'.
--   * knockout_materialize / knockout_advance / apply_knockout_walkover (0130): trabajan por
--     feeds_slot_id y por ronda; los perdedores de 'semi' van al 3er puesto aunque 'semi' sea la
--     primera ronda; no asumen que existan octavos ni cuartos.
--   * Vistas de puntos (0131): sólo leen 'final' y 'third_place'.
--
-- NO toca eventos ya sorteados: el sorteo es idempotente y esta migración no escribe ninguna tabla.

-- ===========================================================================
-- 1. Posiciones de los byes de la primera ronda, balanceadas (4 u 8 posiciones)
-- ===========================================================================
create or replace function public.knockout_pick_bye_positions(p_first_slots integer, p_byes integer)
returns integer[]
language plpgsql
volatile
set search_path = public
as $$
declare
  v_matches integer;
  v_left integer;
  v_groups_per_half integer;
  v_half integer;
  v_cnt integer;
  v_extra_first boolean;
  v_g integer;
  v_group integer;
  v_c integer;
  v_pa integer;
  v_pb integer;
  v_result integer[] := '{}'::integer[];
begin
  if p_byes <= 0 then
    return '{}'::integer[];  -- N = 4 (semifinales, 2 posiciones) y N = 8 / 16 (cuadro lleno): sin byes
  end if;

  -- Con byes la primera ronda son los cuartos (4 posiciones, N = 5 a 7) o los octavos (8 posiciones,
  -- N = 9 a 15); siempre queda al menos un cruce real.
  if p_first_slots not in (4, 8) or p_byes >= p_first_slots then
    raise exception 'knockout_pick_bye_positions: combinación inválida (posiciones %, byes %).', p_first_slots, p_byes;
  end if;

  v_matches := p_first_slots - p_byes;        -- cruces reales de la primera ronda (1 a 7)
  v_groups_per_half := p_first_slots / 4;     -- grupos de 2 posiciones por mitad: 1 con 4, 2 con 8

  -- Cruces reales en la mitad izquierda; si v_matches es impar, el extra va a una mitad al azar.
  v_left := v_matches / 2 + case when v_matches % 2 = 1 and random() < 0.5 then 1 else 0 end;

  for v_half in 0..1 loop
    v_cnt := case when v_half = 0 then v_left else v_matches - v_left end;
    v_extra_first := random() < 0.5;  -- con 2 grupos por mitad: cuál recibe el cruce extra

    for v_g in 0..v_groups_per_half - 1 loop
      v_group := v_half * v_groups_per_half + v_g + 1;  -- grupo 1..(2 * grupos por mitad)
      v_pa := 2 * v_group - 1;                           -- posiciones del grupo: 2k-1 y 2k
      v_pb := 2 * v_group;
      v_c := v_cnt / v_groups_per_half
             + case when v_cnt % v_groups_per_half = 1 and ((v_g = 0) = v_extra_first) then 1 else 0 end;

      if v_c = 0 then
        v_result := v_result || v_pa || v_pb;       -- ningún cruce real: los dos son byes
      elsif v_c = 1 then
        if random() < 0.5 then                       -- un cruce real: la posición con bye es al azar
          v_result := v_result || v_pb;
        else
          v_result := v_result || v_pa;
        end if;
      end if;                                        -- v_c = 2: los dos son cruces reales, sin byes
    end loop;
  end loop;

  if cardinality(v_result) <> p_byes then
    raise exception 'knockout_pick_bye_positions: se esperaban % byes y salieron %.', p_byes, cardinality(v_result);
  end if;

  return v_result;
end;
$$;

-- ===========================================================================
-- 2. draw_knockout_bracket: cuadro de 4, 8 o 16 según N
-- ===========================================================================
create or replace function public.draw_knockout_bracket(p_event_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_group_id uuid;
  v_players uuid[];
  v_n integer;
  v_p integer;
  v_byes integer;
  v_first_slots integer;
  v_first_round text;
  v_bye_positions integer[];
  v_pos integer;
  v_i integer;
begin
  select de.id, de.workspace_id, de.competition_format, de.status
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null
  for update;

  if v_event.id is null then
    raise exception 'draw_knockout_bracket: el evento no existe.';
  end if;

  if not public.can_manage_event(v_event.workspace_id, v_event.id) then
    raise exception 'draw_knockout_bracket: no tenés permisos para sortear las llaves de este evento.'
      using errcode = '42501';
  end if;

  if v_event.competition_format <> 'knockout' then
    raise exception 'draw_knockout_bracket: el evento no es una Copa (sólo llaves).';
  end if;

  -- Idempotente: si ya hay un sorteo vigente, se devuelve sin volver a sortear.
  select g.id into v_group_id
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  limit 1;
  if v_group_id is not null then
    return v_group_id;
  end if;

  if v_event.status <> 'playing' then
    raise exception 'draw_knockout_bracket: el sorteo se hace al finalizar el draft (el evento está en %).', v_event.status;
  end if;

  select array_agg(ep.id order by random()) into v_players
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player';

  v_n := coalesce(array_length(v_players, 1), 0);
  if v_n < 4 or v_n > 16 then
    raise exception 'Copa (sólo llaves): se necesitan entre 4 y 16 jugadores inscriptos (hay %).', v_n
      using errcode = '23514';
  end if;

  -- Tamaño del cuadro: 4 (N = 4, arranca en semifinales), 8 (N = 5 a 8, cuartos) o 16 (N = 9 a 16, octavos).
  v_p := case when v_n <= 4 then 4 when v_n <= 8 then 8 else 16 end;
  v_byes := v_p - v_n;
  v_first_slots := v_p / 2;
  v_first_round := case v_p when 4 then 'semi' when 8 then 'quarter' else 'round_of_16' end;

  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (p_event_id, 1, 'bracket', 'active', 'knockout_bracket')
  returning id into v_group_id;

  -- seed = posición en el sorteo (1..N).
  insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
  select v_group_id, ep.id, ep.user_id, t.ord::integer
  from unnest(v_players) with ordinality as t(pid, ord)
  join public.event_participants ep on ep.id = t.pid;

  insert into public.knockout_slots (group_id, round_key, "position")
  select v_group_id, r.round_key, gs
  from (values ('round_of_16', 8), ('quarter', 4), ('semi', 2), ('final', 1), ('third_place', 1)) as r(round_key, n)
  cross join lateral generate_series(1, r.n) as gs
  where (r.round_key <> 'round_of_16' or v_p = 16)  -- octavos sólo con N >= 9
    and (r.round_key <> 'quarter' or v_p >= 8);     -- cuartos sólo con N >= 5

  -- Cada slot alimenta al de la ronda siguiente: posición k -> ceil(k/2), lado 'a' si k es impar.
  update public.knockout_slots s
  set feeds_slot_id = n.id,
      feeds_as = case when s."position" % 2 = 1 then 'a' else 'b' end
  from public.knockout_slots n
  where s.group_id = v_group_id
    and n.group_id = v_group_id
    and n.round_key = case s.round_key
                        when 'round_of_16' then 'quarter'
                        when 'quarter' then 'semi'
                        when 'semi' then 'final'
                      end
    and n."position" = (s."position" + 1) / 2;

  -- Byes en cruces DISTINTOS de la primera ronda (como mucho P/2 - 1: nunca dos byes enfrentados),
  -- repartidos de forma balanceada entre las dos mitades del cuadro y entre los dos cuartos de cada
  -- mitad (ver knockout_pick_bye_positions, más arriba en esta migración).
  v_bye_positions := public.knockout_pick_bye_positions(v_first_slots, v_byes);

  v_i := 1;
  for v_pos in 1..v_first_slots loop
    if v_pos = any (v_bye_positions) then
      update public.knockout_slots s
      set participant_a_id = v_players[v_i], seed_a = v_i, is_bye = true,
          winner_participant_id = v_players[v_i]
      where s.group_id = v_group_id and s.round_key = v_first_round and s."position" = v_pos;
      v_i := v_i + 1;
    else
      update public.knockout_slots s
      set participant_a_id = v_players[v_i], seed_a = v_i,
          participant_b_id = v_players[v_i + 1], seed_b = v_i + 1
      where s.group_id = v_group_id and s.round_key = v_first_round and s."position" = v_pos;
      v_i := v_i + 2;
    end if;
  end loop;

  -- Los que pasan directo ocupan su lugar en la ronda siguiente (dos updates: un mismo slot
  -- siguiente puede recibir un bye de cada lado).
  update public.knockout_slots n
  set participant_a_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = v_group_id and s.is_bye and s.feeds_as = 'a' and n.id = s.feeds_slot_id;

  update public.knockout_slots n
  set participant_b_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = v_group_id and s.is_bye and s.feeds_as = 'b' and n.id = s.feeds_slot_id;

  perform public.knockout_materialize(v_group_id);

  return v_group_id;
end;
$$;

-- Los permisos de draw_knockout_bracket no cambian (CREATE OR REPLACE los conserva).

-- ===========================================================================
-- 3. Trigger: 4 a 16 jugadores inscriptos para iniciar el draft de una Copa (sólo llaves)
--    (misma función y mismo trigger trg_knockout_player_count de 0130: sólo cambia el rango)
-- ===========================================================================
create or replace function public.knockout_enforce_player_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if new.competition_format = 'knockout'
     and new.status in ('drafting', 'playing')
     and old.status = 'scheduled' then
    select count(*) into v_n
    from public.event_participants ep
    where ep.event_id = new.id and ep.role = 'player';

    if v_n < 4 or v_n > 16 then
      raise exception 'Copa (sólo llaves): se necesitan entre 4 y 16 jugadores inscriptos para iniciar el draft (hay %).', v_n
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- Verificación (comentada; correr aparte, SOLO LECTURA: no escribe ninguna tabla)
-- ===========================================================================
-- Simula 1000 sorteos de posiciones de byes para N = 4, 5, 6, 7, 8, 9, 10, 12, 15 y 16 y muestra, por N:
--   posiciones              : posiciones de la primera ronda (2, 4 u 8)
--   cruces_min / cruces_max : cruces reales de la primera ronda por sorteo (siempre p/2 - byes)
--   byes_incorrectos        : sorteos donde la cantidad de byes no es p - N (debe ser 0)
--   max_dif_mitades         : máxima diferencia de cruces reales entre la mitad izquierda y la derecha (<= 1)
--   max_dif_grupos          : máxima diferencia de cruces reales entre los dos grupos de una misma mitad (<= 1;
--                             con 4 posiciones cada mitad tiene un solo grupo, y con 2 no hay grupos: da 0)
--   hay_izq_mas / hay_der_mas : con cruces impares, la mitad con el extra varía al azar (ambas > 0)
--
-- with params as (
--   select n, case when n <= 4 then 4 when n <= 8 then 8 else 16 end as p
--   from unnest(array[4, 5, 6, 7, 8, 9, 10, 12, 15, 16]) as n
-- ), sims as (
--   select n, p, p / 2 as fs, public.knockout_pick_bye_positions(p / 2, p - n) as byes
--   from params cross join generate_series(1, 1000) as i
-- ), counts as (
--   select n, p, fs, byes,
--     (select count(*) from generate_series(1, fs / 2) x where x <> all (byes)) as left_m,
--     (select count(*) from generate_series(fs / 2 + 1, fs) x where x <> all (byes)) as right_m,
--     coalesce((select max(c) - min(c) from (
--       select (select count(*) from generate_series(2 * g - 1, 2 * g) x where x <> all (byes)) as c
--       from generate_series(1, fs / 4) g) q), 0) as dif_izq,
--     coalesce((select max(c) - min(c) from (
--       select (select count(*) from generate_series(2 * g - 1, 2 * g) x where x <> all (byes)) as c
--       from generate_series(fs / 4 + 1, fs / 2) g) q), 0) as dif_der
--   from sims
-- )
-- select n,
--        max(fs)                                                    as posiciones,
--        min(left_m + right_m)                                      as cruces_min,
--        max(left_m + right_m)                                      as cruces_max,
--        count(*) filter (where cardinality(byes) <> p - n)         as byes_incorrectos,
--        max(abs(left_m - right_m))                                 as max_dif_mitades,
--        max(greatest(dif_izq, dif_der))                            as max_dif_grupos,
--        count(*) filter (where left_m > right_m)                   as hay_izq_mas,
--        count(*) filter (where right_m > left_m)                   as hay_der_mas
-- from counts
-- group by n
-- order by n;
