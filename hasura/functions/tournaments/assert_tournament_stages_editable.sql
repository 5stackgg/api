-- Every structural stage edit rebuilds the whole tournament's brackets through
-- update_tournament_stages, which deletes every match in it, finished ones too.
--
-- Setup is exempt: it is either a tournament that was never drawn or one reset
-- after a cancel, and opening registration rebuilds every bracket anyway.
CREATE OR REPLACE FUNCTION public.assert_tournament_stages_editable(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _status text;
BEGIN
    -- Held until the edit commits, so a close of registration cannot draw
    -- round 1 in between and then have this edit's rebuild wipe it.
    SELECT status INTO _status
    FROM public.tournaments
    WHERE id = _tournament_id
    FOR SHARE;

    IF NOT FOUND OR _status = 'Setup' THEN
        RETURN;
    END IF;

    IF _status NOT IN ('RegistrationOpen', 'CheckInReview') THEN
        RAISE EXCEPTION 'Unable to change stages once registration has closed' USING ERRCODE = '22000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND (
              tb.match_id IS NOT NULL
              OR tb.tournament_team_id_1 IS NOT NULL
              OR tb.tournament_team_id_2 IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'Unable to change stages once the bracket has been drawn' USING ERRCODE = '22000';
    END IF;
END;
$$;
