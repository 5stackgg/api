-- Round 1 is materialized while the tournament is still RegistrationClosed (and
-- now CheckInReview) on purpose: the draw, the seeds and the opponents have to
-- be visible so teams can prepare. Materializing them also opened check-in,
-- veto and the join/start flow, so a 12:20 tournament whose registration closed
-- at 12:15 was fully playable at 12:15.
--
-- Deliberately narrow. Only those two holding statuses, and only while `start`
-- is still ahead:
--   * Live (or an organizer starting early) makes this false immediately, so
--     nothing has to be released by hand;
--   * every later round is materialized once the tournament is already running
--     and keeps its current immediate behaviour;
--   * a league fixture plays while its season tournament is Live, so it is
--     never gated either.
CREATE OR REPLACE FUNCTION public.tournament_match_is_pre_start(_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_brackets tb
        INNER JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN public.tournaments t ON t.id = ts.tournament_id
        WHERE tb.match_id = _match_id
          AND t.status IN ('RegistrationClosed', 'CheckInReview')
          AND t."start" > now()
    );
$$;
