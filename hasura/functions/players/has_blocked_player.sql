CREATE OR REPLACE FUNCTION public.has_blocked_player(blocker bigint, blocked bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.player_blocks pb
        WHERE pb.blocker_steam_id = blocker
          AND pb.blocked_steam_id = blocked
    );
$$;
