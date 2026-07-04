-- Generic per-stage-window default-time stamping: for any Live tournament,
-- stamp the window's default_match_at on matchups the captains never agreed on
-- (once the default is near), so the CheckForScheduledTournamentBrackets cron
-- materializes them. Also expires stale pending proposals. Returns brackets
-- stamped. This is the tournament-wide generalization of
-- apply_league_default_schedules (which still covers league seasons whose rounds
-- are gated by league_match_weeks rather than stage windows).
CREATE OR REPLACE FUNCTION public.apply_tournament_default_schedules()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    _stamped int;
BEGIN
    WITH due AS (
        SELECT tb.id, tsw.default_match_at
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        JOIN public.tournaments t ON t.id = ts.tournament_id AND t.status = 'Live'
        JOIN public.tournament_stage_windows tsw
          ON tsw.tournament_stage_id = ts.id
         AND tsw.round = tb.round
        WHERE tb.match_id IS NULL
          AND tb.finished = false
          AND tb.scheduled_at IS NULL
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
          AND tsw.default_match_at IS NOT NULL
          -- 48h catch-up grace after an outage; anything older is left for
          -- admin adjudication rather than back-stamped into the past.
          AND tsw.default_match_at BETWEEN NOW() - INTERVAL '48 hours'
                                       AND NOW() + INTERVAL '2 hours'
    )
    UPDATE public.tournament_brackets tb
    SET scheduled_at = due.default_match_at
    FROM due
    WHERE tb.id = due.id;

    GET DIAGNOSTICS _stamped = ROW_COUNT;

    -- Proposals expire when their time passes or the matchup is settled.
    UPDATE public.league_scheduling_proposals lsp
    SET status = 'Expired'
    WHERE lsp.status = 'Pending'
      AND (
        lsp.proposed_time < NOW()
        OR EXISTS (
            SELECT 1 FROM public.tournament_brackets tb
            LEFT JOIN public.matches m ON m.id = tb.match_id
            WHERE tb.id = lsp.tournament_bracket_id
              AND (
                tb.finished = true
                OR (m.id IS NOT NULL AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn'))
              )
        )
      );

    RETURN _stamped;
END;
$$;
