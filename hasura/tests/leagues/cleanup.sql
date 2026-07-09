-- Removes all league smoke-test fixtures so suites can re-run.
-- Order matters: matches must go before their tournaments (deleting a live
-- tournament cascades match deletion, whose triggers update the tournament
-- row mid-delete), and tournaments before teams (leaving guard) and players.
SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "1"}', false);
SELECT set_config('fivestack.app_key', 'league-smoke-test-app-key', false);
-- League tournaments are guarded against direct cancel/delete; teardown removes
-- them while their divisions still reference them, so stand aside from the guard.
SELECT set_config('fivestack.league_cascade', 'true', false);

UPDATE tournaments SET status='Cancelled'
 WHERE (name LIKE 'LC Test League%' OR name LIKE 'BO Test League%' OR name LIKE 'PF Test League%' OR name LIKE 'ENH Test League%' OR name LIKE 'Ladder Test Season%')
   AND status NOT IN ('Finished','Cancelled','CancelledMinTeams');

DELETE FROM match_maps WHERE map_id IN (
  SELECT id FROM maps
  WHERE name LIKE 'de_league_test%' OR name LIKE 'de_bo_test%'
     OR name LIKE 'de_pf_test%' OR name LIKE 'de_enh_test%'
     OR name LIKE 'de_ladder_test%'
);
DELETE FROM matches WHERE organizer_steam_id >= 86500000000000001;

DELETE FROM tournaments
 WHERE name LIKE 'LC Test League%' OR name LIKE 'BO Test League%'
    OR name LIKE 'PF Test League%' OR name LIKE 'ENH Test League%'
    OR name LIKE 'Ladder Test Season%';

-- Seasons no longer cascade from a league row; remove them by the synthetic
-- test steam-id range (also catches auto-numbered rollover clones).
DELETE FROM league_seasons WHERE created_by_steam_id >= 86500000000000001;

DELETE FROM league_divisions
 WHERE name IN ('Invite', 'Open', 'BO Open', 'PF Open', 'ENH Open',
                'Guard 1', 'Guard 2', 'Guard 3', 'Ladder Top', 'Ladder Low');

DELETE FROM teams
 WHERE name LIKE 'League Team %' OR name LIKE 'BO Team %'
    OR name LIKE 'PF Team %' OR name LIKE 'ENH Team %'
    OR name LIKE 'Ladder Team %';
DELETE FROM players WHERE steam_id > 86500000000000000;

DELETE FROM _map_pool WHERE map_id IN (
  SELECT id FROM maps
  WHERE name LIKE 'de_league_test%' OR name LIKE 'de_bo_test%'
     OR name LIKE 'de_pf_test%' OR name LIKE 'de_enh_test%'
     OR name LIKE 'de_ladder_test%'
);
DELETE FROM maps
 WHERE name LIKE 'de_league_test%' OR name LIKE 'de_bo_test%'
    OR name LIKE 'de_pf_test%' OR name LIKE 'de_enh_test%'
    OR name LIKE 'de_ladder_test%';
DELETE FROM map_pools mp
 WHERE mp.seed = false
   AND NOT EXISTS (SELECT 1 FROM _map_pool m WHERE m.map_pool_id = mp.id)
   AND NOT EXISTS (SELECT 1 FROM match_options mo WHERE mo.map_pool_id = mp.id);

-- Match creation requires a region with an attached server; keep one around.
INSERT INTO server_regions (value, is_lan) VALUES ('TestRegion', false)
ON CONFLICT (value) DO NOTHING;
INSERT INTO servers (host, label, rcon_password, port, enabled, region, type, is_dedicated)
SELECT '127.0.0.1', 'league-test-server', '\x00'::bytea, 27015, true, 'TestRegion', 'Ranked', true
WHERE NOT EXISTS (SELECT 1 FROM servers WHERE label = 'league-test-server');
