CREATE OR REPLACE VIEW public.v_player_map_losses AS
    SELECT mlp.steam_id, m.id AS match_id, mm.id AS map_id, mm.started_at
    FROM match_lineup_players mlp
        INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
        INNER JOIN matches m ON m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id
        INNER JOIN match_maps mm ON mm.match_id = m.id AND mm.winning_lineup_id != ml.id
    WHERE mm.status = 'Finished'