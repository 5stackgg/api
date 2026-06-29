CREATE OR REPLACE FUNCTION public.is_in_draft(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM draft_game_players dgp
        INNER JOIN draft_games dg ON dg.id = dgp.draft_game_id
        WHERE dgp.steam_id = player.steam_id
          AND dg.match_id IS NULL
          AND dg.status NOT IN ('Completed', 'Canceled')
    );
$$;
