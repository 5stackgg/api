DROP VIEW IF EXISTS v_player_elo;

CREATE OR REPLACE VIEW v_player_elo AS
SELECT 
    m.id AS match_id,
    mo."type" AS "type",
    m.created_at AS match_created_at,
    p.steam_id AS player_steam_id,
    p.name AS player_name,
    CASE 
        WHEN m.winning_lineup_id = mlp.match_lineup_id THEN 'win'
        ELSE 'loss'
    END AS match_result,
    -- Extract ELO data using LATERAL join for better performance
    (elo_data->>'current_elo')::INTEGER + (elo_data->>'elo_change')::INTEGER AS updated_elo,
    (elo_data->>'current_elo')::INTEGER AS current_elo,
    (elo_data->>'elo_change')::INTEGER AS elo_change,
    (elo_data->>'player_team_elo_avg')::FLOAT AS player_team_elo_avg,
    (elo_data->>'opponent_team_elo_avg')::FLOAT AS opponent_team_elo_avg,
    (elo_data->>'expected_score')::FLOAT AS expected_score,
    (elo_data->>'actual_score')::FLOAT AS actual_score,
    (elo_data->>'k_factor')::INTEGER AS k_factor,
    (elo_data->>'kills')::INTEGER AS kills,
    (elo_data->>'deaths')::INTEGER AS deaths,
    (elo_data->>'assists')::INTEGER AS assists,
    (elo_data->>'damage')::INTEGER AS damage,
    (elo_data->>'kda')::FLOAT AS kda,
    (elo_data->>'team_avg_kda')::FLOAT AS team_avg_kda,
    (elo_data->>'damage_percent')::FLOAT AS damage_percent,
    (elo_data->>'performance_multiplier')::FLOAT AS performance_multiplier
FROM 
    matches m
JOIN 
    match_lineup_players mlp ON (mlp.match_lineup_id = m.lineup_1_id OR mlp.match_lineup_id = m.lineup_2_id)
JOIN 
    players p ON p.steam_id = mlp.steam_id
JOIN 
    match_options mo ON mo.id = m.match_options_id
CROSS JOIN LATERAL 
    get_elo_for_match(m.id, p.steam_id) AS elo_data;