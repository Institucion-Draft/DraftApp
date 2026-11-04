-- 0148_cube_roulette_age_bonus_config.sql
--
-- Parámetros del bonus por antigüedad de la ruleta de cubos (ver app/src/lib/cubeRouletteWeights.ts):
--   bonus = 1 + beta * min(d, d_cap), con d = eventos contados desde la última salida del cubo (o desde su creación).
--   beta   >= 0   (default 0.02)
--   d_cap  >  0   (default 25)
-- Misma tabla y mismo manejo que m y k (0147): sin UI, se editan desde el dashboard de Supabase / service role.

alter table public.workspace_cube_roulette_config
  add column if not exists beta numeric not null default 0.02,
  add column if not exists d_cap numeric not null default 25;

alter table public.workspace_cube_roulette_config
  drop constraint if exists cube_roulette_config_beta_nonneg,
  drop constraint if exists cube_roulette_config_d_cap_positive;
alter table public.workspace_cube_roulette_config
  add constraint cube_roulette_config_beta_nonneg check (beta >= 0),
  add constraint cube_roulette_config_d_cap_positive check (d_cap > 0);

do $verify$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'workspace_cube_roulette_config' and column_name = 'beta') then
    raise exception '0148: falta la columna beta';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'workspace_cube_roulette_config' and column_name = 'd_cap') then
    raise exception '0148: falta la columna d_cap';
  end if;
  raise notice '0148: bonus por antigüedad listo';
end;
$verify$;
