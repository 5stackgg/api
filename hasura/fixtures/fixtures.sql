-- Dev Fixture Data
-- Inserts ~40 players, 8 teams, ~100 matches with scores, map veto picks, utility/flash data, and 4 tournaments
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
ALTER TABLE match_map_veto_picks DISABLE TRIGGER ALL;

DO $$
DECLARE
  -- Player data
  p_steam_ids bigint[] := ARRAY(SELECT generate_series(76561198000000001::bigint, 76561198000000040::bigint));
  p_names text[] := ARRAY[
    'AceHunter', 'BlazeMaster', 'ColdShot', 'DarkRifle', 'EagleEye',
    'FlashPoint', 'GhostAim', 'HawkSnipe', 'IceNerve', 'JoltFrag',
    'KnifeEdge', 'LightningBolt', 'MidControl', 'NightOwl', 'OmegaPush',
    'PeakForm', 'QuickScope', 'RushKing', 'SmokeWall', 'TacticalMind',
    'UpperHand', 'VenomStrike', 'WallBanger', 'XenonFlash', 'YoloRush',
    'ZenAim', 'AlphaFrag', 'BravoPeek', 'CharlieHold', 'DeltaPush',
    'EchoFlame', 'FuryBlade', 'GrimReaper', 'HyperNova', 'InfernoX',
    'JadeStrike', 'KryptonShot', 'LunarAce', 'MaverickPro', 'NexusKill'
  ];
  p_countries text[] := ARRAY[
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL',
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL',
    'US', 'DE', 'SE', 'DK', 'FR', 'BR', 'HR', 'SI', 'RS', 'PL',
    'BA', 'ME', 'MK', 'AL', 'BG', 'BA', 'ME', 'MK', 'AL', 'BG'
  ];

  -- Team data
  team_ids uuid[] := ARRAY[
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'a0000000-0000-0000-0000-000000000002'::uuid,
    'a0000000-0000-0000-0000-000000000003'::uuid,
    'a0000000-0000-0000-0000-000000000004'::uuid,
    'a0000000-0000-0000-0000-000000000005'::uuid,
    'a0000000-0000-0000-0000-000000000006'::uuid,
    'a0000000-0000-0000-0000-000000000007'::uuid,
    'a0000000-0000-0000-0000-000000000008'::uuid
  ];
  team_names text[] := ARRAY['Astra Force', 'Blitz Brigade', 'Crimson Wolves', 'Dark Phoenix', 'Echo Storm', 'Frost Giants', 'Shadow Vipers', 'Titan Guard'];
  team_short text[] := ARRAY['AST', 'BLZ', 'CRW', 'DPX', 'ECH', 'FRG', 'SHV', 'TTG'];

  -- Tournament data
  tournament_ids uuid[] := ARRAY[
    'b0000000-0000-0000-0000-000000000001'::uuid,
    'b0000000-0000-0000-0000-000000000002'::uuid,
    'b0000000-0000-0000-0000-000000000003'::uuid,
    'b0000000-0000-0000-0000-000000000004'::uuid
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
  v_t1_wins int;
  v_t2_wins int;

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
  FOR i IN 1..40 LOOP
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
  FOR t IN 1..8 LOOP
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
  kill_counts := array_fill(0, ARRAY[40]);
  death_counts := array_fill(0, ARRAY[40]);
  headshot_counts := array_fill(0, ARRAY[40]);
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
    team_1_idx := ((match_idx - 1) % 8) + 1;
    team_2_idx := (match_idx % 8) + 1;

    -- Match date spread over past 90 days
    match_date := now() - (interval '1 day' * (90 - match_idx));
    IF match_status = 'Scheduled' THEN
      match_date := now() + (interval '1 day' * (match_idx - 85));
    END IF;

    -- Create match options
    match_options_id := gen_random_uuid();
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access, tv_delay)
    VALUES (match_options_id, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private', 115);

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
        CASE WHEN ((match_idx - 1) / 8 + match_idx) % 2 = 0 THEN lineup_1_id ELSE lineup_2_id END
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

    INSERT INTO match_maps (id, match_id, map_id, "order", status, lineup_1_side, lineup_2_side, started_at, ended_at, winning_lineup_id)
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
      CASE WHEN match_status = 'Finished' THEN match_date + interval '40 minutes' ELSE NULL END,
      CASE WHEN match_status IN ('Finished', 'Forfeit') THEN
        CASE WHEN ((match_idx - 1) / 8 + match_idx) % 2 = 0 THEN lineup_1_id ELSE lineup_2_id END
      ELSE NULL END
    );

    -- Generate map veto picks (ban all maps except played one)
    DECLARE
      ban_n int := 0;
    BEGIN
      FOR j IN 1..map_count LOOP
        IF map_ids[j] != cur_map_id THEN
          ban_n := ban_n + 1;
          INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, created_at)
          VALUES (match_id, 'Ban',
                  CASE WHEN ban_n % 2 = 1 THEN lineup_1_id ELSE lineup_2_id END,
                  map_ids[j],
                  match_date - interval '10 minutes' + (interval '30 seconds' * ban_n));
        END IF;
      END LOOP;
    END;

    -- ==========================================
    -- 5a. GENERATE ROUNDS AND KILLS FOR FINISHED/LIVE MATCHES
    -- ==========================================
    IF match_status IN ('Finished', 'Live') THEN
      -- Determine final score for finished matches (MR12: first to 13)
      IF match_status = 'Finished' THEN
        IF ((match_idx - 1) / 8 + match_idx) % 2 = 0 THEN
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

      -- Insert rounds (Bresenham-style interleaving for realistic CT/T distribution)
      v_t1_wins := 0; v_t2_wins := 0;
      FOR round_num IN 1..total_rounds LOOP
        -- Distribute wins proportionally across all rounds
        IF v_t1_wins * total_rounds < round_num * l1_score AND v_t1_wins < l1_score THEN
          v_t1_wins := v_t1_wins + 1;
          IF round_num <= 12 THEN winning_side := 'CT'; ELSE winning_side := 'TERRORIST'; END IF;
        ELSE
          v_t2_wins := v_t2_wins + 1;
          IF round_num <= 12 THEN winning_side := 'TERRORIST'; ELSE winning_side := 'CT'; END IF;
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
          v_t1_wins,
          v_t2_wins,
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

        -- Generate utility events (flashes, smokes, HE, molotov)
        DECLARE
          ut timestamptz;
          fp1 int := (team_1_idx - 1) * 5 + ((round_num + 1) % 5) + 1;
          fp2 int := (team_2_idx - 1) * 5 + ((round_num + 2) % 5) + 1;
          fe1 int := (team_2_idx - 1) * 5 + ((round_num + 3) % 5) + 1;
          fe2 int := (team_1_idx - 1) * 5 + ((round_num + 4) % 5) + 1;
        BEGIN
          -- Team 1 flash
          ut := match_date + (interval '2 minutes' * round_num) + interval '40 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (match_map_id, p_steam_ids[fp1], ut, match_id, round_num, 'Flash') ON CONFLICT DO NOTHING;
          INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
          VALUES (match_map_id, ut + interval '1 second', p_steam_ids[fp1], p_steam_ids[fe1], match_id, round_num, 1.5 + (round_num % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

          -- Team 2 flash
          ut := match_date + (interval '2 minutes' * round_num) + interval '50 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (match_map_id, p_steam_ids[fp2], ut, match_id, round_num, 'Flash') ON CONFLICT DO NOTHING;
          INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
          VALUES (match_map_id, ut + interval '1 second', p_steam_ids[fp2], p_steam_ids[fe2], match_id, round_num, 1.5 + ((round_num + 1) % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

          -- Team flash every 3rd round
          IF round_num % 3 = 0 THEN
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (match_map_id, ut + interval '2 seconds', p_steam_ids[fp1],
                    p_steam_ids[(team_1_idx - 1) * 5 + ((round_num + 2) % 5) + 1],
                    match_id, round_num, 0.8 + (round_num % 2)::numeric * 0.4, true) ON CONFLICT DO NOTHING;
          END IF;

          -- Smoke
          ut := match_date + (interval '2 minutes' * round_num) + interval '35 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (match_map_id, p_steam_ids[(team_1_idx - 1) * 5 + ((round_num + 3) % 5) + 1], ut, match_id, round_num, 'Smoke') ON CONFLICT DO NOTHING;

          -- HE or Molotov (alternating rounds)
          ut := match_date + (interval '2 minutes' * round_num) + interval '55 seconds';
          IF round_num % 2 = 0 THEN
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (match_map_id, p_steam_ids[(team_2_idx - 1) * 5 + (round_num % 5) + 1], ut, match_id, round_num, 'HighExplosive') ON CONFLICT DO NOTHING;
            INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
              attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
            VALUES (match_id, match_map_id, round_num,
              p_steam_ids[(team_2_idx - 1) * 5 + (round_num % 5) + 1],
              CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
              p_steam_ids[(team_1_idx - 1) * 5 + ((round_num + 1) % 5) + 1],
              CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
              'BombsiteA', 'hegrenade', 15 + (round_num % 30), 0, 85 - (round_num % 30), 100, 'chest',
              ut + interval '0.3 seconds');
          ELSE
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (match_map_id, p_steam_ids[(team_1_idx - 1) * 5 + ((round_num + 4) % 5) + 1], ut, match_id, round_num, 'Molotov') ON CONFLICT DO NOTHING;
            INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
              attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
            VALUES (match_id, match_map_id, round_num,
              p_steam_ids[(team_1_idx - 1) * 5 + ((round_num + 4) % 5) + 1],
              CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
              p_steam_ids[(team_2_idx - 1) * 5 + ((round_num + 2) % 5) + 1],
              CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
              'BombsiteA', 'inferno', 10 + (round_num % 25), 0, 90 - (round_num % 25), 100, 'chest',
              ut + interval '0.5 seconds');
          END IF;
        END;
      END LOOP; -- rounds
    END IF; -- finished/live
  END LOOP; -- matches

  -- ==========================================
  -- 6. POPULATE AGGREGATE TABLES
  -- ==========================================

  -- Player stats
  FOR i IN 1..40 LOOP
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
  BEGIN
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t1_options_id, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private');

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

    -- Add roster for tournament 1 teams
    FOR t IN 1..4 LOOP
      FOR j IN 1..5 LOOP
        INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
        VALUES (t1_team_ids[t], p_steam_ids[(t - 1) * 5 + j], tournament_ids[1], CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;

    -- Create brackets (semifinals + final)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, finished)
    VALUES
      (t1_bracket_sf1, t1_stage_id, t1_team_ids[1], t1_team_ids[4], 1, 1, true),
      (t1_bracket_sf2, t1_stage_id, t1_team_ids[2], t1_team_ids[3], 1, 2, true),
      (t1_bracket_final, t1_stage_id, t1_team_ids[1], t1_team_ids[2], 2, 1, true);

    -- Create matches linked to finished brackets
    -- SF1: T1 vs T4 → T1 wins, SF2: T2 vs T3 → T2 wins, Final: T1 vs T2 → T1 wins
    DECLARE
      t1_br uuid[] := ARRAY[t1_bracket_sf1, t1_bracket_sf2, t1_bracket_final];
      t1_ti1 int[] := ARRAY[1, 2, 1];
      t1_ti2 int[] := ARRAY[4, 3, 2];
      t1_mid uuid; t1_moid uuid; t1_l1id uuid; t1_l2id uuid; t1_mmid uuid;
      t1_mdate timestamptz;
      t1_l1s int; t1_l2s int;
    BEGIN
      FOR i IN 1..3 LOOP
        t1_mdate := (now() - interval '30 days') + (interval '1 day' * (i - 1));
        t1_moid := gen_random_uuid(); t1_mid := gen_random_uuid();
        t1_l1id := gen_random_uuid(); t1_l2id := gen_random_uuid();
        t1_mmid := gen_random_uuid();

        INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access, tv_delay)
        VALUES (t1_moid, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private', 115);

        INSERT INTO match_lineups (id, team_id, team_name) VALUES
          (t1_l1id, team_ids[t1_ti1[i]], team_names[t1_ti1[i]]),
          (t1_l2id, team_ids[t1_ti2[i]], team_names[t1_ti2[i]]);

        INSERT INTO matches (id, status, match_options_id, lineup_1_id, lineup_2_id,
                             created_at, scheduled_at, started_at, ended_at, winning_lineup_id)
        VALUES (t1_mid, 'Finished', t1_moid, t1_l1id, t1_l2id,
                t1_mdate - interval '1 hour', t1_mdate, t1_mdate,
                t1_mdate + interval '45 minutes', t1_l1id);

        FOR j IN 1..5 LOOP
          INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain, checked_in) VALUES
            (t1_l1id, p_steam_ids[(t1_ti1[i] - 1) * 5 + j], j = 1, true),
            (t1_l2id, p_steam_ids[(t1_ti2[i] - 1) * 5 + j], j = 1, true);
        END LOOP;

        INSERT INTO match_maps (id, match_id, map_id, "order", status, lineup_1_side, lineup_2_side, started_at, ended_at, winning_lineup_id)
        VALUES (t1_mmid, t1_mid, map_ids[((i - 1) % map_count) + 1], 1, 'Finished', 'CT', 'TERRORIST', t1_mdate, t1_mdate + interval '40 minutes', t1_l1id);

        -- Veto picks
        DECLARE ban_n int := 0; t1_cur_map uuid := map_ids[((i - 1) % map_count) + 1];
        BEGIN
          FOR j IN 1..map_count LOOP
            IF map_ids[j] != t1_cur_map THEN
              ban_n := ban_n + 1;
              INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, created_at)
              VALUES (t1_mid, 'Ban', CASE WHEN ban_n % 2 = 1 THEN t1_l1id ELSE t1_l2id END,
                      map_ids[j], t1_mdate - interval '10 minutes' + (interval '30 seconds' * ban_n));
            END IF;
          END LOOP;
        END;

        -- Generate rounds and kills (team1 always wins)
        t1_l1s := 13; t1_l2s := 5 + (i * 2);
        v_t1_wins := 0; v_t2_wins := 0;
        FOR round_num IN 1..(t1_l1s + t1_l2s) LOOP
          IF v_t1_wins * (t1_l1s + t1_l2s) < round_num * t1_l1s AND v_t1_wins < t1_l1s THEN
            v_t1_wins := v_t1_wins + 1;
            winning_side := CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END;
          ELSE
            v_t2_wins := v_t2_wins + 1;
            winning_side := CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END;
          END IF;

          INSERT INTO match_map_rounds (match_map_id, round, lineup_1_score, lineup_2_score,
            lineup_1_money, lineup_2_money, time, lineup_1_timeouts_available, lineup_2_timeouts_available,
            winning_side, lineup_1_side, lineup_2_side)
          VALUES (t1_mmid, round_num, v_t1_wins, v_t2_wins,
            4100 + (round_num * 300), 4100 + (round_num * 300),
            t1_mdate + (interval '2 minutes' * round_num), 2, 2,
            winning_side,
            CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
            CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END);

          FOR k IN 1..5 LOOP
            INSERT INTO player_kills (match_id, match_map_id, round,
              attacker_steam_id, attacker_team, attacked_steam_id, attacked_team, attacked_location,
              "with", hitgroup, headshot, time)
            VALUES (t1_mid, t1_mmid, round_num,
              p_steam_ids[(CASE WHEN k % 2 = 1 THEN t1_ti1[i] ELSE t1_ti2[i] END - 1) * 5 + ((k - 1) % 5) + 1],
              CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'CT' ELSE 'TERRORIST' END,
              p_steam_ids[(CASE WHEN k % 2 = 1 THEN t1_ti2[i] ELSE t1_ti1[i] END - 1) * 5 + ((k + round_num) % 5) + 1],
              CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'TERRORIST' ELSE 'CT' END,
              'BombsiteA', weapons[((i + round_num + k) % array_length(weapons, 1)) + 1],
              CASE WHEN (round_num + k) % 3 = 0 THEN 'head' ELSE hitgroups[((k + round_num) % 6) + 2] END,
              (round_num + k) % 3 = 0,
              t1_mdate + (interval '2 minutes' * round_num) + (interval '5 seconds' * k))
            ON CONFLICT DO NOTHING;
          END LOOP;

          -- Utility events
          DECLARE
            ut timestamptz;
            fp1 int := (t1_ti1[i] - 1) * 5 + ((round_num + 1) % 5) + 1;
            fp2 int := (t1_ti2[i] - 1) * 5 + ((round_num + 2) % 5) + 1;
          BEGIN
            ut := t1_mdate + (interval '2 minutes' * round_num) + interval '40 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t1_mmid, p_steam_ids[fp1], ut, t1_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (t1_mmid, ut + interval '1 second', p_steam_ids[fp1],
                    p_steam_ids[(t1_ti2[i] - 1) * 5 + ((round_num + 3) % 5) + 1],
                    t1_mid, round_num, 1.5 + (round_num % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

            ut := t1_mdate + (interval '2 minutes' * round_num) + interval '50 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t1_mmid, p_steam_ids[fp2], ut, t1_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (t1_mmid, ut + interval '1 second', p_steam_ids[fp2],
                    p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 4) % 5) + 1],
                    t1_mid, round_num, 1.5 + ((round_num + 1) % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

            IF round_num % 3 = 0 THEN
              INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
              VALUES (t1_mmid, ut + interval '2 seconds', p_steam_ids[fp1],
                      p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 2) % 5) + 1],
                      t1_mid, round_num, 0.8 + (round_num % 2)::numeric * 0.4, true) ON CONFLICT DO NOTHING;
            END IF;

            ut := t1_mdate + (interval '2 minutes' * round_num) + interval '35 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t1_mmid, p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 3) % 5) + 1], ut, t1_mid, round_num, 'Smoke') ON CONFLICT DO NOTHING;

            ut := t1_mdate + (interval '2 minutes' * round_num) + interval '55 seconds';
            IF round_num % 2 = 0 THEN
              INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
              VALUES (t1_mmid, p_steam_ids[(t1_ti2[i] - 1) * 5 + (round_num % 5) + 1], ut, t1_mid, round_num, 'HighExplosive') ON CONFLICT DO NOTHING;
              INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
                attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
              VALUES (t1_mid, t1_mmid, round_num,
                p_steam_ids[(t1_ti2[i] - 1) * 5 + (round_num % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
                p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 1) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
                'BombsiteA', 'hegrenade', 15 + (round_num % 30), 0, 85 - (round_num % 30), 100, 'chest', ut + interval '0.3 seconds');
            ELSE
              INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
              VALUES (t1_mmid, p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 4) % 5) + 1], ut, t1_mid, round_num, 'Molotov') ON CONFLICT DO NOTHING;
              INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
                attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
              VALUES (t1_mid, t1_mmid, round_num,
                p_steam_ids[(t1_ti1[i] - 1) * 5 + ((round_num + 4) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
                p_steam_ids[(t1_ti2[i] - 1) * 5 + ((round_num + 2) % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
                'BombsiteA', 'inferno', 10 + (round_num % 25), 0, 90 - (round_num % 25), 100, 'chest', ut + interval '0.5 seconds');
            END IF;
          END;
        END LOOP;

        UPDATE tournament_brackets SET match_id = t1_mid WHERE id = t1_br[i];
      END LOOP;
    END;
  END;

  -- Tournament 2: Live, SingleElimination, 6 teams
  DECLARE
    t2_options_id uuid := gen_random_uuid();
    t2_stage_id uuid := gen_random_uuid();
    t2_team_ids uuid[];
    t2_bracket_r1m1 uuid := gen_random_uuid();
  BEGIN
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t2_options_id, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private');

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

    -- Add roster for tournament 2 teams
    FOR t IN 1..6 LOOP
      FOR j IN 1..5 LOOP
        INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
        VALUES (t2_team_ids[t], p_steam_ids[(t - 1) * 5 + j], tournament_ids[2], CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;

    -- First round brackets (3 matches for 6 teams)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, finished)
    VALUES
      (t2_bracket_r1m1, t2_stage_id, t2_team_ids[1], t2_team_ids[6], 1, 1, true);
    INSERT INTO tournament_brackets (tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, finished)
    VALUES
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

    -- Create match for the one finished bracket (R1 M1: T1 vs T6, T1 wins)
    DECLARE
      t2_mid uuid := gen_random_uuid();
      t2_moid uuid := gen_random_uuid();
      t2_l1id uuid := gen_random_uuid();
      t2_l2id uuid := gen_random_uuid();
      t2_mmid uuid := gen_random_uuid();
      t2_mdate timestamptz := now() - interval '3 days';
      t2_l1s int := 13; t2_l2s int := 8;
    BEGIN
      INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access, tv_delay)
      VALUES (t2_moid, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private', 115);

      INSERT INTO match_lineups (id, team_id, team_name) VALUES
        (t2_l1id, team_ids[1], team_names[1]),
        (t2_l2id, team_ids[6], team_names[6]);

      INSERT INTO matches (id, status, match_options_id, lineup_1_id, lineup_2_id,
                           created_at, scheduled_at, started_at, ended_at, winning_lineup_id)
      VALUES (t2_mid, 'Finished', t2_moid, t2_l1id, t2_l2id,
              t2_mdate - interval '1 hour', t2_mdate, t2_mdate,
              t2_mdate + interval '45 minutes', t2_l1id);

      FOR j IN 1..5 LOOP
        INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain, checked_in) VALUES
          (t2_l1id, p_steam_ids[(1 - 1) * 5 + j], j = 1, true),
          (t2_l2id, p_steam_ids[(6 - 1) * 5 + j], j = 1, true);
      END LOOP;

      INSERT INTO match_maps (id, match_id, map_id, "order", status, lineup_1_side, lineup_2_side, started_at, ended_at, winning_lineup_id)
      VALUES (t2_mmid, t2_mid, map_ids[1], 1, 'Finished', 'CT', 'TERRORIST', t2_mdate, t2_mdate + interval '40 minutes', t2_l1id);

      -- Veto picks
      DECLARE ban_n int := 0;
      BEGIN
        FOR j IN 1..map_count LOOP
          IF map_ids[j] != map_ids[1] THEN
            ban_n := ban_n + 1;
            INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, created_at)
            VALUES (t2_mid, 'Ban', CASE WHEN ban_n % 2 = 1 THEN t2_l1id ELSE t2_l2id END,
                    map_ids[j], t2_mdate - interval '10 minutes' + (interval '30 seconds' * ban_n));
          END IF;
        END LOOP;
      END;

      -- Generate rounds and kills (T1 wins 13-8)
      v_t1_wins := 0; v_t2_wins := 0;
      FOR round_num IN 1..(t2_l1s + t2_l2s) LOOP
        IF v_t1_wins * (t2_l1s + t2_l2s) < round_num * t2_l1s AND v_t1_wins < t2_l1s THEN
          v_t1_wins := v_t1_wins + 1;
          winning_side := CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END;
        ELSE
          v_t2_wins := v_t2_wins + 1;
          winning_side := CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END;
        END IF;

        INSERT INTO match_map_rounds (match_map_id, round, lineup_1_score, lineup_2_score,
          lineup_1_money, lineup_2_money, time, lineup_1_timeouts_available, lineup_2_timeouts_available,
          winning_side, lineup_1_side, lineup_2_side)
        VALUES (t2_mmid, round_num, v_t1_wins, v_t2_wins,
          4100 + (round_num * 300), 4100 + (round_num * 300),
          t2_mdate + (interval '2 minutes' * round_num), 2, 2,
          winning_side,
          CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
          CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END);

        FOR k IN 1..5 LOOP
          INSERT INTO player_kills (match_id, match_map_id, round,
            attacker_steam_id, attacker_team, attacked_steam_id, attacked_team, attacked_location,
            "with", hitgroup, headshot, time)
          VALUES (t2_mid, t2_mmid, round_num,
            p_steam_ids[(CASE WHEN k % 2 = 1 THEN 1 ELSE 6 END - 1) * 5 + ((k - 1) % 5) + 1],
            CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'CT' ELSE 'TERRORIST' END,
            p_steam_ids[(CASE WHEN k % 2 = 1 THEN 6 ELSE 1 END - 1) * 5 + ((k + round_num) % 5) + 1],
            CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'TERRORIST' ELSE 'CT' END,
            'BombsiteA', weapons[((round_num + k) % array_length(weapons, 1)) + 1],
            CASE WHEN (round_num + k) % 3 = 0 THEN 'head' ELSE hitgroups[((k + round_num) % 6) + 2] END,
            (round_num + k) % 3 = 0,
            t2_mdate + (interval '2 minutes' * round_num) + (interval '5 seconds' * k))
          ON CONFLICT DO NOTHING;
        END LOOP;

        -- Utility events
        DECLARE
          ut timestamptz;
          fp1 int := (1 - 1) * 5 + ((round_num + 1) % 5) + 1;
          fp2 int := (6 - 1) * 5 + ((round_num + 2) % 5) + 1;
        BEGIN
          ut := t2_mdate + (interval '2 minutes' * round_num) + interval '40 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (t2_mmid, p_steam_ids[fp1], ut, t2_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
          INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
          VALUES (t2_mmid, ut + interval '1 second', p_steam_ids[fp1],
                  p_steam_ids[(6 - 1) * 5 + ((round_num + 3) % 5) + 1],
                  t2_mid, round_num, 1.5 + (round_num % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

          ut := t2_mdate + (interval '2 minutes' * round_num) + interval '50 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (t2_mmid, p_steam_ids[fp2], ut, t2_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
          INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
          VALUES (t2_mmid, ut + interval '1 second', p_steam_ids[fp2],
                  p_steam_ids[(1 - 1) * 5 + ((round_num + 4) % 5) + 1],
                  t2_mid, round_num, 1.5 + ((round_num + 1) % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

          IF round_num % 3 = 0 THEN
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (t2_mmid, ut + interval '2 seconds', p_steam_ids[fp1],
                    p_steam_ids[(1 - 1) * 5 + ((round_num + 2) % 5) + 1],
                    t2_mid, round_num, 0.8 + (round_num % 2)::numeric * 0.4, true) ON CONFLICT DO NOTHING;
          END IF;

          ut := t2_mdate + (interval '2 minutes' * round_num) + interval '35 seconds';
          INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
          VALUES (t2_mmid, p_steam_ids[(1 - 1) * 5 + ((round_num + 3) % 5) + 1], ut, t2_mid, round_num, 'Smoke') ON CONFLICT DO NOTHING;

          ut := t2_mdate + (interval '2 minutes' * round_num) + interval '55 seconds';
          IF round_num % 2 = 0 THEN
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t2_mmid, p_steam_ids[(6 - 1) * 5 + (round_num % 5) + 1], ut, t2_mid, round_num, 'HighExplosive') ON CONFLICT DO NOTHING;
            INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
              attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
            VALUES (t2_mid, t2_mmid, round_num,
              p_steam_ids[(6 - 1) * 5 + (round_num % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
              p_steam_ids[(1 - 1) * 5 + ((round_num + 1) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
              'BombsiteA', 'hegrenade', 15 + (round_num % 30), 0, 85 - (round_num % 30), 100, 'chest', ut + interval '0.3 seconds');
          ELSE
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t2_mmid, p_steam_ids[(1 - 1) * 5 + ((round_num + 4) % 5) + 1], ut, t2_mid, round_num, 'Molotov') ON CONFLICT DO NOTHING;
            INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
              attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
            VALUES (t2_mid, t2_mmid, round_num,
              p_steam_ids[(1 - 1) * 5 + ((round_num + 4) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
              p_steam_ids[(6 - 1) * 5 + ((round_num + 2) % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
              'BombsiteA', 'inferno', 10 + (round_num % 25), 0, 90 - (round_num % 25), 100, 'chest', ut + interval '0.5 seconds');
          END IF;
        END;
      END LOOP;

      UPDATE tournament_brackets SET match_id = t2_mid WHERE id = t2_bracket_r1m1;
    END;
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

  -- Tournament 4: Finished, RoundRobin groups + DoubleElimination playoffs, 8 teams
  DECLARE
    t4_rr_options_id uuid := gen_random_uuid();
    t4_de_options_id uuid := gen_random_uuid();
    t4_gf_options_id uuid := gen_random_uuid();
    t4_stage1_id uuid := gen_random_uuid();
    t4_stage2_id uuid := gen_random_uuid();
    t4_team_ids uuid[];

    -- Round Robin bracket IDs (Group 1: 6 matches, Group 2: 6 matches)
    t4_rr_g1_m1 uuid := gen_random_uuid();
    t4_rr_g1_m2 uuid := gen_random_uuid();
    t4_rr_g1_m3 uuid := gen_random_uuid();
    t4_rr_g1_m4 uuid := gen_random_uuid();
    t4_rr_g1_m5 uuid := gen_random_uuid();
    t4_rr_g1_m6 uuid := gen_random_uuid();
    t4_rr_g2_m1 uuid := gen_random_uuid();
    t4_rr_g2_m2 uuid := gen_random_uuid();
    t4_rr_g2_m3 uuid := gen_random_uuid();
    t4_rr_g2_m4 uuid := gen_random_uuid();
    t4_rr_g2_m5 uuid := gen_random_uuid();
    t4_rr_g2_m6 uuid := gen_random_uuid();

    -- Double Elimination bracket IDs
    t4_wb_sf1 uuid := gen_random_uuid();
    t4_wb_sf2 uuid := gen_random_uuid();
    t4_wb_final uuid := gen_random_uuid();
    t4_lb_r1 uuid := gen_random_uuid();
    t4_lb_r2 uuid := gen_random_uuid();
    t4_gf uuid := gen_random_uuid();
  BEGIN
    -- Match options for round robin stage (BO1)
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t4_rr_options_id, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private');

    -- Match options for double elimination stage (BO1)
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t4_de_options_id, true, true, 12, 1, true, 'Competitive', comp_map_pool_id, 'Private');

    -- Match options for grand final (BO5)
    INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access)
    VALUES (t4_gf_options_id, true, true, 12, 5, true, 'Competitive', comp_map_pool_id, 'Private');

    INSERT INTO tournaments (id, name, description, start, organizer_steam_id, status, match_options_id, created_at)
    VALUES (
      tournament_ids[4],
      'Adria Championship 2025',
      'Championship featuring round robin group stage followed by double elimination playoffs. 8 teams compete for the title.',
      now() - interval '60 days',
      p_steam_ids[1],
      'Finished',
      t4_de_options_id,
      now() - interval '75 days'
    );

    -- Stage 1: Round Robin (2 groups of 4)
    INSERT INTO tournament_stages (id, tournament_id, type, "order", min_teams, max_teams, match_options_id)
    VALUES (t4_stage1_id, tournament_ids[4], 'RoundRobin', 1, 8, 8, t4_rr_options_id);

    -- Stage 2: Double Elimination (top 2 from each group = 4 teams)
    INSERT INTO tournament_stages (id, tournament_id, type, "order", min_teams, max_teams, match_options_id)
    VALUES (t4_stage2_id, tournament_ids[4], 'DoubleElimination', 2, 4, 4, t4_de_options_id);

    -- Register all 8 teams
    FOR t IN 1..8 LOOP
      INSERT INTO tournament_teams (id, team_id, tournament_id, name, owner_steam_id, seed, eligible_at)
      VALUES (
        gen_random_uuid(),
        team_ids[t],
        tournament_ids[4],
        team_names[t],
        p_steam_ids[(t - 1) * 5 + 1],
        t,
        now() - interval '70 days'
      );
    END LOOP;

    SELECT ARRAY(SELECT id FROM tournament_teams WHERE tournament_id = tournament_ids[4] ORDER BY seed) INTO t4_team_ids;

    -- Add roster for tournament 4 teams
    FOR t IN 1..8 LOOP
      FOR j IN 1..5 LOOP
        INSERT INTO tournament_team_roster (tournament_team_id, player_steam_id, tournament_id, role)
        VALUES (t4_team_ids[t], p_steam_ids[(t - 1) * 5 + j], tournament_ids[4], CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;

    -- ==========================================
    -- Stage 1: Round Robin brackets
    -- Group 1: seeds 1,3,5,7 → T1(Astra Force), T3(Crimson Wolves), T5(Echo Storm), T7(Shadow Vipers)
    -- Group 2: seeds 2,4,6,8 → T2(Blitz Brigade), T4(Dark Phoenix), T6(Frost Giants), T8(Titan Guard)
    -- ==========================================

    -- Group 1 Round Robin (path='WB', group=1)
    -- R1 M1: T1 vs T7 (seed 1 vs seed 7)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m1, t4_stage1_id, t4_team_ids[1], t4_team_ids[7], 1, 1, 'WB', 1, 1, 7, true);
    -- R1 M2: T3 vs T5 (seed 3 vs seed 5)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m2, t4_stage1_id, t4_team_ids[3], t4_team_ids[5], 1, 2, 'WB', 1, 3, 5, true);
    -- R2 M3: T1 vs T3 (seed 1 vs seed 3)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m3, t4_stage1_id, t4_team_ids[1], t4_team_ids[3], 2, 3, 'WB', 1, 1, 3, true);
    -- R2 M4: T5 vs T7 (seed 5 vs seed 7)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m4, t4_stage1_id, t4_team_ids[5], t4_team_ids[7], 2, 4, 'WB', 1, 5, 7, true);
    -- R3 M5: T1 vs T5 (seed 1 vs seed 5)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m5, t4_stage1_id, t4_team_ids[1], t4_team_ids[5], 3, 5, 'WB', 1, 1, 5, true);
    -- R3 M6: T7 vs T3 (seed 7 vs seed 3)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g1_m6, t4_stage1_id, t4_team_ids[7], t4_team_ids[3], 3, 6, 'WB', 1, 7, 3, true);

    -- Group 2 Round Robin (path='WB', group=2)
    -- R1 M1: T2 vs T8 (seed 2 vs seed 8)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m1, t4_stage1_id, t4_team_ids[2], t4_team_ids[8], 1, 1, 'WB', 2, 2, 8, true);
    -- R1 M2: T4 vs T6 (seed 4 vs seed 6)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m2, t4_stage1_id, t4_team_ids[4], t4_team_ids[6], 1, 2, 'WB', 2, 4, 6, true);
    -- R2 M3: T2 vs T4 (seed 2 vs seed 4)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m3, t4_stage1_id, t4_team_ids[2], t4_team_ids[4], 2, 3, 'WB', 2, 2, 4, true);
    -- R2 M4: T6 vs T8 (seed 6 vs seed 8)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m4, t4_stage1_id, t4_team_ids[6], t4_team_ids[8], 2, 4, 'WB', 2, 6, 8, true);
    -- R3 M5: T2 vs T6 (seed 2 vs seed 6)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m5, t4_stage1_id, t4_team_ids[2], t4_team_ids[6], 3, 5, 'WB', 2, 2, 6, true);
    -- R3 M6: T8 vs T4 (seed 8 vs seed 4)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", team_1_seed, team_2_seed, finished)
    VALUES (t4_rr_g2_m6, t4_stage1_id, t4_team_ids[8], t4_team_ids[4], 3, 6, 'WB', 2, 8, 4, true);

    -- ==========================================
    -- Stage 2: Double Elimination brackets
    -- Advancing: T1, T3 (from G1), T2, T4 (from G2)
    -- ==========================================

    -- Winners Bracket SF1 (round=1): T1 vs T4 → T1 wins
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", parent_bracket_id, loser_parent_bracket_id, finished)
    VALUES (t4_wb_sf1, t4_stage2_id, t4_team_ids[1], t4_team_ids[4], 1, 1, 'WB', 1, t4_wb_final, t4_lb_r1, true);

    -- Winners Bracket SF2 (round=1): T2 vs T3 → T2 wins
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", parent_bracket_id, loser_parent_bracket_id, finished)
    VALUES (t4_wb_sf2, t4_stage2_id, t4_team_ids[2], t4_team_ids[3], 1, 2, 'WB', 1, t4_wb_final, t4_lb_r1, true);

    -- Winners Bracket Final (round=2): T1 vs T2 → T1 wins
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", parent_bracket_id, loser_parent_bracket_id, finished)
    VALUES (t4_wb_final, t4_stage2_id, t4_team_ids[1], t4_team_ids[2], 2, 1, 'WB', 1, t4_gf, t4_lb_r2, true);

    -- Losers Bracket R1 (round=1): T4 vs T3 → T3 wins
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", parent_bracket_id, finished)
    VALUES (t4_lb_r1, t4_stage2_id, t4_team_ids[4], t4_team_ids[3], 1, 1, 'LB', 2, t4_lb_r2, true);

    -- Losers Bracket R2 (round=2): T2 vs T3 → T2 wins
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", parent_bracket_id, finished)
    VALUES (t4_lb_r2, t4_stage2_id, t4_team_ids[2], t4_team_ids[3], 2, 1, 'LB', 2, t4_gf, true);

    -- Grand Final (round=3): T1 vs T2 → T1 wins (Champion!)
    INSERT INTO tournament_brackets (id, tournament_stage_id, tournament_team_id_1, tournament_team_id_2, round, match_number, path, "group", match_options_id, finished)
    VALUES (t4_gf, t4_stage2_id, t4_team_ids[1], t4_team_ids[2], 3, 1, 'WB', 1, t4_gf_options_id, true);

    -- Create matches linked to all 18 finished brackets
    -- RR G1: T1vT7(1w), T3vT5(1w), T1vT3(1w), T5vT7(1w), T1vT5(1w), T7vT3(2w)
    -- RR G2: T2vT8(1w), T4vT6(1w), T2vT4(1w), T6vT8(1w), T2vT6(1w), T8vT4(2w)
    -- DE:    T1vT4(1w), T2vT3(1w), T1vT2(1w), T4vT3(2w), T2vT3(1w), T1vT2(1w)
    DECLARE
      t4_all_br uuid[] := ARRAY[
        t4_rr_g1_m1, t4_rr_g1_m2, t4_rr_g1_m3, t4_rr_g1_m4, t4_rr_g1_m5, t4_rr_g1_m6,
        t4_rr_g2_m1, t4_rr_g2_m2, t4_rr_g2_m3, t4_rr_g2_m4, t4_rr_g2_m5, t4_rr_g2_m6,
        t4_wb_sf1, t4_wb_sf2, t4_wb_final, t4_lb_r1, t4_lb_r2, t4_gf
      ];
      t4_m_t1 int[] := ARRAY[1,3,1,5,1,7,  2,4,2,6,2,8,  1,2,1,4,2,1];
      t4_m_t2 int[] := ARRAY[7,5,3,7,5,3,  8,6,4,8,6,4,  4,3,2,3,3,2];
      -- 1=team1 wins, 2=team2 wins
      t4_m_win int[] := ARRAY[1,1,1,1,1,2,  1,1,1,1,1,2,  1,1,1,2,1,1];
      t4_m_bo int[] := ARRAY[1,1,1,1,1,1,  1,1,1,1,1,1,  1,1,1,1,1,5];
      t4_mid uuid; t4_moid uuid; t4_l1id uuid; t4_l2id uuid; t4_mmid uuid;
      t4_mdate timestamptz;
      t4_l1s int; t4_l2s int;
    BEGIN
      FOR i IN 1..18 LOOP
        -- RR matches: 58-53 days ago, DE matches: 50-45 days ago
        IF i <= 12 THEN
          t4_mdate := (now() - interval '58 days') + (interval '1 day' * ((i - 1) / 2));
        ELSE
          t4_mdate := (now() - interval '50 days') + (interval '1 day' * (i - 13));
        END IF;

        t4_moid := gen_random_uuid(); t4_mid := gen_random_uuid();
        t4_l1id := gen_random_uuid(); t4_l2id := gen_random_uuid();
        t4_mmid := gen_random_uuid();

        INSERT INTO match_options (id, overtime, knife_round, mr, best_of, map_veto, type, map_pool_id, lobby_access, tv_delay)
        VALUES (t4_moid, true, true, 12, t4_m_bo[i], true, 'Competitive', comp_map_pool_id, 'Private', 115);

        INSERT INTO match_lineups (id, team_id, team_name) VALUES
          (t4_l1id, team_ids[t4_m_t1[i]], team_names[t4_m_t1[i]]),
          (t4_l2id, team_ids[t4_m_t2[i]], team_names[t4_m_t2[i]]);

        INSERT INTO matches (id, status, match_options_id, lineup_1_id, lineup_2_id,
                             created_at, scheduled_at, started_at, ended_at, winning_lineup_id)
        VALUES (t4_mid, 'Finished', t4_moid, t4_l1id, t4_l2id,
                t4_mdate - interval '1 hour', t4_mdate, t4_mdate,
                t4_mdate + interval '45 minutes',
                CASE WHEN t4_m_win[i] = 1 THEN t4_l1id ELSE t4_l2id END);

        FOR j IN 1..5 LOOP
          INSERT INTO match_lineup_players (match_lineup_id, steam_id, captain, checked_in) VALUES
            (t4_l1id, p_steam_ids[(t4_m_t1[i] - 1) * 5 + j], j = 1, true),
            (t4_l2id, p_steam_ids[(t4_m_t2[i] - 1) * 5 + j], j = 1, true);
        END LOOP;

        INSERT INTO match_maps (id, match_id, map_id, "order", status, lineup_1_side, lineup_2_side, started_at, ended_at, winning_lineup_id)
        VALUES (t4_mmid, t4_mid, map_ids[((i - 1) % map_count) + 1], 1, 'Finished', 'CT', 'TERRORIST', t4_mdate, t4_mdate + interval '40 minutes',
                CASE WHEN t4_m_win[i] = 1 THEN t4_l1id ELSE t4_l2id END);

        -- Veto picks
        DECLARE ban_n int := 0; t4_cur_map uuid := map_ids[((i - 1) % map_count) + 1];
        BEGIN
          FOR j IN 1..map_count LOOP
            IF map_ids[j] != t4_cur_map THEN
              ban_n := ban_n + 1;
              INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, created_at)
              VALUES (t4_mid, 'Ban', CASE WHEN ban_n % 2 = 1 THEN t4_l1id ELSE t4_l2id END,
                      map_ids[j], t4_mdate - interval '10 minutes' + (interval '30 seconds' * ban_n));
            END IF;
          END LOOP;
        END;

        -- Generate rounds and kills
        IF t4_m_win[i] = 1 THEN
          t4_l1s := 13; t4_l2s := 5 + (i % 7);
        ELSE
          t4_l1s := 5 + (i % 7); t4_l2s := 13;
        END IF;

        v_t1_wins := 0; v_t2_wins := 0;
        FOR round_num IN 1..(t4_l1s + t4_l2s) LOOP
          IF v_t1_wins * (t4_l1s + t4_l2s) < round_num * t4_l1s AND v_t1_wins < t4_l1s THEN
            v_t1_wins := v_t1_wins + 1;
            winning_side := CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END;
          ELSE
            v_t2_wins := v_t2_wins + 1;
            winning_side := CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END;
          END IF;

          INSERT INTO match_map_rounds (match_map_id, round, lineup_1_score, lineup_2_score,
            lineup_1_money, lineup_2_money, time, lineup_1_timeouts_available, lineup_2_timeouts_available,
            winning_side, lineup_1_side, lineup_2_side)
          VALUES (t4_mmid, round_num, v_t1_wins, v_t2_wins,
            4100 + (round_num * 300), 4100 + (round_num * 300),
            t4_mdate + (interval '2 minutes' * round_num), 2, 2,
            winning_side,
            CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
            CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END);

          FOR k IN 1..5 LOOP
            INSERT INTO player_kills (match_id, match_map_id, round,
              attacker_steam_id, attacker_team, attacked_steam_id, attacked_team, attacked_location,
              "with", hitgroup, headshot, time)
            VALUES (t4_mid, t4_mmid, round_num,
              p_steam_ids[(CASE WHEN k % 2 = 1 THEN t4_m_t1[i] ELSE t4_m_t2[i] END - 1) * 5 + ((k - 1) % 5) + 1],
              CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'CT' ELSE 'TERRORIST' END,
              p_steam_ids[(CASE WHEN k % 2 = 1 THEN t4_m_t2[i] ELSE t4_m_t1[i] END - 1) * 5 + ((k + round_num) % 5) + 1],
              CASE WHEN (k % 2 = 1) = (round_num <= 12) THEN 'TERRORIST' ELSE 'CT' END,
              'BombsiteA', weapons[((i + round_num + k) % array_length(weapons, 1)) + 1],
              CASE WHEN (round_num + k) % 3 = 0 THEN 'head' ELSE hitgroups[((k + round_num) % 6) + 2] END,
              (round_num + k) % 3 = 0,
              t4_mdate + (interval '2 minutes' * round_num) + (interval '5 seconds' * k))
            ON CONFLICT DO NOTHING;
          END LOOP;

          -- Utility events
          DECLARE
            ut timestamptz;
            fp1 int := (t4_m_t1[i] - 1) * 5 + ((round_num + 1) % 5) + 1;
            fp2 int := (t4_m_t2[i] - 1) * 5 + ((round_num + 2) % 5) + 1;
          BEGIN
            ut := t4_mdate + (interval '2 minutes' * round_num) + interval '40 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t4_mmid, p_steam_ids[fp1], ut, t4_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (t4_mmid, ut + interval '1 second', p_steam_ids[fp1],
                    p_steam_ids[(t4_m_t2[i] - 1) * 5 + ((round_num + 3) % 5) + 1],
                    t4_mid, round_num, 1.5 + (round_num % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

            ut := t4_mdate + (interval '2 minutes' * round_num) + interval '50 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t4_mmid, p_steam_ids[fp2], ut, t4_mid, round_num, 'Flash') ON CONFLICT DO NOTHING;
            INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
            VALUES (t4_mmid, ut + interval '1 second', p_steam_ids[fp2],
                    p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 4) % 5) + 1],
                    t4_mid, round_num, 1.5 + ((round_num + 1) % 3)::numeric * 0.5, false) ON CONFLICT DO NOTHING;

            IF round_num % 3 = 0 THEN
              INSERT INTO player_flashes (match_map_id, time, attacker_steam_id, attacked_steam_id, match_id, round, duration, team_flash)
              VALUES (t4_mmid, ut + interval '2 seconds', p_steam_ids[fp1],
                      p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 2) % 5) + 1],
                      t4_mid, round_num, 0.8 + (round_num % 2)::numeric * 0.4, true) ON CONFLICT DO NOTHING;
            END IF;

            ut := t4_mdate + (interval '2 minutes' * round_num) + interval '35 seconds';
            INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
            VALUES (t4_mmid, p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 3) % 5) + 1], ut, t4_mid, round_num, 'Smoke') ON CONFLICT DO NOTHING;

            ut := t4_mdate + (interval '2 minutes' * round_num) + interval '55 seconds';
            IF round_num % 2 = 0 THEN
              INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
              VALUES (t4_mmid, p_steam_ids[(t4_m_t2[i] - 1) * 5 + (round_num % 5) + 1], ut, t4_mid, round_num, 'HighExplosive') ON CONFLICT DO NOTHING;
              INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
                attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
              VALUES (t4_mid, t4_mmid, round_num,
                p_steam_ids[(t4_m_t2[i] - 1) * 5 + (round_num % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
                p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 1) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
                'BombsiteA', 'hegrenade', 15 + (round_num % 30), 0, 85 - (round_num % 30), 100, 'chest', ut + interval '0.3 seconds');
            ELSE
              INSERT INTO player_utility (match_map_id, attacker_steam_id, time, match_id, round, type)
              VALUES (t4_mmid, p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 4) % 5) + 1], ut, t4_mid, round_num, 'Molotov') ON CONFLICT DO NOTHING;
              INSERT INTO player_damages (match_id, match_map_id, round, attacker_steam_id, attacker_team,
                attacked_steam_id, attacked_team, attacked_location, "with", damage, damage_armor, health, armor, hitgroup, time)
              VALUES (t4_mid, t4_mmid, round_num,
                p_steam_ids[(t4_m_t1[i] - 1) * 5 + ((round_num + 4) % 5) + 1], CASE WHEN round_num <= 12 THEN 'CT' ELSE 'TERRORIST' END,
                p_steam_ids[(t4_m_t2[i] - 1) * 5 + ((round_num + 2) % 5) + 1], CASE WHEN round_num <= 12 THEN 'TERRORIST' ELSE 'CT' END,
                'BombsiteA', 'inferno', 10 + (round_num % 25), 0, 90 - (round_num % 25), 100, 'chest', ut + interval '0.5 seconds');
            END IF;
          END;
        END LOOP;

        UPDATE tournament_brackets SET match_id = t4_mid WHERE id = t4_all_br[i];
      END LOOP;
    END;
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
ALTER TABLE match_map_veto_picks ENABLE TRIGGER ALL;
