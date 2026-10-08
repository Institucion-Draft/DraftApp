-- 0136_zones_draw_engine.sql
-- Grupos + Copa (competition_format = 'zones_knockout'): motor de sorteo de zonas. SIN UI ni juego de partidos.
--
-- Un evento zones_knockout se crea SIN zones_count ni zone_qualifiers (null hasta el sorteo). Cuando el draft
-- termina (status 'playing'), el RPC draw_zones(...) ocupa el lugar que en todos contra todos / Suizo tiene la
-- generación de pairings: reparte a los inscriptos activos en zonas A..D, crea los pairings 'zone' (todos contra
-- todos dentro de cada zona) y los 'interzonal' (un rival de otra zona para quien corresponda) y guarda la
-- configuración RESUELTA en el evento. El planificador que arma las opciones para la UI vive en
-- app/src/lib/zonesPlanner.ts y aplica las mismas reglas que se revalidan acá.
--
-- Alcance:
--   1. draft_events: zone_wildcards (mejores del puesto siguiente que pasan, entre todas las zonas) y
--      zones_drawn_at (marca del sorteo). draft_events_zones_config_valid se relaja: zones_count y zone_qualifiers
--      pueden ser null hasta el sorteo y se exigen válidos (zonas 2 a 4, clasificados >= 1, comodines 0 a
--      zonas-1) una vez sorteado. interzonal pasa a ser el valor RESUELTO en el sorteo.
--   2. event_zones (id, event_id, zone_index 1..4, name 'A'..'D') + event_participants.zone_id + pairings.zone_id
--      (sólo para stage 'zone'; el interzonal no tiene zona). Es el diseño mínimo: una tabla de zonas y una FK
--      en la inscripción y en el pairing de zona.
--   3. zones_interzonal_mode(n, k): 'optional' | 'mandatory' | 'impossible' (interna, pura).
--   4. draw_zones(p_event_id, p_zones_count, p_qualifiers, p_wildcards, p_interzonal) -> jsonb.
--
-- Reglas de interzonal (cada jugador que lo juega, juega exactamente UNO contra alguien de OTRA zona; nunca un
-- rival que ya enfrentó en su zona):
--   * Zonas iguales (N divisible por zonas): opcional, posible sólo si N es par; lo juegan todos.
--   * Zonas desiguales (r = N mod k zonas de s+1, k-r de s): obligatorio si es posible y lo juegan SÓLO los de las
--     zonas chicas (tamaño s), cada uno contra otro de otra zona chica. Posible con al menos 2 zonas chicas y
--     una cantidad par de jugadores en ellas. Si no es posible: sin interzonal y partidos desiguales (no es error).
--   * Si se pide interzonal = true y es imposible, se rechaza. Si se pide false y es obligatorio, se fuerza a true.
--   * Emparejamiento aleatorio y perfecto: se saca un jugador de la zona con más jugadores sin emparejar y se
--     elige al azar un rival de otra zona entre los que dejan el resto emparejable (max zona <= mitad del resto).
--
-- Funciones: ninguna función viva se reemplaza (todas son nuevas); no se toca evaluate_tiebreak_group_after_match
-- ni el motor knockout. Reemplaza únicamente la constraint draft_events_zones_config_valid (0129).

-- ===========================================================================
-- 1. draft_events: comodines y marca de sorteo; constraint de configuración relajada hasta el sorteo
-- ===========================================================================
alter table public.draft_events
  add column if not exists zone_wildcards smallint not null default 0,
  add column if not exists zones_drawn_at timestamptz;

alter table public.draft_events
  drop constraint if exists draft_events_zones_config_valid;

-- Los "is not null" son explícitos: un CHECK con resultado NULL pasa.
alter table public.draft_events
  add constraint draft_events_zones_config_valid
    check (
      (
        competition_format = 'zones_knockout'
        and zone_wildcards >= 0
        and (
          (
            zones_drawn_at is null
            and (zones_count is null or zones_count between 2 and 4)
            and (zone_qualifiers is null or zone_qualifiers >= 1)
          )
          or (
            zones_drawn_at is not null
            and zones_count is not null and zones_count between 2 and 4
            and zone_qualifiers is not null and zone_qualifiers >= 1
            and zone_wildcards <= zones_count - 1
          )
        )
      )
      or (
        competition_format <> 'zones_knockout'
        and zones_count is null
        and zone_qualifiers is null
        and zone_wildcards = 0
        and zones_drawn_at is null
      )
    );

