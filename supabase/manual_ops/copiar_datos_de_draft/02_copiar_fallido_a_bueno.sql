-- ============================================================================================================================
-- 02 — COPIAR los datos de draft del evento FALLIDO al evento BUENO (mismo workspace).  Correr como postgres en el SQL Editor.
--
-- QUÉ COPIA (del FALLIDO al BUENO)
--   1. TIEMPO DE DRAFT: draft_events.draft_started_at y draft_events.draft_ended_at.
--   2. CRONÓMETRO: draft_events.is_timed_draft, timer_packs, timer_alpha, timer_beta, timer_gamma, timer_delta, timer_rho, timer_tmin,
--      timer_tmax, timer_color  +  las filas de draft_timer_logs (una por pick; no tienen ids de participantes).
--   3. SORTEO DE LUGARES: event_seating (n, direction, seats, drawn_by, drawn_at, published_at) y draft_events.random_seating_enabled
--      (sin el toggle en true la app no muestra la mesa). event_seating.seats guarda por asiento participant_id y user_id: el participant_id
--      es del FALLIDO y NO sirve en el bueno, así que se REMAPEA por user_id a la inscripción del bueno. Es lo único que depende de ids de
--      participantes: el resto no (los timer_* y los logs son del evento; los tiempos son del evento).
--
-- QUÉ NO TOCA (datos propios del bueno) Y POR QUÉ
--   name, event_type, competition_format, match_format, top_size, topcut_format, swiss_*: son el tipo de competición CORRECTO, la razón de todo esto.
--   status, event_ended_at, champion_*, final_pending: el estado de juego del bueno es el real (lo que se jugó en él).
--   scheduled_for, cube_id, venue_id, notes, avatar_path, is_official, starting_life, turn_tracking_enabled: configuración propia del bueno.
--   event_participants (inscripciones, colores, avatares, shiny, special_reward), pairings, matches, life_events, diario, predicciones: lo jugado en el bueno.
--   event_seating_pending (sorteo sin publicar): no tiene sentido con el draft ya arrancado.
--   REEMPLAZA (con respaldo): los draft_timer_logs y el event_seating que el bueno ya tuviera, porque son del "draft rápido" y mezclarlos con los
--   reales duplicaría picks (global_pick) y sentaría a la gente dos veces. Se controla con el parámetro reemplazar_logs_y_sorteo_del_bueno.
--
-- TRIGGERS / GUARDS (cómo se resuelven acá)
--   * trg_seating_enforce_before_start (draft_events, 0144): impide cambiar random_seating_enabled una vez arrancado el draft. Si hace falta
--     cambiar el toggle, SE DESACTIVA solo ese trigger dentro de esta misma transacción y se vuelve a activar antes del commit (si algo falla,
--     el rollback lo deja como estaba; DISABLE TRIGGER es transaccional).
--   * draft_events_seasons_sync_trg (0116): al cambiar draft_started_at asegura las temporadas y puede cerrar temporadas listas. Por eso el script
--     ABORTA si el nuevo draft_started_at caería en OTRA temporada que el actual del bueno.
--   * achievements_enq_events_upd (0124): encola el evento y se reevalúa al commit; es idempotente (único por workspace/temporada/usuario/logro).
--   * trg_draft_events_updated_at y trg_audit_draft_events: actualizan updated_at y dejan registro de auditoría. Esperado.
--   * special_unlock_* (0157): disparan con matches (completed/aborted) y con cancelled_at/deleted_at; esta copia no toca ninguna de esas columnas.
--   * Escribir como postgres: el rol saltea RLS y los grants de columna (authenticated no puede escribir draft_timer_logs ni event_seating por
--     fuera de las RPC). NO usar session_replication_role = replica: apagaría también auditoría, logros y temporadas.
--   * ANALYTICS: no hay trigger; el próximo refresh_analytics() (cron 08:30 UTC) toma la nueva duración de draft (draft_ended_at - draft_started_at) y la
--     fecha (día de draft_started_at en Buenos Aires) del evento bueno.
--
-- CÓMO USARLO
--   1. Editar SOLO el bloque PARÁMETROS (los dos ids y el interruptor).
--   2. Correr TODO el archivo (BEGIN ... COMMIT). Si algo no cierra, el bloque DO aborta con un mensaje claro y no queda NADA aplicado
--      (si el editor deja la transacción abierta, correr: rollback;).
--   3. Correr 03_verificar.sql (solo lectura: lado a lado fallido vs bueno).
--   4. ROLLBACK (NO CORRER salvo marcha atrás): bloque al final de este archivo; restaura desde admin_private.event_copy_backup.
-- ============================================================================================================================
begin;
set local lock_timeout = '10s';

