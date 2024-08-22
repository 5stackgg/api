CREATE OR REPLACE FUNCTION public.can_join_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_roster boolean;
BEGIN
	IF tournament.status != 'Scheduled' THEN
		return false;
	END IF;
    SELECT EXISTS (
        SELECT 1
        FROM tournament_team_roster ttr
        WHERE
         tournament_id = tournament.id
         AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO on_roster;
    RETURN NOT on_roster;
END;
$$;