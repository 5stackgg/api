-- Everyone sharing a Live match with the given player -- both lineups' players
-- and coaches, the player included. Watching any of them stream would show the
-- match from the other side, so whatever streams a player shows is kept from
-- this set. A practice session is a Live match seating only its host.
CREATE OR REPLACE FUNCTION public.live_match_peers(_steam_id bigint)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
AS $$
    WITH live AS (
        SELECT m.lineup_1_id, m.lineup_2_id
        FROM matches m
        WHERE m.status = 'Live'
          AND m.source <> 'practice'
          AND (
            EXISTS (
                SELECT 1
                FROM match_lineup_players mlp
                WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                  AND mlp.steam_id = _steam_id
            )
            OR EXISTS (
                SELECT 1
                FROM match_lineups ml
                WHERE ml.id IN (m.lineup_1_id, m.lineup_2_id)
                  AND ml.coach_steam_id = _steam_id
            )
          )
    )
    SELECT mlp.steam_id
    FROM live
    JOIN match_lineup_players mlp
      ON mlp.match_lineup_id IN (live.lineup_1_id, live.lineup_2_id)
    WHERE mlp.steam_id IS NOT NULL
    UNION
    SELECT ml.coach_steam_id
    FROM live
    JOIN match_lineups ml
      ON ml.id IN (live.lineup_1_id, live.lineup_2_id)
    WHERE ml.coach_steam_id IS NOT NULL;
$$;
