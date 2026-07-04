-- Enhancement round smoke test: dual-roster block, lineup guard, mid-season
-- removal with 'Remove' movements, post-materialization renegotiation, season
-- rollover cloning, roster integrity after approval (shrink guard, NULL lock),
-- approved-registration protection, admin adjudication, and movement
-- re-ranking around a mid-table withdrawn team.
\set ON_ERROR_STOP on

SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "89500000000000001"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);

DO $enh$
DECLARE
    _pool_id uuid;
    _map_id uuid;
    _options_id uuid;
    _div_open uuid;
    _season_id uuid;
    _clone RECORD;
    _tid uuid;
    _lt uuid;
    _lts uuid;
    _lts2 uuid;
    _lts_removed uuid;
    _removed_tt uuid;
    _tournament_id uuid;
    _rr_stage uuid;
    _bracket RECORD;
    _proposal_id uuid;
    _match_id uuid;
    _cnt int;
    _guarded boolean;
    _ts timestamptz;
    i int;
    j int;
BEGIN
    RAISE NOTICE '=== ENH SETUP ===';

    FOR i IN 1..30 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (89500000000000000 + i, 'ENH Player ' || i,
                'https://example.com/enh' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW())
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    FOR i IN 1..5 LOOP
        INSERT INTO maps (name, type, active_pool) VALUES ('de_enh_test_' || i, 'Competitive', true)
        RETURNING id INTO _map_id;
        INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id);
    END LOOP;

    INSERT INTO match_options (overtime, knife_round, mr, best_of, map_veto, region_veto, type, map_pool_id, tv_delay, coaches)
    VALUES (true, true, 12, 1, false, false, 'Competitive', _pool_id, 115, false)
    RETURNING id INTO _options_id;

    FOR i IN 1..4 LOOP
        INSERT INTO teams (name, short_name, owner_steam_id)
        VALUES ('ENH Team ' || i, 'EN' || i, 89500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _tid;
        FOR j IN 1..5 LOOP
            INSERT INTO team_roster (team_id, player_steam_id, role)
            VALUES (_tid, 89500000000000000 + ((i - 1) * 5 + j), 'Member')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    -- Free tier 1 from the seeded CAL default ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    INSERT INTO league_divisions (name, tier) VALUES ('ENH Open', 1)
    RETURNING id INTO _div_open;

    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, default_best_of, playoff_best_of, min_roster_size,
                                signup_opens_at, signup_closes_at, starts_at, roster_lock_at)
    VALUES (89500000000000001, 'ENH Test League S7', 3, 2, 1, 1, _options_id, 1, 3, 5,
            NOW() - INTERVAL '7 days', NOW() + INTERVAL '1 hour', NOW(), NOW() + INTERVAL '2 days')
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
        SELECT id INTO _tid FROM teams WHERE name = 'ENH Team ' || i;
        INSERT INTO league_teams (team_id)
        VALUES (_tid)
        RETURNING id INTO _lt;
        INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
        VALUES (_season_id, _lt, 89500000000000001)
        RETURNING id INTO _lts;
        IF i = 2 THEN
            _lts2 := _lts;
        END IF;
        IF i = 4 THEN
            _lts_removed := _lts;
        END IF;
        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 89500000000000000 + ((i - 1) * 5 + j));
        END LOOP;
    END LOOP;

    RAISE NOTICE '=== DUAL-ROSTER BLOCK ===';

    -- Player 1 (team 1) cannot also be rostered on team 4.
    _guarded := false;
    BEGIN
        INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
        VALUES (_lts_removed, 89500000000000001);
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: dual-roster insert should have raised';
    END IF;

    RAISE NOTICE '=== SEASON START ===';

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

    RAISE NOTICE '=== APPROVED ROSTER MAY SHRINK BELOW MINIMUM (WARN + REVOKE AT START) ===';

    -- Team 2 (owner 89500000000000006) sits at exactly min_roster_size.
    -- Dropping below the minimum is now allowed (soft-remove); the team is
    -- warned and revoked at league start rather than blocked here.
    PERFORM set_config('hasura.user', '{"x-hasura-role": "user", "x-hasura-user-id": "89500000000000006"}', false);
    UPDATE league_team_rosters
    SET removed_at = NOW(), removed_reason = 'test shrink'
    WHERE league_team_season_id = _lts2 AND player_steam_id = 89500000000000010;

    SELECT COUNT(*) INTO _cnt
    FROM league_team_rosters
    WHERE league_team_season_id = _lts2 AND player_steam_id = 89500000000000010 AND removed_at IS NULL;
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: below-minimum soft-remove should be allowed and mark the player removed';
    END IF;

    -- Restore the player so later assertions keep team 2 at minimum.
    UPDATE league_team_rosters
    SET removed_at = NULL, removed_reason = NULL
    WHERE league_team_season_id = _lts2 AND player_steam_id = 89500000000000010;

    RAISE NOTICE '=== APPROVED REGISTRATION CANNOT REVERT TO PENDING ===';

    _guarded := false;
    BEGIN
        UPDATE league_team_seasons SET status = 'Pending' WHERE id = _lts2;
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: Approved -> Pending revert should have raised';
    END IF;

    RAISE NOTICE '=== NULL ROSTER LOCK DATE LOCKS AT KICKOFF ===';

    PERFORM set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "89500000000000001"}', false);
    UPDATE league_seasons SET roster_lock_at = NULL WHERE id = _season_id;

    PERFORM set_config('hasura.user', '{"x-hasura-role": "user", "x-hasura-user-id": "89500000000000006"}', false);
    _guarded := false;
    BEGIN
        INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
        VALUES (_lts2, 89500000000000022);
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: live season without a lock date should lock the roster';
    END IF;

    PERFORM set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "89500000000000001"}', false);
    UPDATE league_seasons SET roster_lock_at = NOW() + INTERVAL '2 days' WHERE id = _season_id;

    RAISE NOTICE '=== RENEGOTIATION AFTER MATERIALIZATION ===';

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 1
    ORDER BY tb.match_number LIMIT 1;

    -- Agree on a time and materialize the match.
    INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
    VALUES (_bracket.id, 89500000000000001, NOW() + INTERVAL '5 minutes')
    RETURNING id INTO _proposal_id;
    UPDATE league_scheduling_proposals SET status = 'Accepted' WHERE id = _proposal_id;

    PERFORM schedule_tournament_match(tb)
    FROM tournament_brackets tb
    WHERE tb.id = _bracket.id AND tb.scheduled_at <= NOW() + INTERVAL '15 minutes';

    SELECT match_id INTO _match_id FROM tournament_brackets WHERE id = _bracket.id;
    IF _match_id IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: bracket did not materialize';
    END IF;
    IF (SELECT status FROM matches WHERE id = _match_id) != 'WaitingForCheckIn' THEN
        RAISE EXCEPTION 'ASSERT FAILED: match should be WaitingForCheckIn';
    END IF;

    -- Renegotiate: propose a later time and accept it.
    INSERT INTO league_scheduling_proposals (tournament_bracket_id, proposed_by_steam_id, proposed_time)
    VALUES (_bracket.id, 89500000000000006, NOW() + INTERVAL '2 days')
    RETURNING id INTO _proposal_id;
    UPDATE league_scheduling_proposals SET status = 'Accepted' WHERE id = _proposal_id;

    IF (SELECT status FROM matches WHERE id = _match_id) != 'Scheduled' THEN
        RAISE EXCEPTION 'ASSERT FAILED: renegotiated match should be back to Scheduled, got %',
            (SELECT status FROM matches WHERE id = _match_id);
    END IF;
    IF (SELECT scheduled_at FROM matches WHERE id = _match_id) < NOW() + INTERVAL '1 day' THEN
        RAISE EXCEPTION 'ASSERT FAILED: renegotiated match kept the old time';
    END IF;

    RAISE NOTICE '=== LINEUP GUARD (non-rostered player rejected) ===';

    _guarded := false;
    BEGIN
        -- Player 21 is on no league roster.
        INSERT INTO match_lineup_players (match_lineup_id, steam_id)
        SELECT m.lineup_1_id, 89500000000000021 FROM matches m WHERE m.id = _match_id;
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: non-rostered lineup join should have raised';
    END IF;

    RAISE NOTICE '=== ADMIN ADJUDICATION (forfeits) ===';

    SELECT tournament_team_id INTO _removed_tt
    FROM league_team_seasons WHERE id = _lts_removed;

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 1
      AND _removed_tt IN (tb.tournament_team_id_1, tb.tournament_team_id_2);

    -- A plain user (not an administrator) cannot adjudicate league matchups.
    _guarded := false;
    BEGIN
        PERFORM league_award_forfeit(_bracket.id, _removed_tt,
            json_build_object('x-hasura-user-id', '89500000000000022', 'x-hasura-role', 'user'));
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: non-admin forfeit award should have raised';
    END IF;

    -- An administrator can adjudicate. Team 4 wins weeks 1 and 2, which also
    -- makes it mid-table when it later withdraws (movement re-rank case).
    PERFORM league_award_forfeit(_bracket.id, _removed_tt,
        json_build_object('x-hasura-user-id', '89500000000000001', 'x-hasura-role', 'administrator'));

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 2
      AND _removed_tt IN (tb.tournament_team_id_1, tb.tournament_team_id_2);
    PERFORM league_award_forfeit(_bracket.id, _removed_tt,
        json_build_object('x-hasura-user-id', '89500000000000001', 'x-hasura-role', 'administrator'));

    SELECT COUNT(*) INTO _cnt
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage
      AND _removed_tt IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
      AND tb.finished = true;
    IF _cnt != 2 THEN
        RAISE EXCEPTION 'ASSERT FAILED: admin should have finished 2 matchups, got %', _cnt;
    END IF;

    RAISE NOTICE '=== MID-SEASON TEAM REMOVAL ===';

    PERFORM remove_league_team_from_season(
        _lts_removed,
        json_build_object('x-hasura-user-id', '89500000000000001', 'x-hasura-role', 'administrator')
    );

    IF (SELECT status FROM league_team_seasons WHERE id = _lts_removed) != 'Withdrawn' THEN
        RAISE EXCEPTION 'ASSERT FAILED: removed team should be Withdrawn';
    END IF;

    SELECT COUNT(*) INTO _cnt
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage
      AND (tb.tournament_team_id_1 = _removed_tt OR tb.tournament_team_id_2 = _removed_tt)
      AND tb.finished = false;
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: removed team still has % unfinished matchups', _cnt;
    END IF;

    RAISE NOTICE '=== FINISH SEASON, MOVEMENTS MARK REMOVED TEAM ===';

    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
        ORDER BY ts."order", tb.round, tb.match_number
    LOOP
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
    END LOOP;
    -- Second pass for brackets that became ready (playoffs).
    FOR i IN 1..10 LOOP
        SELECT tb.* INTO _bracket FROM tournament_brackets tb
        JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
        ORDER BY ts."order", tb.round, tb.match_number
        LIMIT 1;
        EXIT WHEN _bracket IS NULL;
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
        _bracket := NULL;
    END LOOP;

    UPDATE league_seasons SET status = 'Finished' WHERE id = _season_id;

    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type = 'Remove';
    IF _cnt != 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 1 Remove movement, got %', _cnt;
    END IF;

    RAISE NOTICE '=== MOVEMENTS RE-RANK AROUND THE WITHDRAWN TEAM ===';

    -- Team 4 won two matches before withdrawing, so its raw standings rank is
    -- mid-table. Movements must ignore it: the removed row carries no rank
    -- and the three survivors re-rank to exactly 1..3.
    IF (SELECT final_rank FROM league_team_movements
        WHERE league_season_id = _season_id AND type = 'Remove') IS NOT NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: removed team should have no final rank';
    END IF;

    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND type != 'Remove';
    IF _cnt != 3 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 3 surviving movements, got %', _cnt;
    END IF;

    IF (SELECT array_agg(final_rank ORDER BY final_rank)
        FROM league_team_movements
        WHERE league_season_id = _season_id AND type != 'Remove') != ARRAY[1, 2, 3] THEN
        RAISE EXCEPTION 'ASSERT FAILED: survivors should re-rank to 1..3, got %',
            (SELECT array_agg(final_rank ORDER BY final_rank)
             FROM league_team_movements
             WHERE league_season_id = _season_id AND type != 'Remove');
    END IF;

    RAISE NOTICE '=== LEAGUE-ADMIN DELEGATION (movement approval, clone guard) ===';

    PERFORM approve_league_season_movements(
        _season_id,
        json_build_object('x-hasura-user-id', '89500000000000030', 'x-hasura-role', 'user')
    );
    SELECT COUNT(*) INTO _cnt FROM league_team_movements
    WHERE league_season_id = _season_id AND approved_at IS NULL;
    IF _cnt != 0 THEN
        RAISE EXCEPTION 'ASSERT FAILED: delegate approval should approve all movements, % left', _cnt;
    END IF;

    _guarded := false;
    BEGIN
        PERFORM clone_league_season(
            _season_id,
            json_build_object('x-hasura-user-id', '89500000000000022', 'x-hasura-role', 'user')
        );
    EXCEPTION WHEN SQLSTATE '22000' THEN
        _guarded := true;
    END;
    IF NOT _guarded THEN
        RAISE EXCEPTION 'ASSERT FAILED: non-admin clone should have raised';
    END IF;

    RAISE NOTICE '=== SEASON ROLLOVER CLONE ===';

    SELECT * INTO _clone FROM clone_league_season(
        _season_id,
        json_build_object('x-hasura-user-id', '89500000000000001', 'x-hasura-role', 'administrator')
    );

    IF _clone.season_number IS NULL OR _clone.name != 'Season ' || _clone.season_number THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone should be auto-numbered "Season N", got %', _clone.name;
    END IF;
    IF _clone.status != 'Setup' THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone should be in Setup';
    END IF;
    IF _clone.starts_at <= NOW() THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone start should be in the future';
    END IF;
    IF _clone.match_options_id = _options_id OR _clone.match_options_id IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone should have fresh match options';
    END IF;

    SELECT COUNT(*) INTO _cnt FROM league_match_weeks WHERE league_season_id = _clone.id;
    IF _cnt != 3 THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone should have 3 match weeks, got %', _cnt;
    END IF;

    -- Weekday preserved: shifted by whole weeks.
    IF EXTRACT(DOW FROM _clone.starts_at) != EXTRACT(DOW FROM (SELECT starts_at FROM league_seasons WHERE id = _season_id)) THEN
        RAISE EXCEPTION 'ASSERT FAILED: clone start weekday should match the original';
    END IF;

    RAISE NOTICE '=== NOTIFICATION TYPES SEEDED ===';

    SELECT COUNT(*) INTO _cnt FROM e_notification_types
    WHERE value IN ('LeagueProposalReceived','LeagueProposalAccepted','LeagueProposalDeclined','LeagueMatchUnscheduled','LeagueRegistrationDecision','LeagueRosterUndersized');
    IF _cnt != 6 THEN
        RAISE EXCEPTION 'ASSERT FAILED: expected 6 league notification types, got %', _cnt;
    END IF;

    RAISE NOTICE '=== PLAYER STATS VIEW SHAPE ===';

    PERFORM league_season_id, player_steam_id, kills, kdr
    FROM v_league_season_player_stats
    WHERE league_season_id = _season_id
    LIMIT 1;

    RAISE NOTICE '=== ALL ENHANCEMENT SMOKE TESTS PASSED ===';
END;
$enh$;