-- ===========================================================================
-- 2. Zonas
-- ===========================================================================
create table if not exists public.event_zones (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.draft_events(id) on delete cascade,
  zone_index smallint not null check (zone_index between 1 and 4),
  name text not null,
  created_at timestamptz not null default now(),
  unique (event_id, zone_index)
);

create index if not exists event_zones_event_idx on public.event_zones (event_id);

alter table public.event_participants
  add column if not exists zone_id uuid references public.event_zones(id) on delete set null;

alter table public.pairings
  add column if not exists zone_id uuid references public.event_zones(id) on delete set null;

alter table public.pairings
  drop constraint if exists pairings_zone_id_valid;

alter table public.pairings
  add constraint pairings_zone_id_valid
    check (zone_id is null or stage = 'zone');

create index if not exists event_participants_zone_idx on public.event_participants (zone_id);
create index if not exists pairings_zone_idx on public.pairings (zone_id);

alter table public.event_zones enable row level security;

drop policy if exists "event_zones_select_workspace_member" on public.event_zones;
create policy "event_zones_select_workspace_member"
  on public.event_zones for select
  to authenticated
  using (
    exists (
      select 1 from public.draft_events de
      where de.id = event_id and public.is_workspace_member(de.workspace_id)
    )
  );

-- ===========================================================================
-- 3. zones_interzonal_mode
-- ===========================================================================
create or replace function public.zones_interzonal_mode(p_n integer, p_k integer)
returns text
language sql
immutable
as $$
  select case
    when p_n % p_k = 0 then
      case when p_n % 2 = 0 then 'optional' else 'impossible' end
    else
      case
        when (p_k - p_n % p_k) >= 2 and ((p_k - p_n % p_k) * (p_n / p_k)) % 2 = 0 then 'mandatory'
        else 'impossible'
      end
  end
$$;

