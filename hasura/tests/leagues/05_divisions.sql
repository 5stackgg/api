-- Division ladder rules: every tier is a promotion/relegation target whether or
-- not it has teams that season; tiers renumber on delete; and teams in the
-- top/bottom division never promote above / relegate below the ladder.
\set ON_ERROR_STOP on

SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "90500000000000001"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);

-- ===========================================================================
-- Part A: the ladder can shrink to one division or none; tiers renumber
-- ===========================================================================
DO $guard$
DECLARE
    _d1 uuid;
    _d2 uuid;
    _d3 uuid;
    _tier int;
BEGIN
    RAISE NOTICE '=== DIVISION LADDER GUARDS ===';

    -- Free tiers 1-3 from the seeded default ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    INSERT INTO league_divisions (name, tier) VALUES ('Guard 1', 1) RETURNING id INTO _d1;
    INSERT INTO league_divisions (name, tier) VALUES ('Guard 2', 2) RETURNING id INTO _d2;
    INSERT INTO league_divisions (name, tier) VALUES ('Guard 3', 3) RETURNING id INTO _d3;

    -- Delete the middle division: allowed, and tiers renumber so the bottom
    -- division moves from tier 3 to tier 2.
    DELETE FROM league_divisions WHERE id = _d2;
    SELECT tier INTO _tier FROM league_divisions WHERE id = _d3;
    IF _tier != 2 THEN
        RAISE EXCEPTION 'ASSERT FAILED: tiers should renumber to 1..N on delete, Guard 3 tier = %', _tier;
    END IF;

    -- Down to a single division: allowed. Nothing promotes out of a one-tier
    -- ladder, but the ladder itself is valid.
    DELETE FROM league_divisions WHERE id = _d3;
    SELECT tier INTO _tier FROM league_divisions WHERE id = _d1;
    IF _tier != 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: lone division should be tier 1, got %', _tier;
    END IF;

    -- And down to none: allowed (turns the ladder off).
    DELETE FROM league_divisions WHERE id = _d1;
    IF (SELECT COUNT(*) FROM league_divisions WHERE id IN (_d1, _d2, _d3)) != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: deleting every division should be allowed';
    END IF;

    RAISE NOTICE 'Part A OK';
END;
$guard$;

-- ===========================================================================
-- Part B: teams in the top division never promote above it; relegation still
-- targets an (empty) lower division.
-- ===========================================================================
DO $extremes$
DECLARE
    _pool_id uuid;
    _map_id uuid;
    _options_id uuid;
    _div_top uuid;
    _div_low uuid;
    _season_id uuid;
    _tournament_id uuid;
    _rr_stage uuid;
    _tid uuid;
    _lt uuid;
    _lts uuid;
    _bracket RECORD;
    _cnt int;
    i int;
    j int;
