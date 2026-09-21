-- 0119_prodec_columns.sql
--
-- Fase E del feature de Temporadas: ProDeC (Pronóstico De Colores) en las tablas de ranking.
-- v_workspace_points (Ranking Global) y v_season_points (Ranking de Temporada) ganan 4 columnas
-- AL FINAL: prodec_points, prodec_first, prodec_second, prodec_third. Las columnas existentes
-- (incluido "points", que sigue siendo SOLO puntos del torneo) no cambian de nombre, orden ni tipo.
--
-- ---------------------------------------------------------------------------------------------
-- Regla de ProDeC (traducción a SQL de prodecDisplay.ts + ProDeCScreen.tsx)
-- ---------------------------------------------------------------------------------------------
-- * Por evento se cuentan las filas de participant_colors de los participantes role='player',
--   sin la 'C' (incoloro no compite). Los colores se agrupan por frecuencia descendente en
--   "tiers" (dense_rank): empate de frecuencia = mismo tier. Tier 1/2/3 = 1°/2°/3° color más
--   elegido. Igual que buildFrequencyTiers, los 5 colores WUBRG entran al ranking AUNQUE nadie
--   los haya elegido (frecuencia 0): un color que nadie eligió puede ser un tier de la
--   pantalla. Se replica tal cual para que los puntos coincidan con lo que muestra ProDeCScreen.
-- * Un voto (event_color_predictions) acierta el tier de su predicted_color. Solo cuenta el
--   tier 1..3 y solo votos de participantes role='player' (como groupVotersByTier con
--   userToParticipant).
-- * Un evento cuenta cuando votaron todos sus jugadores (votos de jugadores >= jugadores), o sea
--   cuando aparece el cartel de ProDeC en EventDetailScreen; no espera a que el evento termine.
--   Excluye sandbox (is_official = false), eliminados, cancelados y 2HG, igual que el resto de
--   las estadísticas.
-- * Puntos: mismos escalones que el torneo — workspace_ranking_points(player_count, posición
--   ProDeC[, config]) con la cantidad de jugadores del evento. En el Global usa la config eterna;
--   en la Temporada, la config de esa temporada (los eventos se asignan a la temporada por
--   draft_started_at, en cualquier estado). Las medallas cuentan aunque el evento tenga menos de
--   4 jugadores (ahí los puntos son 0, igual que en el torneo).
-- * ProDeC NO suma a "points" ni cambia el orden/podio del ranking: son columnas aparte.
-- * En temporadas cerradas ProDeC NO se congela: se calcula siempre sobre los votos y colores
--   vigentes (a diferencia de los podios del cierre forzado).
--
-- ---------------------------------------------------------------------------------------------
-- Cómo se agregan las columnas (por qué no se copia el SQL de las vistas)
-- ---------------------------------------------------------------------------------------------
-- 0116 dejó claro que copiar el cuerpo de una migración anterior arriesga 42P16 si la base tiene
-- drift. Por eso v_workspace_points y v_season_points se reescriben a partir de su definición
-- VIGENTE (pg_get_viewdef) envuelta como subconsulta, con un full join contra los aciertos de
-- ProDeC. Las 3 columnas previas se conservan idénticas (coalesce solo para incluir a quien tiene
-- aciertos de ProDeC pero ningún punto de torneo: ahí points = 0).
-- La verificación del final aborta toda la migración si alguna fila previa cambió de puntos, si
-- aparecen filas nuevas con puntos de torneo, o si las medallas no suman los aciertos de la base.

-- ===========================================================================
-- 0. Snapshot "antes" de las dos vistas
-- ===========================================================================
create temporary table _wp_before_0119 on commit drop as
select user_id, workspace_id, points from public.v_workspace_points;

create temporary table _sp_before_0119 on commit drop as
select season_id, workspace_id, user_id, points from public.v_season_points;

