-- ============================================================================================================================
-- 03 — VERIFICAR (SOLO LECTURA): lado a lado FALLIDO vs BUENO, en UNA sola tabla (el SQL Editor muestra solo el último resultado).
-- Poner los mismos dos ids de 02. Columna "ok": true = coincide / se conservó lo propio del bueno. Todo debería dar ok = true.
-- Correr como postgres.
-- ============================================================================================================================
with p as (
  select 'PEGAR-ID-DEL-EVENTO-FALLIDO'::uuid as f, 'PEGAR-ID-DEL-EVENTO-BUENO'::uuid as b
),
fe as (select d.* from public.draft_events d, p where d.id = p.f),
be as (select d.* from public.draft_events d, p where d.id = p.b),
fp as (select ep.id as pid, ep.user_id from public.event_participants ep, p where ep.event_id = p.f and ep.role = 'player'),
bp as (select ep.id as pid, ep.user_id from public.event_participants ep, p where ep.event_id = p.b and ep.role = 'player'),
bk as (  -- respaldo del BUENO anterior a la primera copia
  select k.fila from admin_private.event_copy_backup k, p
  where k.bueno = p.b and k.tabla = 'draft_events'
    and k.run_id = (select run_id from admin_private.event_copy_backup where bueno = p.b order by backed_up_at asc, id asc limit 1)
),
fl as (select l.* from public.draft_timer_logs l, p where l.event_id = p.f),
bl as (select l.* from public.draft_timer_logs l, p where l.event_id = p.b),
fs as (select s.* from public.event_seating s, p where s.event_id = p.f),
bs as (select s.* from public.event_seating s, p where s.event_id = p.b)
select * from (
  -- 1) TIEMPO DE DRAFT
  select 1 as ord, 'tiempo de draft' as seccion, 'draft_started_at' as campo, fe.draft_started_at::text as fallido_o_antes, be.draft_started_at::text as bueno_o_ahora,
         fe.draft_started_at is not distinct from be.draft_started_at as ok from fe, be
  union all
  select 1, 'tiempo de draft', 'draft_ended_at', fe.draft_ended_at::text, be.draft_ended_at::text,
         fe.draft_ended_at is not distinct from be.draft_ended_at from fe, be
  union all
  select 1, 'tiempo de draft', 'duración (min)',
         round(extract(epoch from (fe.draft_ended_at - fe.draft_started_at)) / 60)::text,
         round(extract(epoch from (be.draft_ended_at - be.draft_started_at)) / 60)::text,
         (fe.draft_ended_at - fe.draft_started_at) is not distinct from (be.draft_ended_at - be.draft_started_at) from fe, be
  union all
  -- 2) CRONÓMETRO: columnas de draft_events + logs
  select 2, 'cronómetro', a.key, a.value, c.value, a.value is not distinct from c.value
  from fe, be, jsonb_each_text(to_jsonb(fe)) a join jsonb_each_text(to_jsonb(be)) c on c.key = a.key
  where a.key in ('is_timed_draft', 'timer_packs', 'timer_alpha', 'timer_beta', 'timer_gamma', 'timer_delta', 'timer_rho', 'timer_tmin', 'timer_tmax', 'timer_color')
  union all
  select 2, 'cronómetro', 'draft_timer_logs: filas', (select count(*) from fl)::text, (select count(*) from bl)::text, (select count(*) from fl) = (select count(*) from bl)
  union all
  select 2, 'cronómetro', 'draft_timer_logs: suma de actual_seconds', (select coalesce(sum(actual_seconds), 0) from fl)::text, (select coalesce(sum(actual_seconds), 0) from bl)::text,
         (select coalesce(sum(actual_seconds), 0) from fl) = (select coalesce(sum(actual_seconds), 0) from bl)
  union all
  select 2, 'cronómetro', 'draft_timer_logs: huella de los picks (md5)',
         (select md5(coalesce(string_agg(format('%s:%s:%s:%s:%s', global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds), '|' order by global_pick), '')) from fl),
         (select md5(coalesce(string_agg(format('%s:%s:%s:%s:%s', global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds), '|' order by global_pick), '')) from bl),
         (select md5(coalesce(string_agg(format('%s:%s:%s:%s:%s', global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds), '|' order by global_pick), '')) from fl)
           = (select md5(coalesce(string_agg(format('%s:%s:%s:%s:%s', global_pick, pack_index, pick_in_pack, estimated_seconds, actual_seconds), '|' order by global_pick), '')) from bl)
  union all
  -- 3) SORTEO DE LUGARES
  select 3, 'sorteo de lugares', 'random_seating_enabled', fe.random_seating_enabled::text, be.random_seating_enabled::text,
         fe.random_seating_enabled is not distinct from be.random_seating_enabled from fe, be
  union all
  select 3, 'sorteo de lugares', 'n / sentido / vigente',
         (select n || ' / ' || direction || ' / ' || is_current from fs), (select n || ' / ' || direction || ' / ' || is_current from bs),
         (select (n, direction) from fs) is not distinct from (select (n, direction) from bs) and (select is_current from bs) is true
  union all
  select 4 + (x.elem ->> 'seat')::integer / 1000.0, 'sorteo de lugares', 'asiento ' || lpad(x.elem ->> 'seat', 2, '0'),
         coalesce(u.display_name, u.username, x.elem ->> 'user_id') || ' (insc. ' || left(x.elem ->> 'participant_id', 8) || ')',
         coalesce(u2.display_name, u2.username, y.elem ->> 'user_id') || ' (insc. ' || left(y.elem ->> 'participant_id', 8) || ')',
         (x.elem ->> 'user_id') = (y.elem ->> 'user_id')
           and exists (select 1 from bp where bp.pid = (y.elem ->> 'participant_id')::uuid and bp.user_id = (y.elem ->> 'user_id')::uuid)
  from fs cross join lateral jsonb_array_elements(fs.seats) as x(elem)
  left join lateral (select e.elem from bs cross join lateral jsonb_array_elements(bs.seats) as e(elem) where e.elem ->> 'seat' = x.elem ->> 'seat') y on true
  left join public.users u on u.id = (x.elem ->> 'user_id')::uuid
  left join public.users u2 on u2.id = (y.elem ->> 'user_id')::uuid
  union all
  -- 5) LO PROPIO DEL BUENO NO SE TOCÓ (compara contra el respaldo)
  select 9, 'propio del bueno (sin tocar)', a.key, c.value, a.value, a.value is not distinct from c.value
  from be, bk, jsonb_each_text(to_jsonb(be)) a join jsonb_each_text(bk.fila) c on c.key = a.key
  where a.key in ('name', 'event_type', 'competition_format', 'match_format', 'top_size', 'topcut_format', 'status', 'scheduled_for', 'event_ended_at',
                  'champion_user_id', 'cube_id', 'venue_id', 'is_official', 'workspace_id', 'deleted_at', 'cancelled_at')
  union all
  select 9, 'propio del bueno (sin tocar)', 'jugadores activos / partidas',
         (select count(*) from bp)::text || ' / ' || (select count(*) from public.matches m join public.pairings pr on pr.id = m.pairing_id, p where pr.event_id = p.b)::text,
         '(no lo toca el script)', true
) t
order by ord, campo;
