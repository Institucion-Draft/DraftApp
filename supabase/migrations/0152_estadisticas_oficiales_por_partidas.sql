-- 0152: una sola definicion de "oficial" para las estadisticas del perfil (aplicada en Supabase el 2026-11-05).
--
-- Oficial significa:
--   * evento con is_official = true (los de prueba nunca cuentan), no borrado, y que no sea
--     Gigantes de Dos Cabezas (tiene su propio conjunto de estadisticas, tablas tg_*);
--   * enfrentamiento (pairing o serie de top cut/desempate) con ganador definido, sin venganzas;
--   * partida con match_type draft, tiebreak o final, completada y con ganador (sin venganzas).
--
-- Vistas nuevas:
--   v_participant_official_results  un enfrentamiento oficial por participante
--   v_participant_official_games    una partida oficial por participante
--   v_player_color_combo_stats      mazos, enfrentamientos y partidas por combinacion de colores
-- Vistas modificadas:
--   v_player_color_stats      agrega games_played, games_won, game_winrate; el winrate por
--                             enfrentamientos ahora incluye top cut y desempates
--   v_player_streaks          ya no cuenta partidas de venganza
--   v_player_workspace_stats  los pairings de venganza no cuentan como enfrentamientos y
--                             total_matches_won/lost excluyen venganzas
--
-- Rollback: drop view de las dos vistas que cambiaron de columnas y de las nuevas, y volver
-- a crear las definiciones anteriores (ver el registro de seguridad y el historial de migraciones).

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
where bm.winner_participant_id is not null;

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
  and m.match_type = any (array['draft'::text, 'tiebreak'::text, 'final'::text]);

revoke all on public.v_participant_official_results, public.v_participant_official_games from anon, authenticated;
grant select on public.v_participant_official_results, public.v_participant_official_games to authenticated;

create or replace view public.v_player_color_combo_stats
with (security_invoker = true) as
with decks as (
  select ep.id as participant_id, ep.user_id, de.workspace_id,
         string_agg(pc.color::text, '' order by array_position(array['W','U','B','R','G','C'], pc.color::text)) as combo
  from public.participant_colors pc
  join public.event_participants ep on ep.id = pc.participant_id and ep.role = 'player'
  join public.draft_events de on de.id = ep.event_id
    and de.is_official = true and de.deleted_at is null and de.event_type <> 'two_headed_giant'
  group by ep.id, ep.user_id, de.workspace_id
), pr as (
  select participant_id, count(*) as played, count(*) filter (where won) as won
  from public.v_participant_official_results group by participant_id
), gr as (
  select participant_id, count(*) as played, count(*) filter (where won) as won
  from public.v_participant_official_games group by participant_id
)
select d.user_id, d.workspace_id, d.combo,
       count(distinct d.participant_id) as decks_count,
       coalesce(sum(pr.played), 0)::bigint as pairings_played,
       coalesce(sum(pr.won), 0)::bigint as pairings_won,
       coalesce(sum(gr.played), 0)::bigint as games_played,
       coalesce(sum(gr.won), 0)::bigint as games_won
from decks d
left join pr on pr.participant_id = d.participant_id
left join gr on gr.participant_id = d.participant_id
group by d.user_id, d.workspace_id, d.combo;

revoke all on public.v_player_color_combo_stats from anon, authenticated;
grant select on public.v_player_color_combo_stats to authenticated;

