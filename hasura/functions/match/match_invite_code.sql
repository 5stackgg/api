CREATE OR REPLACE FUNCTION public.match_invite_code(match public.matches, hasura_session json)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN match.status = 'PickingPlayers' AND is_match_organizer(match, hasura_session)
        THEN (SELECT mo.invite_code FROM match_options mo WHERE mo.id = match.match_options_id)
    END;
$$;
