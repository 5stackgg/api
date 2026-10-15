-- Every player and coach of any Live match. While streams require a login a
-- guest could be any one of them signed out, so guests see none of their
-- streams. A practice session is a Live match seating only its host.
CREATE OR REPLACE FUNCTION public.live_match_participants()
RETURNS SETOF bigint
LANGUAGE sql
STABLE
AS $$
    SELECT mlp.steam_id
    FROM matches m
    JOIN match_lineup_players mlp
      ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE m.status = 'Live'
      AND m.source <> 'practice'
      AND mlp.steam_id IS NOT NULL
    UNION
    SELECT ml.coach_steam_id
    FROM matches m
    JOIN match_lineups ml
      ON ml.id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE m.status = 'Live'
      AND m.source <> 'practice'
      AND ml.coach_steam_id IS NOT NULL;
$$;
