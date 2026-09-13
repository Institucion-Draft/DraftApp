-- 0097_swiss_pairing_backtracking.sql
-- Fix del bug real detectado en producción (evento 87f4cb9a-698e-464f-98b1-78f030874679,
-- reparado a mano): el emparejamiento suizo era puramente greedy (primera opción válida,
-- sin backtracking) y podía "pintarse solo en una esquina" — comprometer una pareja
-- temprano en la ronda que hacía matemáticamente imposible completarla más adelante, aunque
-- existiera una combinación perfecta usando exactamente los mismos cruces disponibles. Como
-- pairings tiene unique(event_id, participant_a_id, participant_b_id), el fallback viejo
-- ("usar el siguiente aunque ya haya jugado") no creaba una repetición nueva: ROBABA la fila
-- ya jugada de una ronda anterior, pisándole swiss_round sin resetear el resultado — la
-- ronda vieja quedaba con un cruce de menos, y la ronda nueva con un cruce "ya resuelto"
-- con un resultado ajeno, sin que nadie jugara nada.
--
-- Diseño (acordado antes de escribir código):
--   1. swiss_find_valid_pairing(pool, ya_jugados): función pura y recursiva con
--      backtracking real — prueba candidatos en el mismo orden de prioridad que antes
--      (puntos/OMW descendente), y si un candidato lleva a un callejón sin salida más
--      adelante, lo descarta y prueba el siguiente. Solo considera cruces NUNCA jugados —
--      ya no existe la rama de "repetir como último recurso". Devuelve NULL si
--      genuinamente no hay combinación válida (nunca fuerza un repetido silencioso).
--      Recibe ya_jugados como parámetro (no consulta la tabla pairings ella misma) para que
--      sea 100% pura y testeable sin tocar la base — generate_swiss_round y
--      generate_swiss_bo2_round arman ese array una sola vez antes de llamarla.
--   2. Compartida entre generate_swiss_round (BO1/BO3) y generate_swiss_bo2_round (BO2):
--      ambas arman su propio pool ordenado (con su propia selección de bye, sin cambios
--      ahí) y llaman a la misma función para el emparejamiento en sí.
--   3. maybe_advance_swiss_round envuelve el llamado a generar la ronda siguiente en un
--      BEGIN/EXCEPTION: si no hay combinación válida, NO deja que la excepción aborte la
--      transacción completa (que es la MISMA transacción del resultado que alguien acaba
--      de cargar — dejaríamos a alguien sin poder guardar un partido válido por un problema
--      ajeno). En cambio, persiste el motivo en draft_events.swiss_pairing_blocked_reason
--      (nullable, se limpia solo en el próximo avance exitoso) para que la UI lo pueda
--      mostrar más adelante (fuera de alcance de esta migración — solo el mecanismo).
--
-- Se conecta con la validación de rondas máximas (N-1) todavía pendiente: esa validación
-- es la primera línea de defensa (evita la forma más obvia de pedir más rondas de las
-- matemáticamente posibles); este fix es la red de seguridad para los casos más raros
-- donde incluso con una cantidad de rondas válida, el historial específico de cruces deja
-- un estado genuinamente sin combinación — en vez de corromper datos en silencio, ahora
-- queda una señal explícita y visible.

-- ===========================================================================
-- 0. Columna para señalizar bloqueo (nullable, se limpia sola en el próximo éxito)
-- ===========================================================================
alter table public.draft_events
  add column if not exists swiss_pairing_blocked_reason text;

-- ===========================================================================
-- 1. swiss_find_valid_pairing: backtracking puro, sin tocar la base
-- ===========================================================================
-- p_pool: participantes a emparejar, YA ordenados por prioridad (puntos/OMW desc) y SIN
--   quien recibe bye esta ronda (eso lo decide el caller antes de llamar). Debe tener
--   cantidad par de elementos.
-- p_already_played: pares ya jugados en el evento, aplanado [a1,b1,a2,b2,...] (el orden
--   dentro de cada par no importa, se compara en ambos sentidos).
-- Devuelve: [p1,rival1,p2,rival2,...] con TODOS los elementos de p_pool, sin usar ningún
--   par de p_already_played — o NULL si no existe ninguna combinación así.
create or replace function public.swiss_find_valid_pairing(
  p_pool uuid[],
  p_already_played uuid[]
)
returns uuid[]
language plpgsql
immutable
as $$
declare
  v_p1 uuid;
  v_rest uuid[];
  v_candidate uuid;
  v_new_rest uuid[];
  v_sub_result uuid[];
  v_n integer;
  v_i integer;
  v_j integer;
  v_played boolean;
