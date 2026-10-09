-- 0140_zones_close_event.sql
-- Grupos + Copa (competition_format = 'zones_knockout'), B5: cierre del evento.
--
--   1. Completitud: knockout_maybe_complete_event ya no es un no-op para zones_knockout. El evento pasa a 'completed'
--      (event_ended_at = now(), final_pending = false) cuando la Copa {sede} (group_origin 'knockout_bracket') está
--      'resolved' (final y 3er puesto resueltos) y Consuelo ('knockout_second_chance') está 'resolved' o no existe.
--      Campeón del evento = campeón de la Copa principal (champion_decided_by = 'tiebreak'), igual que en Copa sola:
--      knockout_advance ya lo corona al resolverse la final. El cuerpo queda igual al de la 0135.
--   2. "Dar por concluido": es un UPDATE del cliente (sin función); no cambia acá. El cliente conserva el campeón sólo si la
--      final de la Copa principal está resuelta (EventDetailScreen). knockout_advance no avanza nada en un evento
--      'concluded' (0135), así que los cruces pendientes quedan tal cual.
--   3. zones_build_cups: by_hash del registro de wildcards (zones_cups_log -> 'wildcards') era un falso positivo cuando dos
--      ELIMINADOS empataban entre sí. Ahora es true sólo si el último que pasa quedó ubicado por hash (o sea, el hash lo
--      separó del primero que no pasa). El resto del cuerpo no cambia.
--
-- Funciones vivas que se reemplazan (md5 del texto entre los $$ del archivo de origen, con sus saltos de línea originales):
--   knockout_maybe_complete_event  186855b80f40c20df7128a58acc26a96  (1514 caracteres con LF; con CRLF: b1c7570be8a48c9b87170fedee907922, 1558)  [0139]
--       si todavía está la 0135 (0139 sin aplicar): 2b9660c05e012d95a39632df27bc321d  (1241 con LF; con CRLF: f25da77889da63f5ce5b6b4772d2c679, 1278)
--       cambio: sin la salida temprana para zones_knockout.
--   zones_build_cups               e2eb743d89a3a0705340d0cfa318e3e9  (5935 caracteres con LF; con CRLF: 700a9d1e9e35ce9bb8b9fa4317acecd2, 6077)  [0139]
--       cambio: by_hash sólo cuando el último que pasa fue elegido por hash.

-- ===========================================================================
-- 1. Completitud del evento Grupos + Copa
-- ===========================================================================
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

  -- 0140: Grupos + Copa (zones_knockout) completa igual que la Copa sola: cuando la Copa {sede} está 'resolved' (final y
  -- 3er puesto) y Consuelo está 'resolved' o no existe (N - T < 4 o > 16). Campeón = el de la Copa principal.

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

-- ===========================================================================
-- 2. by_hash del registro de wildcards
-- ===========================================================================
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
      -- corte: último que pasa vs primero que no pasa. El hash decidió el corte sólo si el último que pasa fue ELEGIDO por hash
      -- (zones_cmp_tie lo pone por delante de todo el resto de su grupo de empatados, y el primero que no pasa es el que
      -- sigue). Que el primero que no pasa esté en v_hash no alcanza: entonces fue elegido sobre los que vienen DESPUÉS de él
      -- (dos eliminados empatados entre sí), no sobre el último que pasa.
      v_by_hash := (v_ord.p_order[v_event.zone_wildcards] = any (v_hash));
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

revoke execute on function public.knockout_maybe_complete_event(uuid) from public, anon, authenticated;
revoke execute on function public.zones_build_cups(uuid) from public, anon, authenticated;
