-- 0130_knockout_engine.sql
-- Fase 1a de Copa (sólo llaves): motor de llaves y capa de datos, SIN pantallas nuevas.
--
-- Camino acordado: knockout_slots guarda la ESTRUCTURA del árbol (con huecos y byes);
-- event_tiebreak_bracket_matches (más pairings con stage='bracket') recibe una fila SOLO cuando
-- ambos jugadores ya son concretos, igual que hoy. No cambia la forma de ninguna fila existente.
--
-- Alcance:
--   1. CHECKs ampliados: bracket_phase (+ 'round_of_16', 'quarter') y group_origin
--      (+ 'knockout_bracket'). Se conservan todos los valores vivos.
--   2. draft_events: Copa admite topcut_format 'bo1' o 'bo3' (no 'sf_bo1_f_bo3') y top_size null
--      en 'knockout'.
--   3. knockout_slots (estructura del árbol) con RLS: lectura para miembros del workspace, sin
--      escritura desde el cliente (sólo funciones security definer). NO se agrega a la publicación
--      realtime: en prod las tablas de bracket no están publicadas (sólo matches).
--   4. Funciones internas: knockout_walkover_row, knockout_materialize, knockout_advance.
--   5. evaluate_tiebreak_group_after_match: UNA rama temprana para group_origin='knockout_bracket'.
--      El resto del cuerpo no se toca (se verifica comparando con el cuerpo vivo).
--   6. RPC draw_knockout_bracket(p_event_id): sorteo idempotente y persistente.
--   7. RPC apply_knockout_walkover(p_participant_id): "Me voy" en Copa (resuelve el evento solo y
--      valida que sea 'knockout').
--   8. Trigger BEFORE UPDATE en draft_events: no se puede pasar a 'drafting' (ni saltearlo hacia
--      'playing') con menos de 8 o más de 16 jugadores inscriptos.
--   9. Verificación automática (patrón de 0129): snapshot y comparación de las vistas de ranking y
--      temporada, y comparación del cuerpo de evaluate_tiebreak_group_after_match.
--
-- Rondas: P = 8 si N = 8 (arranca en 'quarter'); P = 16 si 9 <= N <= 16 (arranca en
-- 'round_of_16'). byes = P - N; cruces de primera ronda = N - P/2. Los byes caen en cruces
-- distintos: nunca hay dos byes enfrentados entre sí.
--
-- Decisiones de comportamiento (iguales a las del top 4 real, 0100):
--   * El evento pasa a 'completed' al resolverse la final; el 3er puesto puede seguir pendiente.
--   * Si los dos de un cruce se fueron, el cruce queda pendiente (no hay a quién darle el walkover).
--   * "Me voy" de alguien que ya ganó su cruce y espera rival: cuando se arma su próximo cruce
--     (parche de "hueco" en cada ronda) el que se queda gana por walkover.
--
-- No se tocan: las vistas de ranking y temporada, compute_event_champion, create_*_top4_bracket,
-- los evaluadores de logros ni achievement_event_eligible. Los eventos Copa de prueba se crean
-- siempre con is_official = false hasta la fase de puntos y logros.
--
-- Idempotente: drop constraint/trigger/policy if exists, create table if not exists,
-- create or replace.

-- ===========================================================================
-- 0. SNAPSHOT "ANTES" (nada cambió todavía)
-- ===========================================================================
create temporary table _snap_0130_placement on commit drop as
select * from public.v_participant_event_placement;

create temporary table _snap_0130_final_positions on commit drop as
select * from public.v_event_final_positions;

create temporary table _snap_0130_workspace_points on commit drop as
select * from public.v_workspace_points;

create temporary table _snap_0130_season_points on commit drop as
select * from public.v_season_points;

create temporary table _snap_0130_eval_fn on commit drop as
select pg_get_functiondef('public.evaluate_tiebreak_group_after_match()'::regprocedure) as def;

-- ===========================================================================
-- 1. CHECKs ampliados (nombres vivos confirmados contra prod)
-- ===========================================================================
alter table public.event_tiebreak_bracket_matches
  drop constraint if exists event_tiebreak_bracket_matches_bracket_phase_check;

alter table public.event_tiebreak_bracket_matches
  add constraint event_tiebreak_bracket_matches_bracket_phase_check
    check (bracket_phase in ('round_of_16', 'quarter', 'semi', 'final', 'third_place'));

alter table public.event_tiebreak_groups
  drop constraint if exists event_tiebreak_groups_group_origin_check;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_group_origin_check
    check (group_origin in (
      'tiebreak', 'swiss_topcut', 'round_robin_topcut', 'round_robin_fourth_place',
      'round_robin_first_place', 'knockout_bracket'
    ));

-- ===========================================================================
-- 2. draft_events: reglas de Copa
-- ===========================================================================
-- Copa: llaves BO1 o BO3 ('sf_bo1_f_bo3' no aplica). El default de la columna sigue siendo 'bo3';
-- la pantalla de creación (fase 1b) setea 'bo1' por defecto para Copa.
alter table public.draft_events
  drop constraint if exists draft_events_cup_topcut_valid;

alter table public.draft_events
  add constraint draft_events_cup_topcut_valid
    check (competition_format not in ('zones_knockout', 'knockout') or topcut_format in ('bo1', 'bo3'));

