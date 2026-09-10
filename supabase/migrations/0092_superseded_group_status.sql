-- 0092_superseded_group_status.sql
-- Bug reportado en vivo: en PairingsListScreen.tsx, después de un recálculo de Fase 5
-- (close_active_round_robin_fourth_place_group + recreación del grupo con el roster reducido),
-- aparecían DOS secciones "Desempate por el 4to puesto" — la vieja (semis con el que se fue) y
-- la nueva. Diagnóstico confirmado: agsRes trae toda fila event_tiebreak_groups con
-- status in ('active','resolved','failed'), y el loop de fourthPlaceFamilyGroups arma una
-- sección por CADA fila 'fourth_place' encontrada, sin deduplicar a "la más reciente" (a
-- diferencia de mainGroup, que sí usa .find() sobre el array ordenado por created_at desc).
--
-- Los tres close_active_round_robin_*_group (0086/0089/0091) marcan el grupo viejo con
-- status='resolved' — EL MISMO status que un cierre real (el desempate se jugó de verdad y
-- avanzó a la siguiente fase). PairingsListScreen no tiene forma de distinguir "resuelto
-- jugando, debe seguir visible como historial" (comportamiento correcto ya existente) de
-- "cerrado por recálculo, reemplazado por otro grupo que cubre la misma disputa" (debe
-- desaparecer, solo el reemplazo importa).
--
-- Fix: nuevo status 'superseded', exclusivo de los tres close_active_*, distinto de 'resolved'.
-- No hace falta tocar NINGÚN filtro de cliente — auditado exhaustivamente (grep de
-- `.eq('status'`/`.in('status'` en las 7 pantallas que consultan event_tiebreak_groups, más
-- `=== 'resolved'` en todo app/src, sin resultados fuera de SQL): TODAS las queries de cliente
-- ya usan allowlists explícitas (`.in('status', ['active','resolved','failed'])` o
-- `.eq('status','active')`) que naturalmente excluyen cualquier valor no listado — 'superseded'
-- queda afuera de esas queries sin ningún cambio de código, PairingsListScreen incluido. La
-- única query sin filtro de status (StandingsScreen.tsx, el resaltado amarillo de "disputa" por
-- group_origin, que agrega sobre TODAS las filas encontradas) sigue viendo los grupos
-- 'superseded' tal cual — correcto y necesario: esa es la que preserva la evidencia de que
-- alguien fue parte de una disputa real aunque se haya ido, mismo principio ya confirmado para
-- round_robin_first_place.
--
-- Mismo problema potencial en Fase 3 (close_active_round_robin_first_place_group) y Fase 4
-- (close_active_round_robin_topcut_bracket_group), aunque no se haya notado visualmente ahí
-- todavía — mismo fix por consistencia, las tres funciones cierran con el mismo propósito.

alter table public.event_tiebreak_groups
  drop constraint if exists event_tiebreak_groups_status_check;

alter table public.event_tiebreak_groups
  add constraint event_tiebreak_groups_status_check
  check (status in ('active', 'resolved', 'failed', 'superseded'));

-- ── close_active_round_robin_first_place_group (Fase 3, 0086): status='superseded'. ───────────
create or replace function public.close_active_round_robin_first_place_group(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_origin = 'round_robin_first_place'
    and status = 'active';

  if v_group_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.pairing_id is not null
      and public.tiebreak_leg_has_started(bm.pairing_id)
  ) into v_any_started;

  if v_any_started then
    return false;
  end if;

  update public.event_tiebreak_groups
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;

-- ── close_active_round_robin_topcut_bracket_group (Fase 4, 0089): status='superseded'. ────────
create or replace function public.close_active_round_robin_topcut_bracket_group(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_type = 'bracket'
    and group_origin = 'round_robin_topcut'
    and status = 'active';

  if v_group_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.pairing_id is not null
      and public.tiebreak_leg_has_started(bm.pairing_id)
  ) into v_any_started;

  if v_any_started then
    return false;
  end if;

  update public.event_tiebreak_groups
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;

-- ── close_active_round_robin_fourth_place_group (Fase 5, 0091): status='superseded'. ──────────
create or replace function public.close_active_round_robin_fourth_place_group(p_event_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_group_id uuid;
  v_any_started boolean;
begin
  select id into v_group_id
  from public.event_tiebreak_groups
  where event_id = p_event_id
    and group_type = 'fourth_place'
    and group_origin = 'round_robin_fourth_place'
    and status = 'active';

  if v_group_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.event_tiebreak_bracket_matches bm
    where bm.group_id = v_group_id
      and bm.pairing_id is not null
      and public.tiebreak_leg_has_started(bm.pairing_id)
  ) into v_any_started;

  if v_any_started then
    return false;
  end if;

  update public.event_tiebreak_groups
  set status = 'superseded', resolved_at = now()
  where id = v_group_id;

  return true;
end;
$$;
