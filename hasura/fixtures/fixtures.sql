-- Dev Fixture Data
-- Inserts ~30 players, 6 teams, ~100 matches with scores, and 3 tournaments
-- This file is idempotent: running cleanup.sql first removes prior fixture data

-- Disable triggers on affected tables (excluding hypertables which don't support this)
-- Hypertables: player_kills, player_damages, player_assists, player_flashes,
--              player_objectives, player_utility, player_sanctions
ALTER TABLE players DISABLE TRIGGER ALL;
ALTER TABLE teams DISABLE TRIGGER ALL;
ALTER TABLE team_roster DISABLE TRIGGER ALL;
ALTER TABLE match_options DISABLE TRIGGER ALL;
ALTER TABLE match_lineups DISABLE TRIGGER ALL;
ALTER TABLE matches DISABLE TRIGGER ALL;
ALTER TABLE match_lineup_players DISABLE TRIGGER ALL;
ALTER TABLE match_maps DISABLE TRIGGER ALL;
ALTER TABLE match_map_rounds DISABLE TRIGGER ALL;
ALTER TABLE player_stats DISABLE TRIGGER ALL;
ALTER TABLE player_kills_by_weapon DISABLE TRIGGER ALL;
ALTER TABLE tournaments DISABLE TRIGGER ALL;
ALTER TABLE tournament_stages DISABLE TRIGGER ALL;
ALTER TABLE tournament_teams DISABLE TRIGGER ALL;
ALTER TABLE tournament_team_roster DISABLE TRIGGER ALL;
ALTER TABLE tournament_brackets DISABLE TRIGGER ALL;

DO $$
DECLARE
  -- Player data
  p_steam_ids bigint[] := ARRAY(SELECT generate_series(76561198000000001::bigint, 76561198000000030::bigint));
  p_names text[] := ARRAY[
    'AceHunter', 'BlazeMaster', 'ColdShot', 'DarkRifle', 'EagleEye',
    'FlashPoint', 'GhostAim', 'HawkSnipe', 'IceNerve', 'JoltFrag',
    'KnifeEdge', 'LightningBolt', 'MidControl', 'NightOwl', 'OmegaPush',
    'PeakForm', 'QuickScope', 'RushKing', 'SmokeWall', 'TacticalMind',
    'UpperHand', 'VenomStrike', 'WallBanger', 'XenonFlash', 'YoloRush',
    'ZenAim', 'AlphaFrag', 'BravoPeek', 'CharlieHold', 'DeltaPush'
  ];
  p_countries text[] := ARRAY[
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL',
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL',
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL'
  ];

  -- Team data
  team_ids uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'a0000000-0000-0000-0000-000000000002'::uuid,
    'a0000000-0000-0000-0000-000000000003'::uuid,
    'a0000000-0000-0000-0000-000000000004'::uuid,
    'a0000000-0000-0000-0000-000000000005'::uuid,
    'a0000000-0000-0000-0000-000000000006'::uuid
  ];
  team_names text[] := ARRAY['Astra Force', 'Blitz Brigade', 'Crimson Wolves', 'Dark Phoenix', 'Echo Storm', 'Frost Giants'];
  team_short text[] := ARRAY['AST', 'BLZ', 'CRW', 'DPX', 'ECH', 'FRG'];

  -- Tournament data
  tournament_ids uuid[] := ARRAY[
    'b0000000-0000-0000-0000-000000000001'::uuid,
    'b0000000-0000-0000-0000-000000000002'::uuid,
    'b0000000-0000-0000-0000-000000000003'::uuid
  ];

  -- Working variables
  i int;
  j int;
  k int;
  t int;
  comp_map_pool_id uuid;
  map_ids uuid[];
  map_count int;

  match_idx int;
  match_status text;
  match_id uuid;
  match_options_id uuid;
  lineup_1_id uuid;
  lineup_2_id uuid;
  team_1_idx int;
  team_2_idx int;
  match_map_id uuid;
  cur_map_id uuid;
  match_date timestamptz;

  round_num int;
  total_rounds int;
  l1_score int;
  l2_score int;
  winning_side text;
  sides text[] := ARRAY['CT', 'TERRORIST'];

  weapons text[] := ARRAY['ak47', 'awp', 'm4a1_silencer', 'deagle', 'usp_silencer', 'glock', 'famas', 'galil', 'mp9', 'mac10'];
  hitgroups text[] := ARRAY['head', 'chest', 'stomach', 'left_arm', 'right_arm', 'left_leg', 'right_leg'];
  weapon_idx int;
  kill_time timestamptz;
  attacker_idx int;
  attacked_idx int;
  is_headshot boolean;

  -- Stats tracking
  kill_counts int[];
  death_counts int[];
  headshot_counts int[];
  weapon_kill_map jsonb;

  -- Tournament working variables
  tourn_stage_id uuid;
  tourn_team_ids uuid[];
  bracket_id uuid;
  bracket_match_id uuid;