-- Copa (sólo llaves): top_size queda en null.
alter table public.draft_events
  drop constraint if exists draft_events_knockout_top_size_null;

alter table public.draft_events
  add constraint draft_events_knockout_top_size_null
    check (competition_format <> 'knockout' or top_size is null);

-- ===========================================================================
-- 3. knockout_slots: estructura del árbol
-- ===========================================================================
create table if not exists public.knockout_slots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.event_tiebreak_groups(id) on delete cascade,
  round_key text not null,
  "position" smallint not null,
  seed_a smallint,
  seed_b smallint,
  participant_a_id uuid references public.event_participants(id) on delete cascade,
  participant_b_id uuid references public.event_participants(id) on delete cascade,
  is_bye boolean not null default false,
  feeds_slot_id uuid references public.knockout_slots(id) on delete cascade,
  feeds_as text,
  -- Agregadas a lo pedido: ganador del cruce (o el único jugador de un bye) y la fila jugable de
  -- event_tiebreak_bracket_matches una vez que ambos jugadores son concretos.
  winner_participant_id uuid references public.event_participants(id) on delete set null,
  bracket_match_id uuid references public.event_tiebreak_bracket_matches(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint knockout_slots_round_key_check
    check (round_key in ('round_of_16', 'quarter', 'semi', 'final', 'third_place')),
  constraint knockout_slots_feeds_as_check
    check (feeds_as is null or feeds_as in ('a', 'b')),
  constraint knockout_slots_feeds_consistent
    check ((feeds_slot_id is null) = (feeds_as is null)),
  constraint knockout_slots_group_round_position_key unique (group_id, round_key, "position")
);

create index if not exists idx_knockout_slots_group on public.knockout_slots (group_id);
create index if not exists idx_knockout_slots_bracket_match on public.knockout_slots (bracket_match_id);
create index if not exists idx_knockout_slots_feeds on public.knockout_slots (feeds_slot_id);

alter table public.knockout_slots enable row level security;

