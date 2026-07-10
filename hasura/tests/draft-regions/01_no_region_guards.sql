-- Draft lobbies + matches must refuse to start when no game server region
-- has servers, instead of stranding the draft in CreatingMatch (or silently
-- bouncing a match back to Veto). Cancel must always keep working.
\set ON_ERROR_STOP on

SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "86600000000000001"}', false);
SELECT set_config('fivestack.app_key', 'draft-region-test-app-key', false);

DO $suite$
DECLARE
    _pool_id uuid;
    _map_id uuid;
    _options_id uuid;
    _draft_id uuid;
    _match_id uuid;
    _server_id uuid;
    _status text;
    _raised boolean;
    i int;
BEGIN
    RAISE NOTICE '=== SETUP: players, maps, one region with one server ===';

    FOR i IN 1..10 LOOP
        INSERT INTO players (steam_id, name, profile_url, avatar_url, role, country, name_registered, created_at)
        VALUES (86600000000000000 + i, 'Draft Region Player ' || i,
                'https://example.com/p' || i, 'https://example.com/a.jpg',
                'user', 'US', true, NOW() - INTERVAL '90 days')
        ON CONFLICT (steam_id) DO NOTHING;
    END LOOP;

    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    FOR i IN 1..3 LOOP
        INSERT INTO maps (name, type, active_pool) VALUES ('de_draftregion_test_' || i, 'Competitive', true)
        RETURNING id INTO _map_id;
        INSERT INTO _map_pool (map_id, map_pool_id) VALUES (_map_id, _pool_id);
    END LOOP;

    INSERT INTO server_regions (value, is_lan) VALUES ('DraftRegionTest', false)
    ON CONFLICT (value) DO NOTHING;
    INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
    VALUES ('127.0.0.1', 'draft-region-test-server', '\x00'::bytea, 27915, true, 'DraftRegionTest', 'Ranked', true)
    RETURNING id INTO _server_id;

    INSERT INTO match_options (map_pool_id, type, mr, best_of)
    VALUES (_pool_id, 'Competitive', 12, 1)
    RETURNING id INTO _options_id;

    RAISE NOTICE '=== TEST 1: draft lobby fills while a server exists ===';

    INSERT INTO draft_games (host_steam_id, type, mode, match_options_id, regions)
    VALUES (86600000000000001, 'Competitive', 'Captains', _options_id, ARRAY['DraftRegionTest'])
    RETURNING id INTO _draft_id;

    FOR i IN 1..10 LOOP
        INSERT INTO draft_game_players (draft_game_id, steam_id, status, elo_snapshot)
        VALUES (_draft_id, 86600000000000000 + i, 'Accepted', 1000 + i)
        ON CONFLICT DO NOTHING;
    END LOOP;
    RAISE NOTICE 'PASSED: draft created and filled with a server available';

    RAISE NOTICE '=== TEST 2: starting the draft with no servers raises ===';
    DELETE FROM servers WHERE id = _server_id;

    _raised := false;
    BEGIN
        UPDATE draft_games SET status = 'Filled' WHERE id = _draft_id;
    EXCEPTION WHEN OTHERS THEN
        _raised := true;
        IF SQLERRM NOT LIKE '%No game server regions%' THEN
            RAISE EXCEPTION 'ASSERT: unexpected start error: %', SQLERRM;
        END IF;
    END;
    IF NOT _raised THEN
        RAISE EXCEPTION 'ASSERT: draft start succeeded with no regions available';
    END IF;

    SELECT status INTO _status FROM draft_games WHERE id = _draft_id;
    IF _status != 'Open' THEN
        RAISE EXCEPTION 'ASSERT: draft should remain Open, got %', _status;
    END IF;
    RAISE NOTICE 'PASSED: draft start refused, lobby still Open (host can retry or cancel)';

    RAISE NOTICE '=== TEST 3: creating a new draft lobby with no servers raises ===';
    _raised := false;
    BEGIN
        INSERT INTO draft_games (host_steam_id, type, mode)
        VALUES (86600000000000002, 'Competitive', 'Captains');
    EXCEPTION WHEN OTHERS THEN
        _raised := true;
        IF SQLERRM NOT LIKE '%No game server regions%' THEN
            RAISE EXCEPTION 'ASSERT: unexpected create error: %', SQLERRM;
        END IF;
    END;
    IF NOT _raised THEN
        RAISE EXCEPTION 'ASSERT: draft creation succeeded with no regions available';
    END IF;
    RAISE NOTICE 'PASSED: draft creation refused with no regions';

    RAISE NOTICE '=== TEST 4: match insert without regions raises (finalize safety net relies on this) ===';
    _raised := false;
    BEGIN
        INSERT INTO matches (match_options_id, organizer_steam_id)
        VALUES (_options_id, 86600000000000001);
    EXCEPTION WHEN OTHERS THEN
        _raised := true;
    END;
    IF NOT _raised THEN
        RAISE EXCEPTION 'ASSERT: match insert succeeded with no regions available';
    END IF;
    RAISE NOTICE 'PASSED: match creation refused with no regions';

    RAISE NOTICE '=== TEST 5: server returns -> draft start works again ===';
    INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
    VALUES ('127.0.0.1', 'draft-region-test-server', '\x00'::bytea, 27915, true, 'DraftRegionTest', 'Ranked', true)
    RETURNING id INTO _server_id;

    UPDATE draft_games SET status = 'Filled' WHERE id = _draft_id;
    SELECT status INTO _status FROM draft_games WHERE id = _draft_id;
    IF _status != 'Filled' THEN
        RAISE EXCEPTION 'ASSERT: draft should be Filled, got %', _status;
    END IF;
    RAISE NOTICE 'PASSED: draft start works once a server is back';

    RAISE NOTICE '=== TEST 6: match in Veto whose region loses all servers ===';
    INSERT INTO match_options (map_pool_id, type, mr, best_of, region_veto, map_veto)
    VALUES (_pool_id, 'Competitive', 12, 1, true, true)
    RETURNING id INTO _options_id;

    INSERT INTO matches (match_options_id, organizer_steam_id)
    VALUES (_options_id, 86600000000000001)
    RETURNING id INTO _match_id;

    UPDATE matches SET status = 'Veto' WHERE id = _match_id;
    SELECT region INTO _status FROM matches WHERE id = _match_id;
    IF _status IS NULL THEN
        RAISE EXCEPTION 'ASSERT: single available region should have been auto-selected';
    END IF;

    DELETE FROM servers WHERE id = _server_id;

    _raised := false;
    BEGIN
        UPDATE matches SET status = 'Live' WHERE id = _match_id;
    EXCEPTION WHEN OTHERS THEN
        _raised := true;
        IF SQLERRM NOT LIKE '%No game servers are available in region%' THEN
            RAISE EXCEPTION 'ASSERT: unexpected match start error: %', SQLERRM;
        END IF;
    END;
    IF NOT _raised THEN
        SELECT status INTO _status FROM matches WHERE id = _match_id;
        RAISE EXCEPTION 'ASSERT: match start succeeded with a dead region (ended in %)', _status;
    END IF;
    RAISE NOTICE 'PASSED: match start refused when the selected region has no servers';

    RAISE NOTICE '=== TEST 7: cancel keeps working with no servers (escape hatch) ===';
    UPDATE matches SET status = 'Canceled' WHERE id = _match_id;
    SELECT status INTO _status FROM matches WHERE id = _match_id;
    IF _status != 'Canceled' THEN
        RAISE EXCEPTION 'ASSERT: match cancel failed, got %', _status;
    END IF;

    DELETE FROM draft_games WHERE id = _draft_id;
    RAISE NOTICE 'PASSED: match cancel and draft delete work with no servers';

    RAISE NOTICE '=== TEST 8: running Live match is not disrupted by servers vanishing ===';
    INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
    VALUES ('127.0.0.1', 'draft-region-test-server', '\x00'::bytea, 27915, true, 'DraftRegionTest', 'Ranked', true)
    RETURNING id INTO _server_id;

    -- maps only auto-populate when the pool size equals best_of
    INSERT INTO map_pools (type, enabled, seed) VALUES ('Competitive', true, false)
    RETURNING id INTO _pool_id;
    INSERT INTO _map_pool (map_id, map_pool_id)
    SELECT id, _pool_id FROM maps WHERE name = 'de_draftregion_test_1';

    INSERT INTO match_options (map_pool_id, type, mr, best_of, region_veto, map_veto)
    VALUES (_pool_id, 'Competitive', 12, 1, false, false)
    RETURNING id INTO _options_id;

    INSERT INTO matches (match_options_id, organizer_steam_id, region)
    VALUES (_options_id, 86600000000000001, 'DraftRegionTest')
    RETURNING id INTO _match_id;

    UPDATE matches SET status = 'Live' WHERE id = _match_id;

    DELETE FROM servers WHERE id = _server_id;

    -- updates to an already-Live match must not hit the region guard
    UPDATE matches SET status = 'Live' WHERE id = _match_id;
    SELECT status INTO _status FROM matches WHERE id = _match_id;
    IF _status != 'Live' THEN
        RAISE EXCEPTION 'ASSERT: live match disturbed, got %', _status;
    END IF;
    UPDATE matches SET status = 'Canceled' WHERE id = _match_id;
    RAISE NOTICE 'PASSED: live match updates unaffected by the guard';

    RAISE NOTICE 'ALL DRAFT-REGION GUARD TESTS PASSED';
END;
$suite$;
