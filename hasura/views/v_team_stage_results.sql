-- Tracks: matches played, matches remaining, wins, losses, rounds won, rounds lost
-- Also exposes the team's group within the stage (taken from their winner-bracket
-- brackets) and their rank within that group, computed with the same tiebreaker
-- chain that advance_round_robin_teams / get_team_at_stage_rank / seed_stage use
-- to promote teams to the next stage. The UI reads `rank` directly so it never
-- disagrees with bracket progression.
--
-- Two ordering columns are exposed and share the SAME ORDER BY so they can never
-- disagree:
--   - `rank`      : ROW_NUMBER, unique & deterministic. Used by the UI display
--                   and by get_team_at_stage_rank() for OFFSET-based seeding.
--   - `placement` : RANK, ties allowed. Used by calculate_tournament_trophies()
--                   so multiple teams sharing a final-stage placement suppress
--                   the bronze award when appropriate.
--
-- For DoubleElimination stages, the ordering is by elimination point rather
-- than raw wins (a DE runner-up that came up through the losers bracket has
-- more wins than the champion, so wins-based ordering puts silver above gold).
-- For RoundRobin / Swiss / SingleElimination the DE keys collapse to constants
-- and the existing wins-based tiebreaker chain is used unchanged.
CREATE OR REPLACE VIEW public.v_team_stage_results AS
WITH team_brackets AS (
    -- Get all brackets for each team in each stage
    SELECT
        tb.tournament_team_id_1 as team_id,
        tb.tournament_stage_id,
        tb.id as bracket_id,
        tb.match_id,
        tb.bye,
        tb."group" as bracket_group,
        COALESCE(tb.path, 'WB') as bracket_path,
        1 as team_position
    FROM tournament_brackets tb
    WHERE tb.tournament_team_id_1 IS NOT NULL

    UNION ALL

    SELECT
        tb.tournament_team_id_2 as team_id,
        tb.tournament_stage_id,
        tb.id as bracket_id,
        tb.match_id,
        tb.bye,
        tb."group" as bracket_group,
        COALESCE(tb.path, 'WB') as bracket_path,
        2 as team_position
    FROM tournament_brackets tb
    WHERE tb.tournament_team_id_2 IS NOT NULL
),
team_match_results AS (
    -- Get match results for each team
    SELECT
        tb.team_id,
        tb.tournament_stage_id,
        tb.bracket_id,
        tb.match_id,
        tb.bye,
        tb.team_position,
        m.lineup_1_id,
        m.lineup_2_id,
        m.winning_lineup_id,
        CASE
            WHEN tb.team_position = 1 THEN m.lineup_1_id
            ELSE m.lineup_2_id
        END as team_lineup_id,
        CASE
            WHEN tb.team_position = 1 THEN m.lineup_2_id
            ELSE m.lineup_1_id
        END as opponent_lineup_id
    FROM team_brackets tb
    LEFT JOIN matches m ON m.id = tb.match_id
),
match_stats AS (
    -- Calculate wins, losses, and games played per match
    SELECT
        tmr.team_id,
        tmr.tournament_stage_id,
        tmr.bracket_id,
        tmr.match_id,
        tmr.bye,
        CASE WHEN tmr.match_id IS NOT NULL AND tmr.winning_lineup_id IS NOT NULL THEN 1 ELSE 0 END as game_played,
        CASE WHEN tmr.winning_lineup_id = tmr.team_lineup_id THEN 1 ELSE 0 END as win,
        CASE WHEN tmr.winning_lineup_id IS NOT NULL
             AND tmr.winning_lineup_id != tmr.team_lineup_id THEN 1 ELSE 0 END as loss
    FROM team_match_results tmr
),
round_stats AS (
    -- Calculate rounds won and lost per team per match
    SELECT
        tmr.team_id,
        tmr.tournament_stage_id,
        tmr.match_id,
        COUNT(*) FILTER (WHERE
            (tmr.team_position = 1 AND mmr.winning_side = mmr.lineup_1_side)
            OR (tmr.team_position = 2 AND mmr.winning_side = mmr.lineup_2_side)
        ) as rounds_won,
        COUNT(*) FILTER (WHERE
            (tmr.team_position = 1 AND mmr.winning_side = mmr.lineup_2_side)
            OR (tmr.team_position = 2 AND mmr.winning_side = mmr.lineup_1_side)
        ) as rounds_lost
    FROM team_match_results tmr
    JOIN match_maps mm ON mm.match_id = tmr.match_id AND mm.status = 'Finished'
    JOIN match_map_rounds mmr ON mmr.match_map_id = mm.id
    WHERE tmr.match_id IS NOT NULL
    GROUP BY tmr.team_id, tmr.tournament_stage_id, tmr.match_id
),
map_stats AS (
    -- Calculate maps won and lost per team per match
    SELECT
        tmr.team_id,
        tmr.tournament_stage_id,
        tmr.match_id,
        mm.id as match_map_id,
        COUNT(*) FILTER (WHERE
            (tmr.team_position = 1 AND mmr.winning_side = mmr.lineup_1_side)
            OR (tmr.team_position = 2 AND mmr.winning_side = mmr.lineup_2_side)
        ) as rounds_won_on_map,
        COUNT(*) FILTER (WHERE
            (tmr.team_position = 1 AND mmr.winning_side = mmr.lineup_2_side)
            OR (tmr.team_position = 2 AND mmr.winning_side = mmr.lineup_1_side)
        ) as rounds_lost_on_map
    FROM team_match_results tmr
    JOIN match_maps mm ON mm.match_id = tmr.match_id AND mm.status = 'Finished'
    JOIN match_map_rounds mmr ON mmr.match_map_id = mm.id
    WHERE tmr.match_id IS NOT NULL
    GROUP BY tmr.team_id, tmr.tournament_stage_id, tmr.match_id, mm.id
),
map_wins_losses AS (
    -- Determine which team won each map (team with more rounds won on that map)
    SELECT
        ms.team_id,
        ms.tournament_stage_id,
        ms.match_id,
        CASE WHEN ms.rounds_won_on_map > ms.rounds_lost_on_map THEN 1 ELSE 0 END as map_won,
        CASE WHEN ms.rounds_won_on_map < ms.rounds_lost_on_map THEN 1 ELSE 0 END as map_lost
    FROM map_stats ms
),
aggregated_map_stats AS (
    -- Aggregate maps won and lost per team per stage
    SELECT
        mwl.team_id,
        mwl.tournament_stage_id,
        SUM(mwl.map_won) as maps_won,
        SUM(mwl.map_lost) as maps_lost
    FROM map_wins_losses mwl
    GROUP BY mwl.team_id, mwl.tournament_stage_id
),
aggregated_stats AS (
    -- Aggregate all stats per team per stage
    SELECT
        ms.team_id,
        ms.tournament_stage_id,
        -- Matches played: count of finished matches (excluding byes)
        SUM(ms.game_played) FILTER (WHERE ms.bye = false) as matches_played,
        -- Matches remaining: total brackets (excluding byes) minus matches played
        COUNT(*) FILTER (WHERE ms.bye = false) - SUM(ms.game_played) FILTER (WHERE ms.bye = false) as matches_remaining,
        -- Wins: count of matches where team won
        SUM(ms.win) as wins,
        -- Losses: count of matches where team lost
        SUM(ms.loss) as losses,
        -- Rounds won: sum across all matches
        COALESCE(SUM(rs.rounds_won), 0) as rounds_won,
        -- Rounds lost: sum across all matches
        COALESCE(SUM(rs.rounds_lost), 0) as rounds_lost
    FROM match_stats ms
    LEFT JOIN round_stats rs ON rs.team_id = ms.team_id
        AND rs.tournament_stage_id = ms.tournament_stage_id
        AND rs.match_id = ms.match_id
    GROUP BY ms.team_id, ms.tournament_stage_id
),
team_kills_deaths AS (
    -- Calculate total kills and deaths for each team in this stage
    SELECT
        tmr.team_id,
        tmr.tournament_stage_id,
        COUNT(*) FILTER (WHERE
            pk.attacker_steam_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id = tmr.team_lineup_id
                  AND mlp.steam_id = pk.attacker_steam_id
            )
            AND pk.attacker_steam_id != pk.attacked_steam_id  -- Exclude suicides
        )::int as total_kills,
        COUNT(*) FILTER (WHERE
            pk.attacked_steam_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id = tmr.team_lineup_id
                  AND mlp.steam_id = pk.attacked_steam_id
            )
            AND pk.attacker_steam_id != pk.attacked_steam_id  -- Exclude suicides
        )::int as total_deaths
    FROM team_match_results tmr
    JOIN player_kills pk ON pk.match_id = tmr.match_id
    WHERE tmr.match_id IS NOT NULL
    GROUP BY tmr.team_id, tmr.tournament_stage_id
),
team_wins_per_stage AS (
    -- Calculate wins per team per stage (needed to find tied teams)
    SELECT
        ms.team_id,
        ms.tournament_stage_id,
        SUM(ms.win) as wins
    FROM match_stats ms
    GROUP BY ms.team_id, ms.tournament_stage_id
),
team_head_to_head_matches AS (
    -- Calculate head-to-head match wins for each team in this stage
    -- Only counts match wins against teams with the same number of wins (tied teams)
    SELECT
        tmr1.team_id,
        tmr1.tournament_stage_id,
        COUNT(*) FILTER (WHERE tmr1.winning_lineup_id = tmr1.team_lineup_id)::int as head_to_head_match_wins
    FROM team_match_results tmr1
    JOIN team_match_results tmr2 ON tmr2.match_id = tmr1.match_id
        AND tmr2.team_id != tmr1.team_id
        AND tmr2.tournament_stage_id = tmr1.tournament_stage_id
        AND tmr2.team_lineup_id = tmr1.opponent_lineup_id
    JOIN team_wins_per_stage tw1 ON tw1.team_id = tmr1.team_id
        AND tw1.tournament_stage_id = tmr1.tournament_stage_id
    JOIN team_wins_per_stage tw2 ON tw2.team_id = tmr2.team_id
        AND tw2.tournament_stage_id = tmr2.tournament_stage_id
        AND tw2.wins = tw1.wins  -- Only count wins against teams with same number of wins
    WHERE tmr1.winning_lineup_id IS NOT NULL
    GROUP BY tmr1.team_id, tmr1.tournament_stage_id
),
team_head_to_head_rounds AS (
    -- Calculate head-to-head rounds won for each team in this stage
    -- Only counts rounds won in matches against teams with the same number of wins (tied teams)
    SELECT
        tmr1.team_id,
        tmr1.tournament_stage_id,
        COUNT(*) FILTER (WHERE
            (tmr1.team_position = 1 AND mmr.winning_side = mmr.lineup_1_side)
            OR (tmr1.team_position = 2 AND mmr.winning_side = mmr.lineup_2_side)
        )::int as head_to_head_rounds_won
    FROM team_match_results tmr1
    JOIN team_match_results tmr2 ON tmr2.match_id = tmr1.match_id
        AND tmr2.team_id != tmr1.team_id
        AND tmr2.tournament_stage_id = tmr1.tournament_stage_id
        AND tmr2.team_lineup_id = tmr1.opponent_lineup_id
    JOIN team_wins_per_stage tw1 ON tw1.team_id = tmr1.team_id
        AND tw1.tournament_stage_id = tmr1.tournament_stage_id
    JOIN team_wins_per_stage tw2 ON tw2.team_id = tmr2.team_id
        AND tw2.tournament_stage_id = tmr2.tournament_stage_id
        AND tw2.wins = tw1.wins  -- Only count rounds against teams with same number of wins
    JOIN match_maps mm ON mm.match_id = tmr1.match_id AND mm.status = 'Finished'
    JOIN match_map_rounds mmr ON mmr.match_map_id = mm.id
    WHERE tmr1.match_id IS NOT NULL
    GROUP BY tmr1.team_id, tmr1.tournament_stage_id
),
team_groups AS (
    -- Each team's group within the stage. Takes the winner-bracket group only
    -- (loser-bracket entries inherit a different `group` value in DE formats)
    -- and falls back to the lowest group number if a team appears in several.
    --
    -- Swiss stages encode win/loss records into `tournament_brackets.group`
    -- (0 = 0-0 pool, 100 = 1-0, 101 = 1-1, etc.), so each team appears in many
    -- "groups" across rounds. Swiss has no parallel pools, so we collapse the
    -- whole stage into a single group (1) and let the ranking sort everyone
    -- into one flat standings list ordered by wins.
    SELECT
        tb.team_id,
        tb.tournament_stage_id,
        CASE
            WHEN ts.type = 'Swiss' THEN 1
            ELSE MIN(tb.bracket_group)
        END as group_number
    FROM team_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.bracket_group IS NOT NULL
      AND tb.bracket_path = 'WB'
    GROUP BY tb.team_id, tb.tournament_stage_id, ts.type
),
stage_types AS (
    -- Stage type per stage, used to switch the ORDER BY to DE-aware ranking
    -- for DoubleElimination stages while leaving every other format on the
    -- existing wins-based chain.
    SELECT id AS tournament_stage_id, type AS stage_type
    FROM tournament_stages
),
team_elimination AS (
    -- DE-only: each team's single elimination point. A bracket eliminates its
    -- loser iff loser_parent_bracket_id IS NULL (true for LB matches and the
    -- Grand Final, never for pre-GF WB matches whose loser drops into LB).
    -- The champion has no row here; the GF loser has a row with path='WB' at
    -- the highest round; LB losers have rows at their LB round.
    SELECT DISTINCT ON (tmr.team_id, tmr.tournament_stage_id)
        tmr.team_id,
        tmr.tournament_stage_id,
        tb.path  AS elim_path,
        tb.round AS elim_round
    FROM team_match_results tmr
    JOIN tournament_brackets tb ON tb.id = tmr.bracket_id
    WHERE tmr.winning_lineup_id IS NOT NULL
      AND tmr.winning_lineup_id != tmr.team_lineup_id
      AND tb.loser_parent_bracket_id IS NULL
    ORDER BY tmr.team_id, tmr.tournament_stage_id, tb.round DESC
),
stage_rows AS (
    SELECT
        ass.team_id as tournament_team_id,
        ass.tournament_stage_id,
        COALESCE(ass.matches_played, 0)::int as matches_played,
        COALESCE(ass.matches_remaining, 0)::int as matches_remaining,
        COALESCE(ass.wins, 0)::int as wins,
        COALESCE(ass.losses, 0)::int as losses,
        COALESCE(ams.maps_won, 0)::int as maps_won,
        COALESCE(ams.maps_lost, 0)::int as maps_lost,
        COALESCE(ass.rounds_won, 0)::int as rounds_won,
        COALESCE(ass.rounds_lost, 0)::int as rounds_lost,
        COALESCE(tkd.total_kills, 0)::int as total_kills,
        COALESCE(tkd.total_deaths, 0)::int as total_deaths,
        CASE
            WHEN COALESCE(tkd.total_deaths, 0) > 0
            THEN (COALESCE(tkd.total_kills, 0)::float / tkd.total_deaths::float)
            ELSE COALESCE(tkd.total_kills, 0)::float
        END as team_kdr,
        COALESCE(hth_matches.head_to_head_match_wins, 0)::int as head_to_head_match_wins,
        COALESCE(hth_rounds.head_to_head_rounds_won, 0)::int as head_to_head_rounds_won,
        COALESCE(tg.group_number, 1)::int as group_number,
        st.stage_type,
        te.elim_path,
        te.elim_round
    FROM aggregated_stats ass
    LEFT JOIN team_kills_deaths tkd ON tkd.team_id = ass.team_id
        AND tkd.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN team_head_to_head_matches hth_matches ON hth_matches.team_id = ass.team_id
        AND hth_matches.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN team_head_to_head_rounds hth_rounds ON hth_rounds.team_id = ass.team_id
        AND hth_rounds.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN aggregated_map_stats ams ON ams.team_id = ass.team_id
        AND ams.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN team_groups tg ON tg.team_id = ass.team_id
        AND tg.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN stage_types st ON st.tournament_stage_id = ass.tournament_stage_id
    LEFT JOIN team_elimination te ON te.team_id = ass.team_id
        AND te.tournament_stage_id = ass.tournament_stage_id
)
-- Column order MUST keep the original 16 columns first (tournament_team_id ..
-- group_number) and `rank` next so existing consumers (UI, get_team_at_stage_rank)
-- keep working. `placement` is appended at the end for the trophy calculator.
SELECT
    sr.tournament_team_id,
    sr.tournament_stage_id,
    sr.matches_played,
    sr.matches_remaining,
    sr.wins,
    sr.losses,
    sr.maps_won,
    sr.maps_lost,
    sr.rounds_won,
    sr.rounds_lost,
    sr.total_kills,
    sr.total_deaths,
    sr.team_kdr,
    sr.head_to_head_match_wins,
    sr.head_to_head_rounds_won,
    sr.group_number,
    (ROW_NUMBER() OVER w)::int as rank,
    (RANK() OVER w)::int as placement
