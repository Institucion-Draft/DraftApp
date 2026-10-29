-- 0147_cube_roulette_weights_config.sql
--
-- Parámetros de las "probabilidades pesadas" de la ruleta de cubos (ver app/src/lib/cubeRouletteWeights.ts).
-- Una fila por workspace; si no hay fila (o un valor no pasa la validación del cliente) la app usa los defaults
-- m = 0.05, k = 6, tau_min = 0.75, modo = 'prod'. No hay UI: se editan desde el dashboard de Supabase / service role.
--
--   m                  peso mínimo de un cubo que salió en el evento anterior (0 <= m <= 1)
--   k                  tau = max(tau_min, N / k), con N = cubos de la ruleta; k más grande = memoria más corta
--   tau_min            piso de tau (> 0)
--   accumulation_mode  'prod' = producto de los pesos de todas sus salidas; 'last' = sólo la salida más reciente
--
-- Para cambiar m y k de un workspace (crea la fila si no existe; los demás parámetros quedan en su default):
--   insert into public.workspace_cube_roulette_config (workspace_id, m, k)
--   values ('<workspace_id>', 0.10, 8)
--   on conflict (workspace_id) do update set m = excluded.m, k = excluded.k, updated_at = now();
--
-- Lectura: miembros del workspace (is_workspace_member, como el resto). Escritura: sin policies de insert/update/delete
-- ni grants para authenticated, así que sólo el service role / dashboard puede escribir.
-- No toca draft_events ni cube_roulette_spins: el historial se arma en el cliente con el cubo registrado de cada evento.

create table if not exists public.workspace_cube_roulette_config (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  m numeric not null default 0.05,
  k numeric not null default 6,
  tau_min numeric not null default 0.75,
  accumulation_mode text not null default 'prod',
  updated_at timestamptz not null default now(),
  constraint cube_roulette_config_m_range check (m >= 0 and m <= 1),
  constraint cube_roulette_config_k_positive check (k > 0),
  constraint cube_roulette_config_tau_min_positive check (tau_min > 0),
  constraint cube_roulette_config_mode_valid check (accumulation_mode in ('prod', 'last'))
);

comment on table public.workspace_cube_roulette_config is
  'Parámetros de las probabilidades pesadas de la ruleta de cubos, por workspace (sin UI; se edita desde el dashboard). Sin fila = defaults del cliente.';

alter table public.workspace_cube_roulette_config enable row level security;

drop policy if exists "cube_roulette_config_select_members" on public.workspace_cube_roulette_config;
create policy "cube_roulette_config_select_members"
  on public.workspace_cube_roulette_config for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- En Supabase los default privileges dan ALL sobre tablas nuevas de public a anon, authenticated y service_role:
-- se revoca todo primero y se otorga sólo lo necesario (lectura a authenticated; service_role escribe desde el dashboard).
revoke all on public.workspace_cube_roulette_config from public, anon, authenticated;
grant select on public.workspace_cube_roulette_config to authenticated;
grant all on public.workspace_cube_roulette_config to service_role;

-- ===========================================================================
-- Verificación
-- ===========================================================================
do $verify$
declare
  v_ws uuid;
  v_user uuid;
  v_b text;
  v_rejected boolean;
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'workspace_cube_roulette_config') then
    raise exception '0147: falta workspace_cube_roulette_config';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.workspace_cube_roulette_config'::regclass) then
    raise exception '0147: workspace_cube_roulette_config sin RLS';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_cube_roulette_config'
                 and policyname = 'cube_roulette_config_select_members' and cmd = 'SELECT') then
    raise exception '0147: falta la policy de lectura';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_cube_roulette_config'
             and cmd <> 'SELECT') then
    raise exception '0147: no debe haber policies de escritura';
  end if;
  if not has_table_privilege('authenticated', 'public.workspace_cube_roulette_config', 'select') then
    raise exception '0147: authenticated no puede leer la tabla';
  end if;
  if has_table_privilege('authenticated', 'public.workspace_cube_roulette_config', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_cube_roulette_config', 'update')
     or has_table_privilege('authenticated', 'public.workspace_cube_roulette_config', 'delete') then
    raise exception '0147: authenticated no debe poder escribir la tabla';
  end if;
  if has_table_privilege('anon', 'public.workspace_cube_roulette_config', 'select')
     or has_table_privilege('anon', 'public.workspace_cube_roulette_config', 'insert')
     or has_table_privilege('anon', 'public.workspace_cube_roulette_config', 'update')
     or has_table_privilege('anon', 'public.workspace_cube_roulette_config', 'delete') then
    raise exception '0147: anon no debe tener privilegios sobre la tabla';
  end if;

  -- Defaults y constraints, con un workspace descartable que se deshace al final (excepción centinela).
  select id into v_user from auth.users limit 1;
  if v_user is not null then
    begin
      insert into public.workspaces (name, slug, created_by)
      values ('verify-0147', 'verify-' || substr(md5(random()::text), 1, 12), v_user)
      returning id into v_ws;
      insert into public.workspace_cube_roulette_config (workspace_id) values (v_ws);
      if not exists (select 1 from public.workspace_cube_roulette_config
                     where workspace_id = v_ws and m = 0.05 and k = 6 and tau_min = 0.75 and accumulation_mode = 'prod') then
        raise exception '0147: defaults incorrectos';
      end if;
      foreach v_b in array array['m = -0.01', 'm = 1.01', 'k = 0', 'tau_min = 0', 'accumulation_mode = ''x'''] loop
        v_rejected := false;
        begin
          execute format('update public.workspace_cube_roulette_config set %s where workspace_id = %L', v_b, v_ws);
        exception when check_violation then
          v_rejected := true;
        end;
        if not v_rejected then
          raise exception '0147: la constraint no rechazó %', v_b;
        end if;
      end loop;
      update public.workspace_cube_roulette_config set m = 0, k = 0.1, tau_min = 0.01, accumulation_mode = 'last' where workspace_id = v_ws;
      update public.workspace_cube_roulette_config set m = 1 where workspace_id = v_ws;
      raise exception 'verify-0147-rollback';
    exception when raise_exception then
      if sqlerrm <> 'verify-0147-rollback' then raise; end if;
    end;
  end if;

  raise notice '0147: config de probabilidades pesadas lista (filas=%)', (select count(*) from public.workspace_cube_roulette_config);
end;
$verify$;
