-- 0139_zones_cups.sql
-- Grupos + Copa (competition_format = 'zones_knockout'), B4: al cerrarse la fase de grupos se arman solas las dos copas.
--
-- zones_build_cups(event_id): idempotente (advisory lock + no hace nada si la Copa principal ya existe) y llamada DENTRO
-- de la misma transacción que setea zones_phase_completed_at: desde zones_check_phase_complete (0137, último pairing
-- resuelto o jugador que se va). Nunca queda la fase cerrada sin llaves, salvo que falle el armado: en ese caso la fase
-- NO se cierra y el error queda en draft_events.zones_cups_log.
--
-- "Dar por concluido" NO arma llaves: concluir un evento Grupos + Copa se comporta como en la 0137 (el evento queda
-- concluded con la fase de grupos como resultado final, sin tocar zones_phase_completed_at).
--
-- Reglas implementadas:
--   * Copa {sede} (group_origin 'knockout_bracket'): los q primeros de cada zona (posición de zone_standings) + w
--     wildcards. T = k*q + w (zones_count, zone_qualifiers, zone_wildcards del evento).
--   * Wildcards: entre los jugadores en la posición q+1 de cada zona, comparados entre zonas por (a) promedio de puntos
--     por enfrentamiento resuelto (puntos de zone_standings, interzonal incluido), (b) cruce directo entre los empatados
--     (puntos en los pairings entre ellos), (c) calidad de rivales por enfrentamiento (puntos totales de los rivales
--     vencidos fuera del grupo empatado / enfrentamientos resueltos), (d) hash estable del participant_id (el de
--     zone_standings). Si el corte entre el último que pasa y el primero que no se decidió por hash, queda registrado en
--     draft_events.zones_cups_log -> 'wildcards' (empatados, quién pasó y quién no, by_hash).
--   * Siembra: todos los 1ros primero, después los 2dos, etc. y los wildcards al final; dentro de cada posición por el
--     mismo orden (promedio y desempates). Cuadro estándar de torneo (zones_bracket_order): los mejores sembrados reciben
--     los byes cuando T no es potencia de 2. En primera ronda se evita el cruce de la misma zona intercambiando el rival
--     de menor siembra con el de otro cruce cuando los dos cruces quedan sin choque (el más cercano en siembra); si no hay
--     forma se acepta (zones_cups_log -> 'same_zone_first_round' cuenta cuántos quedaron).
--   * Formato de las llaves: topcut_format del evento (lo lee topcut_wins_needed). match_format es sólo de la fase de grupos.
--   * Copa Consuelo (group_origin 'knockout_second_chance'): los N - T no clasificados, si son 4 a 16, con el armado
--     existente knockout_build_bracket (orden aleatorio, mismos byes balanceados). Con más de 16 no se arma (el cuadro
--     admite hasta 16).
--   * Pairings: knockout_materialize (0134) reutiliza la fila existente de dos jugadores que ya se enfrentaron (zona,
--     interzonal o venganza) sin tocar su stage ni su resultado oficial (sólo pasa 'revenge' a 'bracket'); la serie de la
--     llave se distingue por match_type 'tiebreak' y por event_tiebreak_bracket_matches.
--   * Jugadores que ya se fueron: al final del armado se llama a apply_knockout_walkover para cada participante de ambos
--     cuadros con left_event_at, así su rival avanza; si los dos de un cruce se fueron, el cruce queda pendiente.
--   * Venganzas: sin cambios.
--
-- Funciones vivas que se reemplazan (cuerpo de la última migración que las define; md5 del texto entre los $$ del
-- archivo de origen, con sus saltos de línea originales):
--   evaluate_tiebreak_group_after_match  970b6464e658bc9f07e74c4ace0e9e2a  (22837 caracteres con LF; con CRLF: 7c77c0d545b6a5506574bd0295dde7a3, 23364)  [0135]
--       cambio: la rama temprana por knockout_advance también para zones_knockout (hay dos cuadros activos).
--   knockout_maybe_complete_event        2b9660c05e012d95a39632df27bc321d  (1241 caracteres con LF; con CRLF: f25da77889da63f5ce5b6b4772d2c679, 1278)  [0135]
--       cambio: no completa el evento en zones_knockout (completitud y podio: B5).
--   knockout_try_draw_second_chance      e4442a5c386f22b87514522d7f4f9893  (2813 caracteres con LF; con CRLF: 807223e326b3c765cc68791e470ce9b6, 2886)  [0135]
--       cambio: no hace nada en zones_knockout (Consuelo sale de zones_build_cups).
--   apply_knockout_walkover              78a26ebbc03ce4b24a471b27028608ba  (2283 caracteres con LF; con CRLF: c60f8104ddde2b670a6e1974f3de568d, 2352)  [0135]
--       cambio: acepta zones_knockout ("Me voy" dentro de las llaves).
--   zones_check_phase_complete           d202267ecabfea6624be1a2e94edb116  (1430 caracteres con LF; con CRLF: 0e45d1eb4660c53a543037a101273955, 1472)  [0137]
--       cambio: arma las llaves en la misma transacción antes de marcar zones_phase_completed_at.

