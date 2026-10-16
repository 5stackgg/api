-- Starts from the few Live matches, never from the player's history. Each
-- lineup is probed on both columns of its unique key, so any index the planner
-- picks reads a single entry; an index on steam_id alone would read the
-- player's whole history instead, which is why match_lineup_players has none.
-- Practice sessions are Live matches the matches permissions hide, so they are
-- left out here too.
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
        WHERE mlp.match_lineup_id = m.lineup_1_id
          AND mlp.steam_id = player.steam_id
        UNION ALL
        SELECT *
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = m.lineup_2_id
          AND mlp.steam_id = player.steam_id
        LIMIT 1
    ) mlp
    WHERE m.status = 'Live'
      AND m.source <> 'practice';
$$;