create or replace view public.v_player_color_stats as
 WITH color_counts AS (
         SELECT ep.user_id, de.workspace_id, pc.color, count(*) AS times_played
           FROM participant_colors pc
             JOIN event_participants ep ON ep.id = pc.participant_id
             JOIN draft_events de ON de.id = ep.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
          WHERE ep.role = 'player'::text
          GROUP BY ep.user_id, de.workspace_id, pc.color
        ), totals AS (
         SELECT color_counts.user_id, color_counts.workspace_id, sum(color_counts.times_played) AS total_color_picks
           FROM color_counts
          GROUP BY color_counts.user_id, color_counts.workspace_id
        ), color_winrates AS (
         SELECT ep.user_id, de.workspace_id, pc.color,
            count(r.result_id) AS pairings_played,
            count(r.result_id) FILTER (WHERE r.won) AS pairings_won
           FROM participant_colors pc
             JOIN event_participants ep ON ep.id = pc.participant_id
             JOIN draft_events de ON de.id = ep.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
             LEFT JOIN v_participant_official_results r ON r.participant_id = ep.id
          WHERE ep.role = 'player'::text
          GROUP BY ep.user_id, de.workspace_id, pc.color
        ), color_games AS (
         SELECT ep.user_id, de.workspace_id, pc.color,
            count(g.result_id) AS games_played,
            count(g.result_id) FILTER (WHERE g.won) AS games_won
           FROM participant_colors pc
             JOIN event_participants ep ON ep.id = pc.participant_id
             JOIN draft_events de ON de.id = ep.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
             LEFT JOIN v_participant_official_games g ON g.participant_id = ep.id
          WHERE ep.role = 'player'::text
          GROUP BY ep.user_id, de.workspace_id, pc.color
        )
 SELECT cc.user_id, cc.workspace_id, cc.color, cc.times_played, t.total_color_picks,
    round(cc.times_played::numeric / t.total_color_picks * 100::numeric, 1) AS percentage,
    cwr.pairings_played,
        CASE
            WHEN cwr.pairings_played > 0 THEN round(cwr.pairings_won::numeric / cwr.pairings_played::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS bo3_winrate,
    cg.games_played,
    cg.games_won,
        CASE
            WHEN cg.games_played > 0 THEN round(cg.games_won::numeric / cg.games_played::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS game_winrate
   FROM color_counts cc
     JOIN totals t USING (user_id, workspace_id)
     JOIN color_winrates cwr USING (user_id, workspace_id, color)
     JOIN color_games cg USING (user_id, workspace_id, color);

create or replace view public.v_player_streaks as
 WITH encounters AS (
         SELECT ep.user_id, de.workspace_id,
            COALESCE(p.official_resolved_at, p.created_at) AS result_at,
                CASE WHEN p.official_winner_participant_id = ep.id THEN 1 ELSE 0 END AS won
           FROM pairings p
             JOIN draft_events de ON de.id = p.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
             JOIN event_participants ep ON (p.participant_a_id = ep.id OR p.participant_b_id = ep.id) AND ep.role = 'player'::text
          WHERE p.official_winner_participant_id IS NOT NULL
            AND COALESCE(p.stage::text, '') <> 'revenge'
            AND NOT (EXISTS ( SELECT 1 FROM matches wm
                  WHERE wm.pairing_id = p.id AND wm.is_walkover = true AND (wm.match_type = ANY (ARRAY['draft'::text, 'final'::text]))))
        UNION ALL
         SELECT ep.user_id, de.workspace_id,
            COALESCE(bm.resolved_at, bm.created_at) AS result_at,
                CASE WHEN bm.winner_participant_id = ep.id THEN 1 ELSE 0 END AS won
           FROM event_tiebreak_bracket_matches bm
             JOIN event_tiebreak_groups etg ON etg.id = bm.group_id AND (etg.status <> ALL (ARRAY['failed'::text, 'superseded'::text]))
             JOIN draft_events de ON de.id = etg.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
             JOIN event_participants ep ON (bm.participant_a_id = ep.id OR bm.participant_b_id = ep.id) AND ep.role = 'player'::text
          WHERE bm.winner_participant_id IS NOT NULL
            AND NOT (EXISTS ( SELECT 1 FROM matches wmb
                  WHERE wmb.pairing_id = bm.pairing_id AND wmb.match_type = 'tiebreak'::text AND wmb.is_walkover = true AND COALESCE(wmb.tiebreak_round, 1) = etg.round_number))
        ), ordered_results AS (
         SELECT encounters.user_id, encounters.workspace_id, encounters.result_at, encounters.won,
            row_number() OVER (PARTITION BY encounters.user_id, encounters.workspace_id ORDER BY encounters.result_at) AS rn
           FROM encounters
        ), grouped AS (
         SELECT ordered_results.user_id, ordered_results.workspace_id, ordered_results.result_at, ordered_results.won, ordered_results.rn,
            ordered_results.rn - row_number() OVER (PARTITION BY ordered_results.user_id, ordered_results.workspace_id, ordered_results.won ORDER BY ordered_results.result_at) AS grp
           FROM ordered_results
        ), streaks AS (
         SELECT grouped.user_id, grouped.workspace_id, grouped.won, grouped.grp, count(*) AS streak_length
           FROM grouped
          GROUP BY grouped.user_id, grouped.workspace_id, grouped.won, grouped.grp
        )
 SELECT user_id, workspace_id,
    COALESCE(max(streak_length) FILTER (WHERE won = 1), 0::bigint) AS longest_win_streak,
    COALESCE(max(streak_length) FILTER (WHERE won = 0), 0::bigint) AS longest_loss_streak
   FROM streaks
  GROUP BY user_id, workspace_id;

create or replace view public.v_player_workspace_stats as
 WITH bracket_pairings AS (
         SELECT ep_1.user_id, de_1.workspace_id,
            count(DISTINCT bm.id) FILTER (WHERE bm.winner_participant_id = ep_1.id) AS won,
            count(DISTINCT bm.id) FILTER (WHERE bm.winner_participant_id IS NOT NULL AND bm.winner_participant_id <> ep_1.id) AS lost
           FROM event_tiebreak_bracket_matches bm
             JOIN event_tiebreak_groups etg ON etg.id = bm.group_id AND (etg.status <> ALL (ARRAY['failed'::text, 'superseded'::text]))
             JOIN draft_events de_1 ON de_1.id = etg.event_id AND de_1.deleted_at IS NULL AND de_1.is_official = true AND de_1.event_type <> 'two_headed_giant'::text
             JOIN event_participants ep_1 ON (bm.participant_a_id = ep_1.id OR bm.participant_b_id = ep_1.id) AND ep_1.role = 'player'::text
          GROUP BY ep_1.user_id, de_1.workspace_id
        )
 SELECT ep.user_id, de.workspace_id,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id = ep.id AND COALESCE(p.stage::text, '') <> 'revenge') + COALESCE(max(bp.won), 0::bigint) AS pairings_won,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id IS NOT NULL AND p.official_winner_participant_id <> ep.id AND COALESCE(p.stage::text, '') <> 'revenge') + COALESCE(max(bp.lost), 0::bigint) AS pairings_lost,
    count(DISTINCT p.id) FILTER (WHERE p.official_winner_participant_id IS NULL AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id) AND COALESCE(p.stage::text, '') <> 'revenge') AS pairings_pending,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND (m.match_type = ANY (ARRAY['draft'::text, 'tiebreak'::text, 'final'::text]))) AS draft_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND (m.match_type = ANY (ARRAY['draft'::text, 'tiebreak'::text, 'final'::text])) AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS draft_matches_lost,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND m.match_type = 'revenge'::text) AS revenge_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND m.match_type = 'revenge'::text AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS revenge_matches_lost,
    count(m.id) FILTER (WHERE m.winner_participant_id = ep.id AND m.status = 'completed'::text AND m.match_type IS DISTINCT FROM 'revenge'::text) AS total_matches_won,
    count(m.id) FILTER (WHERE m.winner_participant_id IS NOT NULL AND m.winner_participant_id <> ep.id AND m.status = 'completed'::text AND m.match_type IS DISTINCT FROM 'revenge'::text AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS total_matches_lost,
    count(DISTINCT p.id) FILTER (WHERE p.super_cup_winner_participant_id = ep.id) AS super_cups_won,
    count(DISTINCT de.id) FILTER (WHERE de.champion_user_id = ep.user_id) AS championships,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'player'::text) AS events_as_player,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'ghost'::text) AS events_as_ghost,
    count(DISTINCT de.id) FILTER (WHERE ep.role = 'player'::text AND (de.status = ANY (ARRAY['completed'::text, 'concluded'::text]))) AS completed_events_as_player,
    avg(EXTRACT(epoch FROM m.ended_at - m.started_at) / 60::numeric) FILTER (WHERE m.status = 'completed'::text AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)) AS avg_match_duration_minutes
   FROM event_participants ep
     JOIN draft_events de ON de.id = ep.event_id AND de.deleted_at IS NULL AND de.is_official = true AND de.event_type <> 'two_headed_giant'::text
     LEFT JOIN pairings p ON p.event_id = de.id AND (p.participant_a_id = ep.id OR p.participant_b_id = ep.id)
     LEFT JOIN matches m ON m.pairing_id = p.id
     LEFT JOIN bracket_pairings bp ON bp.user_id = ep.user_id AND bp.workspace_id = de.workspace_id
  GROUP BY ep.user_id, de.workspace_id;

alter view public.v_player_color_stats set (security_invoker = true);
alter view public.v_player_streaks set (security_invoker = true);
alter view public.v_player_workspace_stats set (security_invoker = true);

commit;
