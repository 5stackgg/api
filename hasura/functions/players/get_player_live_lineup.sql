-- Starts from the few Live matches, never from the player's history. The
-- LIMIT keeps the lineup lookup a per-match index probe: written as a plain
-- join, the cached generic plan assumes an average player and walks every
-- lineup the player has ever been in.
CREATE OR REPLACE FUNCTION public.get_player_live_lineup(player public.players)
RETURNS SETOF public.match_lineup_players
LANGUAGE sql
STABLE
AS $$
    SELECT mlp.*
    FROM matches m
    CROSS JOIN LATERAL (
        SELECT *
        FROM match_lineup_players mlp
        WHERE mlp.steam_id = player.steam_id
          AND mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
        LIMIT 1
    ) mlp
    WHERE m.status = 'Live';
$$;
