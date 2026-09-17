-- 0111_rr_no_top_rank_real_dispute.sql
--
-- Segundo bug confirmado en v_rr_no_top_regular_rank, validando "Copa Imposible": cuando 2+
-- personas empatan en winrate por el 1er puesto, la app juega un desempate REAL para decidir el
-- campeón (dos mecanismos posibles según cuándo se creó el evento — ver abajo). Esa disputa real
-- también diferencia al resto del grupo empatado (quién queda 2°, quién 3°) — pero
-- v_rr_no_top_regular_rank (0110) solo miraba winrate crudo, así que a todo el grupo empatado
-- (menos el campeón, que ya se excluye aparte) le seguía dando el MISMO pos_rank, ignorando el
-- resultado real ya jugado. Caso confirmado: Toxic perdió el desempate real de Copa Imposible y
-- quedó 3°, pero la vista lo empataba en 2° con quien le ganó.
--
-- "Opción B" (confirmada, sin cambios en esta migración): enfrentamientos jugados = pairings
-- resueltos con resultado real (ganador o walkover, da igual — ambos setean
-- official_winner_participant_id de la misma forma), nunca todos los que existen en teoría en la
-- tabla pairings. Eso ya quedó bien en 0110 — acá no se toca.
--
-- Fix de esta migración: antes de caer al winrate crudo, si el evento tuvo una disputa real de
-- 1er puesto ya resuelta, usar SU resultado real como desempate — pero solo como CRITERIO
-- SECUNDARIO dentro del mismo winrate (nunca reemplaza al winrate como criterio primario: gente
-- con distinto winrate real sigue ordenada por winrate, sin que esto la toque). Dos mecanismos
-- soportados, ambos ya existentes en el schema, ninguno se reimplementa desde cero:
--
--   a) Formato viejo (group_type='round_robin', cualquier group_origin — Copa Imposible tiene
--      group_origin='tiebreak'): el campeón queda en event_tiebreak_groups.champion_user_id de
--      esa fila. Para el resto del grupo, se reutiliza count_tiebreak_round_wins (0023) sobre la
--      ronda que efectivamente resolvió la disputa (su propio round_number — "tanda 1" o "tanda
--      2"): quien ganó más partidas de esa ronda entre los NO campeones queda mejor posicionado.
--      Si esa ronda no diferenció a alguien (p. ej. nunca se jugó el cruce entre 2 de ellos),
--      quedan con el mismo conteo y comparten posición igual — comportamiento correcto, no hay
--      resultado real que los distinga.
--
--   b) Formato actual (group_type='fourth_place', group_origin='round_robin_first_place', desde
--      0075): NO tiene fase 'third_place' explícita (a diferencia del bracket real de Top4) — el
--      campeón está en draft_events.champion_user_id (nunca en la fila del grupo, confirmado
--      leyendo 0075). Perdedor de 'final' = 2° real; perdedor(es) de 'semi' = 3° real
--      (compartido si el grupo tenía 4 integrantes — esos 2 nunca jugaron entre sí, mismo
--      criterio "co-terceros" que ya usa podiumFirstPlaceTiebreakResolvedMode/
--      resolveFourthPlaceDisputeOrder en podium.ts para el caso análogo).
--
-- Deliberadamente FUERA de alcance: el desempate viejo de 4 vías (group_type='bracket' vía
-- create_bracket_tiebreak_group pre-0026) — su propia lógica de resolución ("toma la última
-- match cerrada como final", ver 0023) nunca registró de forma confiable quién es 2°/3°/4°, no
-- hay dato real del que partir. Cae al fallback de winrate crudo, igual que antes de este fix.

create or replace view public.v_rr_no_top_regular_rank as
with rr_no_top_stats as (
  select
    ep.id as participant_id,
    ep.user_id,
    de.id as event_id,
    de.workspace_id,
    de.match_format,
    count(distinct p.id) filter (where p.official_winner_participant_id = ep.id) as won,
    count(distinct p.id) filter (
      where p.official_winner_participant_id is not null or p.official_draw = true
    ) as played,
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
),
rr_no_top_dispute_groups as (
  -- Última disputa real de 1er puesto ya resuelta, por evento (un solo grupo relevante por
  -- evento en la práctica; distinct on por las dudas si hubiera más de uno histórico).
  select distinct on (event_id) event_id, group_id, kind, round_number
  from (
    select etg.event_id, etg.id as group_id, 'round_robin'::text as kind, etg.round_number
    from public.event_tiebreak_groups etg
    where etg.group_type = 'round_robin'
      and etg.status = 'resolved'
      and etg.champion_user_id is not null

    union all

    select etg.event_id, etg.id as group_id, 'bracket'::text as kind, etg.round_number
    from public.event_tiebreak_groups etg
    where etg.group_type = 'fourth_place'
      and etg.group_origin = 'round_robin_first_place'
      and etg.status = 'resolved'
  ) x
  order by event_id, round_number desc
),
dispute_tier_round_robin as (
  -- Formato viejo: orden real = wins dentro de la ronda que decidió la disputa, para todos
  -- menos el campeón (ya cubierto aparte por de.champion_user_id).
  select
    gp.participant_id,
    dg.event_id,
    dense_rank() over (
      partition by dg.event_id
      order by public.count_tiebreak_round_wins(dg.group_id, gp.participant_id, dg.round_number) desc
    ) as dispute_tier
  from rr_no_top_dispute_groups dg
  join public.event_tiebreak_groups etg on etg.id = dg.group_id
  join public.event_tiebreak_group_participants gp on gp.group_id = dg.group_id
  where dg.kind = 'round_robin'
    and gp.user_id <> etg.champion_user_id
),
dispute_tier_bracket_raw as (
  -- Formato actual: perdedor de 'final' = tier 1 (2° real); perdedor(es) de 'semi' = tier 2
  -- (3° real, compartido si hay 2 semis).
  select
    (case when bm.winner_participant_id = bm.participant_a_id then bm.participant_b_id else bm.participant_a_id end) as participant_id,
    dg.event_id,
    (case bm.bracket_phase when 'final' then 1 else 2 end) as dispute_tier
  from rr_no_top_dispute_groups dg
  join public.event_tiebreak_bracket_matches bm on bm.group_id = dg.group_id
  where dg.kind = 'bracket'
    and bm.bracket_phase in ('semi', 'final')
    and bm.winner_participant_id is not null
),
dispute_tier as (
  select participant_id, event_id, dispute_tier from dispute_tier_round_robin
  union all
  select participant_id, event_id, dispute_tier from dispute_tier_bracket_raw
)
select
  s.participant_id,
  s.user_id,
  s.event_id,
  s.workspace_id,
  dense_rank() over (
    partition by s.event_id
    order by
      (case
        when s.match_format = 'bo2' then s.bo2_points::numeric
        else (case when s.played > 0 then s.won::numeric / s.played else 0 end)
      end) desc,
      coalesce(dt.dispute_tier, 0) asc
  ) as pos_rank
from rr_no_top_stats s
left join dispute_tier dt on dt.participant_id = s.participant_id and dt.event_id = s.event_id;

grant select on public.v_rr_no_top_regular_rank to anon, authenticated;
