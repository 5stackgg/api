-- Tracks: matches played, matches remaining, wins, losses, rounds won, rounds lost
CREATE OR REPLACE VIEW public.v_team_stage_results AS
WITH team_brackets AS (
    -- Get all brackets for each team in each stage
    SELECT 
        tb.tournament_team_id_1 as team_id,
        tb.tournament_stage_id,
        tb.id as bracket_id,
        tb.match_id,
        tb.bye,
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
)
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
    COALESCE(hth_rounds.head_to_head_rounds_won, 0)::int as head_to_head_rounds_won
FROM aggregated_stats ass
LEFT JOIN team_kills_deaths tkd ON tkd.team_id = ass.team_id 
    AND tkd.tournament_stage_id = ass.tournament_stage_id
LEFT JOIN team_head_to_head_matches hth_matches ON hth_matches.team_id = ass.team_id 
    AND hth_matches.tournament_stage_id = ass.tournament_stage_id
LEFT JOIN team_head_to_head_rounds hth_rounds ON hth_rounds.team_id = ass.team_id 
    AND hth_rounds.tournament_stage_id = ass.tournament_stage_id
LEFT JOIN aggregated_map_stats ams ON ams.team_id = ass.team_id 
    AND ams.tournament_stage_id = ass.tournament_stage_id
ORDER BY 
    ass.wins DESC,
    COALESCE(hth_matches.head_to_head_match_wins, 0) DESC,
    COALESCE(hth_rounds.head_to_head_rounds_won, 0) DESC,
    CASE 
        WHEN COALESCE(ams.maps_lost, 0) > 0 
        THEN (COALESCE(ams.maps_won, 0)::float / ams.maps_lost::float)
        ELSE COALESCE(ams.maps_won, 0)::float
    END DESC,
    CASE 
        WHEN COALESCE(ass.rounds_lost, 0) > 0 
        THEN (COALESCE(ass.rounds_won, 0)::float / ass.rounds_lost::float)
        ELSE COALESCE(ass.rounds_won, 0)::float
    END DESC,
    CASE 
        WHEN COALESCE(tkd.total_deaths, 0) > 0 
        THEN (COALESCE(tkd.total_kills, 0)::float / tkd.total_deaths::float)
        ELSE COALESCE(tkd.total_kills, 0)::float
    END DESC;