BEGIN
  -- ==========================================
  -- 1. INSERT PLAYERS
  -- ==========================================
  FOR i IN 1..30 LOOP
    INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
    VALUES (
      p_steam_ids[i],
      p_names[i],
      'https://steamcommunity.com/profiles/' || p_steam_ids[i],
      'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
      'user',
      p_countries[i],
      true,
      now() - interval '90 days'
    )
    ON CONFLICT (steam_id) DO UPDATE SET name = EXCLUDED.name;
  END LOOP;

  -- ==========================================
  -- 2. INSERT TEAMS (5 players each)
  -- ==========================================
  FOR t IN 1..6 LOOP
    INSERT INTO teams (id, name, short_name, owner_steam_id)
    VALUES (
      team_ids[t],
      team_names[t],
      team_short[t],
      p_steam_ids[(t - 1) * 5 + 1]
    )
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

    FOR j IN 1..5 LOOP
      INSERT INTO team_roster (player_steam_id, team_id, role, status)
      VALUES (
        p_steam_ids[(t - 1) * 5 + j],
        team_ids[t],
        CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END,
        'Starter'
      )
      ON CONFLICT (player_steam_id, team_id) DO NOTHING;
    END LOOP;
  END LOOP;

  -- ==========================================
  -- 3. FIND COMPETITIVE MAP POOL
  -- ==========================================
  SELECT id INTO comp_map_pool_id
  FROM map_pools
  WHERE type = 'Competitive' AND seed = true AND enabled = true
  LIMIT 1;

  IF comp_map_pool_id IS NULL THEN
    RAISE NOTICE 'No competitive map pool found, skipping match generation';
    -- Set flag and return early
    INSERT INTO settings (name, value)
    VALUES ('dev.fixtures_loaded', 'true')
    ON CONFLICT (name) DO UPDATE SET value = 'true';
    RETURN;
  END IF;

  -- Get competitive map IDs
  SELECT ARRAY(
    SELECT m.id FROM maps m
    JOIN _map_pool mp ON mp.map_id = m.id
    WHERE mp.map_pool_id = comp_map_pool_id
    ORDER BY m.name
  ) INTO map_ids;

  map_count := array_length(map_ids, 1);
  IF map_count IS NULL OR map_count = 0 THEN
    RAISE NOTICE 'No maps in competitive pool, skipping match generation';
    INSERT INTO settings (name, value)
    VALUES ('dev.fixtures_loaded', 'true')
    ON CONFLICT (name) DO UPDATE SET value = 'true';
    RETURN;
  END IF;

  -- ==========================================
  -- 4. INITIALIZE STATS ARRAYS
  -- ==========================================
  kill_counts := array_fill(0, ARRAY[30]);
  death_counts := array_fill(0, ARRAY[30]);
  headshot_counts := array_fill(0, ARRAY[30]);
  weapon_kill_map := '{}'::jsonb;

  -- ==========================================
  -- 5. INSERT MATCHES (~100 matches)
  -- ==========================================
  FOR match_idx IN 1..100 LOOP
    -- Determine match status
    IF match_idx <= 80 THEN
      match_status := 'Finished';
    ELSIF match_idx <= 85 THEN
      match_status := 'Live';
    ELSIF match_idx <= 90 THEN
      match_status := 'Scheduled';
    ELSIF match_idx <= 95 THEN
      match_status := 'Canceled';
    ELSE
      match_status := 'Forfeit';
    END IF;

    -- Pick two different teams
    team_1_idx := ((match_idx - 1) % 6) + 1;
    team_2_idx := (match_idx % 6) + 1;

    -- Match date spread over past 90 days
    match_date := now() - (interval '1 day' * (90 - match_idx));
    IF match_status = 'Scheduled' THEN
      match_date := now() + (interval '1 day' * (match_idx - 85));
    END IF;

    -- Create match options
    match_options_id := gen_random_uuid();
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access, tv_delay)
    VALUES (match_options_id, true, true, 12, 1, false, 'Competitive', comp_map_pool_id, 'Private', 115);

    -- Create lineups
    lineup_1_id := gen_random_uuid();
    lineup_2_id := gen_random_uuid();

    INSERT INTO match_lineups (id, team_id, team_name)
    VALUES (lineup_1_id, team_ids[team_1_idx], team_names[team_1_idx]);

    INSERT INTO match_lineups (id, team_id, team_name)
    VALUES (lineup_2_id, team_ids[team_2_idx], team_names[team_2_idx]);

    -- Create match
    match_id := gen_random_uuid();
    INSERT INTO matches (id, status, match_options_id, lineup_1_id, lineup_2_id, created_at, scheduled_at,
                         started_at, ended_at, winning_lineup_id)
    VALUES (
      match_id,
      match_status,
      match_options_id,
      lineup_1_id,
      lineup_2_id,
      match_date - interval '1 hour',
      match_date,
      CASE WHEN match_status IN ('Finished', 'Live', 'Forfeit') THEN match_date ELSE NULL END,
      CASE WHEN match_status = 'Finished' THEN match_date + interval '45 minutes' ELSE NULL END,
      CASE WHEN match_status IN ('Finished', 'Forfeit') THEN
        CASE WHEN match_idx % 2 = 0 THEN lineup_1_id ELSE lineup_2_id END
      ELSE NULL END
    );

    -- Add lineup players (5 per team)
    FOR j IN 1..5 LOOP
      INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain, checked_in)
      VALUES (lineup_1_id, p_steam_ids[(team_1_idx - 1) * 5 + j], j = 1, true);

      INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain, checked_in)
      VALUES (lineup_2_id, p_steam_ids[(team_2_idx - 1) * 5 + j], j = 1, true);
    END LOOP;

    -- Create match map (BO1 - one map per match)
    cur_map_id := map_ids[((match_idx - 1) % map_count) + 1];
    match_map_id := gen_random_uuid();

    INSERT INTO match_maps (id, match_id, map_id, "order", status, lineup_1_side, lineup_2_side, started_at, ended_at)
    VALUES (
      match_map_id,
      match_id,
      cur_map_id,
      1,
      CASE
        WHEN match_status = 'Finished' THEN 'Finished'
        WHEN match_status = 'Live' THEN 'Live'
        WHEN match_status = 'Canceled' THEN 'Canceled'
        ELSE 'Scheduled'
      END,
      'CT',
      'TERRORIST',
      CASE WHEN match_status IN ('Finished', 'Live') THEN match_date ELSE NULL END,
      CASE WHEN match_status = 'Finished' THEN match_date + interval '40 minutes' ELSE NULL END
    );

    -- ==========================================
    -- 5a. GENERATE ROUNDS AND KILLS FOR FINISHED/LIVE MATCHES
    -- ==========================================
    IF match_status IN ('Finished', 'Live') THEN
      -- Determine final score for finished matches (MR12: first to 13)
      IF match_status = 'Finished' THEN
        IF match_idx % 2 = 0 THEN
          l1_score := 13;
          l2_score := 3 + (match_idx % 10); -- 3-12
        ELSE
          l1_score := 3 + (match_idx % 10);
          l2_score := 13;
        END IF;
        total_rounds := l1_score + l2_score;
      ELSE
        -- Live match: partial rounds
        total_rounds := 8 + (match_idx % 8); -- 8-15 rounds
        l1_score := (total_rounds / 2) + (match_idx % 3);
        l2_score := total_rounds - l1_score;
      END IF;

      -- Insert rounds
      FOR round_num IN 1..total_rounds LOOP
        -- Determine which side wins each round
        IF round_num <= l1_score THEN
          -- Lineup 1 wins (simplification: first l1_score rounds go to lineup 1)
          IF round_num <= 12 THEN
            winning_side := 'CT';
          ELSE
            winning_side := 'TERRORIST';
          END IF;
        ELSE
          IF round_num <= 12 THEN
            winning_side := 'TERRORIST';
          ELSE
            winning_side := 'CT';
          END IF;
        END IF;

        INSERT INTO match_map_rounds (
          match_map_id, round, lineup_1_score, lineup_2_score,
          lineup_1_money, lineup_2_money, time,
          lineup_1_timeouts_available, lineup_2_timeouts_available,
          winning_side, lineup_1_side, lineup_2_side
        )
        VALUES (
          match_map_id,
          round_num,
          LEAST(round_num, l1_score),
          GREATEST(0, round_num - l1_score) + CASE WHEN round_num > l1_score THEN 0 ELSE LEAST(round_num - LEAST(round_num, l1_score), l2_score) END,
          4100 + (round_num * 300),
          4100 + (round_num * 300),
          match_date + (interval '2 minutes' * round_num),
          2, 2,
          winning_side,
          CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
          CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END
        );

        -- Insert kills for this round (5-7 kills per round)
        FOR k IN 1..(5 + (round_num % 3)) LOOP
          -- Pick random attacker and attacked from opposing teams
          IF k % 2 = 1 THEN
            attacker_idx := (team_1_idx - 1) * 5 + ((k - 1) % 5) + 1;
            attacked_idx := (team_2_idx - 1) * 5 + ((k + round_num) % 5) + 1;
          ELSE
            attacker_idx := (team_2_idx - 1) * 5 + ((k - 1) % 5) + 1;
            attacked_idx := (team_1_idx - 1) * 5 + ((k + round_num) % 5) + 1;
          END IF;

          weapon_idx := ((match_idx + round_num + k) % array_length(weapons, 1)) + 1;
          is_headshot := (match_idx + round_num + k) % 3 = 0; -- ~33% headshots
          kill_time := match_date + (interval '2 minutes' * round_num) + (interval '5 seconds' * k);

          -- Avoid duplicate primary key: ensure unique (match_map_id, time, attacker, attacked)
          INSERT INTO player_kills (
            match_id, match_map_id, round,
            attacker_steam_id, attacker_team,
            attacked_steam_id, attacked_team, attacked_location,
            "with", hitgroup, headshot, time
          )
          VALUES (
            match_id, match_map_id, round_num,
            p_steam_ids[attacker_idx],
            CASE WHEN k % 2 = 1 THEN 'CT' ELSE 'TERRORIST' END,
            p_steam_ids[attacked_idx],
            CASE WHEN k % 2 = 1 THEN 'TERRORIST' ELSE 'CT' END,
            'BombsiteA',
            weapons[weapon_idx],
            CASE WHEN is_headshot THEN 'head' ELSE hitgroups[((k + round_num) % 6) + 2] END,
            is_headshot,
            kill_time
          )
          ON CONFLICT DO NOTHING;

          -- Track stats
          kill_counts[attacker_idx] := kill_counts[attacker_idx] + 1;
          death_counts[attacked_idx] := death_counts[attacked_idx] + 1;
          IF is_headshot THEN
            headshot_counts[attacker_idx] := headshot_counts[attacker_idx] + 1;
          END IF;

          -- Track weapon kills
          DECLARE
            wkey text := p_steam_ids[attacker_idx]::text || ':' || weapons[weapon_idx];
          BEGIN
            IF weapon_kill_map ? wkey THEN
              weapon_kill_map := jsonb_set(weapon_kill_map, ARRAY[wkey], to_jsonb((weapon_kill_map->>wkey)::int + 1));
            ELSE
              weapon_kill_map := weapon_kill_map || jsonb_build_object(wkey, 1);
            END IF;
          END;
        END LOOP; -- kills per round
      END LOOP; -- rounds
    END IF; -- finished/live
  END LOOP; -- matches

  -- ==========================================
  -- 6. POPULATE AGGREGATE TABLES
  -- ==========================================

  -- Player stats
  FOR i IN 1..30 LOOP
    INSERT INTO player_stats (player_steam_id, kills, deaths, assists, headshots, headshot_percentage)
    VALUES (
      p_steam_ids[i],
      kill_counts[i],
      death_counts[i],
      0,
      headshot_counts[i],
      CASE WHEN kill_counts[i] > 0 THEN (headshot_counts[i]::float / kill_counts[i]) * 100 ELSE 0 END
    )
    ON CONFLICT (player_steam_id) DO UPDATE SET
      kills = EXCLUDED.kills,
      deaths = EXCLUDED.deaths,
      headshots = EXCLUDED.headshots,
      headshot_percentage = EXCLUDED.headshot_percentage;
  END LOOP;

  -- Player kills by weapon
  DECLARE
    wkey text;
    wparts text[];
    w_steam_id bigint;
    w_weapon text;
    w_count int;
  BEGIN
    FOR wkey IN SELECT jsonb_object_keys(weapon_kill_map) LOOP
      wparts := string_to_array(wkey, ':');
      w_steam_id := wparts[1]::bigint;
      w_weapon := wparts[2];
      w_count := (weapon_kill_map->>wkey)::int;

      INSERT INTO player_kills_by_weapon (player_steam_id, "with", kill_count)
      VALUES (w_steam_id, w_weapon, w_count)
      ON CONFLICT (player_steam_id, "with") DO UPDATE SET kill_count = EXCLUDED.kill_count;
    END LOOP;
  END;

  -- ==========================================
  -- 7. INSERT TOURNAMENTS
  -- ==========================================

  -- Tournament 1: Finished, SingleElimination, 4 teams
  DECLARE
    t1_options_id uuid := gen_random_uuid();
    t1_stage_id uuid := gen_random_uuid();
    t1_team_ids uuid[];
    t1_bracket_sf1 uuid := gen_random_uuid();
    t1_bracket_sf2 uuid := gen_random_uuid();
    t1_bracket_final uuid := gen_random_uuid();
    t1_match1_id uuid;
    t1_match2_id uuid;
    t1_match3_id uuid;
  BEGIN
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t1_options_id, true, true, 12, 1, false, 'Competitive', comp_map_pool_id, 'Private');

    INSERT INTO tournaments (id, name, description, start, organizer_steam_id, status, match_options_id, created_at)
    VALUES (
      tournament_ids[1],
      'Adria Cup Season 1',
      'First season of the Adria Cup tournament',
      now() - interval '30 days',
      p_steam_ids[1],
      'Finished',
      t1_options_id,
      now() - interval '45 days'
    );

    INSERT INTO tournament_stages (id, tournament_id, type, "order", min_teams, max_teams, match_options_id)
    VALUES (t1_stage_id, tournament_ids[1], 'SingleElimination', 1, 4, 4, t1_options_id);

    -- Register 4 teams
    FOR t IN 1..4 LOOP
      INSERT INTO tournament_teams (id, team_id, tournament_id, name, owner_steam_id, seed, eligible_at)
      VALUES (
        gen_random_uuid(),
        team_ids[t],
        tournament_ids[1],
        team_names[t],
        p_steam_ids[(t - 1) * 5 + 1],
        t,
        now() - interval '40 days'
      );
    END LOOP;

    SELECT ARRAY(SELECT id FROM tournament_teams WHERE tournament_id = tournament_ids[1] ORDER BY seed) INTO t1_team_ids;

    -- Create bracket matches (semifinals + final)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, finished)
    VALUES
      (t1_bracket_sf1, t1_stage_id, t1_team_ids[1], t1_team_ids[4], 1, 1, true),
      (t1_bracket_sf2, t1_stage_id, t1_team_ids[2], t1_team_ids[3], 1, 2, true),
      (t1_bracket_final, t1_stage_id, t1_team_ids[1], t1_team_ids[2], 2, 1, true);
  END;

  -- Tournament 2: Live, SingleElimination, 6 teams
  DECLARE
    t2_options_id uuid := gen_random_uuid();
    t2_stage_id uuid := gen_random_uuid();
    t2_team_ids uuid[];
  BEGIN
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t2_options_id, true, true, 12, 1, false, 'Competitive', comp_map_pool_id, 'Private');

    INSERT INTO tournaments (id, name, description, start, organizer_steam_id, status, match_options_id, created_at)
    VALUES (
      tournament_ids[2],
      'Balkan Masters Invitational',
      'Top teams from the Balkan region compete',
      now() - interval '3 days',
      p_steam_ids[1],
      'Live',
      t2_options_id,
      now() - interval '14 days'
    );

    INSERT INTO tournament_stages (id, tournament_id, type, "order", min_teams, max_teams, match_options_id)
    VALUES (t2_stage_id, tournament_ids[2], 'SingleElimination', 1, 4, 8, t2_options_id);

    -- Register all 6 teams
    FOR t IN 1..6 LOOP
      INSERT INTO tournament_teams (id, team_id, tournament_id, name, owner_steam_id, seed, eligible_at)
      VALUES (
        gen_random_uuid(),
        team_ids[t],
        tournament_ids[2],
        team_names[t],
        p_steam_ids[(t - 1) * 5 + 1],
        t,
        now() - interval '10 days'
      );
    END LOOP;

    SELECT ARRAY(SELECT id FROM tournament_teams WHERE tournament_id = tournament_ids[2] ORDER BY seed) INTO t2_team_ids;

    -- First round brackets (3 matches for 6 teams)
    INSERT INTO tournament_brackets (tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, finished)
    VALUES
      (t2_stage_id, t2_team_ids[1], t2_team_ids[6], 1, 1, true),
      (t2_stage_id, t2_team_ids[2], t2_team_ids[5], 1, 2, false),
      (t2_stage_id, t2_team_ids[3], t2_team_ids[4], 1, 3, false);

    -- Semifinal brackets (placeholders)
    INSERT INTO tournament_brackets (tournament_stage_id, tournament_team_id_1, round, match_number, finished)
    VALUES
      (t2_stage_id, t2_team_ids[1], 2, 1, false),
      (t2_stage_id, NULL, 2, 2, false);

    -- Final bracket
    INSERT INTO tournament_brackets (tournament_stage_id, round, match_number, finished)
    VALUES (t2_stage_id, 3, 1, false);
  END;

  -- Tournament 3: RegistrationOpen
  DECLARE
    t3_options_id uuid := gen_random_uuid();
    t3_stage_id uuid := gen_random_uuid();
  BEGIN
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t3_options_id, true, true, 12, 3, true, 'Competitive', comp_map_pool_id, 'Open');

    INSERT INTO tournaments (id, name, description, start, organizer_steam_id, status, match_options_id, created_at)
    VALUES (
      tournament_ids[3],
      'EsportAdria Open 2026',
      'Open tournament for all teams. Best of 3, single elimination.',
      now() + interval '14 days',
      p_steam_ids[1],
      'RegistrationOpen',
      t3_options_id,
      now() - interval '2 days'
    );

    INSERT INTO tournament_stages (id, tournament_id, type, "order", min_teams, max_teams, match_options_id)
    VALUES (t3_stage_id, tournament_ids[3], 'SingleElimination', 1, 4, 16, t3_options_id);

    -- Register 2 teams so far
    FOR t IN 1..2 LOOP
      DECLARE
        tt_id uuid := gen_random_uuid();
      BEGIN
        INSERT INTO tournament_teams (id, team_id, tournament_id, name, owner_steam_id, seed, eligible_at)
        VALUES (
          tt_id,
          team_ids[t],
          tournament_ids[3],
          team_names[t],
          p_steam_ids[(t - 1) * 5 + 1],
          t,
          now() - interval '1 day'
        );

        -- Add roster for registered teams
        FOR j IN 1..5 LOOP
          INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
          VALUES (tt_id, p_steam_ids[(t - 1) * 5 + j], tournament_ids[3], CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END)
          ON CONFLICT DO NOTHING;
        END LOOP;
      END;
    END LOOP;
  END;

  -- ==========================================
  -- 8. SET FIXTURES LOADED FLAG
  -- ==========================================
  INSERT INTO settings (name, value)
  VALUES ('dev.fixtures_loaded', 'true')
  ON CONFLICT (name) DO UPDATE SET value = 'true';

END $$;

-- Re-enable triggers (excluding hypertables)
ALTER TABLE players ENABLE TRIGGER ALL;
ALTER TABLE teams ENABLE TRIGGER ALL;
ALTER TABLE team_roster ENABLE TRIGGER ALL;
ALTER TABLE match_options ENABLE TRIGGER ALL;
ALTER TABLE match_lineups ENABLE TRIGGER ALL;
ALTER TABLE matches ENABLE TRIGGER ALL;
ALTER TABLE match_lineup_players ENABLE TRIGGER ALL;
ALTER TABLE match_maps ENABLE TRIGGER ALL;
ALTER TABLE match_map_rounds ENABLE TRIGGER ALL;
ALTER TABLE player_stats ENABLE TRIGGER ALL;
ALTER TABLE player_kills_by_weapon ENABLE TRIGGER ALL;
ALTER TABLE tournaments ENABLE TRIGGER ALL;
ALTER TABLE tournament_stages ENABLE TRIGGER ALL;
ALTER TABLE tournament_teams ENABLE TRIGGER ALL;
ALTER TABLE tournament_team_roster ENABLE TRIGGER ALL;
ALTER TABLE tournament_brackets ENABLE TRIGGER ALL;
