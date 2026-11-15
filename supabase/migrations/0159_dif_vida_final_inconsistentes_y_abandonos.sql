-- 0159_dif_vida_final_inconsistentes_y_abandonos.sql
-- ESTADO: PROPUESTA, NO APLICADA. Aplicar a mano desde el SQL Editor (rol postgres), una sola vez, siguiendo los pasos de abajo.
--
-- QUÉ CAMBIA
--   Redefine SOLO analytics_private.dif_vida_final(match_id) (la 0158 ya está aplicada y no se edita). refresh_analytics() la LLAMA y no embebe
--   la lógica, así que NO se redefine ni se toca. La columna analytics.partidas.dif_vida_final, los permisos y el universo de partidas siguen igual.
--   Reglas, en este orden de prioridad (la primera que aplica gana):
--     1. NULL si la partida no tiene NINGÚN life_events (no se usa la vida inicial en ese caso).
--     2. NULL si algún life_events de la partida tiene un participant_id que NO es ni participant_a_id ni participant_b_id del pairing de esa
--        partida (dato inconsistente de origen: los eventos del perdedor quedaron guardados con un participante ajeno al cruce y el cálculo
--        usaba la vida inicial, dando un valor falso). Esta regla tiene prioridad sobre la de abandonos.
--     3. ABANDONO (matches.ended_by_surrender = true): la vida del que abandona (el lado que NO es winner_participant_id) se toma como 0, sin
--        importar sus life_events. dif_vida_final = vida final del ganador - 0.
--     4. Si no: vida final del ganador menos vida final del perdedor, como en la 0158: para cada lado, resulting_life del último life_events
--        de la partida (occurred_at desc, id desc); si un lado no tiene eventos, su vida inicial (starting_life_a / starting_life_b según sea
--        el participante A o B del pairing).
--     La vida final del ganador (reglas 3 y 4) es el último life_events del ganador, o su vida inicial si no tiene eventos. No se recorta:
--     con la regla de abandonos un negativo solo puede salir en casos raros (p. ej. el ganador en 0 o por debajo).
--
-- CUERPO VIVO QUE REEMPLAZA (md5 del texto entre los $$ ; prosrc en pg_proc):
--   analytics_private.dif_vida_final   68255985c17912a304509477599dca8c  (1160 caracteres con LF; con CRLF: 114f3651185eccd42a3caa851c442262, 1184)  [0158]
--   Comparar en Supabase:  select proname, md5(prosrc), length(prosrc) from pg_proc
--                          where pronamespace = 'analytics_private'::regnamespace and proname = 'dif_vida_final';
--   (si el md5 vivo no coincide con ninguno de los dos, la base tiene un cuerpo distinto del de la 0158: NO aplicar sin revisar la diferencia).
--
-- CÓMO APLICARLA EN PRODUCCIÓN (a mano, SQL Editor)
--   0. FUERA de la ventana del cron de refresco (08:30 UTC = 05:30 Buenos Aires): la migración toma el mismo lock y esperaría.
--   1. ANTES: anotar la Consulta A (esperado hoy: 402 partidas con dato) y las Consultas B y D (los valores falsos de hoy).
--   2. Correr ESTE archivo completo (una sola transacción; no llama al refresco).
--   3. Refrescar a mano: select analytics_private.refresh_analytics();   (hasta entonces la tabla publicada conserva los valores viejos)
--   4. DESPUÉS: repetir las consultas de abajo. Esperado: A) con dato pasa de 402 a 395 (de 408 partidas: 96,8 %); B) las 7 partidas tiebreak de Copa Cordero Atado en NULL;
--      C) ninguna partida con diferencial negativo por rendición (y cada negativo que quede se revisa a mano: caso raro); D) las 2 partidas por
--      rendición que daban -5 y -1 pasan a ser positivas.
--   5. Correr las verificaciones de operacion.md §e (privilegios y RLS; analytics_control.verificacion todo en true; refresco vigente).
--   6. El loader de DraftApp-analytics no necesita cambios (la columna ya existe; solo cambian algunos valores y hay 7 NULL más).
--
-- CONSULTA A (cobertura; la ve también analytics_reader)
--   select count(*) as partidas, count(dif_vida_final) as con_dato, count(*) filter (where dif_vida_final < 0) as negativos from analytics.partidas;
--
-- CONSULTA B (SOLO administrador; esperado: 7 filas, todas con dif_vida_final NULL; una de ellas, e6547d6d, además es por rendición: la regla del participante ajeno tiene prioridad)
--   select g.match_id, p.dif_vida_final
--   from analytics_private.v_partidas_base g join analytics.partidas p on p.id = g.partida_key
--   where g.match_id in ('7161430a-716b-4c5d-b862-4f747935710b', '8e00a333-5ab2-4ab2-858a-1c5c83f5315e', 'bc80d9e5-0adb-484c-a21e-8af4966ee576', 'd4206b74-6cc5-42e7-9a3c-41c626bc8a8d', 'e3e71011-a0fa-4fc1-89fc-1cef58ee741c', 'e6547d6d-7390-4e94-98b6-dc6a85f40983', 'f7d96c45-5f1b-4604-b2e9-a20d732c1aa6');
--
-- CONSULTA C (SOLO administrador; negativos publicados con su motivo; esperado: ninguno con ended_by_surrender = true)
--   select g.match_id, m.ended_by_surrender, p.dif_vida_final
--   from analytics_private.v_partidas_base g join analytics.partidas p on p.id = g.partida_key join public.matches m on m.id = g.match_id
--   where p.dif_vida_final < 0 order by p.dif_vida_final;
--
-- CONSULTA D (SOLO administrador; partidas por rendición publicadas: ninguna negativa; las que daban -5 y -1 ahora son positivas)
--   select g.match_id, p.dif_vida_final
--   from analytics_private.v_partidas_base g join analytics.partidas p on p.id = g.partida_key join public.matches m on m.id = g.match_id
--   where m.ended_by_surrender order by p.dif_vida_final;
--
-- CONSULTA E (SOLO administrador; control no bloqueante, calidad.md P-PRIV-20: partidas publicadas con life_events de participantes ajenos al cruce; hoy 7)
--   select count(*) from analytics_private.v_partidas_base g
--   join analytics.partidas p on p.id = g.partida_key
--   join public.matches m on m.id = g.match_id join public.pairings pr on pr.id = m.pairing_id
--   where exists (select 1 from public.life_events le where le.match_id = m.id and le.participant_id not in (pr.participant_a_id, pr.participant_b_id));

