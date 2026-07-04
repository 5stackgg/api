-- Best-of-X series configuration smoke test: per-week and per-playoff-round
-- best-of resolve into materialized match options; mid-season edits propagate.
\set ON_ERROR_STOP on

SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "86500000000000001"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);

DO $bestof$
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
    _se_stage uuid;
    _bracket RECORD;
    _match_best_of int;
    _val text;
    i int;
    j int;
BEGIN
    RAISE NOTICE '=== BO SETUP ===';

    FOR i IN 1..20 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (87500000000000000 + i, 'BO Player ' || i,
                'https://example.com/bo' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW())
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    SELECT mp.id INTO _pool_id FROM map_pools mp
    JOIN _map_pool m ON m.map_pool_id = mp.id
    WHERE mp.type = 'Competitive' AND mp.enabled
    GROUP BY mp.id HAVING COUNT(*) >= 5 LIMIT 1;

    IF _pool_id IS NULL THEN
        INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
        RETURNING id INTO _pool_id;
        FOR i IN 1..5 LOOP
            INSERT INTO maps (name, type, active_pool) VALUES ('de_bo_test_' || i, 'Competitive', true)
            ON CONFLICT DO NOTHING
            RETURNING id INTO _map_id;
            IF _map_id IS NULL THEN
                SELECT id INTO _map_id FROM maps WHERE name = 'de_bo_test_' || i AND type = 'Competitive';
            END IF;
            INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id)
            ON CONFLICT DO NOTHING;
        END LOOP;
    END IF;

    INSERT INTO match_options (overtime, knife_round, mr, best_of, map_veto, region_veto, type, map_pool_id, tv_delay, coaches)
    VALUES (true, true, 12, 1, false, false, 'Competitive', _pool_id, 115, false)
    RETURNING id INTO _options_id;

    FOR i IN 1..4 LOOP
        INSERT INTO teams (name, short_name, owner_steam_id)
        VALUES ('BO Team ' || i, 'BO' || i, 87500000000000000 + ((i - 1) * 5 + 1))
        RETURNING id INTO _tid;

        FOR j IN 1..5 LOOP
            INSERT INTO team_roster (team_id, player_steam_id, role)
            VALUES (_tid, 87500000000000000 + ((i - 1) * 5 + j), 'Member')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    -- Free tier 1 from the seeded CAL default ladder for this scratch run.
    DELETE FROM league_divisions WHERE name IN ('Invite', 'Main', 'Intermediate', 'Open');

    INSERT INTO league_divisions (name, tier) VALUES ('BO Open', 1)
    RETURNING id INTO _div_open;

    -- Week 2 is a BO3; the single playoff round (2 seats = one final) is a BO5.
    INSERT INTO league_seasons (created_by_steam_id, name, match_weeks_count, playoff_seats, promote_count, relegate_count,
                                match_options_id, default_best_of, playoff_best_of, min_roster_size,
                                starts_at, week_best_of, playoff_round_best_of)
    VALUES (87500000000000001, 'BO Test League Season', 3, 2, 0, 0, _options_id, 1, 3, 5,
            NOW(), '{"2": 3}'::jsonb, '{"WB:1": 5}'::jsonb)
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
        SELECT id INTO _tid FROM teams WHERE name = 'BO Team ' || i;
        INSERT INTO league_teams (team_id)
        VALUES (_tid)
        RETURNING id INTO _lt;

        INSERT INTO league_team_seasons (league_season_id, league_team_id, registered_by_steam_id)
        VALUES (_season_id, _lt, 87500000000000001)
        RETURNING id INTO _lts;

        FOR j IN 1..5 LOOP
            INSERT INTO league_team_rosters (league_team_season_id, player_steam_id)
            VALUES (_lts, 87500000000000000 + ((i - 1) * 5 + j));
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
    FROM league_season_divisions
    WHERE league_season_id = _season_id;

    SELECT id INTO _rr_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 1;
    SELECT id INTO _se_stage FROM tournament_stages WHERE tournament_id = _tournament_id AND "order" = 2;

    RAISE NOTICE '=== STAGE SETTINGS TRANSFORM ===';

    SELECT settings->'round_best_of'->>'WB:2' INTO _val
    FROM tournament_stages WHERE id = _rr_stage;
    IF _val IS DISTINCT FROM '3' THEN
        RAISE EXCEPTION 'ASSERT FAILED: RR stage WB:2 best-of expected 3, got %', _val;
    END IF;

    SELECT settings->'round_best_of'->>'WB:1' INTO _val
    FROM tournament_stages WHERE id = _se_stage;
    IF _val IS DISTINCT FROM '5' THEN
        RAISE EXCEPTION 'ASSERT FAILED: SE stage WB:1 best-of expected 5, got %', _val;
    END IF;

    RAISE NOTICE '=== WEEK 1 MATCH IS BO1 (default) ===';

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 1
    ORDER BY tb.match_number LIMIT 1;

    UPDATE tournament_brackets SET scheduled_at = NOW() WHERE id = _bracket.id;
    PERFORM schedule_tournament_match(tb) FROM tournament_brackets tb WHERE tb.id = _bracket.id;

    SELECT mo.best_of INTO _match_best_of
    FROM tournament_brackets tb
    JOIN matches m ON m.id = tb.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE tb.id = _bracket.id;
    IF _match_best_of != 1 THEN
        RAISE EXCEPTION 'ASSERT FAILED: week-1 match best_of expected 1, got %', _match_best_of;
    END IF;

    RAISE NOTICE '=== WEEK 2 MATCH IS BO3 (per-week override) ===';

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 2
    ORDER BY tb.match_number LIMIT 1;

    UPDATE tournament_brackets SET scheduled_at = NOW() WHERE id = _bracket.id;
    PERFORM schedule_tournament_match(tb) FROM tournament_brackets tb WHERE tb.id = _bracket.id;

    SELECT mo.best_of INTO _match_best_of
    FROM tournament_brackets tb
    JOIN matches m ON m.id = tb.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE tb.id = _bracket.id;
    IF _match_best_of != 3 THEN
        RAISE EXCEPTION 'ASSERT FAILED: week-2 match best_of expected 3, got %', _match_best_of;
    END IF;

    RAISE NOTICE '=== MID-SEASON EDIT PROPAGATES (week 3 -> BO3) ===';

    UPDATE league_seasons
    SET week_best_of = '{"2": 3, "3": 3}'::jsonb
    WHERE id = _season_id;

    SELECT settings->'round_best_of'->>'WB:3' INTO _val
    FROM tournament_stages WHERE id = _rr_stage;
    IF _val IS DISTINCT FROM '3' THEN
        RAISE EXCEPTION 'ASSERT FAILED: propagated WB:3 best-of expected 3, got %', _val;
    END IF;

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _rr_stage AND tb.round = 3
    ORDER BY tb.match_number LIMIT 1;

    UPDATE tournament_brackets SET scheduled_at = NOW() WHERE id = _bracket.id;
    PERFORM schedule_tournament_match(tb) FROM tournament_brackets tb WHERE tb.id = _bracket.id;

    SELECT mo.best_of INTO _match_best_of
    FROM tournament_brackets tb
    JOIN matches m ON m.id = tb.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE tb.id = _bracket.id;
    IF _match_best_of != 3 THEN
        RAISE EXCEPTION 'ASSERT FAILED: week-3 match best_of expected 3 after edit, got %', _match_best_of;
    END IF;

    RAISE NOTICE '=== PLAYOFF FINAL IS BO5 ===';

    -- Forfeit every remaining regular-season matchup so the playoff seeds.
    FOR _bracket IN
        SELECT tb.* FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _rr_stage AND tb.finished = false
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM league_award_forfeit(_bracket.id, _bracket.tournament_team_id_1, current_setting('hasura.user')::json);
    END LOOP;

    SELECT tb.* INTO _bracket FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _se_stage
      AND tb.tournament_team_id_1 IS NOT NULL
      AND tb.tournament_team_id_2 IS NOT NULL
    LIMIT 1;

    IF _bracket IS NULL THEN
        RAISE EXCEPTION 'ASSERT FAILED: playoff bracket was not seeded';
    END IF;

    UPDATE tournament_brackets SET scheduled_at = NOW() WHERE id = _bracket.id;
    PERFORM schedule_tournament_match(tb) FROM tournament_brackets tb WHERE tb.id = _bracket.id;

    SELECT mo.best_of INTO _match_best_of
    FROM tournament_brackets tb
    JOIN matches m ON m.id = tb.match_id
    JOIN match_options mo ON mo.id = m.match_options_id
    WHERE tb.id = _bracket.id;
    IF _match_best_of != 5 THEN
        RAISE EXCEPTION 'ASSERT FAILED: playoff final best_of expected 5, got %', _match_best_of;
    END IF;

    RAISE NOTICE '=== ALL BEST-OF SMOKE TESTS PASSED ===';
END;
$bestof$;
