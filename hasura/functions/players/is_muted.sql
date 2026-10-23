-- players.mute_ends_at covers mutes and silences; see is_baned.sql.
CREATE OR REPLACE FUNCTION public.is_muted(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player.mute_ends_at > now();
$$;
