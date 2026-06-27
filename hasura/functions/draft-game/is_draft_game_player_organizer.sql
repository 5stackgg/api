CREATE OR REPLACE FUNCTION public.is_draft_game_player_organizer(draft_game_player public.draft_game_players, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer', 'match_organizer')
        OR EXISTS (
            SELECT 1
            FROM public.draft_games dg
            WHERE dg.id = draft_game_player.draft_game_id
              AND dg.host_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        );
$$;
