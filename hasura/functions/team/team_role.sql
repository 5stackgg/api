CREATE OR REPLACE FUNCTION public.team_role(team public.teams, hasura_session json)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT role
    FROM team_roster
    WHERE team_id = team.id
      AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    LIMIT 1;
$$;
