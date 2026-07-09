-- League feature smoke test: full season lifecycle on a scratch database.
\set ON_ERROR_STOP on

-- Hasura always sets this GUC on its connections; raw psql needs it for the
-- pre-existing team_roster triggers.
SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "86500000000000001"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);

DO $smoke$
DECLARE
    _map_id uuid;
    _pool_id uuid;
    _options_id uuid;
    _div_invite uuid;
    _div_open uuid;
    _season_id uuid;
    _season2_id uuid;
    _team_ids uuid[] := '{}';
    _league_team_ids uuid[] := '{}';
    _lts_ids uuid[] := '{}';
    _tid uuid;
    _lt uuid;
    _lts uuid;
    _tournament_id uuid;
    _rr_stage uuid;
    _se_stage uuid;
    _bracket RECORD;
    _proposal_id uuid;
    _match_id uuid;
    _cnt int;
    _cnt2 int;
    _ts timestamptz;
    _locked boolean := false;
    i int;
    j int;
BEGIN
    RAISE NOTICE '=== SETUP: players, teams, maps, options ===';

    FOR i IN 1..25 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (86500000000000000 + i, 'League Player ' || i,
                'https://example.com/p' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW() - INTERVAL '90 days')
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    FOR i IN 1..3 LOOP
        INSERT INTO maps (name, type, active_pool) VALUES ('de_league_test_' || i, 'Competitive', true)
        RETURNING id INTO _map_id;
        INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id);
    END LOOP;

    -- Match creation requires at least one region with an attached server.
    INSERT INTO server_regions (value, is_lan) VALUES ('TestRegion', false)
    ON CONFLICT (value) DO NOTHING;
    INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
    VALUES ('127.0.0.1', 'league-test-server', '\x00'::bytea, 27015, true, 'TestRegion', 'Ranked', true);

    INSERT INTO match_options (overtime, knife_round, mr, best_of, map_veto, region_veto, type, map_pool_id, tv_delay, coaches)
    VALUES (true, true, 12, 1, false, false, 'Competitive', _pool_id, 115, false)
    RETURNING id INTO _options_id;

    FOR i IN 1..5 LOOP
        INSERT INTO teams (name, short_name, owner_steam_id)
        VALUES ('League Team ' || i, 'LT' || i, 86500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _tid;
        _team_ids := _team_ids || _tid;

        FOR j IN 1..5 LOOP
            INSERT INTO team_roster (team_id, player_steam_id, role)
            VALUES (_tid, 86500000000000000 + ((i - 1) * 5 + j), CASE WHEN j = 1 THEN 'Admin' ELSE 'Member' END)
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    RAISE NOTICE '=== LEAGUE + SEASON ===';

    -- Free tiers 1-4 from the seeded default ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    INSERT INTO league_divisions (name, tier) VALUES ('Invite', 1) RETURNING id INTO _div_invite;
    INSERT INTO league_divisions (name, tier) VALUES ('Open', 2) RETURNING id INTO _div_open;

    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, default_best_of, playoff_best_of, min_roster_size,
                                signup_opens_at, signup_closes_at, starts_at, roster_lock_at)
    VALUES (86500000000000001, 'LC Test League S1', 3, 2, 1, 1, _options_id, 1, 3, 5,
            NOW() - INTERVAL '7 days', NOW() + INTERVAL '1 hour', NOW(), NOW() + INTERVAL '2 days')
    RETURNING id INTO _season_id;

    FOR i IN 1..3 LOOP
        INSERT INTO league_match_weeks (league_season_id, week_number, opens_at, closes_at, default_match_at)
        VALUES (_season_id, i,
                NOW() - INTERVAL '2 hours' + ((i - 1) * INTERVAL '7 days'),
                NOW() - INTERVAL '2 hours' + (i * INTERVAL '7 days'),
                NOW() + INTERVAL '3 days' + ((i - 1) * INTERVAL '7 days'));
    END LOOP;

    RAISE NOTICE '=== REGISTRATION (4 teams into Open) ===';

    UPDATE league_seasons SET status = 'RegistrationOpen' WHERE id = _season_id;

    FOR i IN 1..4 LOOP
        INSERT INTO league_teams (team_id)
        VALUES (_team_ids[i])
        RETURNING id INTO _lt;
        _league_team_ids := _league_team_ids || _lt;

        INSERT INTO league_team_seasons (league_season_id, league_team_id, requested_division_id, registered_by_steam_id)
        VALUES (_season_id, _lt, _div_open, 86500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _lts;
        _lts_ids := _lts_ids || _lts;

        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 86500000000000000 + ((i - 1) * 5 + j));
        END LOOP;
    END LOOP;

    -- Approving without a division must fail.
    BEGIN
        UPDATE league_team_seasons SET status = 'Approved' WHERE id = _lts_ids[1];
        RAISE EXCEPTION 'ASSERT FAILED: approval without division should have raised';
    EXCEPTION WHEN SQLSTATE '22000' THEN
        NULL;
    END;

    UPDATE league_team_seasons
    SET status = 'Approved', assigned_division_id = _div_open, seed = idx.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
          FROM league_team_seasons WHERE league_season_id = _season_id) idx
    WHERE league_team_seasons.id = idx.id;

    SELECT COUNT(*) INTO _cnt FROM league_season_divisions
    WHERE league_season_id = _season_id AND league_division_id = _div_open;
    IF _cnt != 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 1 season division, got %', _cnt;
    END IF;

    RAISE NOTICE '=== SEASON START ===';

    UPDATE league_seasons SET status = 'RegistrationClosed' WHERE id = _season_id;
    UPDATE league_seasons SET status = 'Live' WHERE id = _season_id;

    SELECT tournament_id INTO _tournament_id
    FROM league_season_divisions
    WHERE league_season_id = _season_id AND league_division_id = _div_open;
    IF _tournament_id IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: division tournament was not materialized';
    END IF;

    IF (SELECT status FROM tournaments WHERE id = _tournament_id) != 'Live' THEN
        RAISE EXCEPTION 'ASSERT FAILED: division tournament is not Live';
    END IF;

    SELECT id INTO _rr_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 1;
    SELECT id INTO _se_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 2;
    IF _rr_stage IS NULL OR _se_stage IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected RR + SE stages';
    END IF;

    -- 4 teams -> 3 RR rounds x 2 matches = 6 brackets, all within 3 weeks.
    SELECT COUNT(*), COUNT(*) FILTER (WHERE round > 3) INTO _cnt, _cnt2
    FROM tournament_brackets WHERE tournament_stage_id = _rr_stage;
    IF _cnt != 6 OR _cnt2 != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 6 RR brackets within 3 rounds, got % (beyond: %)', _cnt, _cnt2;
    END IF;

    -- Dormancy: no schedules, no matches.
    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _rr_stage AND (scheduled_at IS NOT NULL OR match_id IS NOT NULL);
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: % RR brackets scheduled/materialized prematurely', _cnt;
    END IF;

    SELECT COUNT(*) INTO _cnt FROM tournament_teams WHERE tournament_id = _tournament_id;
    IF _cnt != 4 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 4 tournament teams, got %', _cnt;
    END IF;

    SELECT COUNT(*) INTO _cnt FROM tournament_team_roster WHERE tournament_id = _tournament_id;
    IF _cnt != 20 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 20 tournament roster rows, got %', _cnt;
    END IF;

    RAISE NOTICE '=== SCHEDULING NEGOTIATION ===';

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 1
    ORDER BY tb.match_number LIMIT 1;

    -- Proposal outside the week window must fail.
    BEGIN
        INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
        VALUES (_bracket.id, 86500000000000001, NOW() + INTERVAL '30 days');
        RAISE EXCEPTION 'ASSERT FAILED: out-of-window proposal should have raised';
    EXCEPTION WHEN SQLSTATE '22000' THEN
        NULL;
    END;

    INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
    VALUES (_bracket.id, 86500000000000001, NOW() + INTERVAL '5 minutes')
    RETURNING id INTO _proposal_id;

    -- Superseded/Expired are system-only; a direct write must be rejected.
    BEGIN
        UPDATE league_scheduling_proposals SET status = 'Superseded' WHERE id = _proposal_id;
        RAISE EXCEPTION 'ASSERT FAILED: direct Superseded write should have raised';
    EXCEPTION WHEN SQLSTATE '22000' THEN
        NULL;
    END;

    BEGIN
        UPDATE league_scheduling_proposals SET status = 'Expired' WHERE id = _proposal_id;
        RAISE EXCEPTION 'ASSERT FAILED: direct Expired write should have raised';
    EXCEPTION WHEN SQLSTATE '22000' THEN
        NULL;
    END;

    UPDATE league_scheduling_proposals SET status = 'Accepted' WHERE id = _proposal_id;

    SELECT scheduled_at INTO _ts FROM tournament_brackets WHERE id = _bracket.id;
    IF _ts IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: accepted proposal did not stamp bracket scheduled_at';
    END IF;

    RAISE NOTICE '=== MATERIALIZATION (cron equivalent) ===';

    PERFORM schedule_tournament_match(tb)
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    JOIN tournaments t ON t.id = ts.tournament_id
    WHERE tb.match_id IS NULL AND tb.finished = false
      AND tb.scheduled_at IS NOT NULL AND tb.scheduled_at <= NOW() + INTERVAL '15 minutes'
      AND t.status = 'Live';

    SELECT match_id INTO _match_id FROM tournament_brackets WHERE id = _bracket.id;
    IF _match_id IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: due bracket did not materialize a match';
    END IF;

    SELECT COUNT(*) INTO _cnt FROM match_lineup_players mlp
    JOIN matches m ON m.id = _match_id AND mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id);
    IF _cnt != 10 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 10 lineup players, got %', _cnt;
    END IF;

    -- Accepting a proposal materializes the match as Scheduled so it lands on
    -- team calendars immediately; CheckForScheduledMatches opens check-in later.
    IF (SELECT status FROM matches WHERE id = _match_id) != 'Scheduled' THEN
        RAISE EXCEPTION 'ASSERT FAILED: match should be Scheduled, got %',
            (SELECT status FROM matches WHERE id = _match_id);
    END IF;

    RAISE NOTICE '=== DEFAULT SCHEDULE FALLBACK ===';

    UPDATE league_match_weeks SET default_match_at = NOW() + INTERVAL '1 hour'
    WHERE league_season_id = _season_id AND week_number = 1;

    -- Mirrors the ApplyLeagueDefaultSchedules cron, which runs both: the league
    -- function skips window-backed stages, the generic one handles them.
    PERFORM apply_league_default_schedules() + apply_tournament_default_schedules();

    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _rr_stage AND round = 1 AND scheduled_at IS NOT NULL;
    IF _cnt != 2 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected both week-1 brackets scheduled after fallback, got %', _cnt;
    END IF;

    RAISE NOTICE '=== ROSTER LOCK ===';

    UPDATE league_seasons SET roster_lock_at = NOW() - INTERVAL '1 hour' WHERE id = _season_id;

    -- The lock applies to regular users; admins bypass it.
    PERFORM set_config('hasura.user', '{"x-hasura-role": "user", "x-hasura-user-id": "86500000000000001"}', false);
    BEGIN
        INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
        VALUES (_lts_ids[1], 86500000000000021);
        _locked := false;
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _locked := true;
    END;
    PERFORM set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "86500000000000001"}', false);
    IF NOT _locked THEN
        RAISE EXCEPTION 'ASSERT FAILED: roster insert past lock should have raised';
    END IF;

    RAISE NOTICE '=== FORFEIT EVERY REMAINING RR MATCHUP ===';

    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _rr_stage AND tb.finished = false
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
    END LOOP;

    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _rr_stage AND finished = false;
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: % RR brackets still unfinished after forfeits', _cnt;
    END IF;

    RAISE NOTICE '=== STANDINGS ===';

    SELECT COUNT(*) INTO _cnt FROM v_league_division_standings WHERE league_season_id = _season_id;
    IF _cnt != 4 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 4 standings rows, got %', _cnt;
    END IF;

    RAISE NOTICE '=== PLAYOFFS ===';

    SELECT COUNT(*) INTO _cnt FROM tournament_brackets
    WHERE tournament_stage_id = _se_stage
      AND tournament_team_id_1 IS NOT NULL AND tournament_team_id_2 IS NOT NULL;
    IF _cnt < 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: playoff stage was not seeded from RR results';
    END IF;

    UPDATE league_seasons SET status = 'Playoffs' WHERE id = _season_id;

    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _se_stage AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NOT NULL
    LOOP
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
    END LOOP;

    IF (SELECT status FROM tournaments WHERE id = _tournament_id) != 'Finished' THEN
        RAISE EXCEPTION 'ASSERT FAILED: tournament should be Finished, got %',
            (SELECT status FROM tournaments WHERE id = _tournament_id);
    END IF;

    RAISE NOTICE '=== SEASON FINISH + MOVEMENTS ===';

    UPDATE league_seasons SET status = 'Finished' WHERE id = _season_id;

    SELECT COUNT(*) INTO _cnt FROM league_team_movements WHERE league_season_id = _season_id;
    IF _cnt != 4 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 4 movement rows, got %', _cnt;
    END IF;

    -- Invite fielded no teams this season, but it is still the division above Open.
    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type = 'DirectPromote' AND computed_to_division_id = _div_invite;
    IF _cnt != 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected exactly 1 promotion into the empty Invite division, got %', _cnt;
    END IF;

    -- Bottom of the bottom tier has nowhere to go.
    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type = 'DirectRelegate';
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: bottom tier should have no relegations, got %', _cnt;
    END IF;

    RAISE NOTICE '=== NEXT SEASON AUTO-SLOT ===';

    PERFORM approve_league_season_movements(_season_id, json_build_object('x-hasura-user-id', '86500000000000001', 'x-hasura-role', 'administrator'));

    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, min_roster_size, status)
    VALUES (86500000000000001, 'LC Test League S2', 3, 2, 1, 1, clone_match_options(_options_id), 5, 'RegistrationOpen')
    RETURNING id INTO _season2_id;

    -- Re-register the promoted team; it must auto-slot into Invite.
    SELECT m.league_team_id INTO _lt FROM league_team_movements m
    WHERE m.league_season_id = _season_id AND m.type = 'DirectPromote';

    INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
    VALUES (_season2_id, _lt, 86500000000000001)
    RETURNING assigned_division_id INTO _tid;

    IF _tid IS DISTINCT FROM _div_invite THEN
        RAISE EXCEPTION 'ASSERT FAILED: promoted team did not auto-slot into Invite (got %)', _tid;
    END IF;

    RAISE NOTICE '=== ALL LEAGUE SMOKE TESTS PASSED ===';
END;
$smoke$;