begin
  v_n := coalesce(array_length(p_pool, 1), 0);
  if v_n = 0 then
    return '{}'::uuid[];
  end if;
  if v_n = 1 then
    -- No debería llegar acá (el caller ya sacó el bye antes de llamar), pero un pool
    -- impar no tiene emparejamiento posible por definición.
    return null;
  end if;

  v_p1 := p_pool[1];
  v_rest := p_pool[2:v_n];

  for v_i in 1 .. array_length(v_rest, 1) loop
    v_candidate := v_rest[v_i];

    v_played := false;
    v_j := 1;
    while v_j <= coalesce(array_length(p_already_played, 1), 0) loop
      if (p_already_played[v_j] = v_p1 and p_already_played[v_j + 1] = v_candidate)
        or (p_already_played[v_j] = v_candidate and p_already_played[v_j + 1] = v_p1)
      then
        v_played := true;
        exit;
      end if;
      v_j := v_j + 2;
    end loop;

    if v_played then
      continue;
    end if;

    -- Candidato sin jugar contra v_p1: intentar completar el resto del pool sin él.
    v_new_rest := v_rest[1:v_i - 1] || v_rest[v_i + 1:array_length(v_rest, 1)];
    v_sub_result := public.swiss_find_valid_pairing(v_new_rest, p_already_played);

    if v_sub_result is not null then
      return array[v_p1, v_candidate] || v_sub_result;
    end if;
    -- Este candidato llevó a un callejón sin salida más adelante: backtrackear y
    -- probar el siguiente candidato para v_p1 (a diferencia del algoritmo viejo, que
    -- se conformaba con el primero disponible y nunca volvía atrás).
  end loop;

  -- Ningún candidato para v_p1 permite completar el resto: no hay solución desde acá.
  return null;
end;
$$;

-- ===========================================================================
-- 2. generate_swiss_round (BO1/BO3): usa swiss_find_valid_pairing
-- ===========================================================================
create or replace function public.generate_swiss_round(p_event_id uuid, p_round integer)
returns void
language plpgsql
security definer
as $$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_already_played uuid[] := '{}';
  v_rec record;
  v_result uuid[];
  v_p_a uuid;
  v_p_b uuid;
  v_k integer;
begin
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and not (p_round = any (ep.bye_rounds))
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  for v_rec in
    select participant_a_id, participant_b_id
    from public.pairings
    where event_id = p_event_id and swiss_round is not null
  loop
    v_already_played := v_already_played || v_rec.participant_a_id || v_rec.participant_b_id;
  end loop;

  v_result := public.swiss_find_valid_pairing(v_remaining_participants, v_already_played);

  if v_result is null then
    raise exception 'No existe una combinación de cruces sin repetidos para la ronda % del evento % (Suizo).', p_round, p_event_id;
  end if;

  v_k := 1;
  while v_k <= coalesce(array_length(v_result, 1), 0) loop
    if v_result[v_k] < v_result[v_k + 1] then
      v_p_a := v_result[v_k]; v_p_b := v_result[v_k + 1];
    else
      v_p_a := v_result[v_k + 1]; v_p_b := v_result[v_k];
    end if;

    update public.pairings
    set swiss_round = p_round
    where event_id = p_event_id
      and participant_a_id = v_p_a
      and participant_b_id = v_p_b;

    v_k := v_k + 2;
  end loop;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  perform public.recalc_swiss_tiebreakers(p_event_id);
end;
$$;

-- ===========================================================================
-- 3. generate_swiss_bo2_round (BO2): mismo fix, misma función compartida
-- ===========================================================================
create or replace function public.generate_swiss_bo2_round(p_event_id uuid, p_round integer)
returns void
language plpgsql
security definer
as $$
declare
  v_total_players integer;
  v_has_odd boolean;
  v_bye_participant_id uuid;
  v_remaining_participants uuid[];
  v_already_played uuid[] := '{}';
  v_rec record;
  v_result uuid[];
  v_p_a uuid;
  v_p_b uuid;
  v_k integer;
