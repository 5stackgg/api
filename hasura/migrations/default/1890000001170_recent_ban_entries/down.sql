DROP INDEX IF EXISTS public.idx_players_steam_banned;
-- CASCADE takes recently_banned_players() with it; it is re-applied from
-- hasura/functions on the next boot that has the table again.
DROP TABLE IF EXISTS public.recent_ban_entries CASCADE;
