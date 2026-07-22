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
        )
        -- In a Teams lobby each side is run by its own team: its owner or captain
        -- arranges that side's starters and backups without organizing the lobby.
        OR EXISTS (
            SELECT 1
            FROM public.draft_games dg
            INNER JOIN public.teams t ON t.id IN (dg.team_1_id, dg.team_2_id)
            WHERE dg.id = draft_game_player.draft_game_id
              AND dg.mode = 'Teams'
              AND dg.match_id IS NULL
              AND (
                  t.owner_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
                  OR t.captain_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              )
              AND (
                  COALESCE(dg.inner_squad, false)
                  OR draft_game_player.lineup IS NULL
                  OR t.id = CASE draft_game_player.lineup WHEN 2 THEN dg.team_2_id ELSE dg.team_1_id END
              )
        );
$$;
