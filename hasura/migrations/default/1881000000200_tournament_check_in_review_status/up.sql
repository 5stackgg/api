-- A pre-start hold, deliberately NOT Paused: Paused means "a running tournament
-- was halted" and owns can_pause / can_resume plus the Paused -> Live
-- rescheduling block in tau_tournaments. Folding this into it would fire that
-- block on a bracket that has never been seeded.
--
-- Repeated in hasura/enums/tournament-statuses.sql; enums are applied after
-- migrations, and tournaments.status has an FK onto this table.
INSERT INTO public.e_tournament_status ("value", "description") VALUES
    ('CheckInReview', 'Check-in closed with teams missing; held for organizer review')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";