begin;
set local lock_timeout = '3s';
-- El MISMO lock que toma refresh_analytics(): mientras corre la migración ningún refresco usa la función a medio cambiar.
select pg_advisory_xact_lock(hashtext('analytics_refresh'));

create or replace function analytics_private.dif_vida_final(p_match_id uuid)
returns integer
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
           -- 1) sin ningún life_events: NULL (no se usa la vida inicial)
           when not exists (select 1 from public.life_events le0 where le0.match_id = m.id) then null
           -- 2) algún life_events de un participante que no es ni A ni B del cruce: dato inconsistente, NULL (prioridad sobre el abandono)
           when exists (select 1 from public.life_events le1
                        where le1.match_id = m.id and le1.participant_id not in (p.participant_a_id, p.participant_b_id)) then null
           else coalesce(wl.resulting_life,
                         case when m.winner_participant_id = p.participant_a_id then m.starting_life_a else m.starting_life_b end)
              - case
                  -- 3) abandono: el que abandona (el lado que no es el ganador) queda en 0, sin importar sus eventos
                  when m.ended_by_surrender is true then 0
                  -- 4) normal: vida final del perdedor (último evento, o su vida inicial si no tiene)
                  else coalesce(ll.resulting_life,
                                case when lp.loser_id = p.participant_a_id then m.starting_life_a else m.starting_life_b end)
                end
         end
  from public.matches m
  join public.pairings p on p.id = m.pairing_id
  cross join lateral (
    select case when m.winner_participant_id = p.participant_a_id then p.participant_b_id else p.participant_a_id end as loser_id
  ) lp
  left join lateral (
    select le.resulting_life from public.life_events le
    where le.match_id = m.id and le.participant_id = m.winner_participant_id
    order by le.occurred_at desc, le.id desc limit 1
  ) wl on true
  left join lateral (
    select le.resulting_life from public.life_events le
    where le.match_id = m.id and le.participant_id = lp.loser_id
    order by le.occurred_at desc, le.id desc limit 1
  ) ll on true
  where m.id = p_match_id
$$;

comment on function analytics_private.dif_vida_final(uuid) is 'Diferencial de vida final de una partida (ganador - perdedor). NULL sin life_events o con eventos de un participante ajeno al cruce; en un abandono (ended_by_surrender) la vida del perdedor cuenta como 0. Ver 0159.';

-- create or replace conserva el dueño y el ACL; se repite el REVOKE explícito por si algún entorno la tuviera abierta.
revoke all on function analytics_private.dif_vida_final(uuid) from public, anon, authenticated, service_role, analytics_reader;

do $verify$
begin
  if has_function_privilege('analytics_reader', 'analytics_private.dif_vida_final(uuid)', 'execute')
     or has_function_privilege('anon', 'analytics_private.dif_vida_final(uuid)', 'execute')
     or has_function_privilege('authenticated', 'analytics_private.dif_vida_final(uuid)', 'execute') then
    raise exception '0159: dif_vida_final(uuid) es ejecutable por roles que no corresponden';
  end if;
  if not (select prosecdef from pg_proc where oid = 'analytics_private.dif_vida_final(uuid)'::regprocedure) then
    raise exception '0159: dif_vida_final(uuid) dejó de ser SECURITY DEFINER';
  end if;
end;
$verify$;

commit;

-- ============================================================================================================================
-- ROLLBACK -- NO CORRER. Solo documenta cómo deshacer; ejecutar únicamente con revisión manual.
--   1. Re-ejecutar la definición de analytics_private.dif_vida_final(uuid) de supabase/migrations/0158_partidas_dif_vida_final.sql
--      (sección 2, "create or replace function analytics_private.dif_vida_final(p_match_id uuid) ... $$;") y su REVOKE explícito.
--   2. select analytics_private.refresh_analytics();   -- vuelven los valores de la 0158 (incluidos los falsos de las 7 partidas inconsistentes
--      y los abandonos con la vida del perdedor según sus eventos)
-- ============================================================================================================================
