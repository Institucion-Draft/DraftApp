-- 0153: los walkovers ("me voy") no cuentan en las estadisticas (aplicada en Supabase el 2026-11-06).
--
-- Un cruce resuelto por walkover no cuenta como enfrentamiento ganado ni perdido, sus partidas
-- (is_walkover = true) no cuentan como partidas ganadas ni perdidas y no entran en la duracion
-- promedio (antes contaban como 0 minutos). Misma regla que ya usaba v_player_streaks:
--   * pairing con alguna partida walkover de tipo draft o final;
--   * cruce de llave con una partida walkover de tipo tiebreak en su ronda.
--
-- Vistas modificadas (mismas columnas que antes):
--   v_participant_official_results  (alimenta winrate por color y por combinacion de colores)
--   v_participant_official_games    (idem, por partidas)
--   v_player_workspace_stats        (enfrentamientos, partidas totales y duracion promedio)
--
-- Rollback: volver a crear las definiciones de la migracion 0152.

begin;

create or replace view public.v_participant_official_results
with (security_invoker = true) as
select ep.id as participant_id, ep.user_id, de.workspace_id, de.id as event_id,
       'pairing'::text as source, p.id::text as result_id,
       (p.official_winner_participant_id = ep.id) as won
from public.pairings p
join public.draft_events de on de.id = p.event_id
  and de.is_official = true and de.deleted_at is null and de.event_type <> 'two_headed_giant'
join public.event_participants ep on ep.role = 'player'
  and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
where p.official_winner_participant_id is not null
  and coalesce(p.stage::text, '') <> 'revenge'
  and not exists (select 1 from public.matches wm
    where wm.pairing_id = p.id and wm.is_walkover = true
      and wm.match_type = any (array['draft'::text, 'final'::text]))
union all
select ep.id, ep.user_id, de.workspace_id, de.id,
       'bracket'::text, bm.id::text,
       (bm.winner_participant_id = ep.id)
from public.event_tiebreak_bracket_matches bm
join public.event_tiebreak_groups etg on etg.id = bm.group_id
  and etg.status <> all (array['failed'::text, 'superseded'::text])
join public.draft_events de on de.id = etg.event_id
  and de.is_official = true and de.deleted_at is null and de.event_type <> 'two_headed_giant'
join public.event_participants ep on ep.role = 'player'
  and (bm.participant_a_id = ep.id or bm.participant_b_id = ep.id)
where bm.winner_participant_id is not null
  and not exists (select 1 from public.matches wmb
    where wmb.pairing_id = bm.pairing_id and wmb.match_type = 'tiebreak'
      and wmb.is_walkover = true and coalesce(wmb.tiebreak_round, 1) = etg.round_number);

create or replace view public.v_participant_official_games
with (security_invoker = true) as
select ep.id as participant_id, ep.user_id, de.workspace_id, de.id as event_id,
       m.id::text as result_id,
       (m.winner_participant_id = ep.id) as won
from public.matches m
join public.pairings p on p.id = m.pairing_id
join public.draft_events de on de.id = p.event_id
  and de.is_official = true and de.deleted_at is null and de.event_type <> 'two_headed_giant'
join public.event_participants ep on ep.role = 'player'
  and (p.participant_a_id = ep.id or p.participant_b_id = ep.id)
where m.status = 'completed'
  and m.winner_participant_id is not null
  and m.is_walkover is not true
  and m.match_type = any (array['draft'::text, 'tiebreak'::text, 'final'::text]);

create or replace view public.v_player_workspace_stats as
 WITH bracket_pairings AS (
         SELECT ep_1.user_id, de_1.workspace_id,
            count(DISTINCT bm.id) FILTER (WHERE bm.winner_participant_id = ep_1.id) AS won,
            count(DISTINCT bm.id) FILTER (WHERE bm.winner_participant_id IS NOT NULL AND bm.winner_participant_id <> ep_1.id) AS lost
           FROM event_tiebreak_bracket_matches bm
             JOIN event_tiebreak_groups etg ON etg.id = bm.group_id AND (etg.status <> ALL (ARRAY['failed'::text, 'superseded'::text]))
             JOIN draft_events de_1 ON de_1.id = etg.event_id AND de_1.deleted_at IS NULL AND de_1.is_official = true AND de_1.event_type <> 'two_headed_giant'::text
             JOIN event_participants ep_1 ON (bm.participant_a_id = ep_1.id OR bm.participant_b_id = ep_1.id) AND ep_1.role = 'player'::text
          WHERE NOT EXISTS ( SELECT 1 FROM matches wmb
                  WHERE wmb.pairing_id = bm.pairing_id AND wmb.match_type = 'tiebreak'::text AND wmb.is_walkover = true AND COALESCE(wmb.tiebreak_round, 1) = etg.round_number)
          GROUP BY ep_1.user_id, de_1.workspace_id
        )
 SELECT ep.user_id, de.workspace_id,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id = ep.id AND wk.pairing_id IS NULL AND COALESCE(p.stage::text, '') <> 'revenge') + COALESCE(max(bp.won), 0::bigint) AS pairings_won,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id IS NOT NULL AND p.official_winner_participant_id <> ep.id AND wk.pairing_id IS NULL AND COALESCE(p.stage::text, '') <> 'revenge') + COALESCE(max(bp.lost), 0::bigint) AS pairings_lost,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id IS NULL AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id) AND COALESCE(p.stage::text, '') <> 'revenge') AS pairings_pending,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND m.is_walkover IS NOT TRUE AND (m.match_type = ANY (ARRAY['draft'::text, 'tiebreak'::text, 'final'::text]))) AS draft_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND m.is_walkover IS NOT TRUE AND (m.match_type = ANY (ARRAY['draft'::text, 'tiebreak'::text, 'final'::text])) AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS draft_matches_lost,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND m.match_type = 'revenge'::text) AS revenge_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND m.match_type = 'revenge'::text AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS revenge_matches_lost,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND m.status = 'completed'::text AND m.is_walkover IS NOT TRUE AND m.match_type IS DISTINCT FROM 'revenge'::text) AS total_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND m.status = 'completed'::text AND m.is_walkover IS NOT TRUE AND m.match_type IS DISTINCT FROM 'revenge'::text AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS total_matches_lost,
    count(DISTINCT p.id) FILTER (WHERE p.super_cup_winner_participant_id = ep.id) AS super_cups_won,
    count(DISTINCT de.id) FILTER (WHERE de.champion_user_id = ep.user_id) AS championships,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'player'::text) AS events_as_player,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'ghost'::text) AS events_as_ghost,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'player'::text AND (de.status = ANY (ARRAY['completed'::text, 'concluded'::text]))) AS completed_events_as_player,
    avg(EXTRACT(epoch FROM m.ended_at - m.started_at) / 60::numeric) FILTER (WHERE m.status = 'completed'::text AND m.is_walkover IS NOT TRUE AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS avg_match_duration_minutes
   FROM event_participants ep
     JOIN draft_events de ON de.id = ep.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
     LEFT JOIN pairings p ON p.event_id = de.id AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)
     LEFT JOIN ( SELECT DISTINCT pairing_id FROM matches
                  WHERE is_walkover = true AND (match_type = ANY (ARRAY['draft'::text, 'final'::text]))) wk ON wk.pairing_id = p.id
     LEFT JOIN matches m ON m.pairing_id = p.id
     LEFT JOIN bracket_pairings bp ON bp.user_id = ep.user_id AND bp.workspace_id = de.workspace_id
  GROUP BY ep.user_id, de.workspace_id;

alter view public.v_player_workspace_stats set (security_invoker = true);

commit;