FROM stage_rows sr
WINDOW w AS (
    PARTITION BY sr.tournament_stage_id, sr.group_number
    ORDER BY
        -- DE only: still-alive teams sort above eliminated teams.
        CASE WHEN sr.stage_type = 'DoubleElimination'
             THEN (sr.elim_round IS NOT NULL)::int
             ELSE 0
        END ASC,
        -- DE only: GF (path='WB') above LB at equal round.
        CASE WHEN sr.stage_type = 'DoubleElimination' AND sr.elim_path = 'WB' THEN 1
             WHEN sr.stage_type = 'DoubleElimination' AND sr.elim_path = 'LB' THEN 0
             ELSE 0
        END DESC,
        -- DE only: later elimination round = better placement.
        CASE WHEN sr.stage_type = 'DoubleElimination'
             THEN sr.elim_round
             ELSE NULL
        END DESC NULLS FIRST,
        -- Existing tiebreaker chain — unchanged for RR/Swiss/SingleElim, and
        -- per-tier tiebreak for DE rows in the same elimination tier.
        sr.wins DESC,
        sr.head_to_head_match_wins DESC,
        sr.head_to_head_rounds_won DESC,
        CASE
            WHEN sr.maps_lost > 0
            THEN (sr.maps_won::float / sr.maps_lost::float)
            ELSE sr.maps_won::float
        END DESC,
        CASE
            WHEN sr.rounds_lost > 0
            THEN (sr.rounds_won::float / sr.rounds_lost::float)
            ELSE sr.rounds_won::float
        END DESC,
        sr.team_kdr DESC,
        -- Deterministic final tiebreaker so identical stats produce a stable
        -- ordering across calls (e.g. for OFFSET-based seeding in seed_stage).
        sr.tournament_team_id ASC
);