-- ===========================================================================
-- 1. Registro del armado
-- ===========================================================================
alter table public.draft_events
  add column if not exists zones_cups_log jsonb;

-- ===========================================================================
-- 2. Tablas temporales de ranking (mismo cálculo de puntos que zone_standings, 0137)
-- ===========================================================================
create or replace function public.zones_prepare_rank_tables(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bo2 boolean;
begin
  select de.match_format = 'bo2' into v_bo2 from public.draft_events de where de.id = p_event_id;

  drop table if exists _zr_pairings;
  drop table if exists _zr_points;
  create temporary table _zr_pairings (
    pa uuid not null, pb uuid not null, winner uuid, draw boolean not null, pts_a integer not null, pts_b integer not null
  ) on commit drop;
  create temporary table _zr_points (pid uuid primary key, pts integer not null) on commit drop;

  insert into _zr_pairings (pa, pb, winner, draw, pts_a, pts_b)
  select p.participant_a_id, p.participant_b_id, p.official_winner_participant_id,
         (p.official_winner_participant_id is null and p.official_draw is true),
         case
           when p.official_winner_participant_id = p.participant_a_id then case when coalesce(v_bo2, false) then 3 else 1 end
           when p.official_winner_participant_id is null and p.official_draw is true and coalesce(v_bo2, false) then 1
           else 0
         end,
         case
           when p.official_winner_participant_id = p.participant_b_id then case when coalesce(v_bo2, false) then 3 else 1 end
           when p.official_winner_participant_id is null and p.official_draw is true and coalesce(v_bo2, false) then 1
           else 0
         end
  from public.pairings p
  where p.event_id = p_event_id and p.stage in ('zone', 'interzonal');

  insert into _zr_points (pid, pts)
  select ep.id,
         coalesce((
           select sum(case when q.pa = ep.id then q.pts_a else q.pts_b end)
           from _zr_pairings q
           where q.pa = ep.id or q.pb = ep.id
         ), 0)::integer
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.zone_id is not null;
end;
$$;

-- Promedio de puntos por enfrentamiento resuelto (0 si todavía no tiene ninguno).
create or replace function public.zones_pts_avg(p_pid uuid)
returns numeric
language plpgsql
volatile
as $$
begin
  return coalesce((select z.pts from _zr_points z where z.pid = p_pid), 0)::numeric
         / greatest((
             select count(*) from _zr_pairings q
             where (q.winner is not null or q.draw) and (q.pa = p_pid or q.pb = p_pid)
           ), 1);
end;
$$;

-- Desempate de un grupo con el MISMO promedio: cruce directo (puntos entre los del grupo) -> si el grupo entero queda
-- igual (ciclo), calidad de rivales por enfrentamiento -> hash. p_hash: los que quedaron ubicados por hash.
create or replace function public.zones_cmp_tie(p_group uuid[], out p_order uuid[], out p_hash uuid[])
returns record
language plpgsql
volatile
as $$
declare
  v_n integer := coalesce(cardinality(p_group), 0);
  v_key integer;
  v_bucket uuid[];
  v_chosen uuid;
  v_top_n integer;
  v_sub record;
begin
  p_order := '{}';
  p_hash := '{}';
  if v_n <= 1 then
    p_order := coalesce(p_group, '{}');
    return;
  end if;

  for v_key, v_bucket in
    select t.iw, array_agg(t.pid)
    from (
      select g.pid,
             coalesce((
               select sum(case when p.pa = g.pid then p.pts_a else p.pts_b end)
               from _zr_pairings p
               where (p.pa = g.pid and p.pb = any (p_group)) or (p.pb = g.pid and p.pa = any (p_group))
             ), 0)::integer as iw
      from unnest(p_group) as g(pid)
    ) t
    group by t.iw
    order by t.iw desc
  loop
    if cardinality(v_bucket) = 1 then
      p_order := p_order || v_bucket;
    elsif cardinality(v_bucket) = v_n then
      with q as (
        select b.pid,
               coalesce((
                 select sum(coalesce((select z.pts from _zr_points z where z.pid = case when p.pa = b.pid then p.pb else p.pa end), 0))
                 from _zr_pairings p
                 where p.winner = b.pid
                   and (case when p.pa = b.pid then p.pb else p.pa end) <> all (v_bucket)
               ), 0)::numeric
               / greatest((
                   select count(*) from _zr_pairings p2
                   where (p2.winner is not null or p2.draw) and (p2.pa = b.pid or p2.pb = b.pid)
                 ), 1) as qual,
               public.zones_stable_hash(b.pid::text) as h
        from unnest(v_bucket) as b(pid)
      )
      select (select q1.pid from q q1 order by q1.qual desc, q1.h asc limit 1),
             (select count(*) from q q2 where q2.qual = (select max(q3.qual) from q q3))
      into v_chosen, v_top_n;
      if v_top_n > 1 then
        p_hash := p_hash || v_chosen;
      end if;
      select * into v_sub from public.zones_cmp_tie(array_remove(v_bucket, v_chosen));
      p_order := p_order || v_chosen || v_sub.p_order;
      p_hash := p_hash || v_sub.p_hash;
    else
      select * into v_sub from public.zones_cmp_tie(v_bucket);
      p_order := p_order || v_sub.p_order;
      p_hash := p_hash || v_sub.p_hash;
    end if;
  end loop;
end;
$$;

-- Ordena un conjunto de jugadores (de zonas distintas) por promedio de puntos por enfrentamiento y, dentro de cada
-- empate de promedio, zones_cmp_tie.
create or replace function public.zones_order_by_avg(p_pids uuid[], out p_order uuid[], out p_hash uuid[])
returns record
language plpgsql
volatile
as $$
declare
  v_avg numeric;
  v_grp uuid[];
  v_sub record;
begin
  p_order := '{}';
  p_hash := '{}';
  if coalesce(cardinality(p_pids), 0) = 0 then
    return;
  end if;
  for v_avg, v_grp in
    select a.av, array_agg(a.pid)
    from (select x as pid, public.zones_pts_avg(x) as av from unnest(p_pids) as x) a
    group by a.av
    order by a.av desc
  loop
    if cardinality(v_grp) = 1 then
      p_order := p_order || v_grp;
    else
      select * into v_sub from public.zones_cmp_tie(v_grp);
      p_order := p_order || v_sub.p_order;
      p_hash := p_hash || v_sub.p_hash;
    end if;
  end loop;
end;
$$;

-- ===========================================================================
-- 3. Cuadro sembrado
-- ===========================================================================
-- Orden estándar de siembra para un cuadro de p_size (2, 4, 8, 16): los cruces de primera ronda son (ord[2i-1], ord[2i]).
create or replace function public.zones_bracket_order(p_size integer)
returns integer[]
language plpgsql
immutable
as $$
declare
  v_ord integer[] := array[1, 2];
  v_size integer := 2;
  v_next integer[];
  e integer;
begin
  while v_size < p_size loop
    v_next := '{}';
    v_size := v_size * 2;
    foreach e in array v_ord loop
      v_next := v_next || e || (v_size + 1 - e);
    end loop;
    v_ord := v_next;
  end loop;
  return v_ord;
end;
$$;

-- Arma el cuadro de un grupo con jugadores YA sembrados (p_seeds[1] = mejor). Misma estructura que
-- knockout_build_bracket (slots, feeds, byes que pasan a la ronda siguiente, knockout_materialize), pero la ubicación es la
-- del cuadro estándar: los mejores sembrados reciben los byes, y se evita el cruce de la misma zona en primera ronda.
-- Devuelve cuántos cruces de primera ronda quedaron de la misma zona.
create or replace function public.zones_build_seeded_bracket(p_group_id uuid, p_seeds uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
  v_p integer;
  v_first_slots integer;
  v_first_round text;
  v_ord integer[];
  v_xs integer[] := '{}';
  v_ys integer[] := '{}';
  v_zone uuid[];
  v_pos integer;
  v_pos2 integer;
  v_best integer;
  v_bestd integer;
  v_tmp integer;
  v_conflicts integer := 0;
begin
  if not exists (select 1 from public.event_tiebreak_groups g where g.id = p_group_id) then
    raise exception 'zones_build_seeded_bracket: el grupo no existe.';
  end if;
  v_n := coalesce(array_length(p_seeds, 1), 0);
  if v_n < 4 or v_n > 16 then
    raise exception 'Copa (grupos + llaves): se necesitan entre 4 y 16 jugadores en el cuadro (hay %).', v_n
      using errcode = '23514';
  end if;

  v_p := case when v_n <= 4 then 4 when v_n <= 8 then 8 else 16 end;
  v_first_slots := v_p / 2;
  v_first_round := case v_p when 4 then 'semi' when 8 then 'quarter' else 'round_of_16' end;

  insert into public.event_tiebreak_group_participants (group_id, participant_id, user_id, seed)
  select p_group_id, ep.id, ep.user_id, t.ord::integer
  from unnest(p_seeds) with ordinality as t(pid, ord)
  join public.event_participants ep on ep.id = t.pid;

  insert into public.knockout_slots (group_id, round_key, "position")
  select p_group_id, r.round_key, gs
  from (values ('round_of_16', 8), ('quarter', 4), ('semi', 2), ('final', 1), ('third_place', 1)) as r(round_key, n)
  cross join lateral generate_series(1, r.n) as gs
  where (r.round_key <> 'round_of_16' or v_p = 16)
    and (r.round_key <> 'quarter' or v_p >= 8);

  update public.knockout_slots s
  set feeds_slot_id = n.id,
      feeds_as = case when s."position" % 2 = 1 then 'a' else 'b' end
  from public.knockout_slots n
  where s.group_id = p_group_id
    and n.group_id = p_group_id
    and n.round_key = case s.round_key
                        when 'round_of_16' then 'quarter'
                        when 'quarter' then 'semi'
                        when 'semi' then 'final'
                      end
    and n."position" = (s."position" + 1) / 2;

  -- Cruces de primera ronda del cuadro estándar: (siembra mejor, siembra peor); la peor > n es un bye.
  v_ord := public.zones_bracket_order(v_p);
  for v_pos in 1..v_first_slots loop
    v_xs := v_xs || v_ord[2 * v_pos - 1];
    v_ys := v_ys || v_ord[2 * v_pos];
  end loop;

  select array_agg(ep.zone_id order by t.ord) into v_zone
  from unnest(p_seeds) with ordinality as t(pid, ord)
  join public.event_participants ep on ep.id = t.pid;

  -- Evitar la misma zona en primera ronda: se intercambia la peor siembra del cruce con la de otro cruce si los dos
  -- quedan sin choque (el intercambio más cercano en siembra).
  for v_pos in 1..v_first_slots loop
    if v_ys[v_pos] <= v_n and v_zone[v_xs[v_pos]] is not distinct from v_zone[v_ys[v_pos]] then
      v_best := 0;
      v_bestd := 1000;
      for v_pos2 in 1..v_first_slots loop
        if v_pos2 <> v_pos
           and v_ys[v_pos2] <= v_n
           and v_zone[v_xs[v_pos]] is distinct from v_zone[v_ys[v_pos2]]
           and v_zone[v_xs[v_pos2]] is distinct from v_zone[v_ys[v_pos]]
           and abs(v_ys[v_pos2] - v_ys[v_pos]) < v_bestd then
          v_best := v_pos2;
          v_bestd := abs(v_ys[v_pos2] - v_ys[v_pos]);
        end if;
      end loop;
      if v_best > 0 then
        v_tmp := v_ys[v_pos];
        v_ys[v_pos] := v_ys[v_best];
        v_ys[v_best] := v_tmp;
      end if;
    end if;
  end loop;

  for v_pos in 1..v_first_slots loop
    if v_ys[v_pos] > v_n then
      update public.knockout_slots s
      set participant_a_id = p_seeds[v_xs[v_pos]], seed_a = v_xs[v_pos], is_bye = true,
          winner_participant_id = p_seeds[v_xs[v_pos]]
      where s.group_id = p_group_id and s.round_key = v_first_round and s."position" = v_pos;
    else
      update public.knockout_slots s
      set participant_a_id = p_seeds[v_xs[v_pos]], seed_a = v_xs[v_pos],
          participant_b_id = p_seeds[v_ys[v_pos]], seed_b = v_ys[v_pos]
      where s.group_id = p_group_id and s.round_key = v_first_round and s."position" = v_pos;
      if v_zone[v_xs[v_pos]] is not distinct from v_zone[v_ys[v_pos]] then
        v_conflicts := v_conflicts + 1;
      end if;
    end if;
  end loop;

  update public.knockout_slots n
  set participant_a_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = p_group_id and s.is_bye and s.feeds_as = 'a' and n.id = s.feeds_slot_id;

  update public.knockout_slots n
  set participant_b_id = s.winner_participant_id
  from public.knockout_slots s
  where s.group_id = p_group_id and s.is_bye and s.feeds_as = 'b' and n.id = s.feeds_slot_id;

  perform public.knockout_materialize(p_group_id);
  return v_conflicts;
end;
$$;

-- ===========================================================================
-- 4. zones_build_cups
-- ===========================================================================
-- Devuelve el registro (jsonb) del armado, o null si no hay nada que armar (formato/sorteo, o ya estaban armadas).
-- NO modifica draft_events: el que llama guarda el registro junto con zones_phase_completed_at.
create or replace function public.zones_build_cups(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_zone record;
  v_order uuid[];
  v_set uuid[];
  v_cand uuid[];
  v_ord record;
  v_seeds uuid[] := '{}';
  v_wild uuid[] := '{}';
  v_hash uuid[] := '{}';
  v_rest uuid[];
  v_main uuid;
  v_cons uuid;
  v_same integer;
  v_pos integer;
  v_cut_tied uuid[] := '{}';
  v_by_hash boolean := false;
  v_wild_log jsonb := null;
  v_cons_size integer;
  v_cons_built boolean := false;
  v_left record;
  v_walkovers integer := 0;
begin
  select de.id, de.competition_format, de.zones_drawn_at, de.zones_count, de.zone_qualifiers, de.zone_wildcards
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null or v_event.competition_format <> 'zones_knockout' or v_event.zones_drawn_at is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('zonescups:' || p_event_id::text));

  -- Idempotente: si la Copa principal ya está armada, no se vuelve a armar nada.
  if exists (
    select 1 from public.event_tiebreak_groups g
    where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  ) then
    return null;
  end if;

  if v_event.zones_count is null or v_event.zone_qualifiers is null then
    raise exception 'zones_build_cups: el evento no tiene la configuración de zonas.';
  end if;

  perform public.zones_prepare_rank_tables(p_event_id);

  -- Posición de cada jugador dentro de su zona (zone_standings).
  drop table if exists _zc_rank;
  create temporary table _zc_rank (pid uuid primary key, zone_id uuid not null, pos integer not null) on commit drop;
  for v_zone in select z.id from public.event_zones z where z.event_id = p_event_id order by z.zone_index loop
    v_order := public.zones_rank_members((
      select array_agg(m.id) from public.event_participants m
      where m.event_id = p_event_id and m.zone_id = v_zone.id and m.role = 'player'
    ));
    insert into _zc_rank (pid, zone_id, pos)
    select t.pid, v_zone.id, t.ord::integer from unnest(v_order) with ordinality as t(pid, ord);
  end loop;

  -- Siembra: los 1ros, los 2dos, ... (cada posición ordenada entre zonas) y los wildcards al final.
  for v_pos in 1..v_event.zone_qualifiers loop
    select array_agg(r.pid) into v_set from _zc_rank r where r.pos = v_pos;
    select * into v_ord from public.zones_order_by_avg(v_set);
    v_seeds := v_seeds || v_ord.p_order;
  end loop;

  if v_event.zone_wildcards > 0 then
    select array_agg(r.pid) into v_cand from _zc_rank r where r.pos = v_event.zone_qualifiers + 1;
    if coalesce(cardinality(v_cand), 0) < v_event.zone_wildcards then
      raise exception 'zones_build_cups: no hay suficientes candidatos a wildcard (% para %).', coalesce(cardinality(v_cand), 0), v_event.zone_wildcards;
    end if;
    select * into v_ord from public.zones_order_by_avg(v_cand);
    v_hash := v_ord.p_hash;
    v_wild := v_ord.p_order[1:v_event.zone_wildcards];
    v_seeds := v_seeds || v_wild;
    if cardinality(v_cand) > v_event.zone_wildcards then
      -- corte: último que pasa vs primero que no pasa
      v_by_hash := (v_ord.p_order[v_event.zone_wildcards] = any (v_hash))
                   or (v_ord.p_order[v_event.zone_wildcards + 1] = any (v_hash));
      select array_agg(x) into v_cut_tied
      from unnest(v_ord.p_order) as x
      where public.zones_pts_avg(x) = public.zones_pts_avg(v_ord.p_order[v_event.zone_wildcards]);
    end if;
    v_wild_log := jsonb_build_object(
      'candidates', to_jsonb(v_ord.p_order),
      'advanced', to_jsonb(v_wild),
      'eliminated', to_jsonb(v_ord.p_order[v_event.zone_wildcards + 1:]),
      'cut_tied', to_jsonb(coalesce(v_cut_tied, '{}'::uuid[])),
      'by_hash', v_by_hash
    );
  end if;

  if cardinality(v_seeds) <> v_event.zone_qualifiers * v_event.zones_count + v_event.zone_wildcards then
    raise exception 'zones_build_cups: la cantidad de clasificados (%) no coincide con la configuración (% x % + %).',
      cardinality(v_seeds), v_event.zones_count, v_event.zone_qualifiers, v_event.zone_wildcards;
  end if;

  -- Copa principal
  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (p_event_id, 1, 'bracket', 'active', 'knockout_bracket')
  returning id into v_main;
  v_same := public.zones_build_seeded_bracket(v_main, v_seeds);

  -- Copa Consuelo: los no clasificados (4 a 16), orden aleatorio y byes balanceados (armado existente).
  select array_agg(r.pid order by random()) into v_rest
  from _zc_rank r
  where r.pid <> all (v_seeds);
  v_cons_size := coalesce(cardinality(v_rest), 0);
  if v_cons_size >= 4 and v_cons_size <= 16 then
    insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
    values (p_event_id, 1, 'bracket', 'active', 'knockout_second_chance')
    returning id into v_cons;
    perform public.knockout_build_bracket(v_cons, v_rest);
    v_cons_built := true;
  end if;

  -- Los que ya se fueron (left_event_at) y quedaron en algún cuadro: su rival avanza por walkover. Si los dos de un cruce
  -- se fueron, el cruce queda pendiente (apply_knockout_walkover no hace nada cuando no hay a quién darle la victoria).
  for v_left in
    select distinct ep.id
    from public.event_tiebreak_group_participants gp
    join public.event_participants ep on ep.id = gp.participant_id
    where gp.group_id in (v_main, v_cons) and ep.left_event_at is not null
  loop
    v_walkovers := v_walkovers + public.apply_knockout_walkover(v_left.id);
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'built_at', now(),
    'main_group_id', v_main,
    'consuelo_group_id', v_cons,
    'copa_size', cardinality(v_seeds),
    'consuelo_size', v_cons_size,
    'consuelo_built', v_cons_built,
    'seeds', to_jsonb(v_seeds),
    'same_zone_first_round', v_same,
    'walkovers_applied', v_walkovers,
    'wildcards', v_wild_log
  ));
