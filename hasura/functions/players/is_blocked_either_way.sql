CREATE OR REPLACE FUNCTION public.is_blocked_either_way(a bigint, b bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT a IS NOT NULL
       AND b IS NOT NULL
       AND a <> b
       AND EXISTS (
           SELECT 1
           FROM public.player_blocks pb
           WHERE (pb.blocker_steam_id = a AND pb.blocked_steam_id = b)
              OR (pb.blocker_steam_id = b AND pb.blocked_steam_id = a)
       );
$$;
