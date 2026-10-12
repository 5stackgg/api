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
    _stage tournament_stages%ROWTYPE;
    _tournament_status text;
    _was_finished boolean;
    _agreed boolean;
    _match_id uuid;
    _scheduled matches%ROWTYPE;
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

    SELECT * INTO _stage
    FROM tournament_stages
    WHERE id = _bracket.tournament_stage_id;

    SELECT status INTO _tournament_status
    FROM tournaments
    WHERE id = _stage.tournament_id;

    IF _tournament_status NOT IN ('RegistrationClosed', 'Live') THEN
        RAISE EXCEPTION 'the tournament is not running' USING ERRCODE = '22000';
    END IF;

    _agreed := EXISTS (
        SELECT 1
        FROM league_scheduling_proposals p
        WHERE p.tournament_bracket_id = _bracket.id
          AND p.status = 'Accepted'
    );

    -- Due only when a scheduler would create it now: straight away where the
    -- tournament starts its own matches (a later round-robin round once both
    -- teams are done with the round before, as schedule_next_round_robin_matches
    -- waits), as soon as both sides agreed a time (tau_league_scheduling_proposals),
    -- otherwise by the bracket's time, as CheckForScheduledTournamentBrackets
    -- picks it up.
    IF NOT (
        _agreed
        OR (
            should_auto_schedule(_stage.id)
            AND (
                _stage.type <> 'RoundRobin'
                OR _bracket.round = 1
                OR (
                    opponent_finished_previous_round(_bracket.tournament_team_id_1, _stage.id, _bracket.round - 1, _bracket."group"::int)
                    AND opponent_finished_previous_round(_bracket.tournament_team_id_2, _stage.id, _bracket.round - 1, _bracket."group"::int)
                )
            )
        )
        OR (
            _tournament_status = 'Live'
            AND COALESCE(_bracket.scheduled_at <= now() + interval '15 minutes', false)
        )
    ) THEN
        RAISE EXCEPTION 'this bracket''s match is not due yet' USING ERRCODE = '22000';
    END IF;

    _was_finished := _bracket.finished;

    IF _was_finished THEN
        IF _stage.type NOT IN ('SingleElimination', 'DoubleElimination') THEN
            RAISE EXCEPTION 'only elimination stage matches can be replayed once won' USING ERRCODE = '22000';
        END IF;

        UPDATE tournament_brackets
        SET finished = false
        WHERE id = _bracket_id
        RETURNING * INTO _bracket;
    END IF;

    -- Parked as Scheduled like the accepted proposal parks it, so check-in
    -- still opens near the agreed kickoff rather than now.
    IF _agreed THEN
        PERFORM set_config('fivestack.schedule_as_pending', 'true', true);
    END IF;

    _match_id := schedule_tournament_match(_bracket);

    IF _agreed THEN
        PERFORM set_config('fivestack.schedule_as_pending', 'false', true);
    END IF;

    IF _match_id IS NULL THEN
        RAISE EXCEPTION 'this bracket needs a schedule before its match can be created' USING ERRCODE = '22000';
    END IF;

    IF _was_finished THEN
        -- The unwind deletes every match the slot fed, with no sweep of their
        -- demos or clips, so only ones that never started may be in the way.
        -- Canceled is not enough on its own: CancelExpiredMatches cancels a
        -- live match that stalled, and a reset clears started_at but leaves
        -- the maps and demos it played.
        IF EXISTS (
            SELECT 1
            FROM preview_tournament_match_reset(_match_id) affected
            JOIN matches m ON m.id = affected.match_id
            WHERE affected.will_delete_match
              AND (
                  m.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled')
                  OR m.started_at IS NOT NULL
                  OR EXISTS (
                      SELECT 1 FROM match_maps mm
                      WHERE mm.match_id = m.id AND mm.started_at IS NOT NULL
                  )
                  OR EXISTS (
                      SELECT 1 FROM match_map_demos d
                      WHERE d.match_id = m.id
                  )
              )
        ) THEN
            RAISE EXCEPTION 'a match downstream of this bracket was already played or went live, even if it was canceled since, so this slot can no longer be replayed' USING ERRCODE = '22000';
        END IF;

        -- reset_tournament_match also rewrites the match itself and clears
        -- cancels_at, which tbu_matches only arms on a status change, so the
        -- match is handed back the status, time and no-show deadline it was
        -- just scheduled with.
        SELECT * INTO _scheduled
        FROM matches
        WHERE id = _match_id;

        PERFORM reset_tournament_match(_match_id, NULL, _scheduled.status, _scheduled.scheduled_at);

        UPDATE matches
        SET cancels_at = _scheduled.cancels_at
        WHERE id = _match_id;
    END IF;

    RETURN _match_id;
END;
$$;
