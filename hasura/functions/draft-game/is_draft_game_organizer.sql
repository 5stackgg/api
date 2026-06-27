CREATE OR REPLACE FUNCTION public.is_draft_game_organizer(draft_game public.draft_games, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer', 'match_organizer')
        OR draft_game.host_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
$$;
