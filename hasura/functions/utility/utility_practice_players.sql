-- How full a practice server is, for anyone who can see the session: staff
-- list running servers by it, and friends are told when one has no room.
-- is_connected is what the plugin's occupancy report writes and what the
-- reaper's idle clock reads, so a server shown empty is one about to be shut
-- down. The maximum is the match's own, which is what join refuses at.

CREATE OR REPLACE FUNCTION public.utility_practice_connected_players(
    session public.utility_practice_sessions
) RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::integer
      FROM public.match_lineup_players mlp
      INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
     WHERE ml.match_id = session.match_id
       AND mlp.is_connected = true;
$$;

CREATE OR REPLACE FUNCTION public.utility_practice_max_players(
    session public.utility_practice_sessions
) RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT public.match_max_players_per_lineup(m)
      FROM public.matches m
     WHERE m.id = session.match_id;
$$;
