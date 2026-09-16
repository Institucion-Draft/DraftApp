-- 0106_draft_timer_logs_can_manage_event.sql
--
-- Bug encontrado en vivo hoy: "new row violates row-level security policy for table
-- draft_timer_logs" (42501) al usar el cronómetro de draft. Diagnóstico: la única policy de la
-- tabla ("Organizers can insert timer logs", 0066) chequea event_participants.role = 'organizer'
-- — un valor que participants_role_valid (0001) nunca permitió (solo 'player'/'ghost'/'exile').
-- El exists() de esa policy es literalmente siempre false: nació rota en 0066, nunca insertó una
-- fila con éxito para nadie, ni siquiera para el organizador real. No es una regresión de hoy.
--
-- El insert es fire-and-forget desde el cliente (DraftTimerScreen.tsx, logPick: solo
-- console.error en el catch), así que el error nunca bloqueó el cronómetro en sí — pero la tabla
-- quedó sin poder guardar telemetría de timing real de picks desde que existe.
--
-- Fix: mismo patrón mecánico que las ~29 policies ya migradas hoy a can_manage_event (Fases 3-5,
-- 0103/0104/0105) — reemplaza el chequeo roto de event_participants.role por
-- can_manage_event(de.workspace_id, de.id) (organizador real del workspace O posta puntual del
-- evento). Se renombra la policy al estilo snake_case ya usado en el resto de policies de la
-- Fase 3-5 (las demás tablas no tenían un nombre "Title Case con espacios" como esta).
--
-- Se agrega también una policy de SELECT, inexistente hasta ahora (con RLS habilitada y sin
-- policy de lectura, nadie podía leer estas filas ni siquiera si el insert hubiera funcionado).
-- Criterio elegido: cualquier participante del evento O can_manage_event — mismo criterio que
-- diary_read (0105) para datos no sensibles de un evento. Es solo telemetría de timing de picks
-- (segundos estimados vs. reales por pick), sin dato sensible, así que no hace falta acotarla a
-- organizador: deja la tabla lista para un eventual análisis futuro de timing real de picks
-- consumido por cualquier participante, no solo por quien organiza.

-- ===========================================================================
-- 1. timer_logs_insert_organizer (reemplaza "Organizers can insert timer logs", 0066 — rota)
-- ===========================================================================
drop policy if exists "Organizers can insert timer logs" on public.draft_timer_logs;

create policy "timer_logs_insert_organizer"
  on public.draft_timer_logs for insert
  to authenticated
  with check (
    exists (
      select 1 from public.draft_events de
      where de.id = draft_timer_logs.event_id
        and public.can_manage_event(de.workspace_id, de.id)
    )
  );

-- ===========================================================================
-- 2. timer_logs_select_participant_or_organizer (nueva — no existía ninguna policy de SELECT)
-- ===========================================================================
drop policy if exists "timer_logs_select_participant_or_organizer" on public.draft_timer_logs;

create policy "timer_logs_select_participant_or_organizer"
  on public.draft_timer_logs for select
  to authenticated
  using (
    exists (
      select 1 from public.event_participants ep
      where ep.event_id = draft_timer_logs.event_id
        and (ep.user_id = auth.uid() or ep.member_b_user_id = auth.uid())
    )
    or exists (
      select 1 from public.draft_events de
      where de.id = draft_timer_logs.event_id
        and public.can_manage_event(de.workspace_id, de.id)
    )
  );
