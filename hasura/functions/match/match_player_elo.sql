CREATE OR REPLACE FUNCTION player_elo_for_match(
    match_record public.matches,
    hasura_session json
) RETURNS JSONB AS $$
DECLARE
    player_record public.players;
BEGIN
    SELECT * INTO player_record
    FROM players
    WHERE steam_id = hasura_session->>'x-hasura-user-id'
    LIMIT 1;

    IF player_record IS NULL THEN
        RAISE EXCEPTION 'Player not found for steam_id: %', hasura_session->>'x-hasura-user-id';
    END IF;

   RETURN get_player_elo_for_match(match_record, player_record);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_player_elo_for_match(
    match_record public.matches,
    player_record public.players
) RETURNS JSONB AS $$
DECLARE
    _current_player_elo INTEGER;
    _player_team_elo_avg FLOAT;
    _opponent_team_elo_avg FLOAT;
    _player_lineup_id UUID;
    _opponent_lineup_id UUID;
    _k_factor INTEGER := 500;
    _expected_score FLOAT;
    _actual_score FLOAT;
    _elo_change INTEGER;
    _scale_factor INTEGER := 4000;
    _default_elo INTEGER := 5000;
    
    -- Performance metrics
    _player_kills INTEGER;
    _player_deaths INTEGER;
    _player_assists INTEGER;
    _player_damage INTEGER;
    _team_total_kills INTEGER;
    _team_total_deaths INTEGER;
    _team_total_assists INTEGER;
    _team_total_damage INTEGER;
    _performance_multiplier FLOAT;
    _player_kda FLOAT;
    _team_avg_kda FLOAT;
    _player_damage_percent FLOAT;