begin
  perform public.generate_all_pairings(p_event_id);

  select count(*) into v_total_players
  from public.event_participants
  where event_id = p_event_id and role = 'player' and left_event_at is null;

  v_has_odd := (v_total_players % 2 = 1);

  if v_has_odd then
    select ep.id into v_bye_participant_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and coalesce(array_length(ep.bye_rounds, 1), 0) = 0
    order by public.swiss_points_of(p_event_id, ep.id) asc,
             coalesce(ep.swiss_omw, 0) asc
    limit 1;

    if v_bye_participant_id is not null then
      update public.event_participants
      set bye_rounds = array_append(bye_rounds, p_round)
      where id = v_bye_participant_id;
    end if;
  end if;

  select array_agg(ep.id order by public.swiss_points_of(p_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc)
  into v_remaining_participants
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
    and (v_bye_participant_id is null or ep.id <> v_bye_participant_id);

  for v_rec in
    select participant_a_id, participant_b_id
    from public.pairings
    where event_id = p_event_id and swiss_round is not null
  loop
    v_already_played := v_already_played || v_rec.participant_a_id || v_rec.participant_b_id;
  end loop;

  v_result := public.swiss_find_valid_pairing(v_remaining_participants, v_already_played);

  if v_result is null then
    raise exception 'No existe una combinación de cruces sin repetidos para la ronda % del evento % (Suizo BO2).', p_round, p_event_id;
  end if;

  v_k := 1;
  while v_k <= coalesce(array_length(v_result, 1), 0) loop
    if v_result[v_k] < v_result[v_k + 1] then
      v_p_a := v_result[v_k]; v_p_b := v_result[v_k + 1];
    else
      v_p_a := v_result[v_k + 1]; v_p_b := v_result[v_k];
    end if;

    update public.pairings
    set swiss_round = p_round
    where event_id = p_event_id
      and participant_a_id = v_p_a
      and participant_b_id = v_p_b;

    v_k := v_k + 2;
  end loop;

  update public.draft_events set current_swiss_round = p_round where id = p_event_id;

  perform public.recalc_swiss_tiebreakers(p_event_id);
end;
$$;

-- ===========================================================================
-- 4. maybe_advance_swiss_round: envolver el avance de ronda en BEGIN/EXCEPTION
-- ===========================================================================
create or replace function public.maybe_advance_swiss_round()
returns trigger
language plpgsql
security definer
as $$
declare
  v_event_id uuid;
  v_competition_format text;
  v_match_format text;
  v_current_round integer;
  v_total_rounds integer;
  v_pending_pairings integer;
  v_top4 uuid[];
  v_new_group_id uuid;
begin
  if new.official_winner_participant_id is null and new.official_draw is not true then
    return new;
  end if;
  if new.swiss_round is null then return new; end if;

  v_event_id := new.event_id;

  select competition_format, match_format, current_swiss_round,
         coalesce(swiss_rounds_manual, swiss_rounds_total)
  into v_competition_format, v_match_format, v_current_round, v_total_rounds
  from public.draft_events where id = v_event_id;

  if v_competition_format <> 'swiss' then return new; end if;
  if v_current_round is null then return new; end if;

  select count(*) into v_pending_pairings
  from public.pairings
  where event_id = v_event_id
    and swiss_round = v_current_round
    and official_winner_participant_id is null
    and official_draw = false;

  if v_pending_pairings > 0 then return new; end if;

  if v_current_round < v_total_rounds then
    -- No dejar que "no se pudo armar la ronda siguiente" aborte esta transacción: es la
    -- MISMA transacción del resultado que se acaba de cargar, que sí es válido y debe
    -- guardarse igual. Se persiste el motivo para que la UI lo muestre más adelante.
    begin
      if v_match_format = 'bo2' then
        perform public.generate_swiss_bo2_round(v_event_id, v_current_round + 1);
      else
        perform public.generate_swiss_round(v_event_id, v_current_round + 1);
      end if;
      update public.draft_events set swiss_pairing_blocked_reason = null where id = v_event_id;
    exception when others then
      update public.draft_events set swiss_pairing_blocked_reason = sqlerrm where id = v_event_id;
    end;
    return new;
  end if;

  -- Última ronda: generar bracket de top 4. Mismos criterios que la tabla de
  -- posiciones (Pts > OMW > GW > OGW) más el desempate final por user_id (0050/0093).
  select array_agg(ep.id order by public.swiss_points_of(v_event_id, ep.id) desc,
                                     coalesce(ep.swiss_omw, 0) desc,
                                     coalesce(ep.swiss_gw, 0) desc,
                                     coalesce(ep.swiss_ogw, 0) desc,
                                     ep.user_id asc)
  into v_top4
  from public.event_participants ep
  where ep.event_id = v_event_id and ep.role = 'player' and ep.left_event_at is null;

  if v_top4 is not null and array_length(v_top4, 1) >= 4 then
    v_top4 := v_top4[1:4];
    v_new_group_id := public.create_bracket_tiebreak_group(v_event_id, v_top4);
    update public.event_tiebreak_groups
    set group_origin = 'swiss_topcut'
    where id = v_new_group_id;
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- 5. VERIFICACIÓN AUTOMÁTICA: harness de swiss_find_valid_pairing
-- ===========================================================================
-- Helper de validación solo para este harness — se retira al final de la migración.
create or replace function public._swiss_test_validate_matching(
  p_pool uuid[], p_already_played uuid[], p_result uuid[]
)
returns boolean
language plpgsql
as $$
declare
  v_n integer;
  v_seen uuid[] := '{}';
  v_k integer;
  v_a uuid;
  v_b uuid;
  v_j integer;
begin
  if p_result is null then return false; end if;
  v_n := coalesce(array_length(p_pool, 1), 0);
  if coalesce(array_length(p_result, 1), 0) <> v_n then return false; end if;

  v_k := 1;
  while v_k <= v_n loop
    v_a := p_result[v_k];
    if not (v_a = any (p_pool)) then return false; end if;
    if v_a = any (v_seen) then return false; end if;
    v_seen := v_seen || v_a;
    v_k := v_k + 1;
  end loop;

  v_k := 1;
  while v_k <= v_n loop
    v_a := p_result[v_k];
    v_b := p_result[v_k + 1];
    v_j := 1;
    while v_j <= coalesce(array_length(p_already_played, 1), 0) loop
      if (p_already_played[v_j] = v_a and p_already_played[v_j + 1] = v_b)
        or (p_already_played[v_j] = v_b and p_already_played[v_j + 1] = v_a)
      then
        return false;
      end if;
      v_j := v_j + 2;
    end loop;
    v_k := v_k + 2;
  end loop;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.1 Caso real: Eli/Karen/Martín/Toxic/Esteban/Manu, evento 87f4cb9a-698e-464f-
--     98b1-78f030874679, con los resultados EXACTOS de ronda 1 y 2 que causaron el
--     bug. El algoritmo viejo se quedaba sin salida para Esteban en este escenario
--     exacto; el nuevo debe encontrar una combinación válida.
-- ---------------------------------------------------------------------------
do $$
declare
  v_eli uuid := gen_random_uuid();
  v_karen uuid := gen_random_uuid();
  v_martin uuid := gen_random_uuid();
  v_toxic uuid := gen_random_uuid();
  v_esteban uuid := gen_random_uuid();
  v_manu uuid := gen_random_uuid();
  v_pool uuid[];
  v_played uuid[];
  v_result uuid[];
begin
  -- Orden real por puntos/OMW al momento de generar la ronda 3 (ver diagnóstico previo).
  v_pool := array[v_eli, v_karen, v_martin, v_toxic, v_esteban, v_manu];
  -- Ronda 1: Karen-Eli, Manu-Martín, Toxic-Esteban. Ronda 2 (original): Toxic-Karen,
  -- Martín-Eli, Esteban-Manu.
  v_played := array[
    v_karen, v_eli,
    v_manu, v_martin,
    v_toxic, v_esteban,
    v_toxic, v_karen,
    v_martin, v_eli,
    v_esteban, v_manu
  ];

  v_result := public.swiss_find_valid_pairing(v_pool, v_played);

  if not public._swiss_test_validate_matching(v_pool, v_played, v_result) then
    raise exception 'Fase backtracking: FALLÓ el caso real reconstruido (Eli/Karen/Martín/Toxic/Esteban/Manu) — no encontró una combinación válida que sabemos que existe.';
  end if;

  raise notice 'Fase backtracking: OK — caso real reconstruido resuelto correctamente.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.2 N impar con bye: 5 jugadores, uno ya con bye en una ronda anterior. El
--     caller saca al que recibe el bye ANTES de llamar a la función (sin cambios
--     ahí); esto prueba que el pool par restante (4) sigue resolviéndose bien.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
  v_pool uuid[] := array[v_a, v_b, v_c, v_d]; -- el 5to (bye) ya fue excluido por el caller
  v_played uuid[] := array[v_a, v_b, v_c, v_d]; -- ronda previa: A-B, C-D
  v_result uuid[];
begin
  v_result := public.swiss_find_valid_pairing(v_pool, v_played);

  if not public._swiss_test_validate_matching(v_pool, v_played, v_result) then
    raise exception 'Fase backtracking: FALLÓ el caso de N impar con bye (pool de 4 tras sacar al bye).';
  end if;

  raise notice 'Fase backtracking: OK — N impar con bye resuelto correctamente.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.3 Cerca del máximo N-1: 6 jugadores, calendario round-robin completo por el
--     método del círculo (5 rondas, las 15 combinaciones posibles se usan todas
--     exactamente una vez). Se prueba que, con las 4 primeras rondas ya jugadas,
--     todavía encuentra la única combinación que queda para la 5ta (la última
--     posible) — el borde exacto del máximo teórico, sin fallar de más.
-- ---------------------------------------------------------------------------
do $$
declare
  v_p1 uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid();
  v_p4 uuid := gen_random_uuid();
  v_p5 uuid := gen_random_uuid();
  v_p6 uuid := gen_random_uuid();
  v_pool uuid[] := array[v_p1, v_p2, v_p3, v_p4, v_p5, v_p6];
  v_played uuid[];
  v_result uuid[];
begin
  -- Rondas 1-4 del método del círculo (p1 fijo, resto rota):
  -- R1: 1-6,2-5,3-4  R2: 1-5,6-4,2-3  R3: 1-4,5-3,6-2  R4: 1-3,4-2,5-6
  v_played := array[
    v_p1, v_p6, v_p2, v_p5, v_p3, v_p4,
    v_p1, v_p5, v_p6, v_p4, v_p2, v_p3,
    v_p1, v_p4, v_p5, v_p3, v_p6, v_p2,
    v_p1, v_p3, v_p4, v_p2, v_p5, v_p6
  ];
  -- Después de 4 rondas quedan exactamente 3 cruces sin jugar en TODO el evento
  -- (12 de los 15 posibles ya se usaron): 1-2, 3-6, 4-5 — la ronda 5 del método del
  -- círculo. No hay otra combinación posible: es el único matching perfecto que
  -- queda con esos 3 cruces.

  v_result := public.swiss_find_valid_pairing(v_pool, v_played);

  if not public._swiss_test_validate_matching(v_pool, v_played, v_result) then
    raise exception 'Fase backtracking: FALLÓ el caso cercano al máximo N-1 (ronda 5 de 5 posibles, 6 jugadores) — debía encontrar la única combinación restante.';
  end if;

  raise notice 'Fase backtracking: OK — ronda 5 de 5 (borde del máximo teórico) resuelta correctamente.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.4a Caso irresoluble real: alguien ya jugó contra TODO el resto del pool (la
--      forma más común y realista de quedar sin combinación — exceder el máximo
--      de rondas sin repetir). Debe devolver NULL, nunca forzar un repetido.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
  v_pool uuid[] := array[v_a, v_b, v_c, v_d];
  v_played uuid[] := array[v_a, v_b, v_a, v_c, v_a, v_d]; -- A ya jugó contra B, C y D
  v_result uuid[];
