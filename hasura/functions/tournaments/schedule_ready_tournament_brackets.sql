-- Schedules every bracket that auto-scheduling skipped while it was off: a
-- paused tournament resuming, Auto Start turned on, or a stage's match mode
-- switched from admin to auto. Brackets only get scheduled when their teams
-- change, so without this they sit with both teams and no match forever.
--
-- A round robin seeds every round up front, so a later round already holds
-- both teams while the earlier rounds are still being played; it waits until
-- neither team has an earlier match left in its group.
--
-- A bracket with an explicit time more than 15 minutes out is left to
-- CheckForScheduledTournamentBrackets, which materializes it on its own time.
CREATE OR REPLACE FUNCTION public.schedule_ready_tournament_brackets(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM tournaments t
        WHERE t.id = _tournament_id
          AND t.auto_start
          AND t.status IN ('RegistrationClosed', 'CheckInReview', 'Live')
    ) THEN
        RETURN;
    END IF;

    -- Lower rounds first so cascading byes propagate.
    FOR bracket_row IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.match_id IS NULL
          AND tb.finished = false
          AND tb.bye = false
          AND ((tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NULL)
            OR (tb.tournament_team_id_1 IS NULL AND tb.tournament_team_id_2 IS NOT NULL))
          AND NOT tournament_bracket_awaits_earlier_round(tb, ts.type)
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM resolve_bracket_bye(bracket_row);
    END LOOP;

    FOR bracket_row IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.match_id IS NULL
          AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
          AND (tb.scheduled_at IS NULL OR tb.scheduled_at <= now() + interval '15 minutes')
          AND NOT tournament_bracket_awaits_earlier_round(tb, ts.type)
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM schedule_tournament_match(bracket_row);
    END LOOP;

    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.tournament_bracket_awaits_earlier_round(
    _bracket tournament_brackets,
    _stage_type text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT _stage_type = 'RoundRobin'
       AND EXISTS (
           SELECT 1
           FROM tournament_brackets prev
           LEFT JOIN matches pm ON pm.id = prev.match_id
           WHERE prev.tournament_stage_id = _bracket.tournament_stage_id
             AND prev."group" = _bracket."group"
             AND prev.round < _bracket.round
             AND prev.finished = false
             AND pm.winning_lineup_id IS NULL
             AND (prev.tournament_team_id_1 IN (_bracket.tournament_team_id_1, _bracket.tournament_team_id_2)
               OR prev.tournament_team_id_2 IN (_bracket.tournament_team_id_1, _bracket.tournament_team_id_2))
       );
$$;