BEGIN
    -- Get the player's current ELO value from the most recent record
    SELECT current INTO _current_player_elo
    FROM player_elo 
    WHERE steam_id = player_record.steam_id
    AND created_at < match_record.ended_at
    AND match_id != match_record.id
    ORDER BY created_at DESC
    LIMIT 1;

    if(_current_player_elo is null) then
        _current_player_elo := _default_elo;
    end if;

    -- Determine which lineup the player is in
    SELECT mlp.match_lineup_id INTO _player_lineup_id
    FROM match_lineup_players mlp
    WHERE mlp.steam_id = player_record.steam_id
    AND (mlp.match_lineup_id = match_record.lineup_1_id OR mlp.match_lineup_id = match_record.lineup_2_id)
    LIMIT 1;

    IF _player_lineup_id = match_record.lineup_1_id THEN
        _opponent_lineup_id := match_record.lineup_2_id;
    ELSE
        _opponent_lineup_id := match_record.lineup_1_id;
    END IF;

    -- Calculate average ELO for player's team
    -- First get the sum of all previous ELO changes for each player in the team
    SELECT 
        AVG(player_elo) INTO _player_team_elo_avg
    FROM (
        SELECT 
            mlp.steam_id,
            COALESCE(
                (
                    SELECT current 
                    FROM player_elo pr2 
                    WHERE pr2.steam_id = mlp.steam_id
                    AND pr2.created_at < match_record.ended_at
                    AND pr2.match_id != match_record.id
                    ORDER BY pr2.created_at DESC
                    LIMIT 1
                ), _default_elo
            ) AS player_elo
        FROM 
            match_lineup_players mlp
        WHERE 
            mlp.match_lineup_id = _player_lineup_id
        GROUP BY 
            mlp.steam_id
    ) AS team_elos;

    -- Calculate average ELO for opponent's team
    -- First get the sum of all previous ELO changes for each player in the team
    SELECT 
        AVG(player_elo) INTO _opponent_team_elo_avg
    FROM (
        SELECT 
            mlp.steam_id,
            COALESCE(
                (
                    SELECT current 
                    FROM player_elo pr2 
                    WHERE pr2.steam_id = mlp.steam_id
                    AND pr2.created_at < match_record.ended_at
                    AND pr2.match_id != match_record.id
                    ORDER BY pr2.created_at DESC
                    LIMIT 1
                ), _default_elo
            ) AS player_elo
        FROM 
            match_lineup_players mlp
        WHERE 
            mlp.match_lineup_id = _opponent_lineup_id
        GROUP BY 
            mlp.steam_id
    ) AS team_elos;

    -- Get player's performance metrics
    SELECT COUNT(*) INTO _player_kills
    FROM player_kills 
    WHERE match_id = match_record.id AND attacker_steam_id = player_record.steam_id;
    
    SELECT COUNT(*) INTO _player_deaths
    FROM player_kills 
    WHERE match_id = match_record.id AND attacked_steam_id = player_record.steam_id;
    
    SELECT COUNT(*) INTO _player_assists
    FROM player_assists 
    WHERE match_id = match_record.id AND attacker_steam_id = player_record.steam_id;
    
    SELECT COALESCE(SUM(damage), 0) INTO _player_damage
    FROM player_damages 
    WHERE match_id = match_record.id AND attacker_steam_id = player_record.steam_id AND attacker_steam_id IS NOT NULL;
    
    -- Get team's total performance metrics
    SELECT COUNT(*) INTO _team_total_kills
    FROM player_kills pk
    JOIN match_lineup_players mlp ON pk.attacker_steam_id = mlp.steam_id
    WHERE pk.match_id = match_record.id AND mlp.match_lineup_id = _player_lineup_id;
    
    SELECT COUNT(*) INTO _team_total_deaths
    FROM player_kills pk
    JOIN match_lineup_players mlp ON pk.attacked_steam_id = mlp.steam_id
    WHERE pk.match_id = match_record.id AND mlp.match_lineup_id = _player_lineup_id;
    
    SELECT COUNT(*) INTO _team_total_assists
    FROM player_assists pa
    JOIN match_lineup_players mlp ON pa.attacker_steam_id = mlp.steam_id
    WHERE pa.match_id = match_record.id AND mlp.match_lineup_id = _player_lineup_id;
    
    SELECT COALESCE(SUM(pd.damage), 0) INTO _team_total_damage
    FROM player_damages pd
    JOIN match_lineup_players mlp ON pd.attacker_steam_id = mlp.steam_id
    WHERE pd.match_id = match_record.id AND mlp.match_lineup_id = _player_lineup_id AND pd.attacker_steam_id IS NOT NULL;
    
    -- Calculate player's KDA (Kills + Assists / Deaths, with a minimum of 1 death to avoid division by zero)
    _player_kda := (_player_kills + _player_assists)::FLOAT / GREATEST(_player_deaths, 1)::FLOAT;
    
    -- Calculate team's average KDA
    _team_avg_kda := (_team_total_kills + _team_total_assists)::FLOAT / GREATEST(_team_total_deaths, 1)::FLOAT;
    
    -- Calculate player's damage percentage
    _player_damage_percent := CASE 
        WHEN _team_total_damage > 0 THEN _player_damage::FLOAT / _team_total_damage::FLOAT
        ELSE 0
    END;
    
    -- Calculate performance multiplier based on KDA ratio and damage percentage
    -- This will be a value between 0.8 and 1.2, with 1.0 being average performance
    _performance_multiplier := 1.0 + 
        (0.1 * (_player_kda / GREATEST(_team_avg_kda, 0.1) - 1.0)) + 
        (0.1 * (_player_damage_percent - 0.2)); -- Assuming 20% damage is average for a 5-player team
    
    -- Ensure the multiplier stays within reasonable bounds
    _performance_multiplier := GREATEST(0.8, LEAST(1.2, _performance_multiplier));

    -- Calculate the expected score based on team ELO averages
    -- ELO formula: Expected Score = 1 / (1 + 10^((Opponent Rating - Player Rating) / Scale Factor))
    -- The scale factor (4000) is increased for a wider ELO range:
    -- - A difference of 4000 points means the stronger player is expected to win 10 times more often
    -- - A difference of 2000 points means the stronger player is expected to win 3 times more often
    -- - A difference of 1000 points means the stronger player is expected to win 1.6 times more often
    -- This allows for a much wider range of ratings (0-50,000+) with 28,000 being expert level
    _expected_score := 1.0 / (1.0 + POWER(10.0, (_opponent_team_elo_avg - _player_team_elo_avg) / _scale_factor));

    -- Determine the actual score based on match result
    -- 1.0 for a win, 0.0 for a loss
    IF match_record.winning_lineup_id = _player_lineup_id THEN
        _actual_score := 1.0;
    ELSE
        _actual_score := 0.0;
        -- On losses, invert and scale the performance multiplier to protect good performers
        -- This linear transformation maps the original multiplier (0.8 to 1.2) to a loss reduction multiplier:
        -- This creates a linear inverse relationship where better performance = less ELO loss
        _performance_multiplier := 0.9 - 2.125 * (_performance_multiplier - 0.8);
        _performance_multiplier := GREATEST(0.05, LEAST(1.0, _performance_multiplier));
    END IF;

    -- Calculate the elo change (round to nearest integer)
    -- ELO change formula: New Rating = Old Rating + K * (Actual Score - Expected Score) * Performance Multiplier
    _elo_change := ROUND(_k_factor * (_actual_score - _expected_score) * _performance_multiplier);

    -- Return the elo change as JSON with detailed information
    RETURN jsonb_build_object(
        'current_elo', _current_player_elo, -- The current ELO rating of the player (including base ELO)
        'elo_change', _elo_change, -- The change in ELO rating for the player after the match
        'player_team_elo_avg', _player_team_elo_avg, -- The average ELO rating of the player's team before the match
        'opponent_team_elo_avg', _opponent_team_elo_avg, -- The average ELO rating of the opponent's team before the match
        'expected_score', _expected_score, -- The expected score for the player's team based on ELO ratings
        'actual_score', _actual_score, -- The actual score for the player's team based on the match result
        'k_factor', _k_factor, -- The K-factor used in the calculation
        'kills', _player_kills,
        'deaths', _player_deaths,
        'assists', _player_assists,
        'damage', _player_damage,
        'kda', _player_kda::FLOAT,
        'team_avg_kda', _team_avg_kda::FLOAT,
        'damage_percent', _player_damage_percent,
        'performance_multiplier', _performance_multiplier
    );
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION public.get_elo_for_match(
    match_id UUID,
    input_steam_id BIGINT
) RETURNS JSONB AS $$
DECLARE
    match_record public.matches;
    player_record public.players;
