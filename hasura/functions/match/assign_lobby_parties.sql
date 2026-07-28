-- Queue parties for 5stack matches, derived from the lobby.
CREATE OR REPLACE FUNCTION public.assign_lobby_parties(_match_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- A lobby two players happen to share says nothing about how they queued
    -- for someone else's server.
    IF NOT EXISTS (
        SELECT 1
          FROM public.matches
         WHERE id = _match_id
           AND source = '5stack'
    ) THEN
        RETURN;
    END IF;

    UPDATE public.match_lineup_players mlp
       SET party_id = lp.lobby_id,
           party_source = 'lobby'
      FROM public.match_lineups ml,
           public.lobby_players lp
     WHERE ml.id = mlp.match_lineup_id
       AND ml.match_id = _match_id
       AND lp.steam_id = mlp.steam_id
       AND lp.status = 'Accepted'
       AND mlp.party_id IS NULL
       -- A lobby is only a party when someone else from it is in this match.
       AND EXISTS (
           SELECT 1
             FROM public.match_lineup_players other
             JOIN public.match_lineups other_ml
               ON other_ml.id = other.match_lineup_id
             JOIN public.lobby_players other_lp
               ON other_lp.steam_id = other.steam_id
              AND other_lp.lobby_id = lp.lobby_id
              AND other_lp.status = 'Accepted'
            WHERE other_ml.match_id = _match_id
              AND other.steam_id IS DISTINCT FROM mlp.steam_id
       );
END;
$$;
