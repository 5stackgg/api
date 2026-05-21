ALTER TABLE public.player_elo
  ADD COLUMN IF NOT EXISTS actual_score             double precision,
  ADD COLUMN IF NOT EXISTS expected_score           double precision,
  ADD COLUMN IF NOT EXISTS k_factor                 integer,
  ADD COLUMN IF NOT EXISTS player_team_elo_avg      double precision,
  ADD COLUMN IF NOT EXISTS opponent_team_elo_avg    double precision,
  ADD COLUMN IF NOT EXISTS kills                    integer,
  ADD COLUMN IF NOT EXISTS deaths                   integer,
  ADD COLUMN IF NOT EXISTS assists                  integer,
  ADD COLUMN IF NOT EXISTS damage                   integer,
  ADD COLUMN IF NOT EXISTS kda                      double precision,
  ADD COLUMN IF NOT EXISTS team_avg_kda             double precision,
  ADD COLUMN IF NOT EXISTS damage_percent           double precision,
  ADD COLUMN IF NOT EXISTS performance_multiplier   double precision,
  ADD COLUMN IF NOT EXISTS map_wins                 integer,
  ADD COLUMN IF NOT EXISTS map_losses               integer,
  ADD COLUMN IF NOT EXISTS series_multiplier        integer;

-- Inlined from hasura/functions/match/match_player_elo.sql so this backfill
-- works on a fresh setup, before hasura/functions/ has been applied. The
-- functions/ step runs idempotently after migrations and will re-create this.
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

    _player_kills INTEGER;
    _player_deaths INTEGER;
    _player_assists INTEGER;
    _player_damage INTEGER;
    _team_total_kills INTEGER;
    _team_total_deaths INTEGER;
    _team_total_assists INTEGER;
    _team_total_damage INTEGER;
    _impact FLOAT;
    _performance_multiplier FLOAT;
    _player_kda FLOAT;
    _team_avg_kda FLOAT;
    _player_damage_percent FLOAT;
    match_type text;

    _player_map_wins INT := 0;
    _player_map_losses INT := 0;
    _series_multiplier INT := 1;
