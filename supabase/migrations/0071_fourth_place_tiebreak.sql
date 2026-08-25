-- 0071_fourth_place_tiebreak.sql
-- Desempate por el 4to puesto en round_robin_bo1_top4: cuando computeFinalStandingsWithTiebreakSplit
-- (podium.ts) detecta un empate exacto en el corte de la posición 4, el cliente arma la estructura
-- de partidos con computeFourthPlaceTiebreakBracket y este RPC la persiste.
--
-- Reutiliza event_tiebreak_groups / event_tiebreak_bracket_matches (la misma tabla que usa el
-- bracket de semis+final de 4to puesto real, ver 0026_tiebreak_bracket_matches.sql) en vez de
-- crear tablas nuevas:
--   - group_type = 'fourth_place' (nuevo valor) distingue este grupo del bracket real de top4
--     (group_type = 'bracket') para que el trigger evaluate_tiebreak_group_after_match, que hoy
--     solo sabe procesar 'round_robin' y 'bracket', lo ignore por completo (no-op) en vez de
--     tratarlo como el bracket del campeón. La lógica de avance/resolución de ESTE grupo
--     (siguiente ronda cuando se resuelve un partido, marcar ganador final, disparar recién ahí
--     create_round_robin_top4_bracket) se conecta en un paso posterior.
--   - group_origin = 'round_robin_fourth_place' (nuevo valor) para poder distinguirlo en el
--     cliente de 'round_robin_topcut' (el bracket real, "Fase mata-mata") cuando se construya el
--     banner/sección de UI en el paso posterior.
--   - bracket_phase reutiliza 'semi' (partido que todavía no define el 4to puesto, alimenta a
--     otro) y 'final' (el que sí lo define) sin necesitar 'third_place' ni un valor nuevo: no
--     hay disputa por 3er/4to dentro de este grupo, solo importa quién gana el 4to puesto.
--
-- Encadenado de partidos: al igual que el bracket real (que recién inserta la fila 'final' /
-- 'third_place' cuando ambas semis ya se jugaron, no al crear el grupo), acá solo se insertan en
-- event_tiebreak_bracket_matches los partidos con AMBOS lados ya conocidos (slot
-- {"participantId": ...}). Los partidos que dependen del ganador de otro
-- (slot {"winnerOfMatch": <índice>}) todavía no tienen participant_a_id/participant_b_id
-- concretos, así que no pueden vivir en esa tabla (sus columnas son not null). En cambio, la
-- estructura completa que mandó el cliente (computeFourthPlaceTiebreakBracket) se guarda tal
-- cual en la nueva columna pending_bracket_matches, para que el paso posterior arme esas filas
-- cuando el partido del que dependen se resuelva (ahí vive, por ejemplo, quién es el "bye" en un
-- grupo de 3 — el slot concreto del partido final que todavía no se insertó).

alter table public.event_tiebreak_groups
  add column if not exists pending_bracket_matches jsonb;

-- Ensanchar los CHECK de group_type / group_origin sin asumir el nombre exacto de la constraint
-- existente: la migración 0038/0068 ya mostró que agregar columnas/checks vía ALTER TABLE sin
-- CONSTRAINT explícito produce nombres autogenerados poco predecibles. Se buscan y dropean todas
-- las CHECK constraints que mencionan la columna en su definición, y se agrega una sola, con
-- nombre explícito, con el set de valores ampliado.
do $$
declare
  v_conname text;
begin
  for v_conname in
    select conname from pg_constraint
    where conrelid = 'public.event_tiebreak_groups'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%group_type%'
  loop
    execute format('alter table public.event_tiebreak_groups drop constraint %I', v_conname);
  end loop;
end $$;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_group_type_check
  check (group_type in ('round_robin', 'bracket', 'fourth_place'));

do $$
declare
  v_conname text;
begin
  for v_conname in
    select conname from pg_constraint
    where conrelid = 'public.event_tiebreak_groups'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%group_origin%'
  loop
    execute format('alter table public.event_tiebreak_groups drop constraint %I', v_conname);
  end loop;
end $$;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_group_origin_check
  check (group_origin in ('tiebreak', 'swiss_topcut', 'round_robin_topcut', 'round_robin_fourth_place'));

