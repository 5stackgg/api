-- players.gag_ends_at covers gags and silences; see is_baned.sql.
CREATE OR REPLACE FUNCTION public.is_gagged(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player.gag_ends_at > now();
$$;
