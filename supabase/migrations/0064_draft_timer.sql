alter table public.draft_events add column if not exists is_timed_draft boolean not null default false;
alter table public.draft_events add column if not exists timer_packs integer[];
alter table public.draft_events add column if not exists timer_alpha numeric;
alter table public.draft_events add column if not exists timer_beta numeric;
alter table public.draft_events add column if not exists timer_gamma numeric;
alter table public.draft_events add column if not exists timer_delta numeric;
alter table public.draft_events add column if not exists timer_rho numeric;
alter table public.draft_events add column if not exists timer_tmin integer;
alter table public.draft_events add column if not exists timer_tmax integer;
