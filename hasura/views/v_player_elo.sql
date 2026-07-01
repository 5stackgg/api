DROP VIEW IF EXISTS v_player_elo;

CREATE OR REPLACE VIEW v_player_elo AS
SELECT
    pe.match_id,
    pe."type",
    m.created_at AS match_created_at,
    pe.steam_id AS player_steam_id,
    p.name AS player_name,
    pe.season_id AS season_id,
    CASE WHEN pe.actual_score = 1.0 THEN 'win' ELSE 'loss' END AS match_result,
    pe.current::INTEGER AS updated_elo,
    (pe.current - pe.change)::INTEGER AS current_elo,
    pe.change::INTEGER AS elo_change,
    pe.player_team_elo_avg,
    pe.opponent_team_elo_avg,
    pe.expected_score,
    pe.actual_score,
    pe.k_factor,
    pe.kills,
    pe.deaths,
    pe.assists,
    pe.damage,
    pe.kda,
    pe.team_avg_kda,
    pe.damage_percent,
    pe.impact::FLOAT AS impact,
    pe.performance_multiplier,
    pe.map_wins,
    pe.map_losses,
    pe.series_multiplier
FROM
    player_elo pe
JOIN
    matches m ON m.id = pe.match_id
JOIN
    players p ON p.steam_id = pe.steam_id;
