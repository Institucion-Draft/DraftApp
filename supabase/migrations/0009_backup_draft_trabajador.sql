-- Backup congelado del Draft del Trabajador (3 de mayo de 2026)
-- Schema separado para mantener una snapshot estática de los datos oficiales.
-- No se actualiza con cambios posteriores en las tablas originales.

create schema if not exists backup_draft_trabajador_20260503;

-- Backup del evento
create table if not exists backup_draft_trabajador_20260503.draft_events as
select * from public.draft_events
where id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de participantes
create table if not exists backup_draft_trabajador_20260503.event_participants as
select * from public.event_participants
where event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de colores declarados
create table if not exists backup_draft_trabajador_20260503.participant_colors as
select pc.* 
from public.participant_colors pc
join public.event_participants ep on ep.id = pc.participant_id
where ep.event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de pairings
create table if not exists backup_draft_trabajador_20260503.pairings as
select * from public.pairings
where event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de matches
create table if not exists backup_draft_trabajador_20260503.matches as
select m.* 
from public.matches m
join public.pairings p on p.id = m.pairing_id
where p.event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de life_events
create table if not exists backup_draft_trabajador_20260503.life_events as
select le.* 
from public.life_events le
join public.matches m on m.id = le.match_id
join public.pairings p on p.id = m.pairing_id
where p.event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Backup de users que participaron
create table if not exists backup_draft_trabajador_20260503.users as
select distinct u.* 
from public.users u
join public.event_participants ep on ep.user_id = u.id
where ep.event_id = '7f101255-cc00-4f83-9984-e1e06caa0654';

-- Comentario en el schema para documentar
comment on schema backup_draft_trabajador_20260503 is 
  'Snapshot estática del Draft del Trabajador (3 mayo 2026). No modificar.';
