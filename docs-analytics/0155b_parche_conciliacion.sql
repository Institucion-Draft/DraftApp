-- 0155b_parche_conciliacion.sql
-- PARCHE sobre 0155 YA APLICADA. NO aplicado: lo corrés vos a mano en el SQL Editor (rol postgres).
--
-- QUÉ ARREGLA
--   analytics_private.v_conciliacion_calc comparaba las partidas publicadas contra public.v_participant_official_games SIN aplicar la regla de
--   publicación de contrato.md §1: las partidas de un cruce decidido por walkover no se publican (su cruce no se publica). La vista de la app sí cuenta
--   esas partidas reales, así que 'conciliacion:partidas' daba false (p. ej. 846 vs 816) aunque la extracción fuera correcta.
--   Cambio: del lado de la app se excluyen esas partidas reutilizando v_partidas_base / v_enfrentamientos_base (misma lógica que la publicación).
--   Sigue detectando diferencias reales: una partida publicable que falte, una publicada que no esté en la app, o un cruce faltante por cualquier
--   motivo que NO sea walkover.
--
-- QUÉ NO TOCA
--   Solo redefine la vista. No cambia datos, columnas ni la extracción. CREATE OR REPLACE VIEW conserva el dueño y los privilegios (es el mismo objeto);
--   la vista no tiene concesiones para nadie salvo el dueño (REVOKE de la migración 0155). Se repite WITH (security_invoker = false) y las mismas columnas.
--   Verificación (paso 2) antes y después.
--
-- PASOS (como administrador, en este orden)
--   1. ANTES: anotar dueño, privilegios y opciones de la vista (debe ser idéntico después):
--        select c.relowner::regrole as dueno, c.relacl, c.reloptions
--        from pg_class c where c.oid = 'analytics_private.v_conciliacion_calc'::regclass;
--   2. Correr el bloque begin ... commit de abajo (la vista).
--   3. Recalcular analytics_private.control_conciliacion (exacto, interno) y analytics_control.verificacion:
--        BASTA con correr   select analytics_private.refresh_analytics();
--      (el refresco vuelve a calcular control_conciliacion desde la vista y reconstruye verificacion y registro_limpieza, en una sola transacción).
--      Ese refresco vuelve a escribir las seis tablas publicadas: si hubo usuarios, cubos o eventos nuevos desde el último refresco, los puestos
--      (jugadores.id / cubos.id) pueden cambiar. Si NO querés eso, usá la ALTERNATIVA del paso 3b (solo recalcula la conciliación).
--   3b. ALTERNATIVA sin republicar (la vista lee lo ya publicado):
--        begin;
--        delete from analytics_private.control_conciliacion;
--        insert into analytics_private.control_conciliacion (metrica, total_app, total_curado, jugadores_con_diferencia)
--          select metrica, total_app, total_curado, jugadores_con_diferencia from analytics_private.v_conciliacion_calc;
--        delete from analytics_control.verificacion where chequeo like 'conciliacion:%';
--        insert into analytics_control.verificacion (chequeo, ok)
--          select 'conciliacion:' || metrica, (total_app = total_curado and jugadores_con_diferencia = 0) from analytics_private.control_conciliacion;
--        commit;
--   4. DESPUÉS (verificar): repetir la consulta del paso 1 (idéntica) y
--        select * from analytics_private.control_conciliacion;                       -- 2 filas, jugadores_con_diferencia = 0
--        select * from analytics_control.verificacion where chequeo like 'conciliacion:%';   -- ok = true en ambas
--        select * from analytics_control.refresco;                                   -- vigente = true
--
-- ROLLBACK -- NO CORRER: volver a la definición anterior = la misma vista SIN el bloque entre las marcas '>>> PUBLICACIÓN' y '<<< PUBLICACIÓN'
-- (no se recomienda: reintroduce el falso negativo).

begin;
set local lock_timeout = '3s';

