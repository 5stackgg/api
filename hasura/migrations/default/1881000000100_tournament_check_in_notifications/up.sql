-- Its own migration rather than a block inside
-- 1881000000000_tournament_registration_and_check_in: the notification specs
-- scrape every quoted enum value out of any up.sql that so much as mentions
-- e_notification_types, so seeding an unrelated enum in the same file makes
-- those values look like notification types and fails the mapping check.
--
-- Repeated in hasura/enums/notification-types.sql; enums are applied after
-- migrations, so both exist on purpose.
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('TournamentCheckInOpen', 'Check-in has opened for a tournament you are registered for'),
    ('TournamentCheckInClosing', 'Check-in for your tournament closes soon'),
    ('TournamentCheckInMissed', 'Your team missed check-in and was not seeded')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";