-- ============================== PARÁMETROS (lo único que se edita) ==============================
create temp table _p on commit drop as
select 'PEGAR-ID-DEL-EVENTO-FALLIDO'::uuid as fallido,   -- el que tiene los datos reales del draft
       'PEGAR-ID-DEL-EVENTO-BUENO'::uuid   as bueno,     -- el de tipo de competición correcto (recibe los datos)
       true                                as reemplazar_logs_y_sorteo_del_bueno;
-- =================================================================================================

-- Respaldo: una tabla privada (no expuesta por la API), con RLS y sin acceso para public, anon ni authenticated.
create schema if not exists admin_private;
revoke all on schema admin_private from public, anon, authenticated;
create table if not exists admin_private.event_copy_backup (
  id           bigserial primary key,
  run_id       uuid        not null,
  backed_up_at timestamptz not null default now(),
  fallido      uuid        not null,
  bueno        uuid        not null,
  tabla        text        not null,
  fila         jsonb       not null
);
alter table admin_private.event_copy_backup enable row level security;
revoke all on admin_private.event_copy_backup from public, anon, authenticated, service_role;

do $copiar$
declare
  p            record;
  f            public.draft_events%rowtype;
  b            public.draft_events%rowtype;
  v_run        uuid := gen_random_uuid();
  v_dif        text;
  v_n_players  integer;
  v_seat       record;
  v_seats      jsonb;
  v_seat_n     integer;
  v_tiene_sorteo boolean;
  v_logs_f     integer;
  v_logs_b     integer;
  v_new_rse    boolean;