-- create_fourth_place_tiebreak_group: persiste la estructura de partidos calculada en el cliente
-- (computeFourthPlaceTiebreakBracket) para un evento round_robin_bo1_top4. Idempotente: no crea
-- un segundo grupo si ya existe uno (activo o resuelto) para este evento.
--
-- p_top3_ordered: las posiciones 1-3 de computeFinalStandingsWithTiebreakSplit, YA resueltas por
-- tanda 1 (no forman parte del grupo en disputa). Se guardan en event_tiebreak_group_participants
-- (seed 1-3, mismo mecanismo que usa el bracket real de top4 para sus 4 seeds) porque cuando este
-- desempate se resuelva, el trigger de avance necesita armar el top4 completo
-- [1°, 2°, 3°, ganador del desempate] y ese orden no es reconstruible en SQL sin repetir acá la
-- lógica de desempate olímpico + calidad de rivales + hash de podium.ts.
create or replace function public.create_fourth_place_tiebreak_group(
  p_event_id uuid,
  p_matches jsonb,
  p_top3_ordered uuid[]
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_format text;
  v_existing integer;
  v_group_id uuid;
  v_match jsonb;
  v_a_id uuid;
  v_b_id uuid;
  v_advances text;
  v_phase text;
  v_top3_distinct_count integer;
  v_top3_valid_count integer;
  v_top3_overlap_count integer;
  v_pid uuid;
  v_seed integer;
begin
  select competition_format into v_format
  from public.draft_events where id = p_event_id;

  if v_format <> 'round_robin_bo1_top4' then return false; end if;

  select count(*) into v_existing
  from public.event_tiebreak_groups
  where event_id = p_event_id and group_type = 'fourth_place';

  if v_existing > 0 then return false; end if;

  -- El bracket real de top4 se crea recién cuando este desempate se resuelve (paso posterior);
  -- si ya existe, este desempate llegó tarde/duplicado.
  if exists (
    select 1 from public.event_tiebreak_groups
    where event_id = p_event_id and group_type = 'bracket' and group_origin = 'round_robin_topcut'
  ) then
    return false;
  end if;

  -- Defensa en profundidad: la fase regular debe estar 100% resuelta, sin importar lo que el
  -- cliente haya calculado (mismo criterio que create_round_robin_top4_bracket, 0069).
  if exists (
    select 1 from public.pairings
    where event_id = p_event_id and official_winner_participant_id is null
  ) then
    return false;
  end if;

  if p_matches is null or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) = 0 then
    return false;
  end if;

  if p_top3_ordered is null or array_length(p_top3_ordered, 1) <> 3 then
    return false;
  end if;

  select count(*) into v_top3_distinct_count from (select distinct unnest(p_top3_ordered)) u;
  if v_top3_distinct_count <> 3 then return false; end if;

  select count(*) into v_top3_valid_count
  from public.event_participants ep
  where ep.id = any(p_top3_ordered) and ep.event_id = p_event_id and ep.role = 'player';
  if v_top3_valid_count <> 3 then return false; end if;

  -- Ninguno de los 3 ya resueltos puede aparecer como participante concreto dentro de p_matches
  -- (si aparece, no está realmente resuelto — es parte del grupo en disputa).
  select count(*) into v_top3_overlap_count
  from unnest(p_top3_ordered) t3
  where exists (
    select 1 from jsonb_array_elements(p_matches) m
    where (m->'a'->>'participantId')::uuid = t3 or (m->'b'->>'participantId')::uuid = t3
  );
  if v_top3_overlap_count > 0 then return false; end if;

  insert into public.event_tiebreak_groups
    (event_id, round_number, group_type, group_origin, status, pending_bracket_matches)
  values (p_event_id, 1, 'fourth_place', 'round_robin_fourth_place', 'active', p_matches)
  returning id into v_group_id;

  v_seed := 1;
  foreach v_pid in array p_top3_ordered
  loop
    insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
    select v_group_id, v_pid, ep.user_id, v_seed
    from public.event_participants ep
    where ep.id = v_pid;
    v_seed := v_seed + 1;
  end loop;

  for v_match in select * from jsonb_array_elements(p_matches)
  loop
    if not (v_match ? 'a') or not (v_match ? 'b') then continue; end if;
    if not (v_match->'a' ? 'participantId') or not (v_match->'b' ? 'participantId') then
      -- Depende del ganador de otro partido: se arma más adelante (paso posterior), leyendo
      -- pending_bracket_matches cuando ese partido se resuelva.
      continue;
    end if;

    v_a_id := (v_match->'a'->>'participantId')::uuid;
    v_b_id := (v_match->'b'->>'participantId')::uuid;
    v_advances := v_match->>'winnerAdvancesTo';
    v_phase := case when v_advances = 'final_4th' then 'final' else 'semi' end;

    insert into public.event_tiebreak_bracket_matches
      (group_id, bracket_phase, participant_a_id, participant_b_id)
    values (v_group_id, v_phase, v_a_id, v_b_id);
  end loop;

  perform public.link_bracket_matches_to_pairings(v_group_id);

  return true;
end;
$$;
