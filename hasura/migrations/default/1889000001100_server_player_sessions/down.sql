DELETE FROM public.settings WHERE name = 'player_session_retention_days';

DROP VIEW IF EXISTS public.server_recent_players;
DROP VIEW IF EXISTS public.v_server_player_totals;

DROP FUNCTION IF EXISTS public.sync_server_player_sessions(uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.close_stale_server_player_sessions(interval);
DROP FUNCTION IF EXISTS public.prune_server_player_sessions(timestamptz, integer);
DROP FUNCTION IF EXISTS public.server_hourly_activity(uuid, integer);
DROP FUNCTION IF EXISTS public.server_session_settle_conn(text[], text);
DROP FUNCTION IF EXISTS public.server_roster_entries(jsonb);
DROP FUNCTION IF EXISTS public.server_roster_departed(jsonb);

-- The boot step only re-applies a functions or views file whose digest
-- changed, so forget these or a later up would never recreate them.
DELETE FROM migration_hashes.hashes
 WHERE name IN (
     'hasura/functions/servers/server_player_sessions',
     'hasura/views/server_recent_players',
     'hasura/views/v_server_player_totals'
 );

DROP TABLE IF EXISTS public.server_player_stats;

DROP TABLE IF EXISTS public.server_player_sessions;

DROP TABLE IF EXISTS public.server_rosters;
