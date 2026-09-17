-- 0110_rr_no_top_rank_by_winrate.sql
--
-- Bug real encontrado validando v_rr_no_top_regular_rank contra el podio real de la app en 3
-- eventos (Copa Imposible, Draft Soleado 2, Draft de la Pachamama, todos round_robin sin top4):
-- el dense_rank() de 2°/3° comparaba ENFRENTAMIENTOS GANADOS crudos, no winrate (ganados/
-- jugados) — el mismo criterio de orden que ya usa el resto de la app para standings de BO1/BO3
-- (ver StandingsScreen/podium.ts). Caso confirmado en "Draft de la Pachamama": Juan 3 de 5
-- jugados (60%) vs Toxic 3 de 6 jugados (50%) — Juan debería ir claramente arriba sin empate,
-- pero al comparar solo "ganados" (3 == 3) el cálculo los trataba como empatados.
--
-- Fix: para BO1/BO3, el dense_rank ordena por winrate (ganados/jugados) en vez de ganados
-- crudos. Para BO2 el criterio de orden sigue siendo puntos totales (3-1-0) sin cambios — ya
-- confirmado correcto en su momento, el sistema de puntos de BO2 no tiene el problema del
-- denominador porque el puntaje YA pondera victoria/empate/derrota.
--
-- Alcance explícitamente ACOTADO (a pedido): esto NO toca la cascada fina de desempate
-- (head-to-head, calidad de rivales, hash) que existe para decidir un único campeón real — sigue
-- sin usarse acá. Tampoco resuelve el caso de "Copa Imposible" (un empate genuino en puntos Y
-- winrate por el 1er puesto, resuelto en su momento por un desempate real jugado con
-- group_origin='tiebreak', formato viejo) — ese caso necesita leer el resultado de
-- event_tiebreak_bracket_matches de esa disputa real, algo que esta vista todavía no hace; queda
-- pendiente como fix separado. La regla vigente acá sigue siendo la simple: ordenar por winrate
-- real: si el winrate da EXACTAMENTE igual entre 2+, todos comparten esa posición (mismos puntos
-- de Ranking Global) — excepto el 1er puesto, que siempre es único vía champion_user_id (el
-- desempate real ya se jugó en vivo para llegar a esa columna).

create or replace view public.v_rr_no_top_regular_rank as
with rr_no_top_stats as (
  select
    ep.id as participant_id,
    ep.user_id,
    de.id as event_id,
    de.workspace_id,
    de.match_format,
    -- Enfrentamientos ganados (numerador del winrate en BO1/BO3).
    count(distinct p.id) filter (where p.official_winner_participant_id = ep.id) as won,
    -- Enfrentamientos jugados = pairings resueltos (ganador o empate real), sea cual sea el
    -- resultado — denominador del winrate. En BO1/BO3 nunca hay empate real, así que esto
    -- equivale a "pairings con ganador"; se incluye official_draw igual por generalidad.
    count(distinct p.id) filter (
      where p.official_winner_participant_id is not null or p.official_draw = true
    ) as played,
    -- Puntos 3-1-0, sin cambios — sigue siendo el criterio de orden para BO2.
    coalesce(sum(
      case
        when p.official_winner_participant_id = ep.id
          then (case when de.match_format = 'bo2' then 3 else 1 end)
        when p.official_winner_participant_id is null
          and p.official_draw = true
          and de.match_format = 'bo2'
          and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
          then 1
        else 0
      end
    ), 0) as bo2_points
  from public.event_participants ep
  join public.draft_events de
    on de.id = ep.event_id
   and de.competition_format = 'round_robin'
   and de.top_size is null
   and de.deleted_at is null
   and de.event_type <> 'two_headed_giant'
   and de.status in ('completed', 'concluded')
   and de.champion_user_id is not null
  left join public.pairings p
    on p.event_id = de.id
   and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
  where ep.role = 'player'
    and ep.left_event_at is null
    and ep.user_id <> de.champion_user_id
  group by ep.id, ep.user_id, de.id, de.workspace_id, de.match_format
)
select
  participant_id,
  user_id,
  event_id,
  workspace_id,
  dense_rank() over (
    partition by event_id
    order by (
      case
        when match_format = 'bo2' then bo2_points::numeric
        else (case when played > 0 then won::numeric / played else 0 end)
      end
    ) desc
  ) as pos_rank
from rr_no_top_stats;

grant select on public.v_rr_no_top_regular_rank to anon, authenticated;
