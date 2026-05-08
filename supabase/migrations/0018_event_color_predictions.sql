-- 0018_event_color_predictions.sql
-- Tabla para guardar las predicciones del color más pickeado por cada user en cada evento (ProDeC).
-- Un voto por user por evento.
-- C (incoloro) no es opción válida de voto.

create table if not exists public.event_color_predictions (
  event_id uuid not null references public.draft_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  predicted_color text not null check (predicted_color in ('W', 'U', 'B', 'R', 'G')),
  voted_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists idx_event_color_predictions_event on public.event_color_predictions (event_id);

alter table public.event_color_predictions enable row level security;

create policy "select_color_predictions_for_workspace_members"
  on public.event_color_predictions
  for select
  using (
    exists (
      select 1
      from public.draft_events de
      where de.id = event_color_predictions.event_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "insert_own_color_prediction"
  on public.event_color_predictions
  for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.draft_events de
      where de.id = event_color_predictions.event_id
        and public.is_workspace_member(de.workspace_id)
    )
  );

create policy "update_own_color_prediction"
  on public.event_color_predictions
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
