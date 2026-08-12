-- Whether this player has ever signed in here, as opposed to a Steam account we
-- only know about (a shadow row created from an imported match or someone
-- else's friend list).
--
-- A plain boolean rather than exposing last_sign_in_at itself, which is only
-- readable by match_organizer -- when a player last signed in is nobody else's
-- business, but whether they have an account here is what the UI needs.
CREATE OR REPLACE FUNCTION public.is_registered(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player.last_sign_in_at IS NOT NULL;
$$;