end;
$$;

-- ===========================================================================
-- 5. Reemplazos mínimos de funciones vivas
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

  -- 0139: también Grupos + Copa (competition_format = 'zones_knockout'): sus llaves (Copa y Consuelo) son los mismos dos
  -- cuadros activos y los únicos 'tiebreak' que tiene ese formato.
  -- Copa (competition_format = 'knockout', 0135): puede haber dos grupos activos (la copa principal y la
  -- 2da oportunidad), así que el avance NO depende de "el" grupo activo del evento: knockout_advance
  -- busca la copa a la que pertenece el cruce. Los demás formatos siguen por las ramas de abajo, idénticas.
  if exists (
    select 1 from public.draft_events de
    where de.id = v_event_id and de.competition_format in ('knockout', 'zones_knockout')
  ) then
    perform public.knockout_advance(new.id);
    return new;
  end if;

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

create or replace function public.knockout_maybe_complete_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_main record;
  v_second record;
begin
  select de.status into v_status
  from public.draft_events de where de.id = p_event_id and de.deleted_at is null;
  if v_status is distinct from 'playing' then
    return;
  end if;

  -- 0139: Grupos + Copa no completa el evento al terminar las copas (la completitud y el podio son del bloque B5).
  if exists (
    select 1 from public.draft_events de where de.id = p_event_id and de.competition_format = 'zones_knockout'
  ) then
    return;
  end if;

  -- Una copa termina cuando su final Y su 3er puesto están resueltos: el grupo pasa a 'resolved'.
  select g.id, g.status, g.champion_user_id into v_main
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_bracket' and g.status <> 'superseded'
  limit 1;
  if v_main.id is null or v_main.status <> 'resolved' then
    return;
  end if;

  select g.id, g.status into v_second
  from public.event_tiebreak_groups g
  where g.event_id = p_event_id and g.group_origin = 'knockout_second_chance' and g.status <> 'superseded'
  limit 1;
  if v_second.id is not null and v_second.status <> 'resolved' then
    return;
  end if;

  update public.draft_events
  set status = 'completed',
      event_ended_at = now(),
      final_pending = false,
      champion_user_id = coalesce(champion_user_id, v_main.champion_user_id),
      champion_decided_by = coalesce(champion_decided_by, 'tiebreak')
  where id = p_event_id and status = 'playing';