BEGIN
    SELECT "type" INTO match_type FROM match_options WHERE id = match_record.match_options_id;

    SELECT current INTO _current_player_elo
    FROM player_elo
    WHERE steam_id = player_record.steam_id
    AND created_at < match_record.ended_at
    AND match_id != match_record.id
    AND "type" = match_type
    ORDER BY created_at DESC
    LIMIT 1;

    if(_current_player_elo is null) then
        _current_player_elo := _default_elo;
    end if;

    SELECT mlp.match_lineup_id INTO _player_lineup_id
    FROM match_lineup_players mlp
    WHERE mlp.steam_id = player_record.steam_id
    AND mlp.match_lineup_id IN (match_record.lineup_1_id, match_record.lineup_2_id)
    LIMIT 1;

    IF _player_lineup_id = match_record.lineup_1_id THEN
        _opponent_lineup_id := match_record.lineup_2_id;
    ELSE
        _opponent_lineup_id := match_record.lineup_1_id;
    END IF;

    SELECT
        COUNT(*) FILTER (WHERE mm.winning_lineup_id = _player_lineup_id),
        COUNT(*) FILTER (WHERE mm.winning_lineup_id = _opponent_lineup_id)
    INTO _player_map_wins, _player_map_losses
    FROM match_maps mm
    WHERE mm.match_id = match_record.id
      AND mm.winning_lineup_id IS NOT NULL;

    _series_multiplier := GREATEST(ABS(_player_map_wins - _player_map_losses), 1);

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
                    AND pr2."type" = match_type
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
                    AND pr2."type" = match_type
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

    _player_kda := (_player_kills + _player_assists)::FLOAT / GREATEST(_player_deaths, 1)::FLOAT;

    _team_avg_kda := (_team_total_kills + _team_total_assists)::FLOAT / GREATEST(_team_total_deaths, 1)::FLOAT;

    _player_damage_percent := CASE
        WHEN _team_total_damage > 0 THEN _player_damage::FLOAT / _team_total_damage::FLOAT
        ELSE 0
    END;

    _impact := 1.0 +
        (0.1 * (_player_kda / GREATEST(_team_avg_kda, 0.1) - 1.0)) +
        (0.1 * (_player_damage_percent - 0.2));
    _impact := GREATEST(0.8, LEAST(1.2, _impact));

    _performance_multiplier := _impact;

    _expected_score := 1.0 / (1.0 + POWER(10.0, (_opponent_team_elo_avg - _player_team_elo_avg) / _scale_factor));

    IF match_record.winning_lineup_id = _player_lineup_id THEN
        _actual_score := 1.0;
    ELSE
        _actual_score := 0.0;
        _performance_multiplier := 0.9 - 2.125 * (_performance_multiplier - 0.8);
        _performance_multiplier := GREATEST(0.05, LEAST(1.0, _performance_multiplier));
    END IF;

    _elo_change := ROUND(_k_factor * (_actual_score - _expected_score) * _performance_multiplier * _series_multiplier);

    RETURN jsonb_build_object(
        'current_elo', _current_player_elo,
        'elo_change', _elo_change,
        'player_team_elo_avg', _player_team_elo_avg,
        'opponent_team_elo_avg', _opponent_team_elo_avg,
        'expected_score', _expected_score,
        'actual_score', _actual_score,
        'k_factor', _k_factor,
        'kills', _player_kills,
        'deaths', _player_deaths,
        'assists', _player_assists,
        'damage', _player_damage,
        'kda', _player_kda::FLOAT,
        'team_avg_kda', _team_avg_kda::FLOAT,
        'damage_percent', _player_damage_percent,
        'impact', _impact,
        'performance_multiplier', _performance_multiplier,
        'map_wins', _player_map_wins,
        'map_losses', _player_map_losses,
        'series_multiplier', _series_multiplier
    );
END;
$$ LANGUAGE plpgsql STABLE;

WITH calc AS (
  SELECT
    pe.steam_id,
    pe.match_id,
    pe."type",
    public.get_player_elo_for_match(m, p) AS elo_data
  FROM public.player_elo pe
  JOIN public.matches m ON m.id = pe.match_id
  JOIN public.players p ON p.steam_id = pe.steam_id
  WHERE pe.kills IS NULL
)
UPDATE public.player_elo pe
SET
  actual_score           = (calc.elo_data->>'actual_score')::double precision,
  expected_score         = (calc.elo_data->>'expected_score')::double precision,
  k_factor               = (calc.elo_data->>'k_factor')::integer,
  player_team_elo_avg    = (calc.elo_data->>'player_team_elo_avg')::double precision,
  opponent_team_elo_avg  = (calc.elo_data->>'opponent_team_elo_avg')::double precision,
  kills                  = (calc.elo_data->>'kills')::integer,
  deaths                 = (calc.elo_data->>'deaths')::integer,
  assists                = (calc.elo_data->>'assists')::integer,
  damage                 = (calc.elo_data->>'damage')::integer,
  kda                    = (calc.elo_data->>'kda')::double precision,
  team_avg_kda           = (calc.elo_data->>'team_avg_kda')::double precision,
  damage_percent         = (calc.elo_data->>'damage_percent')::double precision,
  performance_multiplier = (calc.elo_data->>'performance_multiplier')::double precision,
  map_wins               = (calc.elo_data->>'map_wins')::integer,
  map_losses             = (calc.elo_data->>'map_losses')::integer,
  series_multiplier      = (calc.elo_data->>'series_multiplier')::integer
FROM calc
WHERE pe.steam_id = calc.steam_id
  AND pe.match_id = calc.match_id
  AND pe."type"   = calc."type";
