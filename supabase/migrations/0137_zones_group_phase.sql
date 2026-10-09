-- 0137_zones_group_phase.sql
-- Grupos + Copa (competition_format = 'zones_knockout'): motor de la fase de grupos. SIN UI. Sin pasaje a la Copa ni a
-- Consuelo (B4).
--
-- Cómo se reutiliza el todos contra todos (round_robin) en la fase de grupos:
--   * Los pairings 'zone' e 'interzonal' (0136) se juegan, se resuelven y se puntúan IGUAL que los de todos contra
--     todos: update_pairing_official_result (0095) los resuelve por match_format (BO1: 1 partida; BO2: 2-0 o 1-1
--     empate; BO3: 2 victorias) sin mirar el formato de competición, y classify_match_type (0134) pasa a 'revenge' toda
--     partida 'draft' posterior al resultado oficial. No hace falta tocarlos.
--   * "Me voy": apply_walkover_for_participant (0099) ya resuelve cualquier pairing pendiente del que se va (de zona e
--     interzonal) con walkover a favor del rival, y lo ya jugado queda. Si el rival TAMBIÉN se fue, el pairing queda
--     sin resolver. Tampoco se toca.
--   * Venganzas: ensure_revenge_pairing es la función de la Copa (sólo llaves) y no se usa fuera de ella, igual que en
--     todos contra todos y Suizo; la venganza de un par de zonas se juega sobre su pairing 'zone' / 'interzonal' una
--     vez resuelto el oficial. Siempre jugable, en cualquier estado del evento (no hay nada que lo impida a nivel DB).
--
-- Alcance:
--   1. draft_events.zones_phase_completed_at: marca de fase de grupos completa.
--   2. zone_standings(event_id): posición de cada jugador DENTRO de su zona con exactamente la cascada del todos contra
--      todos (rankRoundRobinBo1Standings, app/src/lib/podium.ts), contando TODOS sus pairings resueltos de la fase:
--      los de su zona y su interzonal.
--        - Puntos: BO1/BO3 = 1 por enfrentamiento ganado; BO2 = 3 ganado, 1 empatado, 0 perdido.
--        - Empate de puntos: sub-tabla interna del grupo empatado (head-to-head) -> si el grupo entero queda igual
--          (ciclo): calidad de rivales (suma de puntos TOTALES de los rivales a los que le ganó, fuera del propio
--          ciclo; el rival del interzonal cuenta con sus puntos reales) -> recursión sobre el resto -> hash estable.
--        - Criterio estable final (cuando ninguna regla desempata): hash determinístico del participant_id, el mismo
--          que usa el todos contra todos (h = h*31 + código de carácter, entero de 32 bits con signo), menor primero.
--          No se juegan desempates en la fase de grupos.
--        - Se listan todos los jugadores de la zona (incluidos los que se fueron), con los pairings pendientes en cero.
--   3. zones_check_phase_complete(event_id) + triggers: cuando TODOS los pairings 'zone' e 'interzonal' están resueltos
--      (oficial con ganador o empate BO2, incluido el walkover) se marca zones_phase_completed_at. Un pairing donde
--      los DOS jugadores se fueron cuenta como cerrado (no hay a quién darle el walkover). Idempotente; el evento sigue
--      en 'playing'. Se dispara al resolverse un pairing (trigger sobre pairings, que también captura el walkover
--      porque inserta partidas y eso resuelve el pairing) y al marcarse un participante como ido.
--
-- Funciones: ninguna función viva se reemplaza (todas nuevas). No se toca evaluate_tiebreak_group_after_match ni el
-- motor knockout; los otros formatos no pasan por nada de esto (cada función sale si el evento no es zones_knockout).

-- ===========================================================================
-- 1. Marca de fase completa
-- ===========================================================================
alter table public.draft_events
  add column if not exists zones_phase_completed_at timestamptz;

-- ===========================================================================
-- 2. Tabla por zona
-- ===========================================================================