begin
  select * into p from _p;
  if p.fallido = p.bueno then
    raise exception 'ABORTADO: el evento fallido y el bueno son el MISMO id.';
  end if;
  select * into f from public.draft_events where id = p.fallido;
  select * into b from public.draft_events where id = p.bueno;
  if f.id is null then raise exception 'ABORTADO: no existe el evento FALLIDO %.', p.fallido; end if;
  if b.id is null then raise exception 'ABORTADO: no existe el evento BUENO %.', p.bueno; end if;
  if f.workspace_id <> b.workspace_id then
    raise exception 'ABORTADO: los eventos son de workspaces distintos (fallido %, bueno %).', f.workspace_id, b.workspace_id;
  end if;
  if b.deleted_at is not null or b.cancelled_at is not null then
    raise exception 'ABORTADO: el evento BUENO está borrado o cancelado.';
  end if;
  if f.event_type = 'two_headed_giant' or b.event_type = 'two_headed_giant' then
    raise exception 'ABORTADO: este script no está pensado para eventos 2HG (los asientos van por persona y las inscripciones son equipos).';
  end if;
  if f.draft_started_at is null then
    raise exception 'ABORTADO: el evento FALLIDO no tiene draft_started_at: no hay tiempo de draft para copiar.';
  end if;
  if b.draft_started_at is not null
     and public.season_start_at(f.draft_started_at) is distinct from public.season_start_at(b.draft_started_at) then
    raise exception 'ABORTADO: copiar draft_started_at movería el evento bueno a OTRA temporada (fallido %, bueno %). Revisar a mano.',
      f.draft_started_at, b.draft_started_at;
  end if;

  -- Participantes (jugadores activos) de ambos eventos, por user_id.
  select string_agg(format('  - %s (%s): %s', coalesce(nullif(u.display_name, ''), u.username), x.uid, x.donde), E'\n' order by x.donde, x.uid)
  into v_dif
  from (
    select coalesce(fa.user_id, ba.user_id) as uid,
           case when ba.user_id is null then 'está solo en el FALLIDO' else 'está solo en el BUENO' end as donde
    from (select user_id from public.event_participants where event_id = p.fallido and role = 'player' and left_event_at is null) fa
    full join (select user_id from public.event_participants where event_id = p.bueno and role = 'player' and left_event_at is null) ba
      on ba.user_id = fa.user_id
    where fa.user_id is null or ba.user_id is null
  ) x
  left join public.users u on u.id = x.uid;
  if v_dif is not null then
    raise exception E'ABORTADO: los participantes (jugadores activos) de los dos eventos NO coinciden:\n%\nCorregí las inscripciones y volvé a correr.', v_dif;
  end if;
  select count(*) into v_n_players from public.event_participants where event_id = p.bueno and role = 'player' and left_event_at is null;
  if v_n_players = 0 then
    raise exception 'ABORTADO: los eventos no tienen jugadores activos.';
  end if;

  -- Sorteo de lugares del fallido, remapeado por user_id a las inscripciones del bueno.
  v_tiene_sorteo := exists (select 1 from public.event_seating where event_id = p.fallido);
  if v_tiene_sorteo then
    select jsonb_agg(jsonb_set(e.elem, '{participant_id}', to_jsonb(bp.id::text)) order by (e.elem ->> 'seat')::integer), count(*)::integer
    into v_seats, v_seat_n
    from public.event_seating s
    cross join lateral jsonb_array_elements(s.seats) as e(elem)
    left join public.event_participants bp
      on bp.event_id = p.bueno and bp.role = 'player' and bp.left_event_at is null and bp.user_id = (e.elem ->> 'user_id')::uuid
    where s.event_id = p.fallido;
    select string_agg(format('  - asiento %s: usuario %s no está inscripto (activo) en el BUENO', e.elem ->> 'seat', e.elem ->> 'user_id'), E'\n')
    into v_dif
    from public.event_seating s
    cross join lateral jsonb_array_elements(s.seats) as e(elem)
    where s.event_id = p.fallido
      and not exists (select 1 from public.event_participants bp
                      where bp.event_id = p.bueno and bp.role = 'player' and bp.left_event_at is null and bp.user_id = (e.elem ->> 'user_id')::uuid);
    if v_dif is not null then
      raise exception E'ABORTADO: el sorteo de lugares del FALLIDO tiene usuarios que no están en el BUENO:\n%', v_dif;
    end if;
    if v_seat_n <> v_n_players then
      raise exception 'ABORTADO: el sorteo del FALLIDO tiene % asientos y el BUENO tiene % jugadores activos.', v_seat_n, v_n_players;
    end if;
  end if;

  select count(*) into v_logs_f from public.draft_timer_logs where event_id = p.fallido;
  select count(*) into v_logs_b from public.draft_timer_logs where event_id = p.bueno;
  if (v_logs_b > 0 or exists (select 1 from public.event_seating where event_id = p.bueno)) and not p.reemplazar_logs_y_sorteo_del_bueno then
    raise exception 'ABORTADO: el BUENO ya tiene % logs de cronómetro y/o un sorteo de lugares propio, y reemplazar_logs_y_sorteo_del_bueno = false.', v_logs_b;
  end if;

  -- ---------------- RESPALDO de lo que se va a tocar del BUENO ----------------
  insert into admin_private.event_copy_backup (run_id, fallido, bueno, tabla, fila)
  select v_run, p.fallido, p.bueno, 'draft_events', to_jsonb(d) from public.draft_events d where d.id = p.bueno;
  insert into admin_private.event_copy_backup (run_id, fallido, bueno, tabla, fila)
  select v_run, p.fallido, p.bueno, 'draft_timer_logs', to_jsonb(l) from public.draft_timer_logs l where l.event_id = p.bueno order by l.id;
  insert into admin_private.event_copy_backup (run_id, fallido, bueno, tabla, fila)
  select v_run, p.fallido, p.bueno, 'event_seating', to_jsonb(s) from public.event_seating s where s.event_id = p.bueno;

  -- ---------------- COPIA ----------------
  v_new_rse := case when v_tiene_sorteo then true else b.random_seating_enabled end;
  if v_new_rse is distinct from b.random_seating_enabled then
    alter table public.draft_events disable trigger trg_seating_enforce_before_start;   -- se reactiva abajo, dentro de esta transacción
  end if;
  update public.draft_events
  set draft_started_at = f.draft_started_at,
      draft_ended_at   = f.draft_ended_at,
      is_timed_draft   = f.is_timed_draft,
      timer_packs      = f.timer_packs,
      timer_alpha      = f.timer_alpha,
      timer_beta       = f.timer_beta,
      timer_gamma      = f.timer_gamma,
      timer_delta      = f.timer_delta,
      timer_rho        = f.timer_rho,
      timer_tmin       = f.timer_tmin,
      timer_tmax       = f.timer_tmax,
      timer_color      = f.timer_color,
      random_seating_enabled = v_new_rse
  where id = p.bueno;
  if v_new_rse is distinct from b.random_seating_enabled then
    -- ALTER TABLE falla con eventos de triggers diferidos pendientes (achievements_enq_events_upd): se resuelven ya, antes de reactivar.
    set constraints all immediate;
    alter table public.draft_events enable trigger trg_seating_enforce_before_start;
  end if;

  delete from public.draft_timer_logs where event_id = p.bueno;
  insert into public.draft_timer_logs (event_id, global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds, created_at)
  select p.bueno, l.global_pick, l.pack_index, l.pick_in_pack, l.estimated_seconds, l.actual_seconds, l.created_at
  from public.draft_timer_logs l where l.event_id = p.fallido order by l.id;

  if v_tiene_sorteo then
    delete from public.event_seating where event_id = p.bueno;
    insert into public.event_seating (event_id, n, direction, seats, drawn_by, drawn_at, published_at, is_current, invalidated_at)
    select p.bueno, s.n, s.direction, v_seats, s.drawn_by, s.drawn_at, s.published_at, true, null
    from public.event_seating s where s.event_id = p.fallido;
  end if;

  -- ---------------- CONTROLES (si algo no coincide, falla y se deshace todo) ----------------
  select * into b from public.draft_events where id = p.bueno;
  if b.draft_started_at is distinct from f.draft_started_at or b.draft_ended_at is distinct from f.draft_ended_at then
    raise exception 'ABORTADO (control): los tiempos de draft no quedaron iguales.';
  end if;
  if (select count(*) from public.draft_timer_logs where event_id = p.bueno) <> v_logs_f then
    raise exception 'ABORTADO (control): la cantidad de logs del cronómetro no coincide.';
  end if;
  if v_tiene_sorteo and exists (
       select 1 from public.event_seating s
       cross join lateral jsonb_array_elements(s.seats) as e(elem)
       where s.event_id = p.bueno
         and not exists (select 1 from public.event_participants bp
                         where bp.id = (e.elem ->> 'participant_id')::uuid and bp.event_id = p.bueno and bp.user_id = (e.elem ->> 'user_id')::uuid)) then
    raise exception 'ABORTADO (control): algún asiento quedó apuntando a una inscripción que no es del evento bueno.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_seating_enforce_before_start' and tgrelid = 'public.draft_events'::regclass and tgenabled <> 'D') then
    raise exception 'ABORTADO (control): el trigger trg_seating_enforce_before_start quedó desactivado.';
  end if;

  raise notice 'COPIA OK (run_id %): tiempos de draft, % logs de cronómetro, sorteo de lugares %.', v_run, v_logs_f, case when v_tiene_sorteo then 'copiado y remapeado' else 'no había en el fallido (no se tocó)' end;