end;
$$;

create or replace function public.knockout_try_draw_second_chance(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group record;
  v_status text;
  v_existing uuid;
  v_all_resolved boolean;
  v_entrants uuid[];
  v_new uuid;
begin
  select g.id, g.event_id, g.group_origin into v_group
  from public.event_tiebreak_groups g where g.id = p_group_id;

  -- Sólo se dispara desde la copa principal.
  if v_group.id is null or v_group.group_origin <> 'knockout_bracket' then
    return null;
  end if;

  -- 0139: en Grupos + Copa, Consuelo la arma zones_build_cups con los no clasificados (nunca por primer partido perdido).
  if exists (
    select 1 from public.draft_events de where de.id = v_group.event_id and de.competition_format = 'zones_knockout'
  ) then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('knockout2:' || v_group.event_id::text));

  -- Idempotente: si ya hay una 2da oportunidad vigente, se devuelve sin volver a sortear.
  select g.id into v_existing
  from public.event_tiebreak_groups g
  where g.event_id = v_group.event_id and g.group_origin = 'knockout_second_chance' and g.status <> 'superseded'
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  select de.status into v_status
  from public.draft_events de where de.id = v_group.event_id and de.deleted_at is null;
  if v_status is distinct from 'playing' then
    return null;
  end if;

  -- "Primer partido real" de cada jugador: el primer slot no-bye (por ronda) en el que está. Los que entran
  -- con bye juegan su primer partido en la ronda siguiente. Entrantes: perdieron ese partido y no se fueron.
  with placed as (
    select p.pid, s."position" as pos, s.winner_participant_id as winner,
           case s.round_key when 'round_of_16' then 1 when 'quarter' then 2 when 'semi' then 3
                            when 'final' then 4 else 5 end as r
    from public.knockout_slots s
    cross join lateral (values (s.participant_a_id), (s.participant_b_id)) as p(pid)
    where s.group_id = p_group_id and not s.is_bye and p.pid is not null
  ), first_slot as (
    select distinct on (pid) pid, winner from placed order by pid, r, pos
  )
  select bool_and(fs.winner is not null),
         coalesce(
           array_agg(fs.pid order by random()) filter (
             where fs.winner is not null and fs.winner <> fs.pid
               and not exists (
                 select 1 from public.event_participants ep where ep.id = fs.pid and ep.left_event_at is not null
               )
           ),
           '{}'::uuid[]
         )
  into v_all_resolved, v_entrants
  from first_slot fs;

  -- Se sortea recién cuando TODOS los primeros partidos de la copa principal están resueltos, y sólo si
  -- hay 4 o más entrantes (con menos no se crea y no pasa nada).
  if v_all_resolved is not true or coalesce(array_length(v_entrants, 1), 0) < 4 then
    return null;
  end if;

  insert into public.event_tiebreak_groups (event_id, round_number, group_type, status, group_origin)
  values (v_group.event_id, 1, 'bracket', 'active', 'knockout_second_chance')
  returning id into v_new;

  perform public.knockout_build_bracket(v_new, v_entrants);

  return v_new;