-- Hash estable idéntico a stableHash de podium.ts (djb2-like sobre los códigos de carácter, entero de 32 bits).
create or replace function public.zones_stable_hash(p text)
returns integer
language plpgsql
immutable
as $$
declare
  h bigint := 0;
  i integer;
begin
  for i in 1..coalesce(length(p), 0) loop
    h := h * 31 + ascii(substr(p, i, 1));
    h := ((h + 2147483648) % 4294967296 + 4294967296) % 4294967296 - 2147483648;
  end loop;
  return h::integer;
end;
$$;

-- Ordena un grupo empatado en puntos (resolveTieGroup de podium.ts sin gameWinrateMap). Lee las tablas temporales
-- _zr_pairings (pa, pb, winner, draw, pts_a, pts_b) y _zr_points (pid, pts) que arma zone_standings.
create or replace function public.zones_tie_order(p_group uuid[])
returns uuid[]
language plpgsql
volatile
as $$
declare
  v_n integer := coalesce(cardinality(p_group), 0);
  v_order uuid[] := '{}';
  v_key integer;
  v_bucket uuid[];
  v_chosen uuid;
begin
  if v_n <= 1 then
    return coalesce(p_group, '{}');
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
      v_order := v_order || v_bucket;
    elsif cardinality(v_bucket) = v_n then
      -- Ciclo: el head-to-head no diferenció a nadie. Se elige al primero por calidad de rivales (hash como último
      -- recurso) y se recursa sobre el resto, así su resultado directo decide el orden interno.
      select b.pid into v_chosen
      from unnest(v_bucket) as b(pid)
      order by
        coalesce((
          select sum(coalesce((
            select z.pts from _zr_points z where z.pid = case when p.pa = b.pid then p.pb else p.pa end
          ), 0))
          from _zr_pairings p
          where p.winner = b.pid
            and (case when p.pa = b.pid then p.pb else p.pa end) <> all (v_bucket)
        ), 0) desc,
        public.zones_stable_hash(b.pid::text) asc
      limit 1;
      v_order := v_order || v_chosen || public.zones_tie_order(array_remove(v_bucket, v_chosen));
    else
      v_order := v_order || public.zones_tie_order(v_bucket);
    end if;
  end loop;

  return v_order;
end;
$$;

-- Orden de los jugadores de una zona: por puntos totales (zona + interzonal) y, dentro de cada empate, zones_tie_order.
create or replace function public.zones_rank_members(p_members uuid[])
returns uuid[]
language plpgsql
volatile
as $$
declare
  v_order uuid[] := '{}';
  v_pts integer;
  v_grp uuid[];
begin
  if coalesce(cardinality(p_members), 0) = 0 then
    return '{}';
  end if;
  for v_pts, v_grp in
    select z.pts, array_agg(z.pid)
    from _zr_points z
    where z.pid = any (p_members)
    group by z.pts
    order by z.pts desc
  loop
    v_order := v_order || public.zones_tie_order(v_grp);
  end loop;
  return v_order;
end;
$$;

