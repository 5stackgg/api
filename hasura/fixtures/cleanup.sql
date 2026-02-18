-- Cleanup fixture data
-- Removes all fixture data inserted by fixtures.sql
-- Fixture players use steam_ids 76561198000000001 through 76561198000000040

DO $$
DECLARE
  fixture_steam_ids bigint[] := ARRAY(SELECT generate_series(76561198000000001::bigint, 76561198000000040::bigint));
  fixture_team_ids uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'a0000000-0000-0000-0000-000000000002'::uuid,
    'a0000000-0000-0000-0000-000000000003'::uuid,
    'a0000000-0000-0000-0000-000000000004'::uuid,
    'a0000000-0000-0000-0000-000000000005'::uuid,
    'a0000000-0000-0000-0000-000000000006'::uuid,
    'a0000000-0000-0000-0000-000000000007'::uuid,
    'a0000000-0000-0000-0000-000000000008'::uuid
  ];
  fixture_tournament_ids uuid[] := ARRAY[
    'b0000000-0000-0000-0000-000000000001'::uuid,
    'b0000000-0000-0000-0000-000000000002'::uuid,
    'b0000000-0000-0000-0000-000000000003'::uuid,
    'b0000000-0000-0000-0000-000000000004'::uuid
  ];
  match_ids uuid[];