-- ===========================================================================
-- 4. draw_zones
-- ===========================================================================
create or replace function public.draw_zones(
  p_event_id uuid,
  p_zones_count integer,
  p_qualifiers integer,
  p_wildcards integer,
  p_interzonal boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event record;
  v_players uuid[];
  v_n integer;
  v_k integer;
  v_s integer;
  v_r integer;
  v_cands integer;
  v_t integer;
  v_mode text;
  v_iz boolean;
  v_order integer[];
  v_zone_ids uuid[] := '{}';
  v_zid uuid;
  v_i integer;
  v_left integer;
  v_x uuid;
  v_xz uuid;
  v_y uuid;
  v_sizes integer[];
begin
  select de.id, de.workspace_id, de.competition_format, de.status, de.zones_drawn_at,
         de.zones_count, de.zone_qualifiers, de.zone_wildcards, de.interzonal
  into v_event
  from public.draft_events de
  where de.id = p_event_id and de.deleted_at is null
  for update;

  if v_event.id is null then
    raise exception 'draw_zones: el evento no existe.';
  end if;

  if not public.can_manage_event(v_event.workspace_id, v_event.id) then
    raise exception 'draw_zones: no tenés permisos para sortear las zonas de este evento.'
      using errcode = '42501';
  end if;

  if v_event.competition_format <> 'zones_knockout' then
    raise exception 'draw_zones: el evento no es una Copa de grupos + llaves.';
  end if;

  perform pg_advisory_xact_lock(hashtext('zones:' || p_event_id::text));

  -- Idempotente: si ya se sorteó, se devuelve lo guardado sin volver a sortear ni tocar nada.
  if v_event.zones_drawn_at is not null then
    return jsonb_build_object(
      'already_drawn', true,
      'zones_count', v_event.zones_count,
      'zone_qualifiers', v_event.zone_qualifiers,
      'zone_wildcards', v_event.zone_wildcards,
      'interzonal', v_event.interzonal
    );
  end if;

  if v_event.status <> 'playing' then
    raise exception 'draw_zones: el sorteo de zonas se hace al finalizar el draft (el evento está en %).', v_event.status;
  end if;

  select array_agg(ep.id order by random()) into v_players
  from public.event_participants ep
  where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null;

  v_n := coalesce(array_length(v_players, 1), 0);
  v_k := p_zones_count;

  -- Revalidación de TODAS las reglas (las mismas del planificador de la app).
  if v_k is null or v_k < 2 or v_k > 4 then
    raise exception 'Copa (grupos + llaves): la cantidad de zonas tiene que ser de 2 a 4.'
      using errcode = '23514';
  end if;
  if v_n < v_k then
    raise exception 'Copa (grupos + llaves): hay más zonas (%) que jugadores inscriptos (%).', v_k, v_n
      using errcode = '23514';
  end if;

  v_s := v_n / v_k;
  v_r := v_n % v_k;

  if p_qualifiers is null or p_qualifiers < 1 then
    raise exception 'Copa (grupos + llaves): tiene que clasificar al menos 1 jugador por zona.'
      using errcode = '23514';
  end if;
  if p_qualifiers > v_s then
    raise exception 'Copa (grupos + llaves): los clasificados por zona (%) no pueden superar el tamaño de la zona más chica (%).', p_qualifiers, v_s
      using errcode = '23514';
  end if;

  if p_wildcards is null or p_wildcards < 0 or p_wildcards > v_k - 1 then
    raise exception 'Copa (grupos + llaves): los mejores del puesto siguiente van de 0 a %.', v_k - 1
      using errcode = '23514';
  end if;
  -- Sólo compiten por un lugar de comodín las zonas con al menos q+1 jugadores.
  v_cands := v_r + case when v_s >= p_qualifiers + 1 then v_k - v_r else 0 end;
  if p_wildcards > v_cands then
    raise exception 'Copa (grupos + llaves): sólo % zonas tienen jugadores en el puesto siguiente; no se pueden pasar % comodines.', v_cands, p_wildcards
      using errcode = '23514';
  end if;

  v_t := v_k * p_qualifiers + p_wildcards;
  if v_t < 4 or v_t > 16 then
    raise exception 'Copa (grupos + llaves): la Copa tiene que tener entre 4 y 16 jugadores (quedan %).', v_t
      using errcode = '23514';
  end if;

  -- Interzonal: obligatorio si es posible en zonas desiguales; imposible si lo piden y no se puede.
  v_mode := public.zones_interzonal_mode(v_n, v_k);
  if v_mode = 'mandatory' then
    v_iz := true;
  elsif v_mode = 'optional' then
    v_iz := coalesce(p_interzonal, false);
  else
    if coalesce(p_interzonal, false) then
      raise exception 'Copa (grupos + llaves): el interzonal es imposible con % jugadores en % zonas.', v_n, v_k
        using errcode = '23514';
    end if;
    v_iz := false;
  end if;

  -- Zonas A..D y reparto al azar: el orden de las zonas también se sortea, así que las zonas grandes (si las
  -- hay) no son siempre las primeras. Diferencia máxima de 1 jugador entre zonas.
  v_order := array(select gs from generate_series(1, v_k) as gs order by random());

  for v_i in 1..v_k loop
    insert into public.event_zones (event_id, zone_index, name)
    values (p_event_id, v_i, chr(64 + v_i))
    returning id into v_zid;
    v_zone_ids := v_zone_ids || v_zid;
  end loop;

  for v_i in 1..v_n loop
    update public.event_participants
    set zone_id = v_zone_ids[v_order[((v_i - 1) % v_k) + 1]]
    where id = v_players[v_i];
  end loop;

  -- Pairings 'zone': todos contra todos dentro de cada zona.
  insert into public.pairings (event_id, participant_a_id, participant_b_id, stage, zone_id)
  select p_event_id, a.id, b.id, 'zone', a.zone_id
  from public.event_participants a
  join public.event_participants b on b.zone_id = a.zone_id and a.id < b.id
  where a.event_id = p_event_id and a.role = 'player' and a.left_event_at is null and a.zone_id is not null
    and b.event_id = p_event_id and b.role = 'player' and b.left_event_at is null;

  -- Pairings 'interzonal': un rival de otra zona para cada elegible.
  if v_iz then
    drop table if exists _zones_iz;
    create temporary table _zones_iz (pid uuid primary key, zid uuid not null, taken boolean not null default false) on commit drop;

    insert into _zones_iz (pid, zid)
    select ep.id, ep.zone_id
    from public.event_participants ep
    where ep.event_id = p_event_id and ep.role = 'player' and ep.left_event_at is null
      and ep.zone_id is not null
      and (
        v_r = 0
        or ep.zone_id in (
          -- zonas chicas: las de tamaño s
          select z.zone_id from (
            select zone_id, count(*) as cnt
            from public.event_participants
            where event_id = p_event_id and role = 'player' and left_event_at is null and zone_id is not null
            group by zone_id
          ) z
          where z.cnt = v_s
        )
      );

    loop
      select count(*) into v_left from _zones_iz where not taken;
      exit when v_left = 0;

      -- x: un jugador al azar de la zona con más jugadores sin emparejar.
      select i.pid, i.zid into v_x, v_xz
      from _zones_iz i
      where not i.taken
        and i.zid in (
          select c.zid from (select zid, count(*) as cnt from _zones_iz where not taken group by zid) c
          where c.cnt = (select max(m.cnt) from (select count(*) as cnt from _zones_iz where not taken group by zid) m)
        )
      order by random()
      limit 1;

      -- y: al azar entre los de otra zona que dejan al resto emparejable (zona más grande <= mitad del resto).
      select y.pid into v_y
      from _zones_iz y
      where not y.taken and y.zid <> v_xz
        and (
          select max(c.cnt - (case when c.zid = v_xz then 1 else 0 end) - (case when c.zid = y.zid then 1 else 0 end))
          from (select zid, count(*)::integer as cnt from _zones_iz where not taken group by zid) c
        ) * 2 <= v_left - 2
      order by random()
      limit 1;

      if v_y is null then
        raise exception 'draw_zones: no se pudo armar el interzonal (estado inesperado).';
      end if;

      insert into public.pairings (event_id, participant_a_id, participant_b_id, stage)
      values (p_event_id, least(v_x, v_y), greatest(v_x, v_y), 'interzonal');

      update _zones_iz set taken = true where pid in (v_x, v_y);
    end loop;
  end if;

  update public.draft_events
  set zones_count = v_k,
      zone_qualifiers = p_qualifiers,
      zone_wildcards = p_wildcards,
      interzonal = v_iz,
      zones_drawn_at = now()
  where id = p_event_id;

  select array_agg(c.cnt order by c.zone_index) into v_sizes
  from (
    select z.zone_index, count(ep.id)::integer as cnt
    from public.event_zones z
    left join public.event_participants ep on ep.zone_id = z.id
    where z.event_id = p_event_id
    group by z.zone_index
  ) c;

  return jsonb_build_object(
    'already_drawn', false,
    'zones_count', v_k,
    'zone_qualifiers', p_qualifiers,
    'zone_wildcards', p_wildcards,
    'interzonal', v_iz,
    'interzonal_mode', v_mode,
    'zone_sizes', to_jsonb(v_sizes),
    'copa_size', v_t,
    'consuelo_size', v_n - v_t
  );
end;
$$;

-- Permisos: la interna no se expone; draw_zones sólo para usuarios autenticados (valida can_manage_event).
revoke execute on function public.zones_interzonal_mode(integer, integer) from public, anon, authenticated;

revoke execute on function public.draw_zones(uuid, integer, integer, integer, boolean) from public, anon;
grant execute on function public.draw_zones(uuid, integer, integer, integer, boolean) to authenticated;