create or replace function public.zone_standings(p_event_id uuid)
returns table (
  zone_id uuid,
  zone_index smallint,
  zone_name text,
  participant_id uuid,
  user_id uuid,
  rank_in_zone integer,
  points integer,
  pairings_won integer,
  pairings_drawn integer,
  pairings_lost integer,
  pairings_resolved integer,
  left_event_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_event record;
  v_bo2 boolean;
begin
  select de.id, de.workspace_id, de.competition_format, de.match_format
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null;

  if v_event.id is null then
    raise exception 'zone_standings: el evento no existe.';
  end if;
  if not public.is_workspace_member(v_event.workspace_id) then
    raise exception 'zone_standings: no tenés acceso a este evento.' using errcode = '42501';
  end if;
  if v_event.competition_format <> 'zones_knockout' then
    raise exception 'zone_standings: el evento no es una Copa de grupos + llaves.';
  end if;

  v_bo2 := v_event.match_format = 'bo2';

  drop table if exists _zr_pairings;
  drop table if exists _zr_points;
  create temporary table _zr_pairings (
    pa uuid not null, pb uuid not null, winner uuid, draw boolean not null, pts_a integer not null, pts_b integer not null
  ) on commit drop;
  create temporary table _zr_points (pid uuid primary key, pts integer not null) on commit drop;

  -- Pairings de la fase (zona + interzonal). Puntos por lado: BO2 = 3 ganado / 1 empate / 0; BO1 y BO3 = 1 / 0.
  insert into _zr_pairings (pa, pb, winner, draw, pts_a, pts_b)
  select p.participant_a_id, p.participant_b_id, p.official_winner_participant_id,
         (p.official_winner_participant_id is null and p.official_draw is true),
         case
           when p.official_winner_participant_id = p.participant_a_id then case when v_bo2 then 3 else 1 end
           when p.official_winner_participant_id is null and p.official_draw is true and v_bo2 then 1
           else 0
         end,
         case
           when p.official_winner_participant_id = p.participant_b_id then case when v_bo2 then 3 else 1 end
           when p.official_winner_participant_id is null and p.official_draw is true and v_bo2 then 1
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

  return query
  select r.zid, r.zidx, r.zname, r.pid, ep.user_id, r.ord::integer, pt.pts,
         (select count(*) from _zr_pairings q where q.winner = r.pid)::integer,
         (select count(*) from _zr_pairings q where q.draw and (q.pa = r.pid or q.pb = r.pid))::integer,
         (select count(*) from _zr_pairings q
           where q.winner is not null and q.winner <> r.pid and (q.pa = r.pid or q.pb = r.pid))::integer,
         (select count(*) from _zr_pairings q
           where (q.winner is not null or q.draw) and (q.pa = r.pid or q.pb = r.pid))::integer,
         ep.left_event_at
  from (
    select z.id as zid, z.zone_index as zidx, z.name as zname, t.pid, t.ord
    from public.event_zones z
    cross join lateral unnest(
      public.zones_rank_members((
        select array_agg(m.id) from public.event_participants m
        where m.event_id = p_event_id and m.zone_id = z.id and m.role = 'player'
      ))
    ) with ordinality as t(pid, ord)
    where z.event_id = p_event_id
  ) r
  join public.event_participants ep on ep.id = r.pid
  join _zr_points pt on pt.pid = r.pid
  order by r.zidx, r.ord;
end;
$$;

-- ===========================================================================
-- 3. Cierre de la fase de grupos
-- ===========================================================================
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
    update public.draft_events
    set zones_phase_completed_at = now()
    where id = p_event_id and zones_phase_completed_at is null and status = 'playing';
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.zones_phase_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.zones_check_phase_complete(new.event_id);
  return new;
end;
$$;

-- Al resolverse un pairing de la fase (partida terminada o walkover: ambos terminan actualizando el pairing).
drop trigger if exists trg_zones_phase_pairing_resolved on public.pairings;
create trigger trg_zones_phase_pairing_resolved
  after update of official_winner_participant_id, official_draw on public.pairings
  for each row
  when (new.stage in ('zone', 'interzonal') and (new.official_winner_participant_id is not null or new.official_draw is true))
  execute function public.zones_phase_trigger();

-- Al marcarse un participante como ido (un pairing con los dos ido deja de trabar el cierre).
drop trigger if exists trg_zones_phase_participant_left on public.event_participants;
create trigger trg_zones_phase_participant_left
  after update of left_event_at on public.event_participants
  for each row
  when (new.left_event_at is not null and old.left_event_at is distinct from new.left_event_at)
  execute function public.zones_phase_trigger();

-- ===========================================================================
-- Permisos
-- ===========================================================================
revoke execute on function public.zones_stable_hash(text) from public, anon, authenticated;
revoke execute on function public.zones_tie_order(uuid[]) from public, anon, authenticated;
revoke execute on function public.zones_rank_members(uuid[]) from public, anon, authenticated;
revoke execute on function public.zones_check_phase_complete(uuid) from public, anon, authenticated;
revoke execute on function public.zones_phase_trigger() from public, anon, authenticated;

revoke execute on function public.zone_standings(uuid) from public, anon;
grant execute on function public.zone_standings(uuid) to authenticated;
