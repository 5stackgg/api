-- Removes fixture data created by the draft-region suites.
SELECT set_config('hasura.user', '{"x-hasura-role": "admin", "x-hasura-user-id": "86600000000000001"}', false);
SELECT set_config('fivestack.app_key', 'draft-region-test-app-key', false);

DELETE FROM draft_games WHERE host_steam_id BETWEEN 86600000000000001 AND 86600000000000010;
DELETE FROM matches WHERE organizer_steam_id BETWEEN 86600000000000001 AND 86600000000000010;
DELETE FROM servers WHERE label = 'draft-region-test-server';
DELETE FROM server_regions WHERE value = 'DraftRegionTest';
DELETE FROM match_options WHERE map_pool_id IN (
    SELECT DISTINCT map_pool_id FROM _map_pool
    WHERE map_id IN (SELECT id FROM maps WHERE name LIKE 'de_draftregion_test_%')
);
DELETE FROM _map_pool WHERE map_id IN (SELECT id FROM maps WHERE name LIKE 'de_draftregion_test_%');
DELETE FROM maps WHERE name LIKE 'de_draftregion_test_%';
DELETE FROM map_pools mp WHERE mp.type = 'Competitive' AND mp.seed = false
    AND NOT EXISTS (SELECT 1 FROM _map_pool WHERE map_pool_id = mp.id)
    AND NOT EXISTS (SELECT 1 FROM match_options WHERE map_pool_id = mp.id)
    AND NOT EXISTS (SELECT 1 FROM draft_games WHERE map_pool_id = mp.id);
DELETE FROM players WHERE steam_id BETWEEN 86600000000000001 AND 86600000000000010;