BEGIN
    -- Fetch match record
    SELECT * INTO match_record FROM matches WHERE id = match_id;

    IF match_record IS NULL THEN
        RAISE EXCEPTION 'Match with ID % not found', match_id;
    END IF;
    
    -- Skip matches without a winning_lineup_id
    IF match_record.winning_lineup_id IS NULL THEN
        RAISE NOTICE 'Skipping match % as it has no winning_lineup_id', match_id;
        RETURN 0;
    END IF;

    -- Fetch player record
    SELECT * INTO player_record FROM players WHERE players.steam_id = input_steam_id;

    -- Call the existing function to calculate elo change
    RETURN get_player_elo_for_match(match_record, player_record);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_player_elo_for_match(_match_id UUID) RETURNS INTEGER AS $$
DECLARE
    match_record public.matches;
    player_record public.players;
    elo_data JSONB;
    elo_change INTEGER;
    current_elo INTEGER;
    new_elo INTEGER;
    ratings_created INTEGER := 0;
BEGIN
    -- Get the match record
    SELECT * INTO match_record FROM matches WHERE id = _match_id;
    
    IF match_record IS NULL THEN
        RAISE EXCEPTION 'Match with ID % not found', _match_id;
    END IF;
    
    -- Skip matches without a winning_lineup_id
    IF match_record.winning_lineup_id IS NULL THEN
        RAISE NOTICE 'Skipping match % as it has no winning_lineup_id', _match_id;
        RETURN 0;
    END IF;
    
    -- Delete any existing ratings for this match to avoid duplicates
    DELETE FROM player_elo WHERE match_id = _match_id;
    
    -- Get all players in this match
    FOR player_record IN
        SELECT DISTINCT p.* 
        FROM players p
        JOIN match_lineup_players mlp ON p.steam_id = mlp.steam_id
        WHERE mlp.match_lineup_id = match_record.lineup_1_id 
           OR mlp.match_lineup_id = match_record.lineup_2_id
    LOOP
        -- Calculate ELO change for this player in this match
        elo_data := get_player_elo_for_match(match_record, player_record);
        
        -- Validate that we got valid data back
        IF elo_data IS NULL THEN
            RAISE NOTICE 'Skipping player % for match % - elo_data is null', player_record.steam_id, _match_id;
            CONTINUE;
        END IF;
        
        -- Extract values with null checks
        elo_change := COALESCE((elo_data->>'elo_change')::INTEGER, 0);
        current_elo := COALESCE((elo_data->>'current_elo')::INTEGER, 5000); -- Default ELO if null
        new_elo := current_elo + elo_change;
        
        -- Validate the calculated values
        IF current_elo IS NULL OR elo_change IS NULL OR new_elo IS NULL THEN
            RAISE NOTICE 'Skipping player % for match % - invalid elo values (current: %, change: %, new: %)', 
                player_record.steam_id, _match_id, current_elo, elo_change, new_elo;
            CONTINUE;
        END IF;

        INSERT INTO player_elo (
            match_id,
            steam_id,
            current,
            change,
            created_at
        ) VALUES (
            match_record.id,
            player_record.steam_id,
            new_elo,
            elo_change,
            match_record.ended_at
        );
        
        ratings_created := ratings_created + 1;
    END LOOP;
    
    RETURN ratings_created;
END;
$$ LANGUAGE plpgsql;