-- ===========================================================================
-- 1. Base: aciertos de ProDeC por evento y votante
-- ===========================================================================
create or replace view public.v_event_prodec_positions as
with eligible as (
  select de.id as event_id, de.workspace_id
  from public.draft_events de
  where de.deleted_at is null
    and de.is_official = true
    and de.event_type <> 'two_headed_giant'
    and de.status <> 'cancelled'
),
players as (
  select ep.event_id, ep.id as participant_id, ep.user_id
  from public.event_participants ep
  join eligible e on e.event_id = ep.event_id
  where ep.role = 'player'
),
player_counts as (
  select event_id, count(*)::integer as player_count
  from players
  group by event_id
),
vote_counts as (
  select p.event_id, count(*)::integer as votes
  from public.event_color_predictions p
  join players pl on pl.event_id = p.event_id and pl.user_id = p.user_id
  group by p.event_id
),
gated as (
  -- Votaron todos los jugadores (mismo umbral que el cartel de ProDeC en EventDetailScreen).
  select pc.event_id, pc.player_count
  from player_counts pc
  join vote_counts vc on vc.event_id = pc.event_id
  where pc.player_count > 0
    and vc.votes >= pc.player_count
),
color_freq as (
  -- Los 5 colores WUBRG siempre, con su frecuencia (0 si nadie lo declaró), como buildFrequencyTiers.
  select g.event_id, c.color, count(pcol.id)::integer as freq
  from gated g
  cross join (values ('W'), ('U'), ('B'), ('R'), ('G')) as c(color)
  left join players pl on pl.event_id = g.event_id
  left join public.participant_colors pcol
    on pcol.participant_id = pl.participant_id
   and pcol.color = c.color
  group by g.event_id, c.color
),
tiers as (
  select event_id, color, dense_rank() over (partition by event_id order by freq desc)::integer as tier
  from color_freq
)
select
  e.workspace_id,
  p.event_id,
  p.user_id,
  t.tier as position,
  g.player_count
from public.event_color_predictions p
join gated g on g.event_id = p.event_id
join eligible e on e.event_id = p.event_id
join players pl on pl.event_id = p.event_id and pl.user_id = p.user_id
join tiers t on t.event_id = p.event_id and t.color = p.predicted_color
where t.tier <= 3;

grant select on public.v_event_prodec_positions to authenticated;

-- ===========================================================================
-- 2. v_workspace_points y v_season_points: + prodec_points/first/second/third al final
-- ===========================================================================
do $$
declare
  v_def text;
begin
  -- Ranking Global: config eterna (wrapper de 2 argumentos).
  v_def := regexp_replace(pg_get_viewdef('public.v_workspace_points'::regclass, true), ';\s*$', '');
  execute format($f$
    create or replace view public.v_workspace_points as
    select
      coalesce(b.user_id, pd.user_id) as user_id,
      coalesce(b.workspace_id, pd.workspace_id) as workspace_id,
      coalesce(b.points, 0)::integer as points,
      coalesce(pd.prodec_points, 0)::integer as prodec_points,
      coalesce(pd.prodec_first, 0)::integer as prodec_first,
      coalesce(pd.prodec_second, 0)::integer as prodec_second,
      coalesce(pd.prodec_third, 0)::integer as prodec_third
    from (%s) b
    full join (
      select
        pp.workspace_id,
        pp.user_id,
        sum(public.workspace_ranking_points(pp.player_count, pp.position))::integer as prodec_points,
        count(*) filter (where pp.position = 1)::integer as prodec_first,
        count(*) filter (where pp.position = 2)::integer as prodec_second,
        count(*) filter (where pp.position = 3)::integer as prodec_third
      from public.v_event_prodec_positions pp
      group by pp.workspace_id, pp.user_id
    ) pd
      on pd.user_id = b.user_id
     and pd.workspace_id = b.workspace_id
  $f$, v_def);

  -- Ranking de Temporada: config de cada temporada (versión de 3 argumentos).
  v_def := regexp_replace(pg_get_viewdef('public.v_season_points'::regclass, true), ';\s*$', '');
  execute format($f$
    create or replace view public.v_season_points as
    select
      coalesce(b.season_id, pd.season_id) as season_id,
      coalesce(b.workspace_id, pd.workspace_id) as workspace_id,
      coalesce(b.user_id, pd.user_id) as user_id,
      coalesce(b.points, 0)::integer as points,
      coalesce(pd.prodec_points, 0)::integer as prodec_points,
      coalesce(pd.prodec_first, 0)::integer as prodec_first,
      coalesce(pd.prodec_second, 0)::integer as prodec_second,
      coalesce(pd.prodec_third, 0)::integer as prodec_third
    from (%s) b
    full join (
      select
        s.id as season_id,
        pp.workspace_id,
        pp.user_id,
        sum(public.workspace_ranking_points(pp.player_count, pp.position, s.point_config_id))::integer as prodec_points,
        count(*) filter (where pp.position = 1)::integer as prodec_first,
        count(*) filter (where pp.position = 2)::integer as prodec_second,
        count(*) filter (where pp.position = 3)::integer as prodec_third
      from public.v_event_prodec_positions pp
      join public.draft_events de on de.id = pp.event_id
      join public.seasons s
        on s.workspace_id = pp.workspace_id
       and s.starts_at = public.season_start_at(de.draft_started_at)
      group by s.id, pp.workspace_id, pp.user_id
    ) pd
      on pd.user_id = b.user_id
     and pd.season_id = b.season_id
  $f$, v_def);
