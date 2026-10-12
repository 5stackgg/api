-- tournament_brackets.match_id is ON DELETE SET NULL, so a hard-deleted
-- tournament match leaves its slot with both teams and nothing to reset. A slot
-- that had been won also stays finished with its winner already moved on, and
-- every scheduler skips a finished slot, so it is replayed and the brackets it
-- fed are unwound the way a reset unwinds them.
CREATE OR REPLACE FUNCTION public.recreate_tournament_bracket_match(_bracket_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    _bracket tournament_brackets%ROWTYPE;
    _stage_type text;
    _tournament_status text;
    _was_finished boolean;
    _pending boolean;
    _match_id uuid;
BEGIN
    SELECT * INTO _bracket
    FROM tournament_brackets
    WHERE id = _bracket_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bracket not found' USING ERRCODE = '22000';
    END IF;

    IF _bracket.match_id IS NOT NULL THEN
        RAISE EXCEPTION 'this bracket already has a match' USING ERRCODE = '22000';
    END IF;

    IF _bracket.bye
       OR _bracket.tournament_team_id_1 IS NULL
       OR _bracket.tournament_team_id_2 IS NULL THEN
        RAISE EXCEPTION 'both teams have to be in the bracket to recreate its match' USING ERRCODE = '22000';
    END IF;

    SELECT ts.type, t.status
    INTO _stage_type, _tournament_status
    FROM tournament_stages ts
    JOIN tournaments t ON t.id = ts.tournament_id
    WHERE ts.id = _bracket.tournament_stage_id;

    IF _tournament_status NOT IN ('RegistrationClosed', 'Live', 'Paused') THEN
        RAISE EXCEPTION 'the tournament is not running' USING ERRCODE = '22000';
    END IF;

    _was_finished := _bracket.finished;

    IF _was_finished THEN
        IF _stage_type NOT IN ('SingleElimination', 'DoubleElimination') THEN
            RAISE EXCEPTION 'only elimination stage matches can be replayed once won' USING ERRCODE = '22000';
        END IF;

        UPDATE tournament_brackets
        SET finished = false
        WHERE id = _bracket_id
        RETURNING * INTO _bracket;
    END IF;

    -- Materialized as early as the cron would, never earlier: a bracket whose
    -- time is still ahead waits as Scheduled for CheckForScheduledMatches.
    _pending := COALESCE(_bracket.scheduled_at > now() + interval '15 minutes', false);

    IF _pending THEN
        PERFORM set_config('fivestack.schedule_as_pending', 'true', true);
    END IF;

    _match_id := schedule_tournament_match(_bracket);

    PERFORM set_config('fivestack.schedule_as_pending', 'false', true);

    IF _match_id IS NULL THEN
        RAISE EXCEPTION 'this bracket needs a schedule before its match can be created' USING ERRCODE = '22000';
    END IF;

    IF _was_finished THEN
        IF EXISTS (
            SELECT 1
            FROM preview_tournament_match_reset(_match_id) affected
            WHERE affected.will_delete_match
              AND affected.match_status IN ('Live', 'Veto')
        ) THEN
            RAISE EXCEPTION 'cannot replay while an affected downstream match is live' USING ERRCODE = '22000';
        END IF;

        PERFORM reset_tournament_match(
            _match_id,
            NULL,
            CASE WHEN _pending THEN 'Scheduled' ELSE 'WaitingForCheckIn' END,
            CASE WHEN _pending THEN _bracket.scheduled_at END
        );
    END IF;

    RETURN _match_id;
END;
$$;
