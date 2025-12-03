CREATE OR REPLACE FUNCTION public.assign_team_to_bracket_slot(
    _target_bracket_id uuid,
    _team_id uuid
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    target_bracket tournament_brackets%ROWTYPE;
BEGIN
    SELECT * INTO target_bracket
    FROM tournament_brackets
    WHERE id = _target_bracket_id
    LIMIT 1;

    IF target_bracket IS NULL OR _team_id IS NULL THEN
        RETURN;
    END IF;

    IF target_bracket.tournament_team_id_1 IS NULL THEN
        UPDATE tournament_brackets
        SET tournament_team_id_1 = _team_id
        WHERE id = _target_bracket_id;
    ELSIF target_bracket.tournament_team_id_2 IS NULL THEN
        UPDATE tournament_brackets
        SET tournament_team_id_2 = _team_id
        WHERE id = _target_bracket_id;
    END IF;
END;
$$;