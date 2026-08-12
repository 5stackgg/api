-- leaderboard_entries is the SETOF return type for every leaderboard function.
-- RETURN QUERY SELECT matches by POSITION, not by name, so this column must be
-- added last and every producer must select it last.
ALTER TABLE "public"."leaderboard_entries"
  ADD COLUMN IF NOT EXISTS "player_custom_avatar_url" TEXT;
