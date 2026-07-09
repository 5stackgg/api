-- Playoff format smoke test: double-elimination playoffs with a BO5 grand
-- final, and a single-elim season with a third-place decider match.
\set ON_ERROR_STOP on

SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "88500000000000001"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);

DO $format$
DECLARE
    _pool_id uuid;
    _map_id uuid;
    _options_id uuid;
    _div_open uuid;
    _season_id uuid;
    _tid uuid;
    _lt uuid;
    _lts uuid;
    _tournament_id uuid;
    _rr_stage uuid;
    _po_stage uuid;
    _bracket RECORD;
    _match_best_of int;
    _cnt int;
    _val text;
    _guarded boolean;
    i int;
    j int;
BEGIN
    RAISE NOTICE '=== PF SETUP ===';

    FOR i IN 1..30 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (88500000000000000 + i, 'PF Player ' || i,
                'https://example.com/pf' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW())
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    FOR i IN 1..5 LOOP
        INSERT INTO maps (name, type, active_pool) VALUES ('de_pf_test_' || i, 'Competitive', true)
        RETURNING id INTO _map_id;
        INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id);
    END LOOP;

    INSERT INTO match_options (overtime, knife_round, mr, best_of, map_veto, region_veto, type, map_pool_id, tv_delay, coaches)
    VALUES (true, true, 12, 1, false, false, 'Competitive', _pool_id, 115, false)
    RETURNING id INTO _options_id;

    FOR i IN 1..6 LOOP
        INSERT INTO teams (name, short_name, owner_steam_id)
        VALUES ('PF Team ' || i, 'PF' || i, 88500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _tid;
        FOR j IN 1..5 LOOP
            INSERT INTO team_roster (team_id, player_steam_id, role)
            VALUES (_tid, 88500000000000000 + ((i - 1) * 5 + j), 'Member')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    -- Free tier 1 from the seeded default ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    INSERT INTO league_divisions (name, tier) VALUES ('PF Open', 1)
    RETURNING id INTO _div_open;

    RAISE NOTICE '=== DOUBLE-ELIM SEASON, GF IS BO5, LB R1 IS BO3 ===';

    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, default_best_of, playoff_best_of, min_roster_size,
                                starts_at, playoff_stage_type, playoff_round_best_of)
    VALUES (88500000000000001, 'PF Test League DE', 3, 4, 0, 0, _options_id, 1, 1, 5,
            NOW(), 'DoubleElimination', '{"GF": 5, "LB:1": 3}'::jsonb)
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
        SELECT id INTO _tid FROM teams WHERE name = 'PF Team ' || i;
        INSERT INTO league_teams (team_id)
        VALUES (_tid)
        RETURNING id INTO _lt;
        INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
        VALUES (_season_id, _lt, 88500000000000001)
        RETURNING id INTO _lts;
        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 88500000000000000 + ((i - 1) * 5 + j));
        END LOOP;
    END LOOP;

    UPDATE league_team_seasons
    SET status = 'Approved', assigned_division_id = _div_open, seed = idx.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
          FROM league_team_seasons WHERE league_season_id = _season_id) idx
    WHERE league_team_seasons.id = idx.id;

    UPDATE league_seasons SET status = 'RegistrationClosed' WHERE id = _season_id;
    UPDATE league_seasons SET status = 'Live' WHERE id = _season_id;

    SELECT tournament_id INTO _tournament_id
    FROM league_season_divisions WHERE league_season_id = _season_id;
    SELECT id INTO _rr_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 1;
    SELECT id INTO _po_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 2;

    IF (SELECT type FROM tournament_stages WHERE id = _po_stage) != 'DoubleElimination' THEN
        RAISE EXCEPTION 'ASSERT FAILED: playoff stage should be DoubleElimination';
    END IF;

    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _po_stage AND path = 'LB';
    IF _cnt < 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected losers-bracket matches, got %', _cnt;
    END IF;

    SELECT settings->'round_best_of'->>'GF' INTO _val
    FROM tournament_stages WHERE id = _po_stage;
    IF _val IS DISTINCT FROM '5' THEN
        RAISE EXCEPTION 'ASSERT FAILED: GF best-of expected 5, got %', _val;
    END IF;

    -- Structural changes are locked once the season is running.
    _guarded := false;
    BEGIN
        UPDATE league_seasons SET playoff_stage_type = 'SingleElimination' WHERE id = _season_id;
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: playoff format change after start should have raised';
    END IF;

    RAISE NOTICE '=== DRIVE DE PLAYOFFS TO THE GRAND FINAL ===';

    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _rr_stage AND tb.finished = false
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
    END LOOP;

    RAISE NOTICE '=== CAPTAINS SCHEDULE A PLAYOFF MATCHUP ===';

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _po_stage
      AND tb.finished = false
      AND tb.tournament_team_id_1 IS NOT NULL
      AND tb.tournament_team_id_2 IS NOT NULL
    ORDER BY tb.round, tb.match_number
    LIMIT 1;

    -- Beyond the two-week playoff window is rejected.
    _guarded := false;
    BEGIN
        INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
        VALUES (_bracket.id, 88500000000000001, NOW() + INTERVAL '30 days');
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: out-of-window playoff proposal should have raised';
    END IF;

    DECLARE
        _po_proposal uuid;
    BEGIN
        INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
        VALUES (_bracket.id, 88500000000000001, NOW() + INTERVAL '3 days')
        RETURNING id INTO _po_proposal;
        UPDATE league_scheduling_proposals SET status = 'Accepted' WHERE id = _po_proposal;
    END;

    IF (SELECT scheduled_at FROM tournament_brackets WHERE id = _bracket.id) IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: accepted playoff proposal did not schedule the bracket';
    END IF;

    -- Clear it again so the forfeit-driven run below proceeds immediately.
    UPDATE tournament_brackets SET scheduled_at = NULL WHERE id = _bracket.id;
    _bracket := NULL;

    -- Forfeit playoff matchups as they become ready until only the GF remains.
    FOR i IN 1..12 LOOP
        SELECT tb.* INTO _bracket FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _po_stage
          AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
        ORDER BY tb.round, tb.match_number
        LIMIT 1;
        EXIT WHEN _bracket IS NULL;
        RAISE NOTICE 'PF loop %: % round % match %', i, _bracket.path, _bracket.round, _bracket.match_number;

        -- The last remaining matchup chain ends at the grand final: check its
        -- materialized best-of before finishing it.
        SELECT COUNT(*) INTO _cnt FROM tournament_brackets
        WHERE tournament_stage_id = _po_stage AND finished = false;

        IF _cnt = 1 THEN
            UPDATE tournament_brackets SET scheduled_at = NOW() WHERE id = _bracket.id;
            PERFORM schedule_tournament_match(tb) FROM tournament_brackets tb WHERE tb.id = _bracket.id;

            SELECT mo.best_of INTO _match_best_of
            FROM tournament_brackets tb
            JOIN matches m ON m.id = tb.match_id
            JOIN match_options mo ON mo.id = m.match_options_id
            WHERE tb.id = _bracket.id;
            IF _match_best_of != 5 THEN
                RAISE EXCEPTION 'ASSERT FAILED: grand final best_of expected 5, got %', _match_best_of;
            END IF;
        END IF;

        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
        _bracket := NULL;
    END LOOP;

    IF (SELECT status FROM tournaments WHERE id = _tournament_id) != 'Finished' THEN
        RAISE EXCEPTION 'ASSERT FAILED: DE tournament should be Finished, got %',
            (SELECT status FROM tournaments WHERE id = _tournament_id);
    END IF;

    RAISE NOTICE '=== SINGLE-ELIM SEASON WITH THIRD-PLACE DECIDER ===';

    UPDATE league_seasons SET status = 'Finished' WHERE id = _season_id;

    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, default_best_of, playoff_best_of, min_roster_size,
                                starts_at, playoff_stage_type, playoff_third_place_match, status)
    VALUES (88500000000000001, 'PF Test League SE', 3, 4, 0, 0, clone_match_options(_options_id), 1, 3, 5,
            NOW(), 'SingleElimination', true, 'RegistrationOpen')
    RETURNING id INTO _season_id;

    FOR i IN 1..3 LOOP
        INSERT INTO league_match_weeks (league_season_id, week_number, opens_at, closes_at, default_match_at)
        VALUES (_season_id, i,
                NOW() - INTERVAL '2 hours' + ((i - 1) * INTERVAL '7 days'),
                NOW() - INTERVAL '2 hours' + (i * INTERVAL '7 days'),
                NOW() + INTERVAL '3 days' + ((i - 1) * INTERVAL '7 days'));
    END LOOP;

    FOR i IN 1..4 LOOP
        SELECT lt.id INTO _lt FROM league_teams lt
        JOIN teams t ON t.id = lt.team_id
        WHERE t.name = 'PF Team ' || i;

        INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
        VALUES (_season_id, _lt, 88500000000000001)
        RETURNING id INTO _lts;
        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 88500000000000000 + ((i - 1) * 5 + j));
        END LOOP;
    END LOOP;

    UPDATE league_team_seasons
    SET status = 'Approved', assigned_division_id = _div_open, seed = idx.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
          FROM league_team_seasons WHERE league_season_id = _season_id) idx
    WHERE league_team_seasons.id = idx.id AND league_team_seasons.league_season_id = _season_id;

    UPDATE league_seasons SET status = 'RegistrationClosed' WHERE id = _season_id;
    UPDATE league_seasons SET status = 'Live' WHERE id = _season_id;

    SELECT tournament_id INTO _tournament_id
    FROM league_season_divisions
    WHERE league_season_id = _season_id;
    SELECT id INTO _po_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 2;

    IF (SELECT third_place_match FROM tournament_stages WHERE id = _po_stage) != true THEN
        RAISE EXCEPTION 'ASSERT FAILED: SE playoff stage should have third_place_match';
    END IF;

    -- 4 seats -> semis (2) + final + third-place decider = 4 brackets.
    SELECT COUNT(*) INTO _cnt FROM tournament_brackets WHERE tournament_stage_id = _po_stage;
    IF _cnt != 4 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 4 SE playoff brackets (incl. 3rd place), got %', _cnt;
    END IF;

    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _po_stage AND loser_parent_bracket_id IS NOT NULL;
    IF _cnt != 2 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected both semifinals to route losers to the decider, got %', _cnt;
    END IF;

    RAISE NOTICE '=== ALL PLAYOFF FORMAT SMOKE TESTS PASSED ===';
END;
$format$;
