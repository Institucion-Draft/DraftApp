-- 0132_knockout_balanced_byes.sql
-- Copa (sólo llaves): el sorteo reparte los cruces REALES de octavos de forma balanceada entre las
-- dos mitades del cuadro.
--
-- Problema (0130): los byes se sorteaban con "order by random() limit v_byes" entre las 8 posiciones
-- de octavos, sin balancear. Con 10 jugadores los dos cruces de octavos caían en la misma mitad el
-- 43 % de las veces, y con 12 los cuatro cruces podían quedar del mismo lado.
--
-- Regla nueva. Los octavos son las posiciones 1 a 8: las posiciones 1 a 4 alimentan la mitad
-- izquierda (cuartos 1 y 2) y las 5 a 8 la derecha (cuartos 3 y 4). Con N jugadores (9 a 15) hay
-- N - 8 cruces reales de octavos y 16 - N byes.
--   * Entre las dos mitades, la cantidad de cruces reales difiere como máximo en 1. Si N - 8 es
--     impar, la mitad que recibe el cruce extra se elige al azar.
--   * Dentro de cada mitad, los cruces se reparten parejo entre sus dos cuartos (posiciones 1-2 /
--     3-4 / 5-6 / 7-8); si la cantidad es impar, el cuarto que recibe el extra se elige al azar.
--   * Las posiciones concretas dentro de cada cuarto también se eligen al azar.
--
-- Alcance: SOLO cambia cómo se eligen las posiciones de los byes.
--   1. Función interna knockout_pick_bye_positions(p_first_slots, p_byes): devuelve el arreglo de
--      posiciones de byes. Está separada para poder verificarla (ver la consulta comentada al final).
--   2. draw_knockout_bracket: CREATE OR REPLACE con el cuerpo de 0130 idéntico, salvo el bloque que
--      elegía las posiciones de los byes, que ahora llama a la función anterior. El orden aleatorio
--      de jugadores, los byes que avanzan y knockout_materialize quedan igual.
--
-- NO toca eventos ya sorteados: el sorteo es idempotente (si ya hay un grupo 'knockout_bracket'
-- vigente, devuelve ese grupo sin volver a sortear) y esta migración no escribe ninguna tabla.

-- ===========================================================================
-- 1. Posiciones de los byes de la primera ronda, balanceadas
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
    return '{}'::integer[];
  end if;

  -- Sólo hay byes con 9 a 15 jugadores: la primera ronda son los octavos (8 posiciones).
  if p_first_slots <> 8 or p_byes >= p_first_slots then
    raise exception 'knockout_pick_bye_positions: combinación inválida (posiciones %, byes %).', p_first_slots, p_byes;
  end if;

  v_matches := p_first_slots - p_byes;  -- cruces reales de octavos = N - 8 (1 a 7)

  -- Cruces reales en la mitad izquierda; si v_matches es impar, el extra va a una mitad al azar.
  v_left := v_matches / 2 + case when v_matches % 2 = 1 and random() < 0.5 then 1 else 0 end;

  for v_half in 0..1 loop
    v_cnt := case when v_half = 0 then v_left else v_matches - v_left end;
    v_extra_first := random() < 0.5;  -- cuál de los dos cuartos de la mitad recibe el cruce extra

    for v_g in 0..1 loop
      v_group := v_half * 2 + v_g + 1;  -- cuarto 1..4
      v_pa := 2 * v_group - 1;          -- posiciones del cuarto: 2k-1 y 2k
      v_pb := 2 * v_group;
      v_c := v_cnt / 2 + case when v_cnt % 2 = 1 and ((v_g = 0) = v_extra_first) then 1 else 0 end;

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

revoke execute on function public.knockout_pick_bye_positions(integer, integer) from public, anon, authenticated;

-- ===========================================================================
-- 2. draw_knockout_bracket: igual que 0130, salvo la elección de las posiciones de los byes
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
  if v_n < 8 or v_n > 16 then
    raise exception 'Copa (sólo llaves): se necesitan entre 8 y 16 jugadores inscriptos (hay %).', v_n
      using errcode = '23514';
  end if;

  v_p := case when v_n <= 8 then 8 else 16 end;
  v_byes := v_p - v_n;
  v_first_slots := v_p / 2;
  v_first_round := case when v_p = 8 then 'quarter' else 'round_of_16' end;

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
  where v_p = 16 or r.round_key <> 'round_of_16';

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

-- Los permisos de draw_knockout_bracket no cambian (CREATE OR REPLACE los conserva): execute para
-- authenticated, no para public ni anon (ver 0130, sección 9).

-- ===========================================================================
-- Verificación (comentada; correr aparte, SOLO LECTURA: no escribe ninguna tabla)
-- ===========================================================================
-- Simula 1000 sorteos de posiciones de byes para N = 9, 10, 12 y 15 y muestra, por N:
--   cruces_min / cruces_max : cruces reales de octavos por sorteo (siempre N - 8)
--   byes_incorrectos        : sorteos donde la cantidad de byes no es 16 - N (debe ser 0)
--   max_dif_mitades         : máxima diferencia de cruces reales entre la mitad izquierda y la
--                             derecha (debe ser <= 1)
--   max_dif_cuartos         : máxima diferencia de cruces reales entre los dos cuartos de una misma
--                             mitad (debe ser <= 1)
--   hay_izq_mas / hay_der_mas : con N - 8 impar, la mitad con el cruce extra varía al azar (ambas > 0)
--
-- with sims as (
--   select n, i, public.knockout_pick_bye_positions(8, 16 - n) as byes
--   from unnest(array[9, 10, 12, 15]) as n
--   cross join generate_series(1, 1000) as i
-- ), counts as (
--   select n, i, byes,
--     (select count(*) from generate_series(1, 4) p where p <> all (byes)) as left_m,
--     (select count(*) from generate_series(5, 8) p where p <> all (byes)) as right_m,
--     (select count(*) from generate_series(1, 2) p where p <> all (byes)) as q1,
--     (select count(*) from generate_series(3, 4) p where p <> all (byes)) as q2,
--     (select count(*) from generate_series(5, 6) p where p <> all (byes)) as q3,
--     (select count(*) from generate_series(7, 8) p where p <> all (byes)) as q4
--   from sims
-- )
-- select n,
--        count(*)                                                     as sorteos,
--        min(left_m + right_m)                                        as cruces_min,
--        max(left_m + right_m)                                        as cruces_max,
--        count(*) filter (where cardinality(byes) <> 16 - n)          as byes_incorrectos,
--        max(abs(left_m - right_m))                                   as max_dif_mitades,
--        max(greatest(abs(q1 - q2), abs(q3 - q4)))                    as max_dif_cuartos,
--        count(*) filter (where left_m > right_m)                     as hay_izq_mas,
--        count(*) filter (where right_m > left_m)                     as hay_der_mas
-- from counts
-- group by n
-- order by n;
