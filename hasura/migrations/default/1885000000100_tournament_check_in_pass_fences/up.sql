-- Two fences for the two passes ProcessTournamentCheckIn runs against a
-- deadline, each holding the deadline it has already acted on rather than a
-- flag. The deadline is what moves when an organizer extends the window, so
-- storing it is what makes an extension earn a fresh reminder and a fresh close
-- without either firing twice for the same one.
--
-- The status can no longer answer either question: extending now leaves the
-- tournament held in CheckInReview (flipping it back to RegistrationOpen
-- re-opened registration to newcomers, which an extension never meant), so
-- "held for review" and "held for review with a live extension" are the same
-- status.
ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS check_in_closed_for timestamptz,
    ADD COLUMN IF NOT EXISTS check_in_closing_notified_for timestamptz;

COMMENT ON COLUMN public.tournaments.check_in_closed_for IS 'The check_in_ends_at the close pass has already acted on';
COMMENT ON COLUMN public.tournaments.check_in_closing_notified_for IS 'The check_in_ends_at the closing reminder was sent for';

-- Backfill, or every tournament already sitting in review re-closes and
-- re-notifies its whole field the first time the job runs after this deploy.
UPDATE public.tournaments
   SET check_in_closed_for = check_in_ends_at
 WHERE check_in_ends_at IS NOT NULL
   AND check_in_closed_for IS NULL
   AND status NOT IN ('Setup', 'RegistrationOpen');
