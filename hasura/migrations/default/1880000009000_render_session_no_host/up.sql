-- A render session is system-owned: it books a server for the utility renderer,
-- not for a person. It borrowed the requester's steam id only to satisfy this
-- NOT NULL, which then made it match "my practice session"
-- (host_steam_id = me) and show up as the reviewer's own starting server.
-- Drop the requirement; a render session's host is NULL, and who asked for it
-- is tracked on utility_lineup_renders.requested_by_steam_id for recovery.
ALTER TABLE "public"."utility_practice_sessions"
    ALTER COLUMN "host_steam_id" DROP NOT NULL;