begin
  v_result := public.swiss_find_valid_pairing(v_pool, v_played);

  if v_result is not null then
    raise exception 'Fase backtracking: FALLÓ el caso irresoluble (jugador sin candidatos) — debía devolver NULL y devolvió una combinación.';
  end if;

  raise notice 'Fase backtracking: OK — caso irresoluble (jugador sin candidatos) devuelve NULL como corresponde.';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.4b Caso irresoluble sutil: A, B y C ya jugaron entre sí (triángulo cerrado),
--      D no jugó contra nadie — D es la única opción de los 3, pero solo puede
--      emparejarse con uno. Ningún jugador individual "se quedó sin candidatos"
--      (A, B y C todos tienen a D disponible), pero la estructura global es
--      irresoluble igual — prueba que el backtracking evalúa el conjunto completo,
--      no solo el primer nivel.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
  v_pool uuid[] := array[v_a, v_b, v_c, v_d];
  v_played uuid[] := array[v_a, v_b, v_a, v_c, v_b, v_c]; -- triángulo A-B-C cerrado
  v_result uuid[];
begin
  v_result := public.swiss_find_valid_pairing(v_pool, v_played);

  if v_result is not null then
    raise exception 'Fase backtracking: FALLÓ el caso irresoluble sutil (triángulo cerrado + 1) — debía devolver NULL y devolvió una combinación.';
  end if;

  raise notice 'Fase backtracking: OK — caso irresoluble sutil (triángulo cerrado + 1) devuelve NULL como corresponde.';
end;
$$;

-- Retirar el helper de test, no es parte del schema permanente.
drop function public._swiss_test_validate_matching(uuid[], uuid[], uuid[]);