create or replace view analytics_private.v_conciliacion_calc with (security_invoker = false) as
with app_enf as (
  select pp.pos, count(*) as n
  from public.v_participant_official_results r
  join analytics_private.v_eventos_validos ev on ev.event_id = r.event_id
  join analytics_private.player_alias pa on pa.user_id = r.user_id
  join analytics_private.player_pos pp on pp.alias_n = pa.alias_n
  left join public.pairings pq on r.source = 'pairing' and pq.id::text = r.result_id
  left join public.event_tiebreak_bracket_matches bb on r.source = 'bracket' and bb.id::text = r.result_id
  where not exists (select 1 from analytics_private.player_optout o
                    join public.event_participants ex on ex.user_id = o.user_id
                    where ex.id in (coalesce(pq.participant_a_id, bb.participant_a_id), coalesce(pq.participant_b_id, bb.participant_b_id)))
  group by pp.pos
), cur_enf as (
  select s.pos, count(*) as n from (
    select e.evento_id, e.jugador_a as pos from analytics.enfrentamientos e where e.resultado = 'victoria'
    union all
    select e.evento_id, e.jugador_b from analytics.enfrentamientos e where e.resultado = 'victoria'
  ) s
  join analytics.participaciones p on p.evento_id = s.evento_id and p.jugador_id = s.pos and p.rol = 'player'
  group by s.pos
), app_par as (
  select pp.pos, count(*) as n
  from public.v_participant_official_games g
  join analytics_private.v_eventos_validos ev on ev.event_id = g.event_id
  join analytics_private.player_alias pa on pa.user_id = g.user_id
  join analytics_private.player_pos pp on pp.alias_n = pa.alias_n
  join public.matches mm on mm.id::text = g.result_id
  join public.pairings pq on pq.id = mm.pairing_id
  where not exists (select 1 from analytics_private.player_optout o
                    join public.event_participants ex on ex.user_id = o.user_id
                    where ex.id in (pq.participant_a_id, pq.participant_b_id))
  -- >>> PUBLICACIÓN: regla de contrato.md §1, reutilizada de las vistas base (no se duplica a mano). Una partida real de un cruce decidido por
  --     walkover NO se publica porque su cruce no se publica; la vista oficial de la app sí la cuenta, así que se excluye de ESTE lado.
  --     Solo se excluye por walkover: una partida publicable que falte, o cuyo cruce falte por cualquier otro motivo, sigue marcando diferencia.
  and not exists (select 1 from analytics_private.v_partidas_base b
                  join analytics_private.v_enfrentamientos_base cz on cz.enf_key = b.enf_key
                  where b.match_id = mm.id and cz.es_walkover)
  -- <<< PUBLICACIÓN
  group by pp.pos
), cur_par as (
  select s.pos, count(*) as n from (
    select e.evento_id, g.jugador_a as pos from analytics.partidas g join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
    union all
    select e.evento_id, g.jugador_b from analytics.partidas g join analytics.enfrentamientos e on e.id = g.enfrentamiento_id
  ) s
  join analytics.participaciones p on p.evento_id = s.evento_id and p.jugador_id = s.pos and p.rol = 'player'
  group by s.pos
), por_jugador as (
  select 'enfrentamientos'::text as metrica, coalesce(a.pos, c.pos) as pos,
         coalesce(a.n, 0) as valor_app, coalesce(c.n, 0) as valor_curado
  from app_enf a full join cur_enf c on c.pos = a.pos
  union all
  select 'partidas', coalesce(a.pos, c.pos), coalesce(a.n, 0), coalesce(c.n, 0)
  from app_par a full join cur_par c on c.pos = a.pos
)
select p.metrica,
       sum(p.valor_app)::bigint as total_app,
       sum(p.valor_curado)::bigint as total_curado,
       (count(*) filter (where p.valor_app <> p.valor_curado))::bigint as jugadores_con_diferencia
from por_jugador p
group by p.metrica;

commit;