BEGIN
  -- Collect all match IDs that belong to fixture lineups
  SELECT ARRAY(
    SELECT DISTINCT m.id FROM matches m
    JOIN match_lineups ml ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
    WHERE ml.team_id = ANY(fixture_team_ids)
  ) INTO match_ids;

  -- If no matches found, also check for matches with fixture players in lineups
  IF match_ids IS NULL OR array_length(match_ids, 1) IS NULL THEN
    SELECT ARRAY(
      SELECT DISTINCT m.id FROM matches m
      JOIN match_lineups ml ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
      JOIN match_lineup_players mlp ON mlp.match_lineup_id = ml.id
      WHERE mlp.steam_id = ANY(fixture_steam_ids)
    ) INTO match_ids;
  END IF;

  IF match_ids IS NOT NULL AND array_length(match_ids, 1) > 0 THEN
    -- Disable triggers to avoid errors from Hasura session vars
    -- Note: hypertables (player_kills, player_damages, player_assists, player_flashes,
    --        player_objectives, player_utility) don't support DISABLE TRIGGER
    ALTER TABLE player_unused_utility DISABLE TRIGGER ALL;
    ALTER TABLE match_map_rounds DISABLE TRIGGER ALL;
    ALTER TABLE match_maps DISABLE TRIGGER ALL;
    ALTER TABLE match_lineup_players DISABLE TRIGGER ALL;
    ALTER TABLE matches DISABLE TRIGGER ALL;
    ALTER TABLE match_lineups DISABLE TRIGGER ALL;
    ALTER TABLE match_options DISABLE TRIGGER ALL;
    ALTER TABLE match_map_veto_picks DISABLE TRIGGER ALL;

    -- Delete player event data
    DELETE FROM player_kills WHERE match_id = ANY(match_ids);
    DELETE FROM player_damages WHERE match_id = ANY(match_ids);
    DELETE FROM player_assists WHERE match_id = ANY(match_ids);
    DELETE FROM player_flashes WHERE match_id = ANY(match_ids);
    DELETE FROM player_objectives WHERE match_id = ANY(match_ids);
    DELETE FROM player_unused_utility WHERE match_id = ANY(match_ids);
    DELETE FROM player_utility WHERE match_id = ANY(match_ids);

    -- Delete map veto picks
    DELETE FROM match_map_veto_picks WHERE match_id = ANY(match_ids);

    -- Delete match map data
    DELETE FROM match_map_rounds WHERE match_map_id IN (
      SELECT id FROM match_maps WHERE match_id = ANY(match_ids)
    );
    DELETE FROM match_maps WHERE match_id = ANY(match_ids);

    -- Delete match lineup players
    DELETE FROM match_lineup_players WHERE match_lineup_id IN (
      SELECT ml.id FROM match_lineups ml
      JOIN matches m ON (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
      WHERE m.id = ANY(match_ids)
    );

    -- Collect lineup and option IDs before deleting matches
    DECLARE
      lineup_ids uuid[];
      option_ids uuid[];
    BEGIN
      SELECT ARRAY(
        SELECT DISTINCT unnest(ARRAY[m.lineup_1_id, m.lineup_2_id])
        FROM matches m WHERE m.id = ANY(match_ids)
      ) INTO lineup_ids;

      SELECT ARRAY(
        SELECT DISTINCT m.match_options_id
        FROM matches m WHERE m.id = ANY(match_ids) AND m.match_options_id IS NOT NULL
      ) INTO option_ids;

      -- Delete matches
      DELETE FROM matches WHERE id = ANY(match_ids);

      -- Delete lineups
      DELETE FROM match_lineups WHERE id = ANY(lineup_ids);

      -- Delete match options (only fixture-created ones)
      DELETE FROM match_options WHERE id = ANY(option_ids);
    END;

    -- Re-enable triggers (excluding hypertables)
    ALTER TABLE player_unused_utility ENABLE TRIGGER ALL;
    ALTER TABLE match_map_rounds ENABLE TRIGGER ALL;
    ALTER TABLE match_maps ENABLE TRIGGER ALL;
    ALTER TABLE match_lineup_players ENABLE TRIGGER ALL;
    ALTER TABLE matches ENABLE TRIGGER ALL;
    ALTER TABLE match_lineups ENABLE TRIGGER ALL;
    ALTER TABLE match_options ENABLE TRIGGER ALL;
    ALTER TABLE match_map_veto_picks ENABLE TRIGGER ALL;
  END IF;

  -- Delete tournament data
  ALTER TABLE tournament_brackets DISABLE TRIGGER ALL;
  ALTER TABLE tournament_team_roster DISABLE TRIGGER ALL;
  ALTER TABLE tournament_teams DISABLE TRIGGER ALL;
  ALTER TABLE tournament_stages DISABLE TRIGGER ALL;
  ALTER TABLE tournaments DISABLE TRIGGER ALL;

  DELETE FROM tournament_brackets WHERE tournament_stage_id IN (
    SELECT id FROM tournament_stages WHERE tournament_id = ANY(fixture_tournament_ids)
  );
  DELETE FROM tournament_team_roster WHERE tournament_id = ANY(fixture_tournament_ids);
  DELETE FROM tournament_teams WHERE tournament_id = ANY(fixture_tournament_ids);
  DELETE FROM tournament_stages WHERE tournament_id = ANY(fixture_tournament_ids);
  DELETE FROM tournaments WHERE id = ANY(fixture_tournament_ids);

  ALTER TABLE tournament_brackets ENABLE TRIGGER ALL;
  ALTER TABLE tournament_team_roster ENABLE TRIGGER ALL;
  ALTER TABLE tournament_teams ENABLE TRIGGER ALL;
  ALTER TABLE tournament_stages ENABLE TRIGGER ALL;
  ALTER TABLE tournaments ENABLE TRIGGER ALL;

  -- Delete season data for fixture players/seasons
  DELETE FROM player_elo WHERE steam_id = ANY(fixture_steam_ids);
  DELETE FROM player_season_stats WHERE player_steam_id = ANY(fixture_steam_ids);
  DELETE FROM seasons WHERE id IN (
    'c0000000-0000-0000-0000-000000000001'::uuid,
    'c0000000-0000-0000-0000-000000000002'::uuid,
    'c0000000-0000-0000-0000-000000000003'::uuid
  );

  -- Delete player stats for fixture players
  DELETE FROM player_stats WHERE player_steam_id = ANY(fixture_steam_ids);
  DELETE FROM player_kills_by_weapon WHERE player_steam_id = ANY(fixture_steam_ids);

  -- Delete team roster and teams
  ALTER TABLE team_roster DISABLE TRIGGER ALL;
  ALTER TABLE teams DISABLE TRIGGER ALL;

  DELETE FROM team_roster WHERE team_id = ANY(fixture_team_ids);
  DELETE FROM teams WHERE id = ANY(fixture_team_ids);

  ALTER TABLE team_roster ENABLE TRIGGER ALL;
  ALTER TABLE teams ENABLE TRIGGER ALL;

  -- Delete fixture players
  ALTER TABLE players DISABLE TRIGGER ALL;
  DELETE FROM players WHERE steam_id = ANY(fixture_steam_ids);
  ALTER TABLE players ENABLE TRIGGER ALL;

  -- Remove the settings flag
  DELETE FROM settings WHERE name = 'dev.fixtures_loaded';
END $$;
