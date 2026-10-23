-- players.ban_ends_at is kept by hasura/triggers/player_sanctions.sql: the
-- latest end of a ban that hasn't been removed, infinity for one with no end,
-- -infinity for none. One expression, so it inlines as a column read.
CREATE OR REPLACE FUNCTION public.is_banned(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player.ban_ends_at > now();
$$;