end;
$copiar$;

commit;

-- ============================================================================================================================
-- ROLLBACK -- NO CORRER salvo marcha atrás deliberada. Restaura el BUENO a como estaba ANTES de la PRIMERA copia (la más antigua del respaldo).
-- Para usarlo: quitar el "-- " del bloque, poner el id del BUENO y correr todo junto.
-- >>> ROLLBACK
-- begin;
-- set local lock_timeout = '10s';
-- create temp table _r on commit drop as
-- select 'PEGAR-ID-DEL-EVENTO-BUENO'::uuid as bueno,
--        (select run_id from admin_private.event_copy_backup where bueno = 'PEGAR-ID-DEL-EVENTO-BUENO'::uuid order by backed_up_at asc, id asc limit 1) as run_id;
-- do $rollback$
-- declare r record;
-- begin
--   select * into r from _r;
--   if r.run_id is null then raise exception 'No hay respaldo para el evento %', r.bueno; end if;
--   alter table public.draft_events disable trigger trg_seating_enforce_before_start;
--   update public.draft_events d
--   set draft_started_at = x.draft_started_at, draft_ended_at = x.draft_ended_at, is_timed_draft = x.is_timed_draft,
--       timer_packs = x.timer_packs, timer_alpha = x.timer_alpha, timer_beta = x.timer_beta, timer_gamma = x.timer_gamma,
--       timer_delta = x.timer_delta, timer_rho = x.timer_rho, timer_tmin = x.timer_tmin, timer_tmax = x.timer_tmax,
--       timer_color = x.timer_color, random_seating_enabled = x.random_seating_enabled
--   from admin_private.event_copy_backup bk, lateral jsonb_populate_record(null::public.draft_events, bk.fila) x
--   where bk.run_id = r.run_id and bk.tabla = 'draft_events' and d.id = r.bueno;
--   set constraints all immediate;
--   alter table public.draft_events enable trigger trg_seating_enforce_before_start;
--   delete from public.draft_timer_logs where event_id = r.bueno;
--   insert into public.draft_timer_logs
--   select (jsonb_populate_record(null::public.draft_timer_logs, bk.fila)).* from admin_private.event_copy_backup bk
--   where bk.run_id = r.run_id and bk.tabla = 'draft_timer_logs' order by bk.id;
--   delete from public.event_seating where event_id = r.bueno;
--   insert into public.event_seating
--   select (jsonb_populate_record(null::public.event_seating, bk.fila)).* from admin_private.event_copy_backup bk
--   where bk.run_id = r.run_id and bk.tabla = 'event_seating';
-- end;
-- $rollback$;
-- commit;
-- <<< ROLLBACK
-- (el respaldo queda en admin_private.event_copy_backup; borrarlo solo cuando ya no haga falta)
-- ============================================================================================================================