end;
$$;

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

  if v_format is null or v_format not in ('knockout', 'zones_knockout') then
    raise exception 'apply_knockout_walkover: el evento no es una Copa (sólo llaves ni grupos + llaves).';
  end if;

  if v_left_event_at is null then
    return 0;
  end if;

  -- 'completed' también: el 3er puesto puede seguir pendiente después de la final.
  if v_status not in ('playing', 'completed') then
    return 0;
  end if;

  -- 0135: puede haber dos cuadros activos (la copa principal y la 2da oportunidad); se recorren los dos.
  for v_group_id in
    select g.id
    from public.event_tiebreak_groups g
    where g.event_id = v_event_id
      and g.group_origin in ('knockout_bracket', 'knockout_second_chance')
      and g.status = 'active'
    order by g.created_at, g.id
  loop
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
  end loop;

  return v_count;
end;
$$;

create or replace function public.zones_check_phase_complete(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_total integer;
  v_pending integer;
  v_log jsonb;
begin
  select de.id, de.competition_format, de.status, de.zones_drawn_at, de.zones_phase_completed_at
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null or v_event.competition_format <> 'zones_knockout' or v_event.zones_drawn_at is null then
    return false;
  end if;
  if v_event.zones_phase_completed_at is not null then
    return true;
  end if;
  if v_event.status <> 'playing' then
    return false;
  end if;

  -- Pendiente = sin ganador ni empate, salvo que los DOS jugadores se hayan ido (no hay a quién darle el walkover).
  select count(*),
         count(*) filter (
           where p.official_winner_participant_id is null
             and p.official_draw is not true
             and not (epa.left_event_at is not null and epb.left_event_at is not null)
         )
  into v_total, v_pending
  from public.pairings p
  join public.event_participants epa on epa.id = p.participant_a_id
  join public.event_participants epb on epb.id = p.participant_b_id
  where p.event_id = p_event_id and p.stage in ('zone', 'interzonal');

  if v_total > 0 and v_pending = 0 then
    -- 0139: nunca queda la fase cerrada sin llaves. Si el armado falla, la fase NO se cierra (queda registrado el error
    -- en zones_cups_log y se reintenta en el próximo disparo: otro pairing resuelto o un jugador que se va).
    begin
      v_log := public.zones_build_cups(p_event_id);
    exception when others then
      update public.draft_events
      set zones_cups_log = jsonb_build_object('error', sqlerrm, 'at', now())
      where id = p_event_id;
      return false;
    end;
    update public.draft_events
    set zones_phase_completed_at = now(),
        zones_cups_log = coalesce(v_log, zones_cups_log)
    where id = p_event_id and zones_phase_completed_at is null and status = 'playing';
    return true;
  end if;
  return false;
end;
$$;

-- ===========================================================================
-- Permisos: las internas no se exponen; las reemplazadas conservan los suyos (CREATE OR REPLACE los mantiene)
-- ===========================================================================
revoke execute on function public.zones_prepare_rank_tables(uuid) from public, anon, authenticated;
revoke execute on function public.zones_pts_avg(uuid) from public, anon, authenticated;
revoke execute on function public.zones_cmp_tie(uuid[]) from public, anon, authenticated;
revoke execute on function public.zones_order_by_avg(uuid[]) from public, anon, authenticated;
revoke execute on function public.zones_bracket_order(integer) from public, anon, authenticated;
revoke execute on function public.zones_build_seeded_bracket(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.zones_build_cups(uuid) from public, anon, authenticated;
