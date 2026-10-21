-- How full a practice server is, for anyone who can see the session. Seats
-- are what join refuses on: a player keeps one from joining until they leave,
-- whether or not they are connected, so a full server can have nobody on it.
-- Connected is who is on it now, the column the plugin's occupancy report
-- writes and the reaper's idle clock reads.

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

-- A practice match seats everybody in lineup_1.
CREATE OR REPLACE FUNCTION public.utility_practice_seated_players(
    session public.utility_practice_sessions
) RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::integer
      FROM public.matches m
      INNER JOIN public.match_lineup_players mlp ON mlp.match_lineup_id = m.lineup_1_id
     WHERE m.id = session.match_id;
$$;

CREATE OR REPLACE FUNCTION public.utility_practice_is_full(
    session public.utility_practice_sessions
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        public.utility_practice_seated_players(session)
            >= public.utility_practice_max_players(session),
        false
    );
$$;
