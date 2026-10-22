-- Looks up every Live lineup at once in the player's own slice of the
-- (steam_id, match_lineup_id) index, so the cost follows neither the player's
-- history nor how many matches are Live (see is_in_another_match). Practice sessions are Live matches the matches
-- permissions hide, so they are left out here too.
CREATE OR REPLACE FUNCTION public.get_player_live_lineup(player public.players)
RETURNS SETOF public.match_lineup_players
LANGUAGE sql
STABLE
AS $$
    SELECT mlp.*
    FROM match_lineup_players mlp
    WHERE mlp.steam_id = player.steam_id
      AND mlp.match_lineup_id = ANY (ARRAY(
          SELECT m.lineup_1_id FROM matches m WHERE m.status = 'Live' AND m.source <> 'practice'
          UNION ALL
          SELECT m.lineup_2_id FROM matches m WHERE m.status = 'Live' AND m.source <> 'practice'
      ));
$$;