BEGIN
    RAISE NOTICE '=== TOP-DIVISION MOVEMENTS ===';

    FOR i IN 1..20 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (90500000000000000 + i, 'Ladder Player ' || i,
                'https://example.com/l' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW())
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    FOR i IN 1..5 LOOP
        INSERT INTO maps (name, type, active_pool) VALUES ('de_ladder_test_' || i, 'Competitive', true)
        RETURNING id INTO _map_id;
        INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id);
    END LOOP;

    INSERT INTO match_options (overtime, knife_round, mr, best_of, map_veto, region_veto, type, map_pool_id, tv_delay, coaches)
    VALUES (true, true, 12, 1, false, false, 'Competitive', _pool_id, 115, false)
    RETURNING id INTO _options_id;

    FOR i IN 1..4 LOOP
        INSERT INTO teams (name, short_name, owner_steam_id)
        VALUES ('Ladder Team ' || i, 'LD' || i, 90500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _tid;
        FOR j IN 1..5 LOOP
            INSERT INTO team_roster (team_id, player_steam_id, role)
            VALUES (_tid, 90500000000000000 + ((i - 1) * 5 + j), 'Member')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    -- Free tiers 1-2 from the seeded ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    -- Top division (tier 1) is where teams play; the lower division (tier 2) is
    -- an empty relegation target.
    INSERT INTO league_divisions (name, tier) VALUES ('Ladder Top', 1) RETURNING id INTO _div_top;
    -- No teams register into it this season; it must still be the relegation
    -- target for the division above.
    INSERT INTO league_divisions (name, tier) VALUES ('Ladder Low', 2) RETURNING id INTO _div_low;

    -- No playoff stage (playoff_seats = 0): the RR stage is the whole season,
    -- so finishing it finishes the tournament.
    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats,
                                match_options_id, default_best_of, min_roster_size, starts_at)
    VALUES (90500000000000001, 'Ladder Test Season', 3, 0, _options_id, 1, 5, NOW())
    RETURNING id INTO _season_id;

    FOR i IN 1..3 LOOP
        INSERT INTO league_match_weeks (league_season_id, week_number, opens_at, closes_at, default_match_at)
        VALUES (_season_id, i,
                NOW() - INTERVAL '2 hours' + ((i - 1) * INTERVAL '7 days'),
                NOW() - INTERVAL '2 hours' + (i * INTERVAL '7 days'),
                NOW() + INTERVAL '3 days' + ((i - 1) * INTERVAL '7 days'));
    END LOOP;

    UPDATE league_seasons SET status = 'RegistrationOpen' WHERE id = _season_id;

    FOR i IN 1..4 LOOP
        SELECT id INTO _tid FROM teams WHERE name = 'Ladder Team ' || i;
        INSERT INTO league_teams (team_id) VALUES (_tid)
        RETURNING id INTO _lt;
        INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
        VALUES (_season_id, _lt, 90500000000000001)
        RETURNING id INTO _lts;
        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 90500000000000000 + ((i - 1) * 5 + j));
        END LOOP;
    END LOOP;

    -- All four approved into the top division.
    UPDATE league_team_seasons
    SET status = 'Approved', assigned_division_id = _div_top, seed = idx.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
          FROM league_team_seasons WHERE league_season_id = _season_id) idx
    WHERE league_team_seasons.id = idx.id;

    UPDATE league_seasons SET status = 'RegistrationClosed' WHERE id = _season_id;
    UPDATE league_seasons SET status = 'Live' WHERE id = _season_id;

    SELECT tournament_id INTO _tournament_id
    FROM league_season_divisions
    WHERE league_season_id = _season_id AND league_division_id = _div_top;
    IF _tournament_id IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: top division tournament was not materialized';
    END IF;
    SELECT id INTO _rr_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 1;

    -- Play out the regular season by forfeiting every matchup to team 1, giving
    -- a clean rank order (team 1 top, later teams bottom).
    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _rr_stage AND tb.finished = false
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM league_award_forfeit(
            _bracket.id,
            LEAST(_bracket.tournament_team_id_1, _bracket.tournament_team_id_2),
            current_setting('hasura.user')::json
        );
    END LOOP;

    IF (SELECT status FROM tournaments WHERE id = _tournament_id) != 'Finished' THEN
        RAISE EXCEPTION 'ASSERT FAILED: single-stage tournament should be Finished, got %',
            (SELECT status FROM tournaments WHERE id = _tournament_id);
    END IF;

    UPDATE league_seasons SET status = 'Finished' WHERE id = _season_id;

    -- No team in the top division may be promoted (nothing is above tier 1).
    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type = 'DirectPromote';
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: top-division teams should never promote, got % Promote rows', _cnt;
    END IF;

    -- Relegation still works into the lower division even though it is inactive
    -- (did not run this season) and therefore empty.
    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type = 'DirectRelegate' AND computed_to_division_id = _div_low;
    IF _cnt < 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: bottom of the top division should relegate into the inactive lower division';
    END IF;

    RAISE NOTICE 'Part B OK';
END;
$extremes$;

-- ===========================================================================
-- Part C: seasons cannot overlap another still-scheduled season's window.
-- ===========================================================================
DO $overlap$
DECLARE
    _s1 uuid;
    _blocked boolean;
BEGIN
    RAISE NOTICE '=== SEASON OVERLAP GUARD ===';

    INSERT INTO league_seasons (created_by_steam_id, signup_opens_at, starts_at, match_weeks_count)
    VALUES (90500000000000001, NOW() + INTERVAL '90 days', NOW() + INTERVAL '100 days', 3)
    RETURNING id INTO _s1;

    -- A season whose window overlaps _s1 is rejected.
    _blocked := false;
    BEGIN
        INSERT INTO league_seasons (created_by_steam_id, signup_opens_at, starts_at, match_weeks_count)
        VALUES (90500000000000001, NOW() + INTERVAL '95 days', NOW() + INTERVAL '105 days', 3);
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _blocked := true;
    END;
    IF NOT _blocked THEN
        RAISE EXCEPTION 'ASSERT FAILED: overlapping season should have raised';
    END IF;

    -- A season scheduled well after _s1 is allowed.
    INSERT INTO league_seasons (created_by_steam_id, signup_opens_at, starts_at, match_weeks_count)
    VALUES (90500000000000001, NOW() + INTERVAL '190 days', NOW() + INTERVAL '200 days', 3);

    RAISE NOTICE 'Part C OK';
END;
$overlap$;