end;
$$;

-- ===========================================================================
-- 3. VERIFICACIÓN AUTOMÁTICA
-- ===========================================================================
do $$
declare
  v_changed integer;
  v_extra integer;
  v_base integer;
  v_global integer;
  v_season_base integer;
  v_season integer;
begin
  -- Global: toda fila previa sigue con los mismos puntos de torneo.
  select count(*) into v_changed
  from _wp_before_0119 b
  left join public.v_workspace_points n on n.user_id = b.user_id and n.workspace_id = b.workspace_id
  where n.user_id is null or n.points is distinct from b.points;
  if v_changed > 0 then
    raise exception 'Fase E (ProDeC): % fila(s) de v_workspace_points cambiaron de puntos de torneo o desaparecieron. Migración abortada, nada quedó aplicado.', v_changed;
  end if;

  -- Global: las filas nuevas solo pueden ser de quien tiene aciertos de ProDeC y 0 puntos de torneo.
  select count(*) into v_extra
  from public.v_workspace_points n
  where not exists (select 1 from _wp_before_0119 b where b.user_id = n.user_id and b.workspace_id = n.workspace_id)
    and (n.points <> 0 or (n.prodec_first + n.prodec_second + n.prodec_third) = 0);
  if v_extra > 0 then
    raise exception 'Fase E (ProDeC): % fila(s) nuevas de v_workspace_points que no son solo de ProDeC. Migración abortada, nada quedó aplicado.', v_extra;
  end if;

  -- Las medallas del Global suman exactamente los aciertos de la base.
  select count(*) into v_base from public.v_event_prodec_positions;
  select coalesce(sum(prodec_first + prodec_second + prodec_third), 0) into v_global from public.v_workspace_points;
  if v_base <> v_global then
    raise exception 'Fase E (ProDeC): v_workspace_points suma % aciertos de ProDeC pero la base tiene %. Migración abortada, nada quedó aplicado.', v_global, v_base;
  end if;

  -- Temporada: mismas garantías.
  select count(*) into v_changed
  from _sp_before_0119 b
  left join public.v_season_points n on n.season_id = b.season_id and n.user_id = b.user_id
  where n.user_id is null or n.points is distinct from b.points;
  if v_changed > 0 then
    raise exception 'Fase E (ProDeC): % fila(s) de v_season_points cambiaron de puntos de torneo o desaparecieron. Migración abortada, nada quedó aplicado.', v_changed;
  end if;

  select count(*) into v_extra
  from public.v_season_points n
  where not exists (select 1 from _sp_before_0119 b where b.season_id = n.season_id and b.user_id = n.user_id)
    and (n.points <> 0 or (n.prodec_first + n.prodec_second + n.prodec_third) = 0);
  if v_extra > 0 then
    raise exception 'Fase E (ProDeC): % fila(s) nuevas de v_season_points que no son solo de ProDeC. Migración abortada, nada quedó aplicado.', v_extra;
  end if;

  -- Las medallas por temporada suman los aciertos de la base que caen en alguna temporada.
  select count(*) into v_season_base
  from public.v_event_prodec_positions pp
  join public.draft_events de on de.id = pp.event_id
  join public.seasons s
    on s.workspace_id = pp.workspace_id
   and s.starts_at = public.season_start_at(de.draft_started_at);
  select coalesce(sum(prodec_first + prodec_second + prodec_third), 0) into v_season from public.v_season_points;
  if v_season_base <> v_season then
    raise exception 'Fase E (ProDeC): v_season_points suma % aciertos de ProDeC pero la base tiene % en temporadas. Migración abortada, nada quedó aplicado.', v_season, v_season_base;
  end if;

  raise notice 'Fase E (ProDeC): columnas agregadas — puntos de torneo idénticos antes/después; % acierto(s) de ProDeC en el Global, % en temporadas.', v_global, v_season;
end;
$$;