drop policy if exists "select_knockout_slots_for_workspace_members" on public.knockout_slots;
create policy "select_knockout_slots_for_workspace_members"
  on public.knockout_slots
  for select
  using (
    exists (
      select 1
      from public.event_tiebreak_groups g
      join public.draft_events de on de.id = g.event_id
      where g.id = knockout_slots.group_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

-- Sin escritura desde el cliente: sólo las funciones security definer de abajo.
revoke insert, update, delete, truncate on public.knockout_slots from anon, authenticated;
grant select on public.knockout_slots to authenticated;

-- ===========================================================================
-- 4. Funciones internas
-- ===========================================================================

-- Walkover de UN cruce de llaves: el que se queda gana por abandono. Inserta las partidas que le
-- faltan para llegar a las victorias necesarias (topcut_wins_needed, BO1 = 1, BO3 = 2). Mismo
-- mecanismo que apply_walkover_for_topcut_bracket_leg (0100): la partida se inserta
-- 'in_progress' y se completa en un UPDATE aparte, que es lo que dispara el trigger de avance.
create or replace function public.knockout_walkover_row(p_bm_id uuid, p_stayer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bm record;
  v_group record;
  v_needed integer;
  v_stayer_wins integer;
  v_to_insert integer;
  v_next_number integer;
  v_i integer;
  v_match_id uuid;
begin
  select bm.id, bm.group_id, bm.bracket_phase, bm.pairing_id, bm.winner_participant_id
  into v_bm
  from public.event_tiebreak_bracket_matches bm
  where bm.id = p_bm_id;

  if v_bm.id is null or v_bm.winner_participant_id is not null or v_bm.pairing_id is null then
    return 0;
  end if;

  select g.event_id, g.round_number into v_group
  from public.event_tiebreak_groups g where g.id = v_bm.group_id;

  v_needed := public.topcut_wins_needed(v_group.event_id, v_bm.bracket_phase);

  select count(*) into v_stayer_wins
  from public.matches
  where pairing_id = v_bm.pairing_id
    and match_type = 'tiebreak'
    and status = 'completed'
    and winner_participant_id = p_stayer_id;

  v_to_insert := v_needed - v_stayer_wins;
  if v_to_insert <= 0 then
    return 0;
  end if;

  select coalesce(max(match_number), 0) into v_next_number
  from public.matches where pairing_id = v_bm.pairing_id;

  for v_i in 1..v_to_insert loop
    insert into public.matches (pairing_id, match_number, match_type, status, tiebreak_round, started_at)
    values (v_bm.pairing_id, v_next_number + v_i, 'tiebreak', 'in_progress', v_group.round_number, now())
    returning id into v_match_id;

    update public.matches
    set status = 'completed', winner_participant_id = p_stayer_id, is_walkover = true, ended_at = now()
    where id = v_match_id;
  end loop;

  return v_to_insert;
end;
$$;

-- Materializa los cruces listos: todo slot con AMBOS jugadores concretos (y que no sea bye) que
-- todavía no tenga fila jugable recibe su fila en event_tiebreak_bracket_matches y su pairing
-- (stage='bracket'; si el par ya existía, se reusa la fila: el unique de pairings lo permite).
-- Parche de "hueco": si uno de los dos ya se fue (left_event_at), el que se queda gana por walkover
-- en el momento de armarse el cruce. Si se fueron los dos, el cruce queda pendiente.
create or replace function public.knockout_materialize(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_slot record;
  v_current uuid;
  v_bm_id uuid;
  v_pairing_id uuid;
  v_pa uuid;
  v_pb uuid;
  v_a_left boolean;
  v_b_left boolean;
  v_progress boolean;
begin
  select g.event_id into v_event_id from public.event_tiebreak_groups g where g.id = p_group_id;
  if v_event_id is null then
    return;
  end if;

  loop
    v_progress := false;

    for v_slot in
      select s.id, s.round_key, s.participant_a_id, s.participant_b_id
      from public.knockout_slots s
      where s.group_id = p_group_id
        and not s.is_bye
        and s.bracket_match_id is null
        and s.participant_a_id is not null
        and s.participant_b_id is not null
      order by case s.round_key
                 when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3
                 when 'final' then 4 else 5 end,
               s."position"
    loop
      -- Un walkover anidado puede haber materializado este slot mientras iterábamos.
      select s.bracket_match_id into v_current
      from public.knockout_slots s where s.id = v_slot.id for update;
      if v_current is not null then
        continue;
      end if;

      insert into public.event_tiebreak_bracket_matches
        (group_id, bracket_phase, participant_a_id, participant_b_id)
      values (p_group_id, v_slot.round_key, v_slot.participant_a_id, v_slot.participant_b_id)
      returning id into v_bm_id;

      v_pa := least(v_slot.participant_a_id, v_slot.participant_b_id);
      v_pb := greatest(v_slot.participant_a_id, v_slot.participant_b_id);

      insert into public.pairings (event_id, participant_a_id, participant_b_id, stage)
      values (v_event_id, v_pa, v_pb, 'bracket')
      on conflict (event_id, participant_a_id, participant_b_id) do nothing;

      select p.id into v_pairing_id
      from public.pairings p
      where p.event_id = v_event_id and p.participant_a_id = v_pa and p.participant_b_id = v_pb;

      update public.event_tiebreak_bracket_matches set pairing_id = v_pairing_id where id = v_bm_id;
      update public.knockout_slots set bracket_match_id = v_bm_id where id = v_slot.id;
      v_progress := true;

      select exists (select 1 from public.event_participants where id = v_slot.participant_a_id and left_event_at is not null),
             exists (select 1 from public.event_participants where id = v_slot.participant_b_id and left_event_at is not null)
      into v_a_left, v_b_left;

      if v_a_left and not v_b_left then
        perform public.knockout_walkover_row(v_bm_id, v_slot.participant_b_id);
      elsif v_b_left and not v_a_left then
        perform public.knockout_walkover_row(v_bm_id, v_slot.participant_a_id);
      end if;
    end loop;

    exit when not v_progress;
  end loop;
end;
$$;

-- Avance del árbol tras completarse una partida 'tiebreak' de un grupo 'knockout_bracket'.
-- Identifica la serie por pairing_id (en eliminación simple un par se enfrenta una sola vez),
-- cuenta victorias (walkover incluido) contra topcut_wins_needed, y cuando hay ganador: lo marca
-- en la fila y en el slot, lo manda al slot siguiente (los perdedores de semis al 3er puesto),
-- corona al campeón al resolverse la final y cierra el grupo recién cuando no queda ningún
-- cruce pendiente (no por cantidad de filas: las rondas se materializan de a una).
create or replace function public.knockout_advance(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match record;
  v_pairing record;
  v_group record;
  v_bm record;
  v_slot record;
  v_wins_a integer;
  v_wins_b integer;
  v_needed integer;
  v_winner uuid;
  v_loser uuid;
  v_champion_user uuid;
begin
  select m.id, m.pairing_id, m.match_type, m.status into v_match
  from public.matches m where m.id = p_match_id;

  if v_match.id is null or v_match.match_type <> 'tiebreak' or v_match.status <> 'completed' then
    return;
  end if;

  select p.id, p.event_id into v_pairing from public.pairings p where p.id = v_match.pairing_id;
  if v_pairing.id is null then
    return;
  end if;

  select g.id, g.event_id into v_group
  from public.event_tiebreak_groups g
  where g.event_id = v_pairing.event_id
    and g.group_origin = 'knockout_bracket'
    and g.status = 'active'
  limit 1;

  if v_group.id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('knockout:' || v_group.id::text));

  select bm.id, bm.bracket_phase, bm.participant_a_id, bm.participant_b_id into v_bm
  from public.event_tiebreak_bracket_matches bm
  where bm.group_id = v_group.id
    and bm.pairing_id = v_pairing.id
    and bm.winner_participant_id is null
  limit 1;

  if v_bm.id is null then
    return;
  end if;

  select count(*) filter (where m.winner_participant_id = v_bm.participant_a_id),
         count(*) filter (where m.winner_participant_id = v_bm.participant_b_id)
  into v_wins_a, v_wins_b
  from public.matches m
  where m.pairing_id = v_pairing.id
    and m.match_type = 'tiebreak'
    and m.status = 'completed';

  v_needed := public.topcut_wins_needed(v_group.event_id, v_bm.bracket_phase);

  if v_wins_a < v_needed and v_wins_b < v_needed then
    return;
  end if;

  if v_wins_a >= v_needed then
    v_winner := v_bm.participant_a_id;
    v_loser := v_bm.participant_b_id;
  else
    v_winner := v_bm.participant_b_id;
    v_loser := v_bm.participant_a_id;
  end if;

  update public.event_tiebreak_bracket_matches
  set winner_participant_id = v_winner, resolved_at = now()
  where id = v_bm.id;

  select s.id, s.round_key, s.feeds_slot_id, s.feeds_as into v_slot
  from public.knockout_slots s where s.bracket_match_id = v_bm.id;

  if v_slot.id is not null then
    update public.knockout_slots set winner_participant_id = v_winner where id = v_slot.id;

    if v_slot.feeds_slot_id is not null then
      update public.knockout_slots
      set participant_a_id = case when v_slot.feeds_as = 'a' then v_winner else participant_a_id end,
          participant_b_id = case when v_slot.feeds_as = 'b' then v_winner else participant_b_id end
      where id = v_slot.feeds_slot_id;
    end if;

    -- Los perdedores de las semis juegan el 3er puesto (misma posición que la semi: a / b).
    if v_slot.round_key = 'semi' then
      update public.knockout_slots
      set participant_a_id = case when v_slot.feeds_as = 'a' then v_loser else participant_a_id end,
          participant_b_id = case when v_slot.feeds_as = 'b' then v_loser else participant_b_id end
      where group_id = v_group.id and round_key = 'third_place';
    end if;

    if v_slot.round_key = 'final' then
      select ep.user_id into v_champion_user from public.event_participants ep where ep.id = v_winner;

      update public.draft_events
      set champion_user_id = v_champion_user,
          champion_decided_by = 'tiebreak',
          event_ended_at = now(),
          status = 'completed',
          final_pending = false
      where id = v_group.event_id and champion_user_id is null;

      update public.event_tiebreak_groups
      set champion_user_id = v_champion_user
      where id = v_group.id and champion_user_id is null;
    end if;
  end if;

  perform public.knockout_materialize(v_group.id);

  if not exists (
    select 1 from public.knockout_slots s
    where s.group_id = v_group.id and not s.is_bye and s.winner_participant_id is null
  ) then
    update public.event_tiebreak_groups
    set status = 'resolved', resolved_at = now()
    where id = v_group.id and status = 'active';
  end if;
end;
$$;

-- ===========================================================================
-- 5. evaluate_tiebreak_group_after_match: rama temprana para Copa
--    Cuerpo idéntico al vivo (0100) salvo la rama marcada "0130".
-- ===========================================================================
create or replace function public.evaluate_tiebreak_group_after_match()
returns trigger
language plpgsql
security definer
as $$
declare
  v_pairing record;
  v_event_id uuid;
  v_active_group record;
  v_participant_count integer;
  v_played_count integer;
  v_total_pairs_needed integer;
  v_winner_participant_id uuid;
  v_max_wins integer;
  v_leader_user_id uuid;
  v_leader_participant_ids uuid[];
  v_max_match_winrate numeric;
  v_winrate_leaders_count integer;
  v_event_already_completed boolean;
begin
  if new.match_type <> 'tiebreak' or new.status <> 'completed' then
    return new;
  end if;

  select event_id, participant_a_id, participant_b_id into v_pairing
  from public.pairings where id = new.pairing_id;
  v_event_id := v_pairing.event_id;

  select id, group_type, round_number, group_origin into v_active_group
  from public.event_tiebreak_groups
  where event_id = v_event_id and status = 'active'
  limit 1;

  if v_active_group.id is null then return new; end if;

  -- Copa (sólo llaves, group_origin='knockout_bracket', 0130): el avance lo resuelve
  -- knockout_advance (16avos a final + 3er puesto, byes, cierre del grupo). Los demás orígenes
  -- siguen exactamente por las ramas de abajo.
  if v_active_group.group_origin = 'knockout_bracket' then
    perform public.knockout_advance(new.id);
    return new;
  end if;

  select (status = 'completed') into v_event_already_completed
  from public.draft_events where id = v_event_id;

  -- ROUND ROBIN: sin cambios respecto a 0091.
  if v_active_group.group_type = 'round_robin' then
    select count(*) into v_participant_count
    from public.event_tiebreak_group_participants where group_id = v_active_group.id;

    v_total_pairs_needed := v_participant_count * (v_participant_count - 1) / 2;
    v_played_count := public.count_tiebreak_round_played(v_active_group.id, v_active_group.round_number);

    if v_event_already_completed then
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', resolved_at = now() where id = v_active_group.id;
      end if;
      return new;
    end if;

    select participant_id, public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number)
    into v_winner_participant_id, v_max_wins
    from public.event_tiebreak_group_participants where group_id = v_active_group.id
    order by public.count_tiebreak_round_wins(v_active_group.id, participant_id, v_active_group.round_number) desc limit 1;

    if v_max_wins = v_participant_count - 1 then
      select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      if v_played_count >= v_total_pairs_needed then
        update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      else
        update public.event_tiebreak_groups set champion_user_id = v_leader_user_id where id = v_active_group.id;
      end if;
      return new;
    end if;

    if v_played_count < v_total_pairs_needed then return new; end if;

    if v_active_group.round_number = 1 then
      select array_agg(participant_id order by participant_id) into v_leader_participant_ids
      from public.event_tiebreak_group_participants where group_id = v_active_group.id;
      update public.event_tiebreak_groups set status = 'failed' where id = v_active_group.id;
      perform public.create_round_robin_tiebreak_group(v_event_id, v_leader_participant_ids, 2);
      return new;
    end if;

    with winrates as (
      select etgp.participant_id, etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
      from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
    )
    select max(wr), count(*) filter (where wr = (select max(wr) from winrates))
    into v_max_match_winrate, v_winrate_leaders_count from winrates;

    if v_winrate_leaders_count = 1 then
      select user_id into v_leader_user_id from (
        select etgp.user_id, public.event_match_winrate(v_event_id, etgp.participant_id) as wr
        from public.event_tiebreak_group_participants etgp where etgp.group_id = v_active_group.id
      ) wr_table where wr = v_max_match_winrate;
      update public.event_tiebreak_groups set status = 'resolved', champion_user_id = v_leader_user_id, resolved_at = now() where id = v_active_group.id;
      update public.draft_events
      set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak', event_ended_at = now(),
          status = 'completed', final_pending = false where id = v_event_id and champion_user_id is null;
      return new;
    end if;

    update public.event_tiebreak_groups set status = 'failed', resolved_at = now() where id = v_active_group.id;
    update public.draft_events
    set polemica_winners = (
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) = v_max_match_winrate
    ),
    recognition_winners = coalesce(recognition_winners, '{}') || coalesce((
      select array_agg(etgp.user_id) from public.event_tiebreak_group_participants etgp
      where etgp.group_id = v_active_group.id and public.event_match_winrate(v_event_id, etgp.participant_id) < v_max_match_winrate
    ), '{}'),
    champion_decided_by = 'polemica', status = 'completed', event_ended_at = now(), final_pending = false
    where id = v_event_id and champion_user_id is null;
    return new;
  end if;

  -- BRACKET (semis+final+3°/4° del top4 real de round_robin O de Suizo, o de la Copa Polémica).
  if v_active_group.group_type = 'bracket' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
      v_llave_winner uuid;
      v_completed_semis integer;
      v_final_exists boolean;
      v_semi_winners uuid[];
      v_semi_losers uuid[];
      v_bracket_total integer;
      v_bracket_pending integer;
      v_w1_left boolean;
      v_w2_left boolean;
      v_l1_left boolean;
      v_l2_left boolean;
    begin
      select id, bracket_phase, participant_a_id, participant_b_id
      into v_bm_id, v_bm_phase, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      select count(*) filter (where m.winner_participant_id = v_bm_a),
             count(*) filter (where m.winner_participant_id = v_bm_b)
      into v_wins_a, v_wins_b
      from public.matches m
      where m.pairing_id = new.pairing_id
        and m.match_type = 'tiebreak'
        and m.status = 'completed';

      v_wins_needed := public.topcut_wins_needed(v_event_id, v_bm_phase);

      if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
        return new;
      end if;

      if v_wins_a >= v_wins_needed then
        v_llave_winner := v_bm_a;
      else
        v_llave_winner := v_bm_b;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_llave_winner,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      if v_bm_phase = 'semi' then
        select count(*) into v_completed_semis
        from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and bracket_phase = 'semi'
          and winner_participant_id is not null;

        if v_completed_semis >= 2 then
          select exists (
            select 1 from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'final'
          ) into v_final_exists;

          if not v_final_exists then
            select
              array_agg(winner_participant_id order by created_at),
              array_agg(
                case when winner_participant_id = participant_a_id
                     then participant_b_id else participant_a_id end
                order by created_at
              )
            into v_semi_winners, v_semi_losers
            from public.event_tiebreak_bracket_matches
            where group_id = v_active_group.id and bracket_phase = 'semi';

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'final', v_semi_winners[1], v_semi_winners[2]);

            insert into public.event_tiebreak_bracket_matches
              (group_id, bracket_phase, participant_a_id, participant_b_id)
            values (v_active_group.id, 'third_place', v_semi_losers[1], v_semi_losers[2]);

            perform public.link_bracket_matches_to_pairings(v_active_group.id);

            -- Gap análogo al del bye (0087/0089): alguno de los 4 puede haberse ido entre que
            -- ganó/perdió su semi y este instante (la otra semi tardó más en resolverse).
            -- Fase 6.8: extendido a swiss_topcut, mismo mecanismo genérico de bracket.
            if v_active_group.group_origin in ('round_robin_topcut', 'swiss_topcut') then
              select exists(select 1 from public.event_participants where id = v_semi_winners[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_winners[2] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[1] and left_event_at is not null),
                     exists(select 1 from public.event_participants where id = v_semi_losers[2] and left_event_at is not null)
              into v_w1_left, v_w2_left, v_l1_left, v_l2_left;

              -- Exactamente uno se fue de cada lado: walkover directo a favor del que se queda,
              -- reusando apply_walkover_for_topcut_bracket_leg (dispara este mismo trigger de
              -- nuevo sobre la fila recién creada). Si se fueron los dos de un mismo lado, esa
              -- fila queda pendiente para siempre — mismo criterio que "ambos se fueron".
              if v_w1_left and not v_w2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[1], v_active_group.group_origin);
              elsif v_w2_left and not v_w1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_winners[2], v_active_group.group_origin);
              end if;

              if v_l1_left and not v_l2_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[1], v_active_group.group_origin);
              elsif v_l2_left and not v_l1_left then
                perform public.apply_walkover_for_topcut_bracket_leg(v_semi_losers[2], v_active_group.group_origin);
              end if;
            end if;
          end if;
        end if;

      elsif v_bm_phase = 'final' then
        select user_id into v_leader_user_id
        from public.event_participants where id = v_llave_winner;

        update public.draft_events
        set champion_user_id = v_leader_user_id,
            champion_decided_by = 'tiebreak',
            event_ended_at = now(),
            status = 'completed',
            final_pending = false
        where id = v_event_id and champion_user_id is null;

        update public.event_tiebreak_groups
        set champion_user_id = v_leader_user_id
        where id = v_active_group.id and champion_user_id is null;
      end if;

      select count(*),
             count(*) filter (where winner_participant_id is null)
      into v_bracket_total, v_bracket_pending
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id;

      if v_bracket_total >= 4 and v_bracket_pending = 0 then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';
      end if;

      return new;
    end;
  end if;

  -- FOURTH_PLACE: desempate por el 4to puesto de round_robin_bo1_top4 (0071/0072/0091) O
  -- desempate de 1er puesto de round_robin BO3 clásico (0075/0087/0090,
  -- group_origin='round_robin_first_place'). Sin cambios — Suizo no tiene equivalente (el corte
  -- se resuelve matemáticamente, sin disputa en vivo, decisión ya confirmada).
  if v_active_group.group_type = 'fourth_place' then
    declare
      v_bm_id uuid;
      v_bm_phase text;
      v_bm_a uuid;
      v_bm_b uuid;
      v_wins_a integer;
      v_wins_b integer;
      v_wins_needed integer;
      v_resolved_index integer;
      v_resolved_match jsonb;
      v_advances text;
      v_next_index integer;
      v_next_match jsonb;
      v_next_a_id uuid;
      v_next_b_id uuid;
      v_next_phase text;
      v_next_already_exists boolean;
      v_top3 uuid[];
      v_top4 uuid[];
      v_bye_left_a boolean;
      v_bye_left_b boolean;
    begin
      -- Ubicar la fila del bracket que matchea este pairing y sigue sin ganador.
      select id, bracket_phase, participant_a_id, participant_b_id
      into v_bm_id, v_bm_phase, v_bm_a, v_bm_b
      from public.event_tiebreak_bracket_matches
      where group_id = v_active_group.id
        and winner_participant_id is null
        and (
          (participant_a_id = v_pairing.participant_a_id and participant_b_id = v_pairing.participant_b_id)
          or (participant_a_id = v_pairing.participant_b_id and participant_b_id = v_pairing.participant_a_id)
        )
      limit 1;

      if v_bm_id is null then
        return new;
      end if;

      if v_active_group.group_origin = 'round_robin_first_place' then
        v_wins_needed := case when v_bm_phase = 'final' then 2 else 1 end;

        select count(*) filter (where m.winner_participant_id = v_bm_a),
               count(*) filter (where m.winner_participant_id = v_bm_b)
        into v_wins_a, v_wins_b
        from public.matches m
        where m.pairing_id = new.pairing_id
          and m.match_type = 'tiebreak'
          and m.status = 'completed';

        if v_wins_a < v_wins_needed and v_wins_b < v_wins_needed then
          return new;
        end if;

        v_winner_participant_id := case when v_wins_a >= v_wins_needed then v_bm_a else v_bm_b end;
      else
        v_winner_participant_id := new.winner_participant_id;
      end if;

      update public.event_tiebreak_bracket_matches
      set winner_participant_id = v_winner_participant_id,
          pairing_id = new.pairing_id,
          resolved_at = now()
      where id = v_bm_id;

      select ord.idx - 1, ord.elem
      into v_resolved_index, v_resolved_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id
        and (ord.elem->'a' ? 'participantId')
        and (ord.elem->'b' ? 'participantId')
        and (
          ((ord.elem->'a'->>'participantId')::uuid = v_bm_a and (ord.elem->'b'->>'participantId')::uuid = v_bm_b)
          or ((ord.elem->'a'->>'participantId')::uuid = v_bm_b and (ord.elem->'b'->>'participantId')::uuid = v_bm_a)
        )
      limit 1;

      if v_resolved_index is null then
        return new;
      end if;

      v_advances := v_resolved_match->>'winnerAdvancesTo';

      update public.event_tiebreak_groups
      set pending_bracket_matches = (
        select jsonb_agg(
          jsonb_build_object(
            'round', elem->'round',
            'a', case
                   when (elem->'a' ? 'winnerOfMatch') and (elem->'a'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'a'
                 end,
            'b', case
                   when (elem->'b' ? 'winnerOfMatch') and (elem->'b'->>'winnerOfMatch')::integer = v_resolved_index
                   then jsonb_build_object('participantId', v_winner_participant_id::text)
                   else elem->'b'
                 end,
            'winnerAdvancesTo', elem->'winnerAdvancesTo'
          )
          order by ord.idx
        )
        from jsonb_array_elements(pending_bracket_matches) with ordinality as ord(elem, idx)
      )
      where id = v_active_group.id;

      if v_advances = 'final_4th' then
        update public.event_tiebreak_groups
        set status = 'resolved', resolved_at = now()
        where id = v_active_group.id and status = 'active';

        if v_active_group.group_origin = 'round_robin_first_place' then
          select user_id into v_leader_user_id from public.event_participants where id = v_winner_participant_id;
          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;
          return new;
        end if;

        select array_agg(participant_id order by seed) into v_top3
        from public.event_tiebreak_group_participants
        where group_id = v_active_group.id;

        if v_top3 is not null and array_length(v_top3, 1) = 3 then
          v_top4 := v_top3 || v_winner_participant_id;
          perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
        end if;

        return new;
      end if;

      v_next_index := v_advances::integer;

      select ord.elem into v_next_match
      from public.event_tiebreak_groups g
      cross join lateral jsonb_array_elements(g.pending_bracket_matches) with ordinality as ord(elem, idx)
      where g.id = v_active_group.id and ord.idx - 1 = v_next_index;

      if v_next_match is null
        or not (v_next_match->'a' ? 'participantId')
        or not (v_next_match->'b' ? 'participantId') then
        return new;
      end if;

      v_next_a_id := (v_next_match->'a'->>'participantId')::uuid;
      v_next_b_id := (v_next_match->'b'->>'participantId')::uuid;
      v_next_phase := case when v_next_match->>'winnerAdvancesTo' = 'final_4th' then 'final' else 'semi' end;

      if v_active_group.group_origin = 'round_robin_first_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select user_id into v_leader_user_id from public.event_participants
          where id = v_winner_participant_id;

          update public.draft_events
          set champion_user_id = v_leader_user_id, champion_decided_by = 'tiebreak',
              event_ended_at = now(), status = 'completed', final_pending = false
          where id = v_event_id and champion_user_id is null;

          return new;
        end if;
      elsif v_active_group.group_origin = 'round_robin_fourth_place' and v_next_phase = 'final' then
        select exists(select 1 from public.event_participants where id = v_next_a_id and left_event_at is not null),
               exists(select 1 from public.event_participants where id = v_next_b_id and left_event_at is not null)
        into v_bye_left_a, v_bye_left_b;

        if v_bye_left_a and v_bye_left_b then
          return new;
        end if;

        if v_bye_left_a or v_bye_left_b then
          insert into public.event_tiebreak_bracket_matches
            (group_id, bracket_phase, participant_a_id, participant_b_id, winner_participant_id, resolved_at)
          values (v_active_group.id, 'final', v_next_a_id, v_next_b_id, v_winner_participant_id, now());

          perform public.link_bracket_matches_to_pairings(v_active_group.id);

          update public.event_tiebreak_groups
          set status = 'resolved', resolved_at = now()
          where id = v_active_group.id and status = 'active';

          select array_agg(participant_id order by seed) into v_top3
          from public.event_tiebreak_group_participants
          where group_id = v_active_group.id;

          if v_top3 is not null and array_length(v_top3, 1) = 3 then
            v_top4 := v_top3 || v_winner_participant_id;
            perform public.create_round_robin_top4_bracket(v_event_id, v_top4);
          end if;

          return new;
        end if;
      end if;

      select exists (
        select 1 from public.event_tiebreak_bracket_matches
        where group_id = v_active_group.id
          and ((participant_a_id = v_next_a_id and participant_b_id = v_next_b_id)
            or (participant_a_id = v_next_b_id and participant_b_id = v_next_a_id))
      ) into v_next_already_exists;

      if not v_next_already_exists then
        insert into public.event_tiebreak_bracket_matches
          (group_id, bracket_phase, participant_a_id, participant_b_id)
        values (v_active_group.id, v_next_phase, v_next_a_id, v_next_b_id);

        perform public.link_bracket_matches_to_pairings(v_active_group.id);
      end if;

      return new;
    end;
  end if;

  return new;
end;
$$;

-- ===========================================================================
-- 6. RPC draw_knockout_bracket(p_event_id): sorteo idempotente y persistente
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

  -- Byes en cruces DISTINTOS de la primera ronda (como mucho P/2 - 1: nunca dos byes enfrentados).
  select coalesce(array_agg(x.pos), '{}'::integer[]) into v_bye_positions
  from (
    select gs as pos from generate_series(1, v_first_slots) gs order by random() limit v_byes
  ) x;

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

-- ===========================================================================
-- 7. RPC apply_knockout_walkover(p_participant_id): "Me voy" en Copa
--    Resuelve el evento por su cuenta y valida que sea 'knockout'. Sin left_event_at no hace
--    nada (igual que apply_walkover_for_participant). Devuelve la cantidad de cruces resueltos.
-- ===========================================================================
create or replace function public.apply_knockout_walkover(p_participant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_left_event_at timestamptz;
  v_format text;
  v_status text;
  v_group_id uuid;
  v_bm record;
  v_stayer uuid;
  v_count integer := 0;
begin
  select ep.event_id, ep.left_event_at into v_event_id, v_left_event_at
  from public.event_participants ep where ep.id = p_participant_id;

  if v_event_id is null then
    raise exception 'apply_knockout_walkover: el participante no existe.';
  end if;

  select de.competition_format, de.status into v_format, v_status
  from public.draft_events de where de.id = v_event_id and de.deleted_at is null;

  if v_format is distinct from 'knockout' then
    raise exception 'apply_knockout_walkover: el evento no es una Copa (sólo llaves).';
  end if;

  if v_left_event_at is null then
    return 0;
  end if;

  -- 'completed' también: el 3er puesto puede seguir pendiente después de la final.
  if v_status not in ('playing', 'completed') then
    return 0;
  end if;

  select g.id into v_group_id
  from public.event_tiebreak_groups g
  where g.event_id = v_event_id and g.group_origin = 'knockout_bracket' and g.status = 'active'
  limit 1;

  if v_group_id is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtext('knockout:' || v_group_id::text));

  for v_bm in
    select bm.id, bm.participant_a_id, bm.participant_b_id
    from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.winner_participant_id is null
      and bm.pairing_id is not null
      and (bm.participant_a_id = p_participant_id or bm.participant_b_id = p_participant_id)
  loop
    v_stayer := case when v_bm.participant_a_id = p_participant_id then v_bm.participant_b_id
                     else v_bm.participant_a_id end;

    -- Si el rival también se fue no hay a quién darle el walkover: queda pendiente.
    if exists (select 1 from public.event_participants where id = v_stayer and left_event_at is not null) then
      continue;
    end if;

    if public.knockout_walkover_row(v_bm.id, v_stayer) > 0 then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ===========================================================================
-- 8. Trigger: 8 a 16 jugadores inscriptos para iniciar el draft de una Copa (sólo llaves)
--    También cubre saltear 'drafting' (scheduled -> playing). La validación de cliente se saltea.
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

    if v_n < 8 or v_n > 16 then
      raise exception 'Copa (sólo llaves): se necesitan entre 8 y 16 jugadores inscriptos para iniciar el draft (hay %).', v_n
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_knockout_player_count on public.draft_events;
create trigger trg_knockout_player_count
  before update of status on public.draft_events
  for each row execute function public.knockout_enforce_player_count();

-- ===========================================================================
-- 9. Permisos: las internas no se exponen; los dos RPC sí (sólo authenticated)
-- ===========================================================================
revoke execute on function public.knockout_walkover_row(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.knockout_materialize(uuid) from public, anon, authenticated;
revoke execute on function public.knockout_advance(uuid) from public, anon, authenticated;
revoke execute on function public.knockout_enforce_player_count() from public, anon, authenticated;

revoke execute on function public.draw_knockout_bracket(uuid) from public, anon;
grant execute on function public.draw_knockout_bracket(uuid) to authenticated;

revoke execute on function public.apply_knockout_walkover(uuid) from public, anon;
grant execute on function public.apply_knockout_walkover(uuid) to authenticated;

-- ===========================================================================
-- 10. VERIFICACIÓN
-- ===========================================================================
-- Normalización SOLO para comparar: ignora CR, comentarios de línea (--) y espacios al final de
-- línea (la definición viva puede diferir del archivo en eso; nada de eso cambia lo que ejecuta la
-- función). Todo el código ejecutable se compara tal cual. La función no tiene literales con '--'.
create or replace function pg_temp.norm_0130(p text)
returns text
language sql
immutable
as $f$
  select regexp_replace(
    regexp_replace(replace(p, chr(13), ''), '--[^\n]*', '', 'g'),
    '[ \t]+(\n|$)', '\1', 'g')
$f$;

do $$
declare
  v_before text;
  v_after text;
  v_branch constant text := pg_temp.norm_0130($branch$  -- Copa (sólo llaves, group_origin='knockout_bracket', 0130): el avance lo resuelve
  -- knockout_advance (16avos a final + 3er puesto, byes, cierre del grupo). Los demás orígenes
  -- siguen exactamente por las ramas de abajo.
  if v_active_group.group_origin = 'knockout_bracket' then
    perform public.knockout_advance(new.id);
    return new;
  end if;

$branch$);
begin
  select pg_temp.norm_0130(def) into v_before from _snap_0130_eval_fn;
  v_after := pg_temp.norm_0130(pg_get_functiondef('public.evaluate_tiebreak_group_after_match()'::regprocedure));

  if position(v_branch in v_before) > 0 then
    -- Re-ejecución: la rama ya estaba; el código no debe cambiar.
    if v_after is distinct from v_before then
      raise exception '0130: evaluate_tiebreak_group_after_match cambió en una re-ejecución. Nada quedó aplicado.';
    end if;
  elsif replace(v_after, v_branch, '') is distinct from v_before then
    raise exception '0130: el código nuevo de evaluate_tiebreak_group_after_match difiere del vivo en algo más que la rama de Copa. Nada quedó aplicado.';
  elsif position(v_branch in v_after) = 0 then
    raise exception '0130: la rama de Copa no quedó en evaluate_tiebreak_group_after_match. Nada quedó aplicado.';
  end if;
end;
$$;

do $$
declare
  r record;
  v_diff bigint;
begin
  for r in
    select * from (values
      ('_snap_0130_placement',        'public.v_participant_event_placement'),
      ('_snap_0130_final_positions',  'public.v_event_final_positions'),
      ('_snap_0130_workspace_points', 'public.v_workspace_points'),
      ('_snap_0130_season_points',    'public.v_season_points')
    ) as t(snap, vw)
  loop
    execute format(
      'select count(*) from (
         (select * from %1$s except all select * from %2$s)
         union all
         (select * from %2$s except all select * from %1$s)
       ) d', r.snap, r.vw
    ) into v_diff;

    if v_diff > 0 then
      raise exception '0130: % cambió respecto del snapshot previo (% filas distintas). Nada quedó aplicado.', r.vw, v_diff;
    end if;
  end loop;

  raise notice '0130: vistas de placement, posiciones finales, puntos globales y de temporada sin cambios.';
end;
$$;

drop function if exists pg_temp.norm_0130(text);